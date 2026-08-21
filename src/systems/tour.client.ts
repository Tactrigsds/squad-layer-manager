import * as Icons from 'lucide-react'
import * as React from 'react'

import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as DH from '@/lib/display-helpers'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import type * as CS from '@/models/context-shared'
import type * as Msgs from '@/models/messages.models'
import * as TUT from '@/models/tutorial.models'
import { rootRouter } from '@/root-router'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as TutorialsClient from '@/systems/tutorials.client'
import * as UPClient from '@/systems/user-presence.client'
import * as VoteClient from '@/systems/vote.client'

// The tour engine: a global state machine that narrates the live dashboard during a tutorial run. Steps are data
// (src/systems/tutorials/<id>.steps.ts); this file drives them. The overlay (tour-overlay.tsx) renders Store and
// calls Actions. Design source: the rev-3 mock, section 4.

// route id as it appears in router.state.matches; DASHBOARD_TO is the same route as a navigation target (the _app
// layout is pathless, so the URL drops it)
const DASHBOARD_ROUTE_ID = '/_app/servers/$serverId'
const DASHBOARD_TO = '/servers/$serverId'
// where a run started, and where the reader goes when it ends: the server they are looking at is about to stop
// existing, and the index is the one page that can still say something useful about the tutorial
const TUTORIALS_TO = '/tutorials'
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

// The custom tags a step body may use, on top of the standard strong/em/code. Three groups:
//   structure  p, ul, li, br -- the card body is a block, so multi-paragraph copy marks its own paragraphs
//   teams      team1/team2 (raw slots) and teamA/teamB (normalized), plus mark1/mark2 for the (1)/(2) marks,
//              all carrying the app's real team colours so the card matches what the queue renders
//   icons      the icon of the control the copy is describing, rendered inline at text size, so the reader
//              matches the sentence to the screen by shape. Written <grip></grip>: ICU has no self-closing tags.
//   links      the in-app filters page and the layer data docs, both opened in a new tab so the tour, which
//              pauses whenever the dashboard route is left, keeps running.
export type TourTag =
	| 'p'
	| 'ul'
	| 'li'
	| 'br'
	| 'team1'
	| 'team2'
	| 'teamA'
	| 'teamB'
	| 'mark1'
	| 'mark2'
	| 'grip'
	| 'remove'
	| 'swap'
	| 'pencil'
	| 'ellipsis'
	| 'trash'
	| 'dice'
	| 'gear'
	| 'sword'
	| 'repeat'
	| 'addFilter'
	| 'hideRepeats'
	| 'tutorialPoolIcon'
	| 'largeLayersIcon'
	| 'filtersPage'
	| 'scoresDocs'

const SCORES_DOCS_URL = 'https://github.com/Tactrigsds/squad-layer-manager/blob/main/docs/layer_data.md'

const teamName =
	(color: string): Msgs.TagRenderer =>
	(chunks) =>
		React.createElement('span', { className: 'font-semibold', style: { color } }, ...chunks)
const teamMark =
	(color: string): Msgs.TagRenderer =>
	(chunks) =>
		React.createElement('span', { className: 'font-mono', style: { color } }, ...chunks)
const block =
	(tag: string): Msgs.TagRenderer =>
	(chunks) =>
		React.createElement(tag, null, ...chunks)
// an icon tag carries no content; its chunks are the empty pair the ICU parser needs
const icon =
	(Component: React.ComponentType<{ className?: string }>, className?: string): Msgs.TagRenderer =>
	() =>
		React.createElement(Component, { className: `inline h-3.5 w-3.5 align-text-bottom ${className ?? ''}` })
const link =
	(href: string): Msgs.TagRenderer =>
	(chunks) =>
		React.createElement('a', { href, target: '_blank', rel: 'noopener noreferrer', className: 'underline' }, ...chunks)

