import * as React from 'react'

import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as DH from '@/lib/display-helpers'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import type * as Msgs from '@/models/messages.models'
import type * as TUT from '@/models/tutorial.models'
import { rootRouter } from '@/root-router'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as TutorialsClient from '@/systems/tutorials.client'
import * as VoteClient from '@/systems/vote.client'

// The tour engine: a global state machine that narrates the live dashboard during a tutorial run. Steps are data
// (src/systems/tutorials/<id>.steps.ts); this file drives them. The overlay (tour-overlay.tsx) renders Store and
// calls Actions. Design source: the rev-3 mock, section 4.

// route id as it appears in router.state.matches; DASHBOARD_TO is the same route as a navigation target (the _app
// layout is pathless, so the URL drops it)
const DASHBOARD_ROUTE_ID = '/_app/servers/$serverId'
const DASHBOARD_TO = '/servers/$serverId'
// premise loss must persist across a few frames before it regresses: Radix dismiss-and-reopen churn can unmount an
// anchor for a frame during a legitimate transition, and regressing on that would make the tour twitchy
const PREMISE_LOSS_GRACE_MS = 150

// ============================== run data sources ==============================

// The run's data sources a step selector reads from: the squad-server frame (for queue/edit state) plus the
// per-server client observables. All are Zus.AnyInput, so a StateSelector picks whichever it needs.
export type RunStores = {
	serverId: string
	squadServer: SquadServerFrame.Key
	nextLayerSync: ReturnType<typeof LayerQueueClient.nextLayerSyncState$>
	currentMatch: ReturnType<typeof MatchHistoryClient.currentMatch$>
	voteState: ReturnType<typeof VoteClient.voteState$>
}

// Acquire the frame ONCE per run and hold it for the run's lifetime. dropKey is a full teardown when the caller is
// the last holder (it aborts the frame and runs every partial's cleanup), so the tour never drops-and-reacquires on
// pause: off the dashboard the route has already released its ref, and a drop there would destroy the ODSM/edit
// state the premise selectors read. See project_tutorials_feature_plan memory.
function acquireRun(serverId: string): RunStores {
	const squadServer = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverId))
	return {
		serverId,
		squadServer,
		nextLayerSync: LayerQueueClient.nextLayerSyncState$(serverId),
		currentMatch: MatchHistoryClient.currentMatch$(serverId),
		voteState: VoteClient.voteState$(serverId),
	}
}

function releaseRun(run: RunStores) {
	frameManager.dropKey(run.squadServer)
}

// ============================== step model ==============================

type TextMsg = Msgs.Variants.Textable

// the custom tags a step body may use: team names (t1/t2 raw slots, ta/tb normalized) and the monospace (1)/(2)
// slot marks color their chunks with the real team colors; br is a line break for bodies with a display line
export type TourTag = 't1' | 't2' | 'ta' | 'tb' | 'm1' | 'm2' | 'br'
const teamName =
	(color: string): Msgs.TagRenderer =>
	(chunks) =>
		React.createElement('span', { style: { color } }, ...chunks)
const teamMark =
	(color: string): Msgs.TagRenderer =>
	(chunks) =>
		React.createElement('span', { className: 'font-mono', style: { color } }, ...chunks)
const tourTr = tr.withTags({
	t1: teamName(DH.TEAM_COLORS.team1),
	t2: teamName(DH.TEAM_COLORS.team2),
	ta: teamName(DH.TEAM_COLORS.teamA),
	tb: teamName(DH.TEAM_COLORS.teamB),
	m1: teamMark(DH.TEAM_COLORS.team1),
	m2: teamMark(DH.TEAM_COLORS.team2),
	br: () => React.createElement('br'),
})

// a step's card copy: a title and a body. Bundled defs from TUT_Msgs are exactly this shape; a body may be rich
// (def(() => ({ richText: rt(...) }))) using the tour tags above.
export type StepMsg = { title: () => TextMsg; body: () => TextMsg | Msgs.Variants.TRichTextable<TourTag> }
// what the overlay renders: a resolved title and a body node.
export type RenderedStep = { title: string; body: React.ReactNode }

// one shape for everything a step derives from live state: advancement, premises, dynamic copy. inputs picks the
// Zus.AnyInputs, select reads their states.
export type StateSelector<T> = {
	inputs: (run: RunStores) => Zus.AnyInput<any>[]
	select: (...states: any[]) => T
}

