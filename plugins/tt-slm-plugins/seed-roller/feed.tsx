import * as L from 'slm/models/layer'

import type { EventPayloads } from './server.ts'

// The plugin's lines in the server activity feed. Each is the predicate only: the host renders the time, the
// icon and "Seed Roller" in front of it.

// the game's own layer string, which is what an admin reading the feed will recognise. A raw layer id
// (BC-SD-V1:ADF-CA:CAF-CA) is SLM's internal spelling.
function Layer({ layerId }: { layerId: string }) {
	const parsed = L.parseLayerId(layerId)
	return <span className="font-medium">{parsed.code === 'ok' ? L.getLayerString(parsed.layer) : layerId}</span>
}

export function ArmedLine({ payload }: { payload: EventPayloads['seed-roll-armed'] }) {
	return (
		<>
			is rolling to <Layer layerId={payload.seedLayerId} />, then <Layer layerId={payload.followUpLayerId} /> ({payload.population}{' '}
			players, {payload.activePopulation} active)
		</>
	)
}

export function CompletedLine({ payload }: { payload: EventPayloads['seed-roll-completed'] }) {
	return (
		<>
			rolled to <Layer layerId={payload.seedLayerId} />
		</>
	)
}

export function FailedLine({ payload }: { payload: EventPayloads['seed-roll-failed'] }) {
	return (
		<>
			could not roll to seed. {payload.reason} Retrying in {payload.retryIn} (attempt {payload.attempts}).
		</>
	)
}
