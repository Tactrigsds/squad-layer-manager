import { definePluginClient } from 'slm/plugin/client'
import * as Slots from 'slm/plugin/slots'

import { SeedRollerPanel } from './panel.tsx'
import manifest from './plugin.ts'
import * as S from './state.client.ts'

export default definePluginClient(manifest, (ctx) => {
	S.init(ctx)

	// the component comes from a module that exports components and nothing else, so editing it in dev
	// swaps it in place. Registering one defined here instead costs a page reload on every edit.
	Slots.register(ctx, 'server-dashboard:alerts', SeedRollerPanel)
})
