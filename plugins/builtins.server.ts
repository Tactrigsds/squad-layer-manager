import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import type * as PLG from '@/models/plugins.models'
import type { BuiltinPlugin, ServerModule } from '@/systems/plugins.server'

import balanceTriggers from './balance-triggers/plugin.ts'

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
	const known = new Set(BUILTIN_PLUGINS.map((p) => p.manifest.id))
	const out: BuiltinPlugin[] = []
	for (const name of fs.readdirSync(import.meta.dirname).sort()) {
		const dir = path.join(import.meta.dirname, name)
		const entry = path.join(dir, 'plugin.ts')
		if (!fs.statSync(dir).isDirectory() || !fs.existsSync(entry)) continue
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