// what a step waits on to advance. Covered with assertNever in the engine.
export type Advance =
	| { type: 'next' } // explicit Next button on the card
	| { type: 'anchor' } // user activates the anchored element
	| ({ type: 'state' } & StateSelector<boolean>) // advances the first time select turns true
	// advances when a sampled value differs from its value at step entry. For operations whose completion is a
	// change rather than a predicate: a layer added (the list grew) or reordered (the order changed), where "done"
	// only means "different from where you started". sample is captured on entry; advanced compares it to each later
	// sample.
	| {
			type: 'change'
			inputs: (run: RunStores) => Zus.AnyInput<any>[]
			sample: (...states: any[]) => unknown
			advanced: (baseline: any, current: any) => boolean
	  }

// what an anchor points at: one data-tour element, or `{ all }` for every laid-out element carrying the id, whose
// zone is the minimum rect containing them (a run of queue rows). A plain string resolves to the first laid-out
// match, so an id shared by several elements still works as a single anchor.
export type AnchorTarget = string | { all: string }
// static target, or a dynamic one (null = not present yet, the overlay waits)
export type AnchorRef = AnchorTarget | ((run: RunStores) => AnchorTarget | null)

export type Step = {
	id: string
	msg: StepMsg | StateSelector<RenderedStep>
	anchor?: AnchorRef // the outlined element (spotlight ring). absent = centered card
	// the region left undimmed, if larger than the outlined element: the whole queue while reordering, the whole item
	// while pointing at one of its buttons. Defaults to anchor. The ring stays on anchor; only the dim cutout and the
	// card placement widen to this.
	spotlight?: AnchorRef
	stage?: string // server stage requested on entry, before narration
	interact?: 'block' | 'anchor-only' | 'free' // absent = 'block'
	// whether this step still makes sense. Absent = the default premise (route matches, anchor resolves). Explicit
	// premises go on journey steps whose subject can be dismissed (an open dialog, an edit session, a running vote).
	premise?: StateSelector<boolean>
	advance: Advance
}

// identity helper; a place to later pin S to the server scenario's stage names (mock Q5). Loose for now.
export function defineSteps(steps: Step[]): Step[] {
	return steps
}

// ============================== selector plumbing ==============================

function isObservable(input: unknown): input is Rx.Observable<unknown> {
	// A Zus/Zustand store also has a .subscribe, but its Zustand-native signature is not one rxjs can consume as a
	// source. Route stores (anything exposing getState) through Zus.toObservable instead; only real observables and
	// BehaviorSubjects, which have no getState, are returned as-is.
	const o = input as { subscribe?: unknown; getState?: unknown }
	return !!input && typeof o.subscribe === 'function' && typeof o.getState !== 'function'
}

function toObs(input: Zus.AnyInput<any>): Rx.Observable<unknown> {
	if (isObservable(input)) return input
	return Zus.toObservable(input as any, true).pipe(Rx.map(([s]) => s))
}

// reactive evaluation of a selector against the run
function watchSelector<T>(run: RunStores, sel: StateSelector<T>): Rx.Observable<T> {
	const inputs = sel.inputs(run)
	if (inputs.length === 0) return Rx.of(sel.select())
	return Rx.combineLatest(inputs.map(toObs)).pipe(
		Rx.map((states) => sel.select(...states)),
		Rx.distinctUntilChanged(),
	)
}

function readInput(input: Zus.AnyInput<any>): unknown {
	if (input && typeof (input as { getValue?: unknown }).getValue === 'function') return (input as { getValue: () => unknown }).getValue()
	return Zus.getState(input as any)
}

function readSelector<T>(run: RunStores, sel: StateSelector<T>): T {
	return sel.select(...sel.inputs(run).map(readInput))
}

// render a message through the tour's tag set, for StateSelector msgs that build their RenderedStep by hand
export function richText(msg: TextMsg | Msgs.Variants.TRichTextable<TourTag>): React.ReactNode {
	return tourTr.richText(msg)
}

// Resolve a step's copy against current state. The overlay re-renders on the sources it subscribes to.
export function renderMsg(run: RunStores, msg: Step['msg']): RenderedStep {
	if ('inputs' in msg) return readSelector(run, msg)
	return { title: tr.text(msg.title()), body: tourTr.richText(msg.body()) }
}

// reactive copy, for branching messages that track live state
export function renderMsg$(run: RunStores, msg: Step['msg']): Rx.Observable<RenderedStep> {
	if ('inputs' in msg) return watchSelector(run, msg)
	return Rx.of(renderMsg(run, msg))
}

export function resolveAnchor(run: RunStores, anchor: AnchorRef | undefined): AnchorTarget | null {
	if (anchor === undefined) return null
	return typeof anchor === 'function' ? anchor(run) : anchor
}

// ============================== DOM inputs (tier-2 presentational state) ==============================

