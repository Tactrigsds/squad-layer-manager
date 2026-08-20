import * as React from 'react'
import { createPortal } from 'react-dom'

import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { rootRouter } from '@/root-router'
import * as Tour from '@/systems/tour.client'

// The tutorial tour overlay: a root portal that dims the dashboard, spotlights the anchored element, and shows the
// coachmark card. Renders Tour.Store and calls Tour.Actions. Visual per the approved mock: medium dim + 2px ring +
// glow cutout, a card with a numbered badge, a top progress bar and "Step N of M", and a Restart control that
// re-requests the current step's stage (promoted to the primary Retry when a stage is not ready).

const ACCENT = '#3b82f6'
const GAP = 12 // px between the anchor and the card

// ---- reactive anchor measurement (no ready-made hook; getBoundingClientRect on a rAF loop, per the house pattern) ----

const isLaidOut = (el: Element) => {
	const r = el.getBoundingClientRect()
	return r.width > 0 || r.height > 0
}

// The elements an anchor target resolves to: every laid-out match for `{ all }`, else the first laid-out match
// (the id may be mounted more than once, hidden copies included).
function useAnchorEls(target: Tour.AnchorTarget | null): Element[] {
	const [els, setEls] = React.useState<Element[]>([])
	const id = target === null ? null : typeof target === 'string' ? target : target.all
	const all = target !== null && typeof target === 'object'
	React.useEffect(() => {
		if (!id) {
			setEls([])
			return
		}
		const pick = (list: Element[]) => {
			if (all) return list.filter(isLaidOut)
			const first = list.find(isLaidOut) ?? list[0]
			return first ? [first] : []
		}
		const sub = Tour.domInput(id)
			.pipe(Rx.map(pick))
			.subscribe((next) => setEls((prev) => (prev.length === next.length && prev.every((el, i) => el === next[i]) ? prev : next)))
		return () => sub.unsubscribe()
	}, [id, all])
	return els
}

type Rect = { top: number; left: number; width: number; height: number; bottom: number; right: number }

function sameRect(a: Rect, b: Rect) {
	return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
}

