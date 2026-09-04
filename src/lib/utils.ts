// Conflicting tailwind classes resolve last-wins, so `cn(props.className, ...own)` lets the component's own classes
// eat the caller's. Put the caller's last when it is meant to be able to override.
export { cn } from 'cnfast'

// An affordance that stays out of the way until its `group/single-item` row is hovered. Collapsed to zero width rather
// than hidden, so it reserves no space between the things either side of it but can still be reached by keyboard.
// Touch screens have no hover, so there it is gone entirely.
export const REVEAL_ON_ITEM_HOVER =
	'pointer-coarse:hidden w-0 overflow-hidden px-0 opacity-0 group-hover/single-item:w-auto group-hover/single-item:px-1 group-hover/single-item:opacity-100 focus-visible:w-auto focus-visible:px-1 focus-visible:opacity-100'
