import { definePluginClient } from 'slm/plugin/client'
import * as Events from 'slm/plugin/events'
import * as Slots from 'slm/plugin/slots'

import { ArmedLine, CompletedLine, FailedLine } from './feed.tsx'
import { SeedRollerPanel } from './panel.tsx'
import manifest from './plugin.ts'
import type { EventPayloads } from './server.ts'
import * as S from './state.client.ts'

export default definePluginClient(manifest, (ctx) => {
	S.init(ctx)

	// above the queue rather than the dashboard alerts: what it says is about what plays next, so it belongs
	// beside the host's own next-layer warnings.
	//
	// the component comes from a module that exports components and nothing else, so editing it in dev
	// swaps it in place. Registering one defined here instead costs a page reload on every edit.
	Slots.register(ctx, 'server-dashboard:queue-alerts', SeedRollerPanel)

	// seed-roll-cancelled has no renderer: its recorded message already says all there is to say, which is
	// what the host falls back to.
	Events.register(ctx, 'seed-roll-armed', (e) => ({
		icon: 'info',
		content: <ArmedLine payload={e.payload as EventPayloads['seed-roll-armed']} />,
	}))
	Events.register(ctx, 'seed-roll-completed', (e) => ({
		icon: 'success',
		content: <CompletedLine payload={e.payload as EventPayloads['seed-roll-completed']} />,
	}))
	Events.register(ctx, 'seed-roll-failed', (e) => ({
		icon: 'warning',
		content: <FailedLine payload={e.payload as EventPayloads['seed-roll-failed']} />,
	}))
})
