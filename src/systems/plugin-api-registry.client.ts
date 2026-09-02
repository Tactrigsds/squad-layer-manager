import * as orpcClient from '@orpc/client'
import * as react from 'react'
import * as reactJsxRuntime from 'react/jsx-runtime'
import * as rxjs from 'rxjs'

import * as zod from '@/lib/zod'
import * as SHIM from '@/models/plugin-api-shim'
import * as componentsComboBox from '@/plugin-api/components/combo-box'
import * as componentsIcons from '@/plugin-api/components/icons'
import * as componentsLayer from '@/plugin-api/components/layer'
import * as componentsPickers from '@/plugin-api/components/pickers'
import * as componentsPluginSettingsLink from '@/plugin-api/components/plugin-settings-link'
import * as libDisplayHelpers from '@/plugin-api/lib/display-helpers'
import * as libRxjsExt from '@/plugin-api/lib/rxjs-ext'
import * as libTemplating from '@/plugin-api/lib/templating'
import * as libZodUtils from '@/plugin-api/lib/zod-utils'
import * as libZustand from '@/plugin-api/lib/zustand'
import * as modelsConstraintBuilders from '@/plugin-api/models/constraint-builders'
import * as modelsFilter from '@/plugin-api/models/filter'
import * as modelsFilterBuilders from '@/plugin-api/models/filter-builders'
import * as modelsGenVote from '@/plugin-api/models/gen-vote'
import * as modelsLayer from '@/plugin-api/models/layer'
import * as modelsLayerQueries from '@/plugin-api/models/layer-queries'
import * as modelsMatchHistory from '@/plugin-api/models/match-history'
import * as modelsRbac from '@/plugin-api/models/rbac'
import * as plugin from '@/plugin-api/plugin'
import * as pluginClient from '@/plugin-api/plugin/client'
import * as pluginDecorations from '@/plugin-api/plugin/decorations'
import * as pluginEvents from '@/plugin-api/plugin/events'
import * as pluginFields from '@/plugin-api/plugin/fields'
import * as pluginRpcClient from '@/plugin-api/plugin/rpc.client'
import * as pluginSlots from '@/plugin-api/plugin/slots'

// The browser half of the shim registry (see models/plugin-api-shim.ts). A packaged plugin's client
// bundle imports `slm/*` and the shared packages as bare specifiers; the import map in index.html
// points those at /plugin-api/*, which serves shims reading from this global. Everything the plugin
// touches is therefore the app's own instance -- one React, one zustand, one set of registrations.

export function setup() {
	;(globalThis as Record<string, unknown>)[SHIM.API_GLOBAL] = {
		'slm/components/combo-box': componentsComboBox,
		'slm/components/icons': componentsIcons,
		'slm/components/layer': componentsLayer,
		'slm/components/pickers': componentsPickers,
		'slm/components/plugin-settings-link': componentsPluginSettingsLink,
		'slm/lib/display-helpers': libDisplayHelpers,
		'slm/lib/rxjs-ext': libRxjsExt,
		'slm/lib/templating': libTemplating,
		'slm/lib/zod-utils': libZodUtils,
		'slm/lib/zustand': libZustand,
		'slm/models/constraint-builders': modelsConstraintBuilders,
		'slm/models/filter': modelsFilter,
		'slm/models/gen-vote': modelsGenVote,
		'slm/models/filter-builders': modelsFilterBuilders,
		'slm/models/layer': modelsLayer,
		'slm/models/layer-queries': modelsLayerQueries,
		'slm/models/match-history': modelsMatchHistory,
		'slm/models/rbac': modelsRbac,
		'slm/plugin': plugin,
		'slm/plugin/client': pluginClient,
		'slm/plugin/decorations': pluginDecorations,
		'slm/plugin/events': pluginEvents,
		'slm/plugin/fields': pluginFields,
		'slm/plugin/rpc.client': pluginRpcClient,
		'slm/plugin/slots': pluginSlots,
		'@orpc/client': orpcClient,
		react,
		'react/jsx-runtime': reactJsxRuntime,
		rxjs,
		zod,
	}
}
