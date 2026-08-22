import type { InstalledPlugin } from '@/systems/plugins.server'

import balanceTriggers from './balance-triggers/plugin.ts'

// The installed plugins, statically registered so the rolldown server bundle includes them.
// Entry modules load lazily at activation; only the manifests are eager.
export const INSTALLED_PLUGINS: InstalledPlugin[] = [
	{
		manifest: balanceTriggers,
		server: () => import('./balance-triggers/server.ts'),
		migrations: () => import('./balance-triggers/migrations.ts'),
		hasClient: true,
	},
]
