import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { createContext, type ReactNode, type RefObject, useContext, useLayoutEffect, useRef } from 'react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/**
 * StickyGroup
 * ============================================================================
 * Makes nested "sticky" headers (or any sticky element) stack cleanly on top
 * of each other as the user scrolls, instead of overlapping or clipping.
 *
 * THE PROBLEM
 * ----------------------------------------------------------------------------
 * With plain CSS `position: sticky`, every sticky element defaults to
 * `top: 0` — so if you have a section header and a subsection header both
 * sticky, they'll stick to the exact same spot and overlap each other once
 * both are pinned. To stack them, each nested sticky element needs a `top`
 * offset equal to the combined height of every sticky ancestor above it —
 * and that offset needs to update live if any ancestor's height changes
 * (responsive text wrapping, font loading, window resize, content edits).
 *
 * HOW THIS SOLVES IT
 * ----------------------------------------------------------------------------
 * You render your own element and attach a ref to it. You pass that ref to
 * a <StickyGroup>. StickyGroup:
 *   1. Applies `position: sticky`, the correct `top` offset, and a `z-index`
 *      directly to your element via the ref.
 *   2. Measures your element's height with a ResizeObserver and keeps it
 *      current.
 *   3. Makes that height available to any <StickyGroup> nested inside its
 *      `children`, so they know how much extra offset to add on top of theirs.
 *
 * All of this state propagation happens through a zustand vanilla store
 * passed through React context, rather than through React state — so
 * measuring a height change and updating a descendant's `top` never
 * triggers a React re-render anywhere in the chain. <StickyGroup> itself
 * renders no DOM element; it's pure wiring.
 *
 * BASIC USAGE
 * ----------------------------------------------------------------------------
 *   function Section() {
 *     const headerRef = useRef<HTMLHeadingElement>(null);
 *     return (
 *       <StickyGroup stickyRef={headerRef}>
 *         <h1 ref={headerRef}>Project Alpha</h1>
 *         <p>Some content...</p>
 *         <Subsection />
 *       </StickyGroup>
 *     );
 *   }
 *
 *   function Subsection() {
 *     const headerRef = useRef<HTMLHeadingElement>(null);
 *     return (
 *       <StickyGroup stickyRef={headerRef}>
 *         <h2 ref={headerRef}>Design Docs</h2>
 *         <p>More content — this stacks below both "Project Alpha" and
 *            "Design Docs" once both are pinned to the top.</p>
 *       </StickyGroup>
 *     );
 *   }
 *
 * Nest as many levels deep as you want — each level automatically stacks
 * below all of its ancestors with no manual offset math.
 *
 * PLACEMENT RULES
 * ----------------------------------------------------------------------------
 * The element `stickyRef` points to does not have to be the first thing (or
 * even a direct child) inside <StickyGroup>'s `children` — StickyGroup
 * doesn't inspect `children` at all, it only touches the ref'd DOM node.
 * That said, for the stacking to look and behave correctly, the ref'd
 * element should:
 *   - Share the same scrolling container as the content in `children`.
 *     (`top` is computed relative to the nearest scrollable ancestor, so a
 *     sticky element in a different scroll container than its "content"
 *     will produce numerically correct but visually meaningless results.)
 *   - Sit immediately before (in DOM order) the content it's meant to head.
 *     Sticky positioning relies on the element's natural place in normal
 *     flow to know when to "release" as its container scrolls past.
 * In practice, rendering it as the first child inside `children` (as in the
 * example above) satisfies both automatically, which is why that's the
 * conventional pattern even though it isn't enforced by the code.
 *
 * REQUIREMENTS
 * ----------------------------------------------------------------------------
 * - React 18+ (uses `useLayoutEffect`; works fine under Strict Mode's
 *   double-invoked effects in development).
 * - `zustand` v5+ as a dependency (only `zustand/vanilla` is used — no
 *   Provider setup or React-hook API from zustand is needed).
 */

