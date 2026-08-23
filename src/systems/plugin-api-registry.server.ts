import * as drizzle from 'drizzle-orm'
import * as drizzleSqliteCore from 'drizzle-orm/sqlite-core'
import * as fs from 'node:fs'
import { registerHooks } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as react from 'react'
import * as reactJsxRuntime from 'react/jsx-runtime'
import * as rxjs from 'rxjs'
import * as zod from 'zod'

import { PROJECT_ROOT } from '$root/paths'
import * as SHIM from '@/models/plugin-api-shim'
import * as libRxjsExt from '@/plugin-api/lib/rxjs-ext'
import * as libZodUtils from '@/plugin-api/lib/zod-utils'
import * as modelsLayer from '@/plugin-api/models/layer'
import * as modelsMatchHistory from '@/plugin-api/models/match-history'
import * as plugin from '@/plugin-api/plugin'
import * as pluginConfig from '@/plugin-api/plugin/config'
import * as pluginRpcServer from '@/plugin-api/plugin/rpc.server'
import * as pluginServers from '@/plugin-api/plugin/servers'
import * as serverInstrumentation from '@/plugin-api/server/instrumentation'
import * as serverLogger from '@/plugin-api/server/logger'
import * as systemsAppEvents from '@/plugin-api/systems/app-events'
import * as systemsLayerQueue from '@/plugin-api/systems/layer-queue'
import * as systemsMatchHistory from '@/plugin-api/systems/match-history'
import * as systemsSquadRcon from '@/plugin-api/systems/squad-rcon'

// Makes `slm/*` and the shared packages resolvable inside a packaged plugin, which is a standalone
// esm bundle loaded from the plugins directory and so has neither our tsconfig paths nor our
// node_modules (zod and rxjs are devDependencies, absent from a production image).
//
// The map is built inside a function rather than at module scope because several slm/* entries
// re-export from plugins.server, which imports this module: at evaluation time that cycle is still
// open, and touching those namespaces would hit the TDZ.
//
// `slm-internal/*` is the way out of the curated surface: it maps onto src/, so a plugin that needs
// something the api does not expose can reach it rather than wait for an upstream release or fork the
// app. It resolves to the same file the app imports, so the plugin shares the module instance and its
// state. Nothing about it is versioned or covered by the api report, which is what the name is for.

let entries: Record<string, object> = {}
let installed = false

export function setup() {
	if (installed) return
	installed = true
	entries = {
		'slm/lib/rxjs-ext': libRxjsExt,
		'slm/lib/zod-utils': libZodUtils,
		'slm/models/layer': modelsLayer,
		'slm/models/match-history': modelsMatchHistory,
		'slm/plugin': plugin,
		'slm/plugin/config': pluginConfig,
		'slm/plugin/rpc.server': pluginRpcServer,
		'slm/plugin/servers': pluginServers,
		'slm/server/instrumentation': serverInstrumentation,
		'slm/server/logger': serverLogger,
		'slm/systems/app-events': systemsAppEvents,
		'slm/systems/layer-queue': systemsLayerQueue,
		'slm/systems/match-history': systemsMatchHistory,
		'slm/systems/squad-rcon': systemsSquadRcon,
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
			// rewritten rather than short-circuited, so tsx still gets to resolve and transform it
			if (specifier.startsWith(INTERNAL_PREFIX)) {
				return nextResolve(internalPath(specifier.slice(INTERNAL_PREFIX.length)), context)
			}
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

const INTERNAL_PREFIX = 'slm-internal/'

// `slm-internal/systems/vote.server` -> <root>/src/systems/vote.server.ts. The extension is probed
// rather than required, so the specifier reads like the `@/` import the app itself writes.
function internalPath(rest: string): string {
	const base = path.join(PROJECT_ROOT, 'src', rest)
	for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
		if (fs.existsSync(candidate)) return pathToFileURL(candidate).href
	}
	throw new Error(`${INTERNAL_PREFIX}${rest} does not name a file under src/`)
}

export function exportNames(specifier: string): readonly string[] {
	const ns = entries[specifier]
	return ns ? Object.keys(ns) : []
}
