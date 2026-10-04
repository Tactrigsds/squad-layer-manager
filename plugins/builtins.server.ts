import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import type * as PLG from '@/models/plugins.models'
import type { BuiltinPlugin, ServerModule } from '@/systems/plugins.server'

import afkKicker from './afk-kicker/plugin.ts'
import balanceTriggers from './balance-triggers/plugin.ts'
import teamkillWarns from './teamkill-warns/plugin.ts'

// The plugins shipped in this repo, statically registered so the rolldown server bundle includes them.
// Entry modules load lazily at activation; only the manifests are eager. A packaged plugin is found in
// PLUGINS_DIR at runtime and registers nothing here.
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
	{
		manifest: balanceTriggers,
		server: () => import('./balance-triggers/server.ts'),
		migrations: () => import('./balance-triggers/migrations.ts'),
		hasClient: true,
	},
	{
		manifest: teamkillWarns,
		server: () => import('./teamkill-warns/server.ts'),
		hasClient: false,
	},
	{
		manifest: afkKicker,
		server: () => import('./afk-kicker/server.ts'),
		hasClient: false,
	},
]

/**
 * Every other directory in here, in dev only, loaded from source rather than from a package. It is what
 * lets a plugin author clone their own repo into plugins/ and get the loop host code gets: the server
 * runs their .ts under tsx watch, and plugins/builtins.ts puts their client in vite's graph.
 *
 * Never used by a real build. The image ships the list above, so a plugin that only ever ran this way
 * has never been through `plugin:pack` or the shim registry, which is most of what running it proves.
 */
export async function discoverSourcePlugins(): Promise<BuiltinPlugin[]> {
	// A plugin repo can install its own copy of a shared package, and the manifests below must still get the host's.
	// Imported here rather than at the top, where it would join main.ts's first import and reorder the registry's cycle.
	const ApiRegistry = await import('@/systems/plugin-api-registry.server')
	ApiRegistry.setup()
	const known = new Set(BUILTIN_PLUGINS.map((p) => p.manifest.id))
	const out: BuiltinPlugin[] = []
	for (const dir of sourceDirs(import.meta.dirname)) {
		assertEsmPackage(dir)
		const entry = path.join(dir, 'plugin.ts')
		const manifest = ((await import(pathToFileURL(entry).href)) as { default?: PLG.Manifest }).default
		if (!manifest || known.has(manifest.id)) continue
		const migrations = path.join(dir, 'migrations.ts')
		out.push({
			manifest,
			server: () => import(pathToFileURL(path.join(dir, 'server.ts')).href) as Promise<ServerModule>,
			...(fs.existsSync(migrations)
				? { migrations: () => import(pathToFileURL(migrations).href) as Promise<{ migrations: PLG.PluginMigration[] }> }
				: {}),
			hasClient: fs.existsSync(path.join(dir, 'client.tsx')),
		})
	}
	return out
}

// Directories holding a plugin.ts, one or two levels down. The second level is what lets one repo hold
// several plugins and still be cloned in here as a unit; it matches the globs builtins.ts asks vite for.
function sourceDirs(root: string): string[] {
	const out: string[] = []
	for (const name of fs.readdirSync(root).sort()) {
		const dir = path.join(root, name)
		if (!fs.statSync(dir).isDirectory()) continue
		if (fs.existsSync(path.join(dir, 'plugin.ts'))) out.push(dir)
		else
			out.push(
				...fs
					.readdirSync(dir)
					.sort()
					.map((n) => path.join(dir, n))
					.filter((d) => fs.existsSync(path.join(d, 'plugin.ts'))),
			)
	}
	return out
}

// Node reads a .ts file's module format from the nearest package.json, so a plugin repo's own package.json without
// `"type": "module"` turns its source into CommonJS under tsx, where import.meta and top-level await break
function assertEsmPackage(dir: string) {
	for (let d = dir; d !== import.meta.dirname; d = path.dirname(d)) {
		const file = path.join(d, 'package.json')
		if (!fs.existsSync(file)) continue
		const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { type?: string }
		if (pkg.type !== 'module') throw new Error(`${file} must set "type": "module", or the plugin in ${dir} loads as CommonJS`)
		return
	}
}