const tourTr = tr.withTags({
	p: block('p'),
	ul: block('ul'),
	li: block('li'),
	br: () => React.createElement('br'),
	team1: teamName(DH.TEAM_COLORS.team1),
	team2: teamName(DH.TEAM_COLORS.team2),
	teamA: teamName(DH.TEAM_COLORS.teamA),
	teamB: teamName(DH.TEAM_COLORS.teamB),
	mark1: teamMark(DH.TEAM_COLORS.team1),
	mark2: teamMark(DH.TEAM_COLORS.team2),
	grip: icon(Icons.GripVertical),
	remove: icon(Icons.X),
	swap: icon(Icons.ArrowLeftRight),
	pencil: icon(Icons.Pencil),
	ellipsis: icon(Icons.EllipsisVertical),
	trash: icon(Icons.Trash),
	dice: icon(Icons.Dices),
	gear: icon(Icons.Settings),
	sword: icon(Icons.Sword),
	repeat: icon(Icons.Repeat, 'text-repeat-violation'),
	addFilter: icon(Icons.Edit),
	tutorialPoolIcon: () => TUT.TUTORIAL_FILTERS.pool.emoji,
	largeLayersIcon: () => TUT.TUTORIAL_FILTERS.large.emoji,
	hideRepeats: () =>
		React.createElement(
			'span',
			{ className: 'whitespace-nowrap' },
			React.createElement(Icons.Square, { className: 'inline h-3.5 w-3.5 align-text-bottom' }),
			` ${tr.text(F_Msgs.hideRepeats())}`,
		),
	filtersPage: link('/filters'),
	scoresDocs: link(SCORES_DOCS_URL),
})

// a step's card copy: a title and a body. Bundled defs from TUT_Msgs are exactly this shape; a body may be rich
// (def(rt(...))) using the tour tags above.
export type StepMsg = { title: () => TextMsg; body: () => TextMsg | Msgs.Variants.TRichTextable<TourTag> }
// what the overlay renders: a resolved title and a body node.
export type RenderedStep = { title: string; body: React.ReactNode }

// one shape for everything a step derives from live state: advancement, premises, dynamic copy. inputs picks the
// Zus.AnyInputs, select reads their states.
export type StateSelector<T> = {
	inputs: (run: RunStores) => Zus.AnyInput<any>[]
	select: (...states: any[]) => T
}

// How the user gets TO a step from the one before it. Lives on the destination step (advanceFromPrevious), so the
// condition for arriving somewhere sits with the step it produces -- which is also exactly the state a jump has to
// reconstruct. Covered with assertNever in the engine.
export type Transition =
	| { type: 'next' } // explicit Next button on the previous step's card
	| { type: 'anchor' } // user activates the previous step's anchored element
	| ({ type: 'state' } & StateSelector<boolean>) // arrives the first time select turns true
	// arrives when a sampled value differs from its value when the transition armed (the previous step being
	// entered). For operations whose completion is a change rather than a predicate: a layer added (the list grew)
	// or reordered (the order changed), where "done" only means "different from where you started".
	| {
			type: 'change'
			inputs: (run: RunStores) => Zus.AnyInput<any>[]
			sample: (...states: any[]) => unknown
			advanced: (baseline: any, current: any) => boolean
	  }

export type SimulateCtx = CS.AbortSignal & { run: RunStores }

export type AdvanceFromPrevious = Transition & {
	// Reproduce the state this transition's user action would have produced, so a jump can fast-forward through it.
	// Sync by contract -- a store or handle write, never a DOM click -- and must be idempotent, since a jump may
	// replay it over state a checkpoint already installed. Async is the declared exception (a server round trip) and
	// must respect ctx.signal. Absent = the transition carries no state a later step observes (pure narration, or a
	// transient interaction like a hover).
	simulate?: (ctx: SimulateCtx) => void | Promise<void>
}

// A step a jump can restore server state at: `stage` names an idempotent server checkpoint stage that RESETS the
// run (saved queue, edit sessions, the peer editor) to how it stands on arrival at this step. `ready` is awaited
// after the stage RPC, for state that reaches the client by subscription rather than in the response. Jumping to
// any step runs the nearest checkpoint at or before it, then replays the simulates in between.
export type Checkpoint = { stage: string; ready?: StateSelector<boolean> }

