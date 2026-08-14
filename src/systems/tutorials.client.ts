import * as ReactRx from '@/lib/react-rxjs'
import type * as TUT from '@/models/tutorial.models'
import * as RPC from '@/orpc.client'

// Client view of the caller's tutorial run, and thin wrappers over the tutorials oRPC surface. The tour engine
// (src/systems/tour.client.ts) drives these; the index page reads the catalogue. Mirrors vote.client.ts.

// watchRun is per-user and legitimately quiet when no run is active, so it binds with a default rather than
// suspending. The server emits the current state immediately on subscribe, so the default is only the pre-connect
// value.
export const [useRunState, runState$] = ReactRx.bindWithDefault(
	() => RPC.observe('tutorials.watchRun', () => RPC.orpc.tutorials.watchRun.call()),
	{ code: 'none' } as TUT.RunState,
)

export const scenariosQueryOptions = RPC.orpc.tutorials.list.queryOptions()

export namespace Actions {
	export function start(scenarioId: TUT.ScenarioId) {
		return RPC.orpc.tutorials.start.call({ scenarioId })
	}
	export function stage(scenarioId: TUT.ScenarioId, stageId: string) {
		return RPC.orpc.tutorials.stage.call({ scenarioId, stageId })
	}
	export function abandon() {
		return RPC.orpc.tutorials.abandon.call()
	}
}
