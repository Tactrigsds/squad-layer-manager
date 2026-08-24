import * as Zus from 'slm/lib/zustand'
import { definePluginClient } from 'slm/plugin/client'
import * as Decorations from 'slm/plugin/decorations'
import * as Rpc from 'slm/plugin/rpc.client'
import * as Slots from 'slm/plugin/slots'

import manifest from './plugin.ts'
import type * as S from './schema.ts'
// type-only, so none of the server bundle reaches the browser: it is where the rpc types come from
import type { router } from './server.ts'

export default definePluginClient(manifest, (ctx) => {
	// inferred from the server's router, so nothing here is annotated. A keyed family: deep-equal
	// arguments share an instance, so the alert slot and every decorated row read one stream per server.
	const streams = Rpc.stores<typeof router>(ctx)
	const activeEvents = (serverId: string) => streams.activeEvents(serverId, {})

	const TINT_CLASSES: Record<string, string> = {
		info: 'border-blue-500/50 text-blue-500',
		warn: 'border-yellow-500/50 text-yellow-600',
		violation: 'border-red-500/50 text-red-500',
	}

	Slots.register(ctx, 'server-dashboard:alerts', function BalanceTriggerAlert(props) {
		const top = Zus.useStore(activeEvents(props.serverId), (events) => events?.[0])
		if (!top) return null
		return (
			<div className={`rounded border p-2 text-sm ${TINT_CLASSES[top.level] ?? ''}`}>
				Balance trigger active: {top.triggerId} favours {top.strongerTeam === 'teamA' ? 'Team A' : 'Team B'}
			</div>
		)
	})

	// decorations contribute data, not markup: the host maps tints onto its own row styling
	Decorations.register(ctx, 'match-history:row', {
		stores: (props) => [activeEvents(props.serverId)],
		select: (events: S.TriggerEvent[] | undefined, props) => {
			const event = events?.find((e) => e.matchTriggeredId === props.matchId)
			if (!event) return null
			return { tint: event.level, title: `balance trigger: ${event.triggerId}` }
		},
	})
})
