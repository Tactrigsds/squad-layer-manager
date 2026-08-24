import type { BuiltinClientPlugin } from '@/systems/plugins.client'

import balanceTriggers from './balance-triggers/plugin.ts'

// The client-safe half of the builtin registry: manifests plus lazy client entries. Server/migration
// entries live in builtins.server.ts so the client bundle never sees them. Only plugins shipped in this
// repo belong here; a packaged plugin is found in PLUGINS_DIR at runtime and registers nothing.
export const BUILTIN_PLUGIN_CLIENTS: BuiltinClientPlugin[] = [
	{ manifest: balanceTriggers, client: () => import('./balance-triggers/client.tsx') },
]
