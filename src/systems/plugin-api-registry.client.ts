import * as orpcClient from '@orpc/client'
import * as react from 'react'
import * as reactJsxRuntime from 'react/jsx-runtime'
import * as rxjs from 'rxjs'
import * as zod from 'zod'

import * as SHIM from '@/models/plugin-api-shim'
import * as libRxjsExt from '@/plugin-api/lib/rxjs-ext'
import * as libZodUtils from '@/plugin-api/lib/zod-utils'
import * as libZustand from '@/plugin-api/lib/zustand'
import * as modelsConstraintBuilders from '@/plugin-api/models/constraint-builders'
import * as modelsFilter from '@/plugin-api/models/filter'
import * as modelsFilterBuilders from '@/plugin-api/models/filter-builders'
import * as modelsLayer from '@/plugin-api/models/layer'
import * as modelsLayerQueries from '@/plugin-api/models/layer-queries'
import * as modelsMatchHistory from '@/plugin-api/models/match-history'
import * as plugin from '@/plugin-api/plugin'
import * as pluginClient from '@/plugin-api/plugin/client'
import * as pluginDecorations from '@/plugin-api/plugin/decorations'
import * as pluginRpcClient from '@/plugin-api/plugin/rpc.client'
import * as pluginSlots from '@/plugin-api/plugin/slots'

// The browser half of the shim registry (see models/plugin-api-shim.ts). A packaged plugin's client
// bundle imports `slm/*` and the shared packages as bare specifiers; the import map in index.html
// points those at /plugin-api/*, which serves shims reading from this global. Everything the plugin
// touches is therefore the app's own instance -- one React, one zustand, one set of registrations.

export function setup() {
	;(globalThis as Record<string, unknown>)[SHIM.API_GLOBAL] = {
		'slm/lib/rxjs-ext': libRxjsExt,
		'slm/lib/zod-utils': libZodUtils,
		'slm/lib/zustand': libZustand,
		'slm/models/constraint-builders': modelsConstraintBuilders,
		'slm/models/filter': modelsFilter,
		'slm/models/filter-builders': modelsFilterBuilders,
		'slm/models/layer': modelsLayer,
		'slm/models/layer-queries': modelsLayerQueries,
		'slm/models/match-history': modelsMatchHistory,
		'slm/plugin': plugin,
		'slm/plugin/client': pluginClient,
		'slm/plugin/decorations': pluginDecorations,
		'slm/plugin/rpc.client': pluginRpcClient,
		'slm/plugin/slots': pluginSlots,
		'@orpc/client': orpcClient,
		react,
		'react/jsx-runtime': reactJsxRuntime,
		rxjs,
		zod,
	}
}
