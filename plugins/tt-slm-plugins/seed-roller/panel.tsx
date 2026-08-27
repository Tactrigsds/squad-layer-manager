import React from 'react'

import * as Zus from 'slm/lib/zustand'

import * as S from './state.client.ts'

// Renders nothing unless the server is on a training layer: that is the only situation this plugin acts in,
// and an idle line on every other map is noise in a panel shared with every other plugin's alerts.

export function SeedRollerPanel(props: { serverId: string }) {
	const status = Zus.useStore(S.status(props.serverId), (s) => s)
	if (!status || !status.onTrainingLayer) return null

	const phase = status.phase
	return (
		<div className="m-2 rounded border p-2 text-sm">
			<p className="font-medium">Seed roller</p>
			{phase.kind === 'armed' ? (
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
			) : phase.kind === 'blocked' ? (
				<p className="text-yellow-600">{phase.reason}</p>
			) : (
				<Idle status={status} />
			)}
		</div>
	)
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
			{criteria?.code === 'err:compile' && <p className="text-red-500">Criteria will not compile: {criteria.message}</p>}
			{criteria?.code === 'err:eval' && <p className="text-red-500">Criteria failed to evaluate: {criteria.message}</p>}
			{criteria?.code === 'ok' && <p className="text-muted-foreground">{criteria.passed ? 'Criteria met.' : 'Waiting on criteria.'}</p>}
			{!nextIsSeedLayer && (
				<p className="text-muted-foreground">
					Next layer is not a seeding layer; one will be drawn from {seedPool || 'no configured pool'}.
				</p>
			)}
		</div>
	)
}

function Armed(props: { serverId: string; deadline: number; seedLayerId: string; followUpLayerId: string }) {
	// a local tick rather than a stream per second: the server hands over a deadline, so the countdown is
	// arithmetic and costs nothing to render
	const [now, setNow] = React.useState(() => Date.now())
	React.useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 500)
		return () => clearInterval(timer)
	}, [])

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