interface StickyState {
	/** Pixels this group's sticky element should offset from the top. */
	offset: number
	/** Nesting depth, used to keep shallower stickies visually on top (z-index). */
	depth: number
}

function createStickyStore(
	initial: StickyState = { offset: 0, depth: 0 },
): StoreApi<StickyState> {
	return createStore<StickyState>(() => initial)
}

// Default store read by any <StickyGroup> with no <StickyGroup> ancestor.
const rootStickyStore = createStickyStore()

const StickyStoreContext = createContext<StoreApi<StickyState>>(rootStickyStore)

export interface StickyGroupProps<T extends HTMLElement = HTMLElement> {
	/** Content to render. May include further nested <StickyGroup>s. */
	children: ReactNode
	/**
	 * Ref to the DOM element that should become sticky. Attach this ref to
	 * an element yourself, anywhere — StickyGroup only touches the node
	 * through the ref, it never renders or clones it.
	 */
	stickyRef: RefObject<T | null>
}

export function StickyGroup<T extends HTMLElement = HTMLElement>({
	children,
	stickyRef,
}: StickyGroupProps<T>) {
	const parentStore = useContext(StickyStoreContext)
	const stickyCeiling = useZIndex(ZI_OFFSETS.STICKYGROUP_CEILING)
	const stickyFloor = useZIndex(ZI_OFFSETS.STICKYGROUP_FLOOR)

	// Created once per component instance and never reassigned, so this
	// object's identity is stable across re-renders. That stability is what
	// lets it be handed down through context without causing descendant
	// re-renders when its *contents* change later.
	const ownStoreRef = useRef<StoreApi<StickyState> | null>(null)
	if (!ownStoreRef.current) {
		ownStoreRef.current = createStickyStore()
	}
	const ownStore = ownStoreRef.current

	useLayoutEffect(() => {
		const el = stickyRef.current
		if (!el) return

		// getBoundingClientRect() reports the border-box size (content +
		// padding + border) — the actual space the element occupies in flow.
		// This is deliberately NOT ResizeObserver's `contentRect`, which
		// excludes padding and border and would under-report the offset
		// descendants need by however much padding/border this element has.
		function measure() {
			return el!.getBoundingClientRect().height
		}

		function applyStyles() {
			const { offset, depth } = parentStore.getState()

			el!.style.position = 'sticky'
			el!.style.top = `${offset}px`
			// deeper stickies pin below their ancestors, so they must also paint below them
			el!.style.zIndex = String(Math.max(stickyCeiling - depth, stickyFloor))

			// Tell any nested <StickyGroup> what offset/depth to build on.
			ownStore.setState({
				offset: offset + measure(),
				depth: depth + 1,
			})
		}

		// Measured synchronously so the correct (padding-inclusive) offset is
		// published on first paint, rather than waiting for ResizeObserver's
		// first async callback — avoiding a one-frame jump as headers settle
		// into their correct stacked position.
		applyStyles()

		// Re-run if an ancestor's offset or depth changes (e.g. an ancestor
		// header's height changed, shifting everything below it).
		const unsubscribeParent = parentStore.subscribe(applyStyles)

		// Re-run if this element's own height changes. We ignore the
		// observer's own contentRect and just re-measure via
		// getBoundingClientRect() inside applyStyles for the same
		// border-box-accuracy reason as above.
		const resizeObserver = new ResizeObserver(applyStyles)
		resizeObserver.observe(el)

		return () => {
			unsubscribeParent()
			resizeObserver.disconnect()
			el!.style.position = ''
			el!.style.top = ''
			el!.style.zIndex = ''
		}
	}, [stickyRef, parentStore, ownStore, stickyCeiling, stickyFloor])

	return (
		<StickyStoreContext.Provider value={ownStore}>
			{children}
		</StickyStoreContext.Provider>
	)
}
