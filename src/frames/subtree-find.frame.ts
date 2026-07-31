import type * as FRM from '@/lib/frame'
import * as Rx from '@/lib/rxjs'
import * as Find from '@/lib/subtree-find'
import * as Zus from '@/lib/zustand'

import { frameManager } from './frame-manager'

// State for one scoped find bar: what was typed, where in the subtree it matched, and which match the reader is
// looking at. The searching itself lives in `@/lib/subtree-find`, which knows nothing about React or this frame.

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>
export type Input = { instanceId: string }
export type Types = {
	name: 'subtreeFind'
	key: FRM.RawInstanceKey<{ instanceId: string }>
	input: Input
	state: Store
}

// Nothing in CSS can interpolate an instance id into `::highlight()`, so the registry names are fixed and only one
// session may paint at a time. `takeOver` closes whichever session held them, which is what a reader expects
// anyway: a second find bar opening is a new search, not a second set of highlights.
export const HIGHLIGHT_ALL = 'slm-find'
export const HIGHLIGHT_CURRENT = 'slm-find-current'

// One frame at most, so the leading edge fires on the first keystroke of a burst and the trailing edge catches the
// last. Long enough to coalesce a fast typist's overlapping keystrokes, short enough that nobody perceives it.
const TYPING_THROTTLE_MS = 16
// A subtree that redraws (a tailing log, a live table) invalidates the index, and rebuilding it is the expensive
// half of a search. Trailing-only, and an order of magnitude slacker than typing.
const MUTATION_AUDIT_MS = 250

// The engine's working set. Mutable and of stable identity by design: the index and the match list are rebuilt on
// every keystroke and every mutation of the searched subtree, and copying them at that rate is the one cost this
// component cannot carry. No selector reads into it.
export type Engine = {
	root: HTMLElement | null
	index: Find.Index | null
	matches: readonly Find.Match[]
	// what has been typed, which runs ahead of the `query` in the store by up to one throttle window
	pending: string
	// the match offset to stay near when the results change under the reader
	anchor: number
	// the match a pending frame will paint and scroll to, and that frame's handle while one is booked
	revealTarget: number
	revealHandle: number
	observer: MutationObserver | null
	typed$: Rx.Subject<void>
	dirty$: Rx.Subject<void>
}

export type Store = {
	engine: Engine
	open: boolean
	/** the query the reported counts belong to, which is what the bar renders against */
	query: string
	matchCount: number
	currentIndex: number
	truncated: boolean
	caseSensitive: boolean
	wholeWord: boolean
	supported: boolean
}

type Controls = { run: () => void; step: (delta: number) => void; close: () => void }
const controls = new WeakMap<Engine, Controls>()

let painter: Engine | null = null

function takeOver(engine: Engine) {
	if (painter && painter !== engine) controls.get(painter)?.close()
	painter = engine
}

function release(engine: Engine) {
	if (painter !== engine) return
	painter = null
	Find.clear(HIGHLIGHT_ALL, HIGHLIGHT_CURRENT)
}

function createKey(frameId: symbol, input: Input): Types['key'] {
	return { frameId, instanceId: input.instanceId }
}

