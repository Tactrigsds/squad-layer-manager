import React from 'react'

/**
 * Offsets are relative to the nearest enclosing `BaseZIndexContext`, not absolute.
 * A floating element computes its own z-index as `base + offset`, then provides that
 * result as the new base for its own content, so nesting composes without any callsite
 * needing to know what it's nested inside.
 *
 * The bands below describe one such context. Ordering within a band is left to DOM order.
 *
 * Draggable windows deliberately sit above popovers: a window floats over the page, so a
 * dropdown opened from the page proper renders behind it. A dropdown opened from *inside*
 * a window bases off that window's z-index and so still renders above it.
 */
export const ZI_OFFSETS = {
	// in-container layering (overlays, spinners, scroll affordances) - use 1..MINOR_CEILING
	MINOR_CEILING: 5,
	// sticky headers and fixed page chrome. a sticky group descends from the ceiling by its
	// nesting depth, since a deeper header pins below its ancestors and must paint below them too
	STICKYGROUP_FLOOR: 10,
	STICKYGROUP_CEILING: 50,
	// combo box, select, dropdown, context menu, hover card
	POPOVER: 60,
	// non-interactive, so it may safely sit above any popover anchored in the same context
	TOOLTIP: 65,
	DRAGGABLE_WINDOW_FLOOR: 70,
	DRAGGABLE_WINDOW_CEILING: 170,
	DIALOG: 180,
}

/** How many windows can be stacked within one context before ordering degrades. */
export const DRAGGABLE_WINDOW_STACK_LIMIT = ZI_OFFSETS.DRAGGABLE_WINDOW_CEILING - ZI_OFFSETS.DRAGGABLE_WINDOW_FLOOR

/** How deep sticky groups may nest within one context before the innermost ones start to tie. */
export const STICKYGROUP_DEPTH_LIMIT = ZI_OFFSETS.STICKYGROUP_CEILING - ZI_OFFSETS.STICKYGROUP_FLOOR

// the current "context" for a z-index stack. this could be the zindex of the current popover the calling component is a part of, etc
export const BaseZIndexContext = React.createContext<number>(0)

export function useZIndex(offset: number) {
	return React.useContext(BaseZIndexContext) + offset
}
