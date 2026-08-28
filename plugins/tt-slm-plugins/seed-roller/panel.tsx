import React from 'react'

import * as Zus from 'slm/lib/zustand'

import * as S from './state.client.ts'

// Renders nothing unless the server is on a training layer: that is the only situation this plugin acts in,
// and an idle line on every other map is noise in a panel the host and every other plugin share.

export function SeedRollerPanel(props: { serverId: string }) {
	const status = Zus.useStore(S.status(props.serverId), (s) => s)
	if (!status || !status.onTrainingLayer) return null

	const phase = status.phase
	return (
		<div className="mx-4 my-2 rounded border p-2 text-sm">
			<p className="font-medium">Seed roller</p>
			{status.notReady ? (
				<p className="text-yellow-600">{status.notReady}</p>
			) : phase.kind === 'armed' ? (
				<Armed
					serverId={props.serverId}
					deadline={phase.deadline}
					seedLayerId={phase.seedLayerId}
					followUpLayerId={phase.followUpLayerId}
				/>
			) : phase.kind === 'rolling' ? (
				<p>Rolling to {phase.seedLayerId}…</p>
			) : phase.kind === 'done' ? (
				<p>Rolled to {phase.seedLayerId}.</p>
			) : phase.kind === 'cancelled' ? (
				<p className="text-muted-foreground">Cancelled. Will not arm again until the next match.</p>
			) : phase.kind === 'retrying' ? (
				<Retrying at={phase.at} nextAttempt={phase.nextAttempt} reason={phase.reason} />
			) : (
				<Idle status={status} />
			)}
		</div>
	)
}

// A relative time has to be recomputed to stay true, so anything rendering one ticks. Once a second is
// enough for both the countdown and the retry line.
function useNow(active: boolean) {
	const [now, setNow] = React.useState(() => Date.now())
	React.useEffect(() => {
		if (!active) return
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [active])
	return now
}

function Idle(props: { status: S.Status }) {
	const { census, criteria, nextIsSeedLayer, seedPool } = props.status
	return (
		<div className="space-y-0.5">
			{census && (
				<p>
					{census.population} players, {census.activePopulation} active, {census.afkPopulation} afk
				</p>
			)}
			{criteria?.code === 'err:eval' && <p className="text-red-500">Criteria failed to evaluate: {criteria.message}</p>}
			{criteria?.code === 'ok' && <p className="text-muted-foreground">{criteria.passed ? 'Criteria met.' : 'Waiting on criteria.'}</p>}
			{!nextIsSeedLayer && (
				<p className="text-muted-foreground">Next layer is not a seeding layer; one will be drawn from {seedPool}.</p>
			)}
		</div>
	)
}

// Says when it failed and when it will try again. A bare sentence with no timing reads as a standing fact
// about the server rather than the outcome of one attempt.
function Retrying(props: { at: number; nextAttempt: number; reason: string }) {
	const now = useNow(true)
	const ago = S.approxDuration(now - props.at)
	const until = props.nextAttempt - now
	return (
		<div className="space-y-0.5">
			<p className="text-yellow-600">{props.reason}</p>
			<p className="text-muted-foreground">
				Failed {ago} ago. {until > 0 ? `Retrying in ${S.approxDuration(until)}.` : 'Retrying.'}
			</p>
		</div>
	)
}

function Armed(props: { serverId: string; deadline: number; seedLayerId: string; followUpLayerId: string }) {
	// the server hands over a deadline rather than a remaining time, so the countdown is arithmetic here and
	// costs nothing to render
	const now = useNow(true)
	return (
		<div className="space-y-1">
			<p>
				Rolling to <span className="font-medium">{props.seedLayerId}</span> in{' '}
				<span className="font-mono">{S.countdown(props.deadline, now)}</span>
			</p>
			<p className="text-muted-foreground">Then {props.followUpLayerId}.</p>
			<button type="button" className="rounded border px-2 py-1" onClick={() => void S.cancel(props.serverId)}>
				Cancel
			</button>
		</div>
	)
}
