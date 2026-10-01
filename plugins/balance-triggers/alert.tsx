import { Icons } from 'slm/components/icons'
import { Alert, AlertDescription, AlertTitle } from 'slm/components/ui'
import * as Zus from 'slm/lib/zustand'

import * as E from './events.client.ts'
import * as TR from './triggers.ts'

// the variant and icon the host gives a decoration of the same level, so the alert and the row it
// describes read as one
const LEVEL_DISPLAY = {
	violation: { variant: 'destructive', icon: Icons.AlertOctagon },
	warn: { variant: 'warning', icon: Icons.AlertTriangle },
	info: { variant: 'info', icon: Icons.Info },
} as const

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
		<div className="flex flex-col gap-1">
			{events.map((event) => {
				const display = LEVEL_DISPLAY[event.level as keyof typeof LEVEL_DISPLAY] ?? LEVEL_DISPLAY.info
				return (
					<Alert key={event.id} variant={display.variant}>
						<display.icon />
						<AlertTitle>{TR.TRIGGERS.find((t) => t.id === event.triggerId)?.name ?? event.triggerId}</AlertTitle>
						<AlertDescription>{E.describe(event, current.layerId, current.ordinal)}</AlertDescription>
					</Alert>
				)
			})}
		</div>
	)
}
