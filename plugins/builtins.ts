import { clients, manifests } from 'virtual:slm-dev-plugins'

import type { BuiltinClientPlugin } from '@/systems/plugins.client'

import balanceTriggers from './balance-triggers/plugin.ts'

// The client-safe half of the builtin registry: manifests plus lazy client entries. Server/migration
// entries live in builtins.server.ts so the client bundle never sees them. Only plugins shipped in this
// repo belong here; a packaged plugin is found in PLUGINS_DIR at runtime and registers nothing.
const SHIPPED: BuiltinClientPlugin[] = [{ manifest: balanceTriggers, client: () => import('./balance-triggers/client.tsx') }]

export const BUILTIN_PLUGIN_CLIENTS: BuiltinClientPlugin[] = [...SHIPPED, ...discoverSourceClients()]

// The client half of what builtins.server.ts discovers. `virtual:slm-dev-plugins` is empty in a build,
// so this is dev-only by construction: it puts a plugin's own source in vite's module graph, which is
// where its HMR comes from.
function discoverSourceClients(): BuiltinClientPlugin[] {
	const known = new Set(SHIPPED.map((e) => e.manifest.id))
	const out: BuiltinClientPlugin[] = []
	for (const [file, mod] of Object.entries(manifests)) {
		const manifest = mod.default
		if (!manifest || known.has(manifest.id)) continue
		const client = clients[file.replace(/plugin\.ts$/, 'client.tsx')]
		out.push({ manifest, ...(client ? { client } : {}) })
	}
	return out
}