// A Zus input for a data-tour id's elements, driven by one shared MutationObserver. Steps read presentational
// state the house does not push into a store (data-state="open", aria-expanded) off the DOM, the same contract the
// e2e suite and screen readers use. Consumed through StateSelector like any other input.
//
// Emits every matching element in document order; the consumer picks. The same anchor can be mounted more than
// once, laid-out and not: an inactive selectLayers dialog keeps a hidden, zero-size copy of the pool controls, and
// a `{ all }` anchor deliberately tags a run of elements. The overlay filters to laid-out nodes at measure time.
const domInputs = new Map<string, Rx.BehaviorSubject<Element[]>>()
let domObserver: MutationObserver | null = null

function queryAnchors(tourId: string): Element[] {
	if (typeof document === 'undefined') return []
	return [...document.querySelectorAll(`[data-tour="${CSS.escape(tourId)}"]`)]
}

function sameElements(a: Element[], b: Element[]): boolean {
	return a.length === b.length && a.every((el, i) => el === b[i])
}

function ensureDomObserver() {
	if (domObserver || typeof document === 'undefined') return
	domObserver = new MutationObserver(() => {
		for (const [id, subj] of domInputs) {
			const els = queryAnchors(id)
			if (!sameElements(els, subj.getValue())) subj.next(els)
		}
	})
	domObserver.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['data-tour', 'data-state', 'aria-expanded', 'aria-selected'],
	})
}

export function domInput(tourId: string): Rx.BehaviorSubject<Element[]> {
	let subj = domInputs.get(tourId)
	if (!subj) {
		subj = new Rx.BehaviorSubject<Element[]>(queryAnchors(tourId))
		domInputs.set(tourId, subj)
		ensureDomObserver()
	}
	return subj
}

// ============================== store ==============================

export type TourState =
	| { code: 'idle' }
	| { code: 'staging'; scenarioId: TUT.ScenarioId; stepIdx: number }
	| { code: 'narrating'; scenarioId: TUT.ScenarioId; stepIdx: number }
	| { code: 'stage-not-ready'; scenarioId: TUT.ScenarioId; stepIdx: number; msg: string }
	| { code: 'stage-failed'; scenarioId: TUT.ScenarioId; stepIdx: number }
	// off the dashboard: overlay collapses to a docked card. stepIdx is where narration resumes.
	| { code: 'paused'; scenarioId: TUT.ScenarioId; stepIdx: number }

export type TourStore = { state: TourState }

export const Store = Zus.createStore<TourStore>()(() => ({ state: { code: 'idle' } }))

export namespace Sel {
	export function state(s: TourStore) {
		return s.state
	}
	// the active step, or undefined when idle
	export function stepIdx(s: TourStore): number | undefined {
		return s.state.code === 'idle' ? undefined : s.state.stepIdx
	}
}

// ============================== engine ==============================

type Active = { scenarioId: TUT.ScenarioId; steps: Step[]; run: RunStores }
let active: Active | null = null
let stepSub = new Rx.Subscription() // advance + premise watchers for the current step
let runSub = new Rx.Subscription() // router pause watcher, lives for the run

// the scenario registry: each scenario's steps, keyed by id. Registered by the steps files at import.
const scenarios = new Map<TUT.ScenarioId, Step[]>()
export function registerScenario(scenarioId: TUT.ScenarioId, steps: Step[]) {
	scenarios.set(scenarioId, steps)
}

// accessors for the overlay: the run's data sources and the step being narrated. Not reactive themselves; the
// overlay re-reads them whenever Store changes.
export function activeRun(): RunStores | null {
	return active?.run ?? null
}
export function stepAt(scenarioId: TUT.ScenarioId, stepIdx: number): Step | undefined {
	return scenarios.get(scenarioId)?.[stepIdx]
}
export function stepCount(scenarioId: TUT.ScenarioId): number {
	return scenarios.get(scenarioId)?.length ?? 0
}

function isOnDashboard(serverId: string): boolean {
	return rootRouter.state.matches.some(
		(m) => m.routeId === DASHBOARD_ROUTE_ID && (m.params as { serverId?: string }).serverId === serverId,
	)
}

function set(state: TourState) {
	Store.setState({ state })
}

function clearStepWatchers() {
	stepSub.unsubscribe()
	stepSub = new Rx.Subscription()
}