function setup(args: FRM.SetupArgs<Input, Store>) {
	const engine: Engine = {
		root: null,
		index: null,
		matches: [],
		pending: '',
		anchor: 0,
		revealTarget: -1,
		revealHandle: 0,
		observer: null,
		typed$: new Rx.Subject<void>(),
		dirty$: new Rx.Subject<void>(),
	}

	args.set({
		engine,
		open: false,
		query: '',
		matchCount: 0,
		currentIndex: -1,
		truncated: false,
		caseSensitive: false,
		wholeWord: false,
		supported: Find.isSupported(),
	} satisfies Store)

	// A search that lands on the same counts as the last one is the common case while a live subtree redraws under
	// an idle query, and every store write re-renders the bar. Only a real change is published.
	function publish(next: Partial<Store>) {
		const current = args.get() as Record<string, unknown>
		for (const key of Object.keys(next)) {
			if (current[key] !== (next as Record<string, unknown>)[key]) {
				args.set(next)
				return
			}
		}
	}

	// paints the current match over the rest of them and brings it into view
	function paintCurrent() {
		engine.revealHandle = 0
		const match = engine.matches[engine.revealTarget]
		if (!engine.index || !match) {
			Find.clear(HIGHLIGHT_CURRENT)
			return
		}
		const range = Find.toRange(engine.index, match)
		Find.paint(HIGHLIGHT_CURRENT, [range], 1)
		Find.scrollRangeIntoView(range)
	}

	function cancelReveal() {
		if (engine.revealHandle === 0) return
		cancelAnimationFrame(engine.revealHandle)
		engine.revealHandle = 0
	}

	// Measuring and scrolling to a match forces a layout flush, and the enter key repeats far faster than the screen
	// refreshes, so holding it spent every frame on positions nobody ever saw. Only the last one in a frame is worth
	// showing. The anchor is still moved for each step, since a rebuild landing mid-burst reads it.
	function reveal(current: number) {
		const match = engine.matches[current]
		if (match) engine.anchor = match.start
		engine.revealTarget = current
		if (engine.revealHandle === 0) engine.revealHandle = requestAnimationFrame(paintCurrent)
	}

	function run() {
		const state = args.get()
		const query = engine.pending
		if (!state.open || !engine.root || query === '') {
			engine.matches = []
			cancelReveal()
			release(engine)
			publish({ query, matchCount: 0, currentIndex: -1, truncated: false })
			return
		}
		engine.index ??= Find.buildIndex(engine.root)
		const { matches, truncated } = Find.search(engine.index, query, {
			caseSensitive: state.caseSensitive,
			wholeWord: state.wholeWord,
		})
		engine.matches = matches
		// the first match at or after where the reader was, so a rebuild does not throw them back to the top
		let current = matches.findIndex((m) => m.start >= engine.anchor)
		if (current === -1) current = matches.length > 0 ? 0 : -1

		takeOver(engine)
		Find.paint(
			HIGHLIGHT_ALL,
			matches.map((m) => Find.toStaticRange(engine.index!, m)),
		)
		publish({ query, matchCount: matches.length, currentIndex: current, truncated })
		reveal(current)
	}

	function step(delta: number) {
		const total = engine.matches.length
		if (total === 0) return
		const next = (args.get().currentIndex + delta + total) % total
		args.set({ currentIndex: next })
		reveal(next)
	}

	function close() {
		engine.pending = ''
		engine.matches = []
		// dropping the index releases its references to every text node in the subtree
		engine.index = null
		cancelReveal()
		release(engine)
		args.set({ open: false, query: '', matchCount: 0, currentIndex: -1, truncated: false })
	}

	controls.set(engine, { run, step, close })

	args.cleanup.push(
		Rx.merge(
			engine.typed$.pipe(Rx.throttleTime(TYPING_THROTTLE_MS, Rx.asyncScheduler, { leading: true, trailing: true })),
			engine.dirty$.pipe(Rx.auditTime(MUTATION_AUDIT_MS)),
		).subscribe(run),
	)
	args.cleanup.push(() => {
		engine.observer?.disconnect()
		cancelReveal()
		engine.index = null
		engine.matches = []
		release(engine)
	})
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'subtreeFind',
	createKey,
	setup,
})

export namespace Sel {
	/** `null` while there is nothing to report, so the bar can leave the counter out entirely. */
	export function counter(state: Store): { current: number; total: number; truncated: boolean } | null {
		if (state.query === '') return null
		return { current: state.currentIndex + 1, total: state.matchCount, truncated: state.truncated }
	}
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<Store>(stores.subtreeFind)
	}

	function engineOf(stores: KeyProp) {
		return store(stores).getState().engine
	}

	/** Points the session at the subtree to search. Pass `null` when the scope unmounts. */
	export function attach(stores: KeyProp, root: HTMLElement | null) {
		const engine = engineOf(stores)
		if (engine.root === root) return
		engine.observer?.disconnect()
		engine.observer = null
		engine.root = root
		engine.index = null
		if (root) {
			// The bar renders inside the region it searches often enough that its own counter ticking over would
			// invalidate the index on every keypress, rebuild it and re-run the search -- a loop fed by nothing but
			// reading the results. Stepping through matches with the enter key held drove it hardest.
			const observer = new MutationObserver((records) => {
				if (!records.some((record) => !Find.isIgnored(record.target))) return
				engine.index = null
				engine.dirty$.next()
			})
			// class and style carry visibility, which decides whether text is indexed at all
			observer.observe(root, {
				childList: true,
				subtree: true,
				characterData: true,
				attributes: true,
				attributeFilter: ['class', 'style', 'hidden'],
			})
			engine.observer = observer
		}
		controls.get(engine)?.run()
	}

	export function setQuery(stores: KeyProp, query: string) {
		const engine = engineOf(stores)
		if (engine.pending === query) return
		// extending the query keeps the reader where they are; anything else is a new search, from the top
		if (!query.startsWith(engine.pending)) engine.anchor = 0
		engine.pending = query
		engine.typed$.next()
	}

	export function setCaseSensitive(stores: KeyProp, caseSensitive: boolean) {
		store(stores).setState({ caseSensitive })
		controls.get(engineOf(stores))?.run()
	}

	export function setWholeWord(stores: KeyProp, wholeWord: boolean) {
		store(stores).setState({ wholeWord })
		controls.get(engineOf(stores))?.run()
	}

	export function next(stores: KeyProp) {
		controls.get(engineOf(stores))?.step(1)
	}

	export function prev(stores: KeyProp) {
		controls.get(engineOf(stores))?.step(-1)
	}

	export function open(stores: KeyProp) {
		const engine = engineOf(stores)
		if (!store(stores).getState().open) {
			store(stores).setState({ open: true })
			engine.index = null
			engine.anchor = 0
		}
		controls.get(engine)?.run()
	}

	export function close(stores: KeyProp) {
		controls.get(engineOf(stores))?.close()
	}

	export function toggle(stores: KeyProp) {
		if (store(stores).getState().open) close(stores)
		else open(stores)
	}
}
