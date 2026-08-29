import * as orpcClient from '@orpc/client'
import * as orpcServer from '@orpc/server'
import * as drizzle from 'drizzle-orm'
import * as drizzleSqliteCore from 'drizzle-orm/sqlite-core'
import { registerHooks } from 'node:module'
import * as react from 'react'
import * as reactJsxRuntime from 'react/jsx-runtime'
import * as rxjs from 'rxjs'
import * as zod from 'zod'

import * as SHIM from '@/models/plugin-api-shim'
import * as libDisplayHelpers from '@/plugin-api/lib/display-helpers'
import * as libRxjsExt from '@/plugin-api/lib/rxjs-ext'
import * as libTemplating from '@/plugin-api/lib/templating'
import * as libZodUtils from '@/plugin-api/lib/zod-utils'
import * as modelsConstraintBuilders from '@/plugin-api/models/constraint-builders'
import * as modelsFilter from '@/plugin-api/models/filter'
import * as modelsFilterBuilders from '@/plugin-api/models/filter-builders'
import * as modelsGenVote from '@/plugin-api/models/gen-vote'
import * as modelsLayer from '@/plugin-api/models/layer'
import * as modelsLayerQueries from '@/plugin-api/models/layer-queries'
import * as modelsMatchHistory from '@/plugin-api/models/match-history'
import * as plugin from '@/plugin-api/plugin'
import * as pluginCommands from '@/plugin-api/plugin/commands'
import * as pluginConfig from '@/plugin-api/plugin/config'
import * as pluginFields from '@/plugin-api/plugin/fields'
import * as pluginRpcServer from '@/plugin-api/plugin/rpc.server'
import * as pluginServers from '@/plugin-api/plugin/servers'
import * as serverInstrumentation from '@/plugin-api/server/instrumentation'
import * as serverLogger from '@/plugin-api/server/logger'
import * as systemsAppEvents from '@/plugin-api/systems/app-events'
import * as systemsDiscord from '@/plugin-api/systems/discord'
import * as systemsFilterEntity from '@/plugin-api/systems/filter-entity'
import * as systemsLayerQueries from '@/plugin-api/systems/layer-queries'
import * as systemsLayerQueue from '@/plugin-api/systems/layer-queue'
import * as systemsMatchHistory from '@/plugin-api/systems/match-history'
import * as systemsPostRollReminders from '@/plugin-api/systems/post-roll-reminders'
import * as systemsSquadRcon from '@/plugin-api/systems/squad-rcon'
import * as systemsSquadServer from '@/plugin-api/systems/squad-server'

// Makes `slm/*` and the shared packages resolvable inside a packaged plugin, which is a standalone
// esm bundle loaded from the plugins directory and so has neither our tsconfig paths nor our
// node_modules (zod and rxjs are devDependencies, absent from a production image).
//
// The map is built inside a function rather than at module scope because several slm/* entries
// re-export from plugins.server, which imports this module: at evaluation time that cycle is still
// open, and touching those namespaces would hit the TDZ.

let entries: Record<string, object> = {}
let installed = false

export function setup() {
	if (installed) return
	installed = true
	entries = {
		'slm/lib/display-helpers': libDisplayHelpers,
		'slm/lib/rxjs-ext': libRxjsExt,
		'slm/lib/templating': libTemplating,
		'slm/lib/zod-utils': libZodUtils,
		'slm/models/constraint-builders': modelsConstraintBuilders,
		'slm/models/filter': modelsFilter,
		'slm/models/gen-vote': modelsGenVote,
		'slm/models/filter-builders': modelsFilterBuilders,
		'slm/models/layer': modelsLayer,
		'slm/models/layer-queries': modelsLayerQueries,
		'slm/models/match-history': modelsMatchHistory,
		'slm/plugin': plugin,
		'slm/plugin/commands': pluginCommands,
		'slm/plugin/config': pluginConfig,
		'slm/plugin/fields': pluginFields,
		'slm/plugin/rpc.server': pluginRpcServer,
		'slm/plugin/servers': pluginServers,
		'slm/server/instrumentation': serverInstrumentation,
		'slm/server/logger': serverLogger,
		'slm/systems/app-events': systemsAppEvents,
		'slm/systems/discord': systemsDiscord,
		'slm/systems/filter-entity': systemsFilterEntity,
		'slm/systems/layer-queries': systemsLayerQueries,
		'slm/systems/layer-queue': systemsLayerQueue,
		'slm/systems/match-history': systemsMatchHistory,
		'slm/systems/post-roll-reminders': systemsPostRollReminders,
		'slm/systems/squad-rcon': systemsSquadRcon,
		'slm/systems/squad-server': systemsSquadServer,
		'@orpc/server': orpcServer,
		'@orpc/client': orpcClient,
		'drizzle-orm': drizzle,
		'drizzle-orm/sqlite-core': drizzleSqliteCore,
		rxjs,
		zod,
		// not for server plugins to use: the browser's shims are served from here, and this is where
		// their export names come from
		react,
		'react/jsx-runtime': reactJsxRuntime,
	}
	;(globalThis as Record<string, unknown>)[SHIM.API_GLOBAL] = entries

	registerHooks({
		resolve(specifier, context, nextResolve) {
			// an unregistered slm/* is still ours to answer: the shim's "not available here" beats a
			// resolution error at naming what went wrong. Anything else falls through to node.
			if (specifier.startsWith('slm/') || specifier in entries) {
				return { url: SHIM.SHIM_SCHEME + specifier, shortCircuit: true }
			}
			return nextResolve(specifier, context)
		},
		load(url, context, nextLoad) {
			if (!url.startsWith(SHIM.SHIM_SCHEME)) return nextLoad(url, context)
			const specifier = url.slice(SHIM.SHIM_SCHEME.length)
			return { format: 'module', source: SHIM.shimSource(specifier, exportNames(specifier)), shortCircuit: true }
		},
	})
}

export function exportNames(specifier: string): readonly string[] {
	const ns = entries[specifier]
	return ns ? Object.keys(ns) : []
}
