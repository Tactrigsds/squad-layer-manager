import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'

import * as SHIM from '@/models/plugin-api-shim'
import * as PLG from '@/models/plugins.models'

// Builds a plugin source directory into a package SLM can install: plugin.json plus one esm bundle
// per entry. Everything the host provides stays external -- `slm/*` and the shared packages resolve
// at load time through the host, which is what keeps one zod and one React in the process.
//
//   pnpm plugin:pack <source-dir> [out-dir]
//
// The source directory holds plugin.ts (the manifest, default-exported), server.ts, and optionally
// client.tsx. Serve the output directory over http and install its plugin.json url.

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
	await bundle.write({ file: path.join(outDir, entry.out), format: 'esm', codeSplitting: false })
	await bundle.close()
	built.push(entry.out)
}

const packageManifest: PLG.PackageManifest = {
	id: manifest.id,
	name: manifest.name,
	version: manifest.version,
	apiVersion: manifest.apiVersion,
	description: manifest.description,
	manifest: 'plugin.mjs',
	server: 'server.mjs',
	...(built.includes('client.mjs') ? { client: 'client.mjs' } : {}),
}
fs.writeFileSync(path.join(outDir, PLG.PACKAGE_MANIFEST_FILE), JSON.stringify(packageManifest, null, '\t') + '\n')
console.log(`packed ${manifest.id} v${manifest.version} -> ${path.relative(process.cwd(), outDir)} (${built.join(', ')})`)