// the minimum rect containing every laid-out element; null while none is
function useUnionRect(els: Element[]): Rect | null {
	const [rect, setRect] = React.useState<Rect | null>(null)
	React.useEffect(() => {
		if (els.length === 0) {
			setRect(null)
			return
		}
		let raf = 0
		const tick = () => {
			let next: Rect | null = null
			for (const el of els) {
				const r = el.getBoundingClientRect()
				if (r.width <= 0 && r.height <= 0) continue
				next =
					next === null
						? { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height }
						: {
								top: Math.min(next.top, r.top),
								left: Math.min(next.left, r.left),
								bottom: Math.max(next.bottom, r.bottom),
								right: Math.max(next.right, r.right),
								width: 0,
								height: 0,
							}
			}
			if (next) {
				next.width = next.right - next.left
				next.height = next.bottom - next.top
			}
			setRect((prev) => (prev === next || (prev && next && sameRect(prev, next)) ? prev : next))
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [els])
	return rect
}

function useRenderedMsg(run: Tour.RunStores, msg: Tour.Step['msg']): Tour.RenderedStep {
	const [rendered, setRendered] = React.useState<Tour.RenderedStep>(() => Tour.renderMsg(run, msg))
	React.useEffect(() => {
		const sub = Tour.renderMsg$(run, msg).subscribe(setRendered)
		return () => sub.unsubscribe()
	}, [run, msg])
	return rendered
}

// ---- entry ----

export function TourOverlay() {
	const state = Zus.useStore(Tour.Store, Tour.Sel.state)
	if (state.code === 'idle') return import.meta.env.DEV ? <TourLauncher /> : null
	return <TourActive state={state} />
}

// Provisional dev-only launch affordance so the tour can be started and verified; the real entry point is the
// tutorials index page (Phase 6).
function TourLauncher() {
	const zIndex = useZIndex(ZI_OFFSETS.DIALOG)
	return (
		<button
			type="button"
			className="fixed bottom-3 right-3 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 shadow-lg hover:bg-zinc-800"
			style={{ zIndex }}
			onClick={() => void Tour.Actions.start('layer-queue')}
		>
			Start tutorial
		</button>
	)
}

function TourActive({ state }: { state: Exclude<Tour.TourState, { code: 'idle' }> }) {
	const zIndex = useZIndex(ZI_OFFSETS.TOUR)
	const run = Tour.activeRun()
	const step = Tour.stepAt(state.scenarioId, state.stepIdx)
	if (!run || !step) return null

	const body =
		state.code === 'paused' ? (
			<DockedCard serverId={run.serverId} />
		) : (
			<AnchoredStep state={state} step={step} run={run} total={Tour.stepCount(state.scenarioId)} />
		)

	return createPortal(
		<BaseZIndexContext.Provider value={zIndex}>
			<div style={{ position: 'fixed', inset: 0, zIndex, pointerEvents: 'none' }}>{body}</div>
		</BaseZIndexContext.Provider>,
		document.body,
	)
}

// ---- the anchored / centered step ----

function AnchoredStep(props: {
	state: Extract<Tour.TourState, { code: 'staging' | 'narrating' | 'stage-not-ready' | 'stage-failed' }>
	step: Tour.Step
	run: Tour.RunStores
	total: number
}) {
	const { state, step, run, total } = props
	const anchorTarget = Tour.resolveAnchor(run, step.anchor)
	const els = useAnchorEls(anchorTarget)
	const rect = useUnionRect(els)
	// the undimmed region, wider than the outline when a step sets it; otherwise the anchor itself
	const spotlightTarget = Tour.resolveAnchor(run, step.spotlight ?? step.anchor)
	const spotEls = useAnchorEls(spotlightTarget)
	const spotRect = useUnionRect(spotEls)
	const rendered = useRenderedMsg(run, step.msg)
	const interact = step.interact ?? 'block'

	// bring the outlined zone into view when it resolves, so it is never dimmed off-screen or behind an overflow
	// scroll. The rAF rect loop tracks it as the scroll settles.
	const firstEl = els[0] ?? null
	React.useEffect(() => {
		firstEl?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
	}, [firstEl])

	// advance:'anchor' — advance when the user activates any anchored element
	React.useEffect(() => {
		if (state.code !== 'narrating' || step.advance.type !== 'anchor' || els.length === 0) return
		const onClick = () => Tour.Actions.next()
		for (const el of els) el.addEventListener('click', onClick, { capture: true })
		return () => {
			for (const el of els) el.removeEventListener('click', onClick, { capture: true } as EventListenerOptions)
		}
	}, [state.code, step.advance.type, els])

	// anchored but the spotlight elements have not mounted yet: wait with a plain dim, no cutout
	const hasSpotlight = spotlightTarget !== null && spotRect !== null
	const hasOutline = anchorTarget !== null && rect !== null

	return (
		<>
			{hasSpotlight ? <Scrim rect={spotRect} /> : <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.66)' }} />}
			{hasOutline && <Outline rect={rect} />}
			<Blockers interact={interact} rect={hasOutline ? rect : null} />
			<Card
				state={state}
				step={step}
				rendered={rendered}
				anchorRect={hasOutline ? rect : null}
				spotRect={hasSpotlight ? spotRect : null}
				total={total}
			/>
		</>
	)
}

// The dark scrim with a hole cut for the undimmed region. Just the dim; the ring is drawn separately so it can sit on
// a smaller element than the hole.
function Scrim({ rect }: { rect: Rect }) {
	return (
		<div
			style={{
				position: 'fixed',
				top: rect.top - 6,
				left: rect.left - 6,
				width: rect.width + 12,
				height: rect.height + 12,
				borderRadius: 12,
				pointerEvents: 'none',
				boxShadow: '0 0 0 9999px rgba(0,0,0,0.66)',
			}}
		/>
	)
}

// The highlight ring around the outlined element. No dim of its own.
function Outline({ rect }: { rect: Rect }) {
	return (
		<div
			style={{
				position: 'fixed',
				top: rect.top - 6,
				left: rect.left - 6,
				width: rect.width + 12,
				height: rect.height + 12,
				borderRadius: 12,
				pointerEvents: 'none',
				boxShadow: `0 0 0 2px ${ACCENT}, 0 0 22px 2px rgba(59,130,246,0.42)`,
			}}
		/>
	)
}

// Pointer control. block = capture everything; anchor-only = frame the anchor so only it stays live; free = nothing.
function Blockers({ interact, rect }: { interact: 'block' | 'anchor-only' | 'free'; rect: Rect | null }) {
	const cap: React.CSSProperties = { position: 'fixed', pointerEvents: 'auto' }
	if (interact === 'free') return null
	if (interact === 'block' || !rect) return <div style={{ ...cap, inset: 0 }} />
	// four rectangles around the anchor, leaving its box open
	return (
		<>
			<div style={{ ...cap, top: 0, left: 0, right: 0, height: Math.max(0, rect.top - 6) }} />
			<div style={{ ...cap, top: rect.bottom + 6, left: 0, right: 0, bottom: 0 }} />
			<div style={{ ...cap, top: rect.top - 6, left: 0, width: Math.max(0, rect.left - 6), height: rect.height + 12 }} />
			<div style={{ ...cap, top: rect.top - 6, left: rect.right + 6, right: 0, height: rect.height + 12 }} />
		</>
	)
}

// ---- the card ----

// Estimates for the first frame only. The card sizes itself from its copy (see MEASURE below) and both values are
// replaced with what it actually measured, so nothing here is a width the layout has to honour.
const CARD_W_ESTIMATE = 320
const CARD_H_ESTIMATE = 180

// What decides the card's width: the copy is held to a comfortable line length and the card takes its size from
// that (`w-max`). Stated in `ch` of the body's own type size, because a reading measure is the real constraint --
// a one-line card stays small, a long one wraps where it is still readable, and the placement math measures the
// result instead of being told a number that has to agree with the CSS.
const BODY_MEASURE = 'min-w-[26ch] max-w-[min(56ch,calc(100vw-3rem))]'

function intersects(a: Rect, b: Rect, margin: number): boolean {
	return a.left < b.right + margin && a.right > b.left - margin && a.top < b.bottom + margin && a.bottom > b.top - margin
}

// The card hugs the outlined anchor, never covers the undimmed spotlight zone, and stays on screen. Candidates
// adjacent to the anchor come first (below, above, right, left), then adjacent to the spotlight but aligned toward
// the anchor, then a clamped fallback for a zone that fills the screen. Above-placements pin the card's bottom
// edge, so a card taller than measured grows away from the element rather than over it.
function placeCard(anchor: Rect | null, spotlight: Rect | null, cardW: number, cardH: number): React.CSSProperties {
	if (!anchor && !spotlight) {
		return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
	}
	const a = anchor ?? spotlight!
	const zone = spotlight ?? anchor!
	const vw = window.innerWidth
	const vh = window.innerHeight
	const clampX = (x: number) => Math.min(Math.max(12, x), vw - cardW - 12)
	const clampY = (y: number) => Math.min(Math.max(12, y), vh - cardH - 12)
	const candidates: { top: number; left: number; pinBottom?: boolean }[] = [
		{ top: a.bottom + GAP, left: clampX(a.left) },
		{ top: a.top - GAP - cardH, left: clampX(a.left), pinBottom: true },
		{ top: clampY(a.top), left: a.right + GAP },
		{ top: clampY(a.top), left: a.left - GAP - cardW },
		{ top: zone.bottom + GAP, left: clampX(a.left) },
		{ top: zone.top - GAP - cardH, left: clampX(a.left), pinBottom: true },
		{ top: clampY(a.top), left: zone.right + GAP },
		{ top: clampY(a.top), left: zone.left - GAP - cardW },
	]
	for (const c of candidates) {
		const box: Rect = { top: c.top, left: c.left, width: cardW, height: cardH, bottom: c.top + cardH, right: c.left + cardW }
		if (box.top < 12 || box.left < 12 || box.bottom > vh - 12 || box.right > vw - 12) continue
		if (intersects(box, zone, GAP / 2)) continue
		if (anchor && intersects(box, anchor, GAP / 2)) continue
		return c.pinBottom ? { bottom: vh - box.bottom, left: c.left } : { top: c.top, left: c.left }
	}
	// Nothing fits beside the zone, because it fills the screen. Take the side with the most room and clamp in, so
	// the card covers as little of the zone as the viewport allows rather than landing on top of it.
	const sides = [
		{ space: vh - zone.bottom, top: zone.bottom + GAP, left: clampX(a.left) },
		{ space: zone.top, top: zone.top - GAP - cardH, left: clampX(a.left) },
		{ space: vw - zone.right, top: clampY(a.top), left: zone.right + GAP },
		{ space: zone.left, top: clampY(a.top), left: zone.left - GAP - cardW },
	]
	const roomiest = sides.reduce((best, side) => (side.space > best.space ? side : best))
	return { top: clampY(roomiest.top), left: clampX(roomiest.left) }
}

function Card(props: {
	state: AnchoredStepState
	step: Tour.Step
	rendered: Tour.RenderedStep
	anchorRect: Rect | null
	spotRect: Rect | null
	total: number
}) {
	const { state, step, rendered, anchorRect, spotRect, total } = props
	const stepNo = state.stepIdx + 1
	const isLast = state.stepIdx === total - 1
	const notReady = state.code === 'stage-not-ready'
	const failed = state.code === 'stage-failed'
	const staging = state.code === 'staging'
	const accent = notReady || failed ? 'bg-amber-500' : 'bg-blue-600'
	const centered = anchorRect === null && spotRect === null

	// the card's real size, so the placement math works off what the copy actually rendered to rather than a guess
	const cardRef = React.useRef<HTMLDivElement>(null)
	const [card, setCard] = React.useState({ w: CARD_W_ESTIMATE, h: CARD_H_ESTIMATE })
	React.useLayoutEffect(() => {
		const el = cardRef.current
		if (el) setCard({ w: el.offsetWidth, h: el.offsetHeight })
	}, [rendered, state])

	return (
		<div
			ref={cardRef}
			className="absolute w-max rounded-lg border border-zinc-700 bg-zinc-900 p-3.5 pt-4 text-zinc-100 shadow-2xl"
			style={{ pointerEvents: 'auto', ...placeCard(anchorRect, spotRect, card.w, card.h) }}
		>
			<div
				className={`absolute -left-3 -top-3 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${accent}`}
			>
				{stepNo}
			</div>
			<div className="mb-0.5 text-[11px] text-zinc-500">
				Step {stepNo} of {total}
			</div>
			<div className="mb-2.5 h-[3px] overflow-hidden rounded-full bg-zinc-800">
				<div className={`h-full ${accent}`} style={{ width: `${(stepNo / Math.max(1, total)) * 100}%` }} />
			</div>
			<h3 className={`text-sm font-semibold ${notReady || failed ? 'text-amber-400' : ''}`}>
				{failed ? 'Something went wrong' : rendered.title}
			</h3>
			{/* a block, not a <p>: step copy marks its own paragraphs and lists, and the spacing rules here are what
			    give an unmarked single-paragraph body and a multi-paragraph one the same top margin */}
			<div
				className={`mt-1.5 ${BODY_MEASURE} break-words text-xs leading-relaxed text-zinc-300 [&_a]:text-blue-400 [&_code]:text-[11px] [&_li]:mt-0.5 [&_p+p]:mt-2 [&_ul+p]:mt-2 [&_ul]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-4`}
			>
				{failed ? 'That step could not be set up. Retry, or exit the tutorial.' : notReady ? state.msg : rendered.body}
			</div>
			<div className="mt-3 flex items-center justify-between gap-2">
				<button
					type="button"
					className="rounded px-1 py-1 text-xs text-zinc-400 hover:text-zinc-200"
					onClick={() => void Tour.Actions.exit()}
				>
					Exit
				</button>
				<div className="flex items-center gap-1.5">
					<CardActions
						state={state}
						step={step}
						isLast={isLast}
						centered={centered}
						staging={staging}
						notReady={notReady}
						failed={failed}
					/>
				</div>
			</div>
		</div>
	)
}

function CardActions(props: {
	state: AnchoredStepState
	step: Tour.Step
	isLast: boolean
	centered: boolean
	staging: boolean
	notReady: boolean
	failed: boolean
}) {
	const { step, isLast, centered, staging, notReady, failed } = props
	if (notReady || failed) {
		return (
			<button type="button" className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white" onClick={() => Tour.Actions.restartStep()}>
				Retry
			</button>
		)
	}
	if (staging) {
		return <span className="px-1 text-xs text-zinc-500">Preparing…</span>
	}
	// Restart is available on any step with server staging to recover (centered intro/outro steps drop it).
	const showRestart = !centered && !!step.stage
	return (
		<>
			{showRestart && (
				<button
					type="button"
					className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
					onClick={() => Tour.Actions.restartStep()}
				>
					Restart
				</button>
			)}
			{step.advance.type === 'next' && (
				<button type="button" className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white" onClick={() => Tour.Actions.next()}>
					{isLast ? 'Finish' : 'Next'}
				</button>
			)}
		</>
	)
}

function DockedCard({ serverId }: { serverId: string }) {
	return (
		<div
			className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2.5 rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-zinc-100 shadow-2xl"
			style={{ pointerEvents: 'auto' }}
		>
			<div className="text-xs text-zinc-300">
				<span className="font-semibold text-white">Tutorial paused.</span> Return to the dashboard to continue where you left off.
			</div>
			<button
				type="button"
				className="whitespace-nowrap rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white"
				onClick={() => void rootRouter.navigate({ to: '/servers/$serverId', params: { serverId } })}
			>
				Back to dashboard
			</button>
		</div>
	)
}

type AnchoredStepState = Extract<Tour.TourState, { code: 'staging' | 'narrating' | 'stage-not-ready' | 'stage-failed' }>
