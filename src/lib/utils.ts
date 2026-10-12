// Conflicting tailwind classes resolve last-wins, so `cn(props.className, ...own)` lets the component's own classes
// eat the caller's. Put the caller's last when it is meant to be able to override.
export { cn } from 'cnfast'

// An affordance that stays out of the way until its `group/single-item` row is hovered. Hidden rather than collapsed,
// so it always takes up its width and hovering never rewraps the row. Touch screens have no hover, so there it is gone
// entirely.
export const REVEAL_ON_ITEM_HOVER = 'pointer-coarse:hidden invisible group-hover/single-item:visible focus-visible:visible'

// A card's or row's title link that opens the whole card: its ::after covers the nearest `relative` ancestor, so the
// card is a link target without nesting anchors. Anything interactive inside must be `relative`, which paints it above
// the overlay.
export const STRETCHED_LINK =
	'after:absolute after:inset-0 after:rounded focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring'
