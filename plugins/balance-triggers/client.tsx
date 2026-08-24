import * as Zus from 'slm/lib/zustand'
import * as L from 'slm/models/layer'
import * as MH from 'slm/models/match-history'
import { definePluginClient } from 'slm/plugin/client'
import * as Decorations from 'slm/plugin/decorations'
import * as Rpc from 'slm/plugin/rpc.client'
import * as Slots from 'slm/plugin/slots'

import manifest from './plugin.ts'
import type * as S from './schema.ts'
// type-only, so none of the server bundle reaches the browser: it is where the rpc types come from
import type { router } from './server.ts'
import * as TR from './triggers.ts'

export default definePluginClient(manifest, (ctx) => {
	// inferred from the server's router, so nothing here is annotated. A keyed family: deep-equal
	// arguments share an instance, so the alert slot and every decorated row read one stream per server.
	const streams = Rpc.stores<typeof router>(ctx)
	const activeEvents = (serverId: string) => streams.activeEvents(serverId, {})

	// most severe first, as the match history tooltip orders them
	const LEVEL_ORDER: Record<string, number> = { violation: 3, warn: 2, info: 1 }

	const TINT_CLASSES: Record<string, string> = {
		info: 'border-blue-500/50 text-blue-500',
		warn: 'border-yellow-500/50 text-yellow-600',
		violation: 'border-red-500/50 text-red-500',
	}

	// the same sentence the reminder uses, with the side named for the match it is shown against
	function describe(event: S.TriggerEvent, layerId: string, ordinal: number) {
		const faction = L.toLayer(layerId)[MH.getTeamNormalizedFactionProp(ordinal, event.strongerTeam as MH.NormedTeamProp)]
		const team = MH.toNormedTeamId(event.strongerTeam as MH.NormedTeamProp)
		return event.message.replace('{{strongerTeam}}', faction ? `Team ${team}(${faction})` : `Team ${team}`)
	}

	Slots.register(ctx, 'server-dashboard:alerts', function BalanceTriggerAlert(props) {
		const state = Zus.useStore(activeEvents(props.serverId), (s) => s)
		const current = state?.current
		// only what the match just played tripped: everything still active in the session would repeat
		// the same few lines once per match that raised them
		const events = (state?.events?.filter((e) => e.matchTriggeredId === state.lastPlayedMatchId) ?? []).toSorted(
			(a, b) => (LEVEL_ORDER[b.level] ?? 0) - (LEVEL_ORDER[a.level] ?? 0),
		)
		if (events.length === 0 || !current) return null
		return (
			<div className="flex flex-col gap-1 p-2">
				{events.map((event) => (
					<div key={event.id} className={`rounded border p-2 text-sm ${TINT_CLASSES[event.level] ?? ''}`}>
						<p className="font-medium">{TR.TRIGGERS.find((t) => t.id === event.triggerId)?.name ?? event.triggerId}</p>
						<p>{describe(event, current.layerId, current.ordinal)}</p>
					</div>
				))}
			</div>
		)
	})

	// decorations contribute data, not markup: the host renders the alert and owns its styling
	Decorations.register(ctx, 'match-history:row', {
		stores: (props) => [activeEvents(props.serverId)],
		// one per event, as the native alert stack did: a match can trip more than one trigger
		select: (state: { events: S.TriggerEvent[] } | undefined, props) =>
			(state?.events ?? [])
				.filter((e) => e.matchTriggeredId === props.matchId)
				.map((event) => ({
					tint: event.level,
					title: TR.TRIGGERS.find((t) => t.id === event.triggerId)?.name ?? event.triggerId,
					body: describe(event, props.layerId, props.ordinal),
				})),
	})
})