// Enter a step: request its stage, then narrate and wire the advance + premise watchers. Idempotent, so pause/
// resume and premise regression both re-enter safely.
async function enterStep(idx: number) {
	if (!active) return
	const { scenarioId, steps, run } = active
	const step = steps[idx]
	if (!step) return doComplete()
	clearStepWatchers()

	if (!isOnDashboard(run.serverId)) {
		set({ code: 'paused', scenarioId, stepIdx: idx })
		return
	}

	if (step.stage) {
		set({ code: 'staging', scenarioId, stepIdx: idx })
		const res = await TutorialsClient.Actions.stage(scenarioId, step.stage)
		// a later transition (pause, exit, regression) raced ahead of this stage: drop the stale result. Checking the
		// full state, not just stepIdx, is what stops a stage that resolved after a pause from clobbering 'paused'.
		const cur = Store.getState().state
		if (active?.scenarioId !== scenarioId || cur.code !== 'staging' || cur.stepIdx !== idx) return
		if (res.code === 'err:not-ready') return set({ code: 'stage-not-ready', scenarioId, stepIdx: idx, msg: res.msg })
		if (res.code !== 'ok') return set({ code: 'stage-failed', scenarioId, stepIdx: idx })
	}

	set({ code: 'narrating', scenarioId, stepIdx: idx })
	wireStep(step, idx)
}

function wireStep(step: Step, idx: number) {
	if (!active) return
	const { run } = active

	if (step.advance.type === 'state') {
		stepSub.add(
			watchSelector(run, step.advance)
				.pipe(Rx.filter(Boolean))
				.subscribe(() => {
					if (Sel.stepIdx(Store.getState()) === idx) doNext()
				}),
		)
	}

	if (step.advance.type === 'change') {
		const adv = step.advance
		const inputs = adv.inputs(run)
		const baseline = adv.sample(...inputs.map(readInput))
		const sample$ = inputs.length === 0 ? Rx.of([]) : Rx.combineLatest(inputs.map(toObs))
		stepSub.add(
			sample$.pipe(Rx.map((states) => adv.sample(...states))).subscribe((cur) => {
				if (adv.advanced(baseline, cur) && Sel.stepIdx(Store.getState()) === idx) doNext()
			}),
		)
	}

	if (step.premise) {
		stepSub.add(
			watchSelector(run, step.premise)
				.pipe(
					// only a loss that persists past the grace window regresses
					Rx.switchMap((holds) => (holds ? Rx.of(true) : Rx.of(false).pipe(Rx.delay(PREMISE_LOSS_GRACE_MS)))),
					Rx.filter((holds) => !holds),
				)
				.subscribe(() => {
					if (Sel.stepIdx(Store.getState()) === idx) regressFrom(idx)
				}),
		)
	}
}

// Walk backward to the nearest step whose premise holds and re-enter it. Step 0 has no premise, so the walk
// terminates.
function regressFrom(idx: number) {
	if (!active) return
	const { steps, run } = active
	for (let j = idx - 1; j >= 0; j--) {
		const premise = steps[j].premise
		if (!premise || readSelector(run, premise)) {
			void enterStep(j)
			return
		}
	}
	void enterStep(0)
}

function reconcilePause() {
	const s = Store.getState().state
	if (!active || s.code === 'idle') return
	const onDash = isOnDashboard(active.run.serverId)
	if (!onDash && s.code !== 'paused') {
		clearStepWatchers()
		set({ code: 'paused', scenarioId: active.scenarioId, stepIdx: s.stepIdx })
	} else if (onDash && s.code === 'paused') {
		void enterStep(s.stepIdx)
	}
}

async function doStart(scenarioId: TUT.ScenarioId) {
	if (active) await doExit()
	const steps = scenarios.get(scenarioId)
	if (!steps) throw new Error(`no steps registered for tutorial ${scenarioId}`)
	const res = await TutorialsClient.Actions.start(scenarioId)
	if (res.code !== 'ok') return res
	active = { scenarioId, steps, run: acquireRun(res.serverId) }
	runSub = new Rx.Subscription()
	runSub.add(rootRouter.subscribe('onResolved', reconcilePause))
	await rootRouter.navigate({ to: DASHBOARD_TO, params: { serverId: res.serverId } })
	await enterStep(0)
	return res
}

function doNext() {
	const s = Store.getState().state
	if (s.code !== 'narrating') return
	void enterStep(s.stepIdx + 1)
}

// re-request the current step's stage: the recovery path behind the Restart/Retry button
function doRestart() {
	const idx = Sel.stepIdx(Store.getState())
	if (idx !== undefined) void enterStep(idx)
}

async function doExit() {
	const wasActive = active
	teardown()
	if (wasActive) await TutorialsClient.Actions.abandon()
}

// Complete keeps the sandbox alive (the idle reaper collects it); only the tour tears down.
function doComplete() {
	if (active) ClientOnlySettings.Actions.markTutorialComplete(active.scenarioId)
	teardown()
}

export namespace Actions {
	export const start = doStart
	export const next = doNext
	export const restartStep = doRestart
	export const exit = doExit
	export const complete = doComplete
}

function teardown() {
	clearStepWatchers()
	runSub.unsubscribe()
	runSub = new Rx.Subscription()
	if (active) releaseRun(active.run)
	active = null
	set({ code: 'idle' })
}
