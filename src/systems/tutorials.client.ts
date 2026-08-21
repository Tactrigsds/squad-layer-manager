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

// the run state outside a component, for the engine deciding whether it has a server to reuse. Bound with a
// default, so this answers 'none' rather than throwing before the stream has connected.
export function runState(): TUT.RunState {
	return runState$().getValue()
}

export const scenariosQueryOptions = RPC.orpc.tutorials.list.queryOptions()

// The caller's place in each tutorial. Per user rather than per browser, so it survives a reload, a new tab and a
// different machine. Invalidated by Actions.saveProgress, which is the only thing that writes it.
export const progressQueryOptions = RPC.orpc.tutorials.getProgress.queryOptions()

// Pages the caller has told to stop offering tutorials. Per user like progress, so dismissing on one machine
// holds on the next. Invalidated by Actions.dismissPrompt, which is the only thing that writes it.
export const dismissedPromptsQueryOptions = RPC.orpc.tutorials.getDismissedPrompts.queryOptions()

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
	export async function dismissPrompt(surfaceId: TUT.SurfaceId) {
		await RPC.orpc.tutorials.dismissPrompt.call({ surfaceId })
		await RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.tutorials.getDismissedPrompts.key() })
	}
	export async function saveProgress(progress: TUT.Progress) {
		await RPC.orpc.tutorials.saveProgress.call(progress)
		await RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.tutorials.getProgress.key() })
	}
}
