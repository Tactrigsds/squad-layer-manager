import { compile, optimize } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'

import * as SHIM from '@/models/plugin-api-shim'
import * as PLG from '@/models/plugins.models'

// Builds a plugin source directory into a package SLM can install: plugin.json plus one esm bundle
// per entry, and a stylesheet for the client. Everything the host provides stays external -- `slm/*`
// and the shared packages resolve at load time through the host, which is what keeps one zod and one
// React in the process.
//
//   pnpm plugin:pack <source-dir> [out-dir]
//
// The source directory holds plugin.ts (the manifest, default-exported), server.ts, and optionally
// client.tsx and client.css. Serve the output directory over http and install its plugin.json url.

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

const [srcArg, outArg] = process.argv.slice(2)
if (!srcArg) {
	console.error('usage: pnpm plugin:pack <source-dir> [out-dir]')
	process.exit(1)
}
const srcDir = path.resolve(srcArg)
const outDir = path.resolve(outArg ?? path.join(srcDir, 'dist'))

const ENTRIES = [
	{ source: 'plugin.ts', out: 'plugin.mjs', required: true },
	{ source: 'server.ts', out: 'server.mjs', required: true },
	{ source: 'client.tsx', out: 'client.mjs', required: false },
] as const

// the manifest module is plain typescript reachable through our own tsconfig paths, so its fields
// can be read here rather than restated in a config file
const manifestModule = (await import(pathToFileURL(path.join(srcDir, 'plugin.ts')).href)) as { default?: PLG.Manifest }
const manifest = manifestModule.default
if (!manifest?.id) throw new Error(`${srcDir}/plugin.ts must default-export the manifest definePlugin() returned`)

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const external = [/^slm\//, ...SHIM.SHARED_PACKAGES]

// Anything left external has to be resolvable at load time: `slm/*` and the shared packages through the
// host's import map, and ./plugin.mjs from the package itself. A bare specifier that is neither resolves
// nowhere, and the failure is silent -- the module never runs, so nothing registers and nothing logs.
function servedByHost(specifier: string): boolean {
	if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) return true
	if (specifier.startsWith('slm/')) return true
	return (SHIM.SHARED_PACKAGES as readonly string[]).includes(specifier)
}
const built: string[] = []
for (const entry of ENTRIES) {
	const input = path.join(srcDir, entry.source)
	if (!fs.existsSync(input)) {
		if (entry.required) throw new Error(`missing ${entry.source} in ${srcDir}`)
		continue
	}
	const bundle = await rolldown({
		input,
		external,
		platform: 'neutral',
		plugins: [
			{
				// the manifest is its own bundle, so server.mjs and client.mjs point at it rather than
				// inlining a second copy: one plugin, one frozen manifest object
				name: 'slm-external-manifest',
				resolveId(source: string) {
					if (entry.out !== 'plugin.mjs' && /(^|\/)plugin\.ts$/.test(source)) return { id: './plugin.mjs', external: true }
					return null
				},
			},
		],
	})
	const { output } = await bundle.write({ file: path.join(outDir, entry.out), format: 'esm', codeSplitting: false })
	await bundle.close()
	for (const chunk of output) {
		if (chunk.type !== 'chunk') continue
		const unresolvable = chunk.imports.filter((spec) => !servedByHost(spec))
		if (unresolvable.length > 0) {
			throw new Error(
				`${entry.out} imports ${unresolvable.join(', ')}, which the host does not serve. ` +
					`Bare specifiers are left external, and the browser's import map only answers slm/* and ` +
					`${SHIM.SHARED_PACKAGES.join(', ')} -- so the bundle would load and then fail to resolve, ` +
					`taking the plugin's whole client half down silently. Import it through an slm/* entry, or ` +
					`vendor it into the plugin.`,
			)
		}
	}
	built.push(entry.out)
}

// The client's stylesheet: the Tailwind utilities its sources use, plus its own client.css if it has
// one. The app's stylesheet is built from the app's sources alone, so a utility the app happens not to
// use exists nowhere unless the plugin brings it. `@reference` reads the app's theme and variants without
// re-emitting any of them, and the utilities land in the app's own cascade layer, so the two sheets read
// as one.
async function compileStyles(): Promise<string> {
	const ownCss = path.join(srcDir, 'client.css')
	const input = [
		`@reference ${JSON.stringify(path.join(repoRoot, 'src', 'index.css'))};`,
		`@import "tailwindcss/utilities" layer(utilities) source(none);`,
		...(fs.existsSync(ownCss) ? [`@import ${JSON.stringify(ownCss)};`] : []),
	].join('\n')
	const compiler = await compile(input, { base: srcDir, onDependency: () => {} })
	const scanner = new Scanner({
		sources: [
			{ base: srcDir, pattern: '**/*', negated: false },
			{ base: outDir, pattern: '**/*', negated: true },
			{ base: path.join(srcDir, 'node_modules'), pattern: '**/*', negated: true },
		],
	})
	return optimize(compiler.build(scanner.scan()), { minify: true }).code
}

if (built.includes('client.mjs')) {
	fs.writeFileSync(path.join(outDir, 'client.css'), await compileStyles())
	built.push('client.css')
}

const packageManifest: PLG.PackageManifest = {
	id: manifest.id,
	name: manifest.name,
	version: manifest.version,
	apiVersion: manifest.apiVersion,
	description: manifest.description,
	manifest: 'plugin.mjs',
	server: 'server.mjs',
	...(built.includes('client.mjs') ? { client: 'client.mjs', styles: 'client.css' } : {}),
}
fs.writeFileSync(path.join(outDir, PLG.PACKAGE_MANIFEST_FILE), JSON.stringify(packageManifest, null, '\t') + '\n')
console.log(`packed ${manifest.id} v${manifest.version} -> ${path.relative(process.cwd(), outDir)} (${built.join(', ')})`)
