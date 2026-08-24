import { definePluginClient } from 'slm/plugin/client'
import * as Decorations from 'slm/plugin/decorations'
import * as Slots from 'slm/plugin/slots'

import { BalanceTriggerAlert } from './alert.tsx'
import * as E from './events.client.ts'
import manifest from './plugin.ts'
import type * as S from './schema.ts'
import * as TR from './triggers.ts'

export default definePluginClient(manifest, (ctx) => {
	E.init(ctx)

	// the component comes from a module that exports components and nothing else, so editing it in dev
	// swaps it in place. Registering one defined here instead costs a page reload on every edit.
	Slots.register(ctx, 'server-dashboard:alerts', BalanceTriggerAlert)

	// decorations contribute data, not markup: the host renders the alert and owns its styling
	Decorations.register(ctx, 'match-history:row', {
		stores: (props) => [E.activeEvents(props.serverId)],
		// one per event, as the native alert stack did: a match can trip more than one trigger
		select: (state: { events: S.TriggerEvent[] } | undefined, props) =>
			(state?.events ?? [])
				.filter((e) => e.matchTriggeredId === props.matchId)
				.map((event) => ({
					tint: event.level,
					title: TR.TRIGGERS.find((t) => t.id === event.triggerId)?.name ?? event.triggerId,
					body: E.describe(event, props.layerId, props.ordinal),
				})),
	})
})
