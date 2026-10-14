import * as dateFns from 'date-fns'
import * as React from 'react'
import { flushSync } from 'react-dom'

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
		const now = new Date()
		const msIntoDay = now.getTime() - dateFns.startOfDay(now).getTime()
		return RPC.orpc.tutorials.start.call({ scenarioId, msIntoDay })
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

// useState that can also be set from outside the React tree, for state that is genuinely component-local but which
// the tutorial engine must be able to drive (a dialog's open flag, a tab choice). The component stays the owner;
// the handle is an actuation channel only -- observation goes through the DOM or a store, never through this.

const handles = new Map<string, Set<React.Dispatch<React.SetStateAction<any>>>>()

// `scope` distinguishes instances of the same hook mounted more than once (one dialog per queue item).
export function handleId(id: string, scope?: string | number): string {
	return scope === undefined ? id : `${id}:${scope}`
}

export function useState_withGlobalHandle<T>(id: string, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
	const [state, setState] = React.useState(initial)
	// layout effect, not effect: registration must be committed synchronously, so that code which mounts the owner
	// under flushSync can set the handle on its very next line
	React.useLayoutEffect(() => {
		let set = handles.get(id)
		if (!set) {
			set = new Set()
			handles.set(id, set)
		}
		set.add(setState)
		return () => {
			set.delete(setState)
			if (set.size === 0) handles.delete(id)
		}
	}, [id])
	return [state, setState]
}

// Set every mounted instance of the handle. Wrapped in flushSync so the render (and anything reading the DOM after
// this call) sees the new state synchronously; returns false when nothing is mounted, so a caller can fail loudly
// rather than no-op.
export function setGlobalHandle<T>(id: string, value: React.SetStateAction<T>): boolean {
	const set = handles.get(id)
	if (!set || set.size === 0) return false
	flushSync(() => {
		for (const dispatch of set) dispatch(value)
	})
	return true
}
