import { compile, optimize } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import * as fs from 'node:fs'
import { isBuiltin } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'
import * as semver from 'semver'

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

// plugin.mjs is loaded by both the server and the browser, so it is built for neither
const ENTRIES = [
	{ source: 'plugin.ts', out: 'plugin.mjs', platform: 'neutral', required: true },
	{ source: 'server.ts', out: 'server.mjs', platform: 'node', required: true },
	{ source: 'client.tsx', out: 'client.mjs', platform: 'browser', required: false },
] as const

// the manifest module is plain typescript reachable through our own tsconfig paths, so its fields
// can be read here rather than restated in a config file
const manifestModule = (await import(pathToFileURL(path.join(srcDir, 'plugin.ts')).href)) as { default?: PLG.Manifest }
const manifest = manifestModule.default
if (!manifest?.id) throw new Error(`${srcDir}/plugin.ts must default-export the manifest definePlugin() returned`)

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const SHARED = new Set<string>(SHIM.SHARED_PACKAGES)
const hostVersions = new Map(
	SHIM.SHARED_PACKAGE_NAMES.map((name) => [name, readPackageJson(path.join(repoRoot, 'node_modules', name)).version]),
)

// Dependencies are bundled. Only `slm/*` and the shared packages stay external, and the host answers those at
// load time. rolldown leaves an import it cannot resolve external too, and nothing at load time can answer
// that one, so it fails the pack instead.
const built: string[] = []
const peerWarnings = new Set<string>()
for (const entry of ENTRIES) {
	const input = path.join(srcDir, entry.source)
	if (!fs.existsSync(input)) {
		if (entry.required) throw new Error(`missing ${entry.source} in ${srcDir}`)
		continue
	}
	const commonJs: string[] = []
	const bundle = await rolldown({
		input,
		external: (id) => id.startsWith('slm/') || SHARED.has(id),
		platform: entry.platform,
		// the ESM build of a package without an `exports` map is named by `module`. Neutral reads no main fields at all.
		resolve: { mainFields: entry.platform === 'browser' ? ['browser', 'module', 'main'] : ['module', 'main'] },
		onLog(level, log, handler) {
			if (log.code === 'UNRESOLVED_IMPORT') {
				const specifier = log.exporter ?? /'([^']+)'/.exec(log.message)?.[1] ?? ''
				const hint = isBuiltin(specifier)
					? `${entry.source} runs in the browser, which has no Node builtins.`
					: `Add ${specifier} to the plugin's package.json and install it.`
				handler('error', { ...log, message: `${log.message.trimEnd()}\n${hint}` })
				return
			}
			handler(level, log)
		},
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
			{
				// a subpath the host does not serve would be bundled as a second copy of a package that must have one
				name: 'slm-shared-subpaths',
				resolveId(source: string, importer: string | undefined) {
					if (SHARED.has(source) || !SHIM.SHARED_PACKAGE_NAMES.includes(SHIM.packageName(source))) return null
					const served = SHIM.SHARED_PACKAGES.filter((s) => SHIM.packageName(s) === SHIM.packageName(source))
					throw new Error(
						`${importer ? path.relative(srcDir, importer) : entry.source} imports ${source}. The host provides ${SHIM.packageName(source)} only as ` +
							`${served.join(', ')}, and a bundled copy would be a second instance of it.`,
					)
				},
			},
			{
				name: 'slm-esm-only',
				moduleParsed(info: { id: string; inputFormat: string }) {
					if (info.inputFormat === 'cjs') commonJs.push(info.id)
				},
			},
		],
	})
	const { output } = await bundle.write({ file: path.join(outDir, entry.out), format: 'esm', codeSplitting: false })
	await bundle.close()
	// CommonJS needs runtime interop: a require() of an external is left as a call the browser cannot make
	if (commonJs.length > 0) {
		const packages = new Set(
			commonJs.map((id) => {
				const dir = owningPackageDir(id)
				if (!dir) return path.relative(srcDir, id)
				const pkg = readPackageJson(dir)
				return `${pkg.name}@${pkg.version}`
			}),
		)
		throw new Error(
			`${entry.source} bundles CommonJS modules from ${[...packages].join(', ')}. Plugins can only bundle ES modules. ` +
				`Use an ESM build of the package, or another package.`,
		)
	}
	for (const chunk of output) {
		if (chunk.type !== 'chunk') continue
		for (const warning of peerMismatches(chunk.moduleIds)) peerWarnings.add(warning)
	}
	built.push(entry.out)
}
for (const warning of peerWarnings) console.warn(`warning: ${warning}`)

// A bundled dependency runs against the host's copy of each shared package, whatever version it was installed with
function peerMismatches(moduleIds: string[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const id of moduleIds) {
		const pkgDir = owningPackageDir(id)
		if (!pkgDir || seen.has(pkgDir)) continue
		seen.add(pkgDir)
		const pkg = readPackageJson(pkgDir)
		for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
			if (!SHIM.SHARED_PACKAGE_NAMES.includes(peer)) continue
			const hostVersion = hostVersions.get(peer)!
			if (!semver.satisfies(hostVersion, range, { includePrerelease: true })) {
				out.push(`${pkg.name}@${pkg.version} expects ${peer} ${range}, and SLM provides ${hostVersion}`)
			}
		}
	}
	return out
}

// The nearest directory above a module that holds a named package.json. Bundlers' dist folders often carry
// a package.json of their own with only a `type` field.
function owningPackageDir(moduleId: string): string | null {
	if (!path.isAbsolute(moduleId) || !moduleId.includes(`${path.sep}node_modules${path.sep}`)) return null
	let dir = path.dirname(moduleId)
	while (dir !== path.dirname(dir)) {
		const file = path.join(dir, 'package.json')
		if (fs.existsSync(file) && readPackageJson(dir).name) return dir
		dir = path.dirname(dir)
	}
	return null
}

type PackageJson = { name?: string; version: string; peerDependencies?: Record<string, string> }
function readPackageJson(dir: string): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
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
