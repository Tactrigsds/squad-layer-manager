import type { BuiltinPlugin } from '@/systems/plugins.server'

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