// what an anchor points at: one data-tour element, or `{ all }` for every laid-out element carrying the id, whose
// zone is the minimum rect containing them (a run of queue rows). A plain string resolves to the first laid-out
// match, so an id shared by several elements still works as a single anchor.
export type AnchorTarget = string | { all: string } | { css: string; all?: boolean }
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
	checkpoint?: Checkpoint
	// absent = { type: 'next' }. Step 0's is never consulted: nothing precedes it.
	advanceFromPrevious?: AdvanceFromPrevious
}

// the transition into steps[idx]; past-the-end reads as a Next so the last step's card shows Finish
export function transitionInto(steps: Step[], idx: number): AdvanceFromPrevious {
	return steps[idx]?.advanceFromPrevious ?? { type: 'next' }
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

// A Zus input for a selector's elements, driven by one shared MutationObserver. Steps read presentational
// state the house does not push into a store (data-state="open", aria-expanded) off the DOM, the same contract the
// e2e suite and screen readers use. Consumed through StateSelector like any other input.
//
// Emits every matching element in document order; the consumer picks. The same anchor can be mounted more than
// once, laid-out and not: an inactive selectLayers dialog keeps a hidden, zero-size copy of the pool controls, and
// a `{ all }` anchor deliberately tags a run of elements. The overlay filters to laid-out nodes at measure time.
const domInputs = new Map<string, Rx.BehaviorSubject<Element[]>>()
let domObserver: MutationObserver | null = null

function queryAnchors(selector: string): Element[] {
	if (typeof document === 'undefined') return []
	return [...document.querySelectorAll(selector)]
}

// The CSS an anchor resolves to. A bare id is the common case and reads as one; `css` is the escape hatch for an
// element the tour cannot tag, because the component is shared and tagging it would tag every instance -- scope
// such a selector to something the tour does own, or it will match the wrong copy.
export function anchorSelector(target: AnchorTarget): string {
	if (typeof target === 'string') return `[data-tour="${CSS.escape(target)}"]`
	if ('css' in target) return target.css
	return `[data-tour="${CSS.escape(target.all)}"]`
}

// whether the target unions every laid-out match rather than resolving to the first. A `{ all }` id says so by
// being that shape; a selector has to ask, since most selectors mean one element.
export function anchorsAll(target: AnchorTarget): boolean {
	if (typeof target !== 'object') return false
	return 'css' in target ? !!target.all : true
}

function sameElements(a: Element[], b: Element[]): boolean {
	return a.length === b.length && a.every((el, i) => el === b[i])
}

function ensureDomObserver() {
	if (domObserver || typeof document === 'undefined') return
	domObserver = new MutationObserver(() => {
		for (const [selector, subj] of domInputs) {
			const els = queryAnchors(selector)
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

export function domInput(selector: string): Rx.BehaviorSubject<Element[]> {
	let subj = domInputs.get(selector)
	if (!subj) {
		subj = new Rx.BehaviorSubject<Element[]>(queryAnchors(selector))
		domInputs.set(selector, subj)
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

type Active = { scenarioId: TUT.ScenarioId; steps: Step[]; resetClient?: (run: RunStores) => void; run: RunStores }
let active: Active | null = null
let stepSub = new Rx.Subscription() // advance + premise watchers for the current step
let runSub = new Rx.Subscription() // router pause watcher, lives for the run

// A scenario's client half: the steps, plus resetClient, which synchronously closes every piece of UI a step may
// have opened (dialogs, draggable windows) so a jump starts from a known screen.
//
// `steps` may be a builder, for a curriculum whose shape depends on what the install can support (whether its
// layers carry scores, say). It is called once, when the run starts, and never again: a step's index is the
// engine's identity for it -- the store, the jumps, the contents list and the checkpoint walk are all indexes --
// so the list has to stop changing shape before any of them exist.
export type ScenarioClientDef = { steps: Step[] | (() => Step[] | Promise<Step[]>); resetClient?: (run: RunStores) => void }

// the scenario registry, keyed by id. Registered by the steps files at import.
const scenarios = new Map<TUT.ScenarioId, ScenarioClientDef>()
export function registerScenario(scenarioId: TUT.ScenarioId, def: ScenarioClientDef) {
	scenarios.set(scenarioId, def)
}

// accessors for the overlay: the run's data sources and the step being narrated. Not reactive themselves; the
// overlay re-reads them whenever Store changes.
export function activeRun(): RunStores | null {
	return active?.run ?? null
}
// The active run's resolved list, which is the one every index refers to. Falls back to the authored list for a
// scenario that is not running, where nothing holds an index into it yet.
export function stepsOf(scenarioId: TUT.ScenarioId): Step[] {
	if (active?.scenarioId === scenarioId) return active.steps
	const authored = scenarios.get(scenarioId)?.steps
	return typeof authored === 'function' ? [] : (authored ?? [])
}
export function stepAt(scenarioId: TUT.ScenarioId, stepIdx: number): Step | undefined {
	return stepsOf(scenarioId)[stepIdx]
}
export function stepCount(scenarioId: TUT.ScenarioId): number {
	return stepsOf(scenarioId).length
}
// the transition out of stepIdx, which under the inversion is the next step's advanceFromPrevious. What the
// overlay consults for the Next button and the anchor-click listener.
export function transitionOutOf(scenarioId: TUT.ScenarioId, stepIdx: number): AdvanceFromPrevious {
	return transitionInto(stepsOf(scenarioId), stepIdx + 1)
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
	recordProgress(scenarioId, step.id)
	wireStep(step, idx)
}

// Where the reader is, saved per user so the tutorial can be picked up later or elsewhere. Written as the step is
// entered rather than on a timer: the step someone leaves on is exactly the one a debounce drops, since closing
// the tab or walking away is what ends the window. Steps change at human speed and the row is tiny, so the only
// thing worth suppressing is re-saving a position already saved -- a premise walking back and forth, say.
let lastSaved: string | undefined
function recordProgress(scenarioId: TUT.ScenarioId, stepId: string | null, completed = false) {
	const mark = `${scenarioId}:${stepId}:${completed}`
	if (mark === lastSaved) return
	lastSaved = mark
	void TutorialsClient.Actions.saveProgress({ scenarioId, stepId, completed }).catch((err) => console.error(err))
}

function wireStep(step: Step, idx: number) {
	if (!active) return
	const { steps, run } = active
	// entering a step arms the transition into the NEXT one; 'change' samples its baseline now
	const next = transitionInto(steps, idx + 1)

	switch (next.type) {
		case 'next':
		case 'anchor':
			// the Next button and the anchor-click listener live in the overlay
			break
		case 'state':
			stepSub.add(
				watchSelector(run, next)
					.pipe(Rx.filter(Boolean))
					.subscribe(() => {
						if (Sel.stepIdx(Store.getState()) === idx) doNext()
					}),
			)
			break
		case 'change': {
			const inputs = next.inputs(run)
			const baseline = next.sample(...inputs.map(readInput))
			const sample$ = inputs.length === 0 ? Rx.of([]) : Rx.combineLatest(inputs.map(toObs))
			stepSub.add(
				sample$.pipe(Rx.map((states) => next.sample(...states))).subscribe((cur) => {
					if (next.advanced(baseline, cur) && Sel.stepIdx(Store.getState()) === idx) doNext()
				}),
			)
			break
		}
		default:
			assertNever(next)
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
		abortJump()
		clearStepWatchers()
		set({ code: 'paused', scenarioId: active.scenarioId, stepIdx: s.stepIdx })
	} else if (onDash && s.code === 'paused') {
		void enterStep(s.stepIdx)
	}
}

// Attach the engine to a run's server and put the reader on its dashboard. Everything a run needs that is not the
// server itself: the resolved step list, the pause watcher, the presence the dashboard route races.
async function attach(scenarioId: TUT.ScenarioId, serverId: string) {
	const def = scenarios.get(scenarioId)
	if (!def) throw new Error(`no steps registered for tutorial ${scenarioId}`)
	const run = acquireRun(serverId)
	const steps = typeof def.steps === 'function' ? await def.steps() : def.steps
	active = { scenarioId, steps, resetClient: def.resetClient, run }
	runSub = new Rx.Subscription()
	runSub.add(rootRouter.subscribe('onResolved', reconcilePause))
	await rootRouter.navigate({ to: DASHBOARD_TO, params: { serverId } })
	await ensurePresenceOnDashboard(run, new AbortController().signal)
}

async function doStart(scenarioId: TUT.ScenarioId) {
	if (active) await doExit()
	const res = await TutorialsClient.Actions.start(scenarioId)
	if (res.code !== 'ok') return res
	await attach(scenarioId, res.serverId)
	await enterStep(0)
	return res
}

// Pick a tutorial up where the reader left it. The server is stood up again only if there isn't one already: a run
// outlives the tour that was narrating it, so a reload finds its server still there and reuses it. From there the
// jump does the work, and does as little of it as it can -- a checkpoint whose queue already matches dispatches
// nothing, and a simulate whose state already holds is skipped.
async function doResume(scenarioId: TUT.ScenarioId, stepId: string) {
	const existing = TutorialsClient.runState()
	const reuse = existing.code === 'active' && existing.scenarioId === scenarioId ? existing.serverId : null
	if (reuse) {
		if (active?.scenarioId !== scenarioId) {
			teardown()
			await attach(scenarioId, reuse)
		}
	} else {
		const res = await doStart(scenarioId)
		if (res.code !== 'ok') return res
	}
	const idx = active?.steps.findIndex((step) => step.id === stepId) ?? -1
	// a step id from before the curriculum changed points at nothing; starting over beats landing somewhere arbitrary
	await doJump(idx === -1 ? 0 : idx)
	return { code: 'ok' as const }
}

function doNext() {
	const s = Store.getState().state
	if (s.code !== 'narrating') return
	void enterStep(s.stepIdx + 1)
}

// ============================== jumps ==============================

const JUMP_READY_TIMEOUT_MS = 5000

let jumpCtl: AbortController | null = null

function abortJump() {
	jumpCtl?.abort()
	jumpCtl = null
}

// resolves true when the selector holds, false on abort or after timeoutMs. Exported for async simulates that
// dispatch a round trip and then wait for its state to land.
export function awaitSelector(run: RunStores, sel: StateSelector<boolean>, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
	if (readSelector(run, sel)) return Promise.resolve(true)
	return new Promise((resolve) => {
		const sub = new Rx.Subscription()
		const done = (ok: boolean) => {
			sub.unsubscribe()
			resolve(ok)
		}
		sub.add(
			watchSelector(run, sel)
				.pipe(Rx.filter(Boolean))
				.subscribe(() => done(true)),
		)
		const timer = setTimeout(() => done(false), timeoutMs)
		sub.add(() => clearTimeout(timer))
		const onAbort = () => done(false)
		signal.addEventListener('abort', onAbort, { once: true })
		sub.add(() => signal.removeEventListener('abort', onAbort))
	})
}

// The dashboard route dispatches enter-server-dashboard once on mount, but at tour start that races the new
// server's appearance in enabledServers, and a gated presence update is dropped rather than retried -- leaving the
// reader's presence rooted on the PREVIOUS server, where every per-server presence op then lands. The tour
// re-asserts it: at start, and before every jump's simulates.
async function ensurePresenceOnDashboard(run: RunStores, signal: AbortSignal) {
	await awaitSelector(
		run,
		{
			inputs: () => [UPClient.Store],
			select: (s: any) => s.session.localState.enabledServers.has(run.serverId),
		},
		signal,
		JUMP_READY_TIMEOUT_MS,
	)
	UPClient.Actions.ensureViewingPanel(run.serverId, 'VIEWING_QUEUE')
}

// Jump to an arbitrary step: reset the client UI, restore server state via the nearest checkpoint at or before the
// target, then replay the simulates in between. Sync simulates run back-to-back in one task; only the checkpoint
// (and any simulate that declares itself async) is awaited, under a signal a newer jump, pause or exit aborts.
// A checkpoint must subsume the effects of every `stage` in its region -- the loop does not replay stages.
// whether every transition strictly between the two steps (in either direction) is pure narration, i.e. crossing
// them changes no state
function pureNarrationPath(steps: Step[], from: number, to: number): boolean {
	const [lo, hi] = from < to ? [from, to] : [to, from]
	for (let i = lo + 1; i <= hi; i++) {
		if (transitionInto(steps, i).type !== 'next') return false
	}
	return true
}

async function doJump(target: number) {
	if (!active) return
	const { scenarioId, steps, resetClient, run } = active
	if (target < 0 || target >= steps.length) return
	// a hop across nothing but Next transitions needs no provisioning: the state here IS the state there
	const cur = Store.getState().state
	if (cur.code === 'narrating' && pureNarrationPath(steps, cur.stepIdx, target)) {
		abortJump()
		return enterStep(target)
	}
	abortJump()
	const ctl = new AbortController()
	jumpCtl = ctl
	clearStepWatchers()
	set({ code: 'staging', scenarioId, stepIdx: target })
	resetClient?.(run)
	await ensurePresenceOnDashboard(run, ctl.signal)
	if (ctl.signal.aborted) return

	let cpIdx = target
	while (cpIdx > 0 && !steps[cpIdx].checkpoint) cpIdx--
	const checkpoint = steps[cpIdx].checkpoint
	if (checkpoint) {
		const res = await TutorialsClient.Actions.stage(scenarioId, checkpoint.stage)
		if (ctl.signal.aborted) return
		if (res.code === 'err:not-ready') return set({ code: 'stage-not-ready', scenarioId, stepIdx: target, msg: res.msg })
		if (res.code !== 'ok') return set({ code: 'stage-failed', scenarioId, stepIdx: target })
		if (checkpoint.ready && !(await awaitSelector(run, checkpoint.ready, ctl.signal, JUMP_READY_TIMEOUT_MS))) {
			if (ctl.signal.aborted) return
			return set({ code: 'stage-failed', scenarioId, stepIdx: target })
		}
	}

	for (let i = cpIdx + 1; i <= target; i++) {
		const t = steps[i].advanceFromPrevious
		if (!t?.simulate) continue
		// a state transition whose condition already holds needs no reproducing
		if (t.type === 'state' && readSelector(run, t)) continue
		await t.simulate({ run, signal: ctl.signal })
		if (ctl.signal.aborted) return
	}
	if (ctl.signal.aborted) return
	jumpCtl = null
	await enterStep(target)
}

// re-provision the current step: the recovery path behind the Reset/Retry buttons
function doReset() {
	const idx = Sel.stepIdx(Store.getState())
	if (idx !== undefined) void doJump(idx)
}

// Ends the run, not just the narration. The two come apart on a reload: the tour is in memory and the run is on
// the server, so a reader who refreshes has a run and no tour, and that is exactly when the index page's Leave
// is the only way to get rid of it. Abandoning a run that is already gone is a no-op.
async function doExit() {
	// Off the dashboard before the server goes, not after. Abandoning deletes it, and a reader left standing on
	// its route is shown a "Server not found" page for a server they just chose to leave.
	const serverId = active?.run.serverId
	teardown()
	if (serverId && isOnDashboard(serverId)) await rootRouter.navigate({ to: TUTORIALS_TO })
	await TutorialsClient.Actions.abandon()
}

// Complete keeps the sandbox alive (the idle reaper collects it); only the tour tears down.
function doComplete() {
	if (active) recordProgress(active.scenarioId, null, true)
	teardown()
}

export namespace Actions {
	export const start = doStart
	export const resume = doResume
	export const next = doNext
	export const jump = doJump
	export const reset = doReset
	export const exit = doExit
	export const complete = doComplete
}

// console access for dev-instance verification: the tour's controls and the run's data sources
if (import.meta.env.DEV && typeof window !== 'undefined') {
	;(window as any).__tourActions = Actions
	;(window as any).__tourRun = () => {
		const run = activeRun()
		return run && { run, squadServer: frameManager.getState(run.squadServer) }
	}
}

function teardown() {
	lastSaved = undefined
	abortJump()
	clearStepWatchers()
	runSub.unsubscribe()
	runSub = new Rx.Subscription()
	if (active) releaseRun(active.run)
	active = null
	set({ code: 'idle' })
}
