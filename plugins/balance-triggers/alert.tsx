import * as Zus from 'slm/lib/zustand'

import * as E from './events.client.ts'
import * as TR from './triggers.ts'

export function BalanceTriggerAlert(props: { serverId: string }) {
	const state = Zus.useStore(E.activeEvents(props.serverId), (s) => s)
	const current = state?.current
	// only what the match just played tripped: everything still active in the session would repeat the
	// same few lines once per match that raised them
	const events = (state?.events?.filter((e) => e.matchTriggeredId === state.lastPlayedMatchId) ?? []).toSorted(
		(a, b) => (E.LEVEL_ORDER[b.level] ?? 0) - (E.LEVEL_ORDER[a.level] ?? 0),
	)
	if (events.length === 0 || !current) return null
	return (
		<div className="flex flex-row flex-wrap items-start gap-1 p-2">
			{events.map((event) => (
				<div key={event.id} className={`max-w-full rounded border p-2 text-sm ${E.TINT_CLASSES[event.level] ?? ''}`}>
					<p className="font-medium">{TR.TRIGGERS.find((t) => t.id === event.triggerId)?.name ?? event.triggerId}</p>
					<p>{E.describe(event, current.layerId, current.ordinal)}</p>
				</div>
			))}
		</div>
	)
}
