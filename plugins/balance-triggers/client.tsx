import * as Zus from 'slm/lib/zustand'
import { definePluginClient } from 'slm/plugin/client'
import * as Decorations from 'slm/plugin/decorations'
import * as Rpc from 'slm/plugin/rpc.client'
import * as Slots from 'slm/plugin/slots'

import manifest from './plugin.ts'
import type * as S from './schema.ts'

export default definePluginClient(manifest, (ctx) => {
	// a keyed family (deep-equal inputs share an instance): one store per server, shared by the
	// alert slot and every decorated row, backed by the server's activeEvents stream
	const activeEvents = Rpc.queryStore<[serverId: string], S.TriggerEvent[]>(ctx, 'activeEvents', (serverId) => ({
		serverId,
		input: {},
	}))

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
