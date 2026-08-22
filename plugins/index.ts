import type { InstalledClientPlugin } from '@/systems/plugins.client'

import balanceTriggers from './balance-triggers/plugin.ts'

// The client-safe half of the installed-plugin registry: manifests plus lazy client entries.
// Server/migration entries live in index.server.ts so the client bundle never sees them.
export const INSTALLED_PLUGIN_CLIENTS: InstalledClientPlugin[] = [
	{ manifest: balanceTriggers, client: () => import('./balance-triggers/client.tsx') },
]
