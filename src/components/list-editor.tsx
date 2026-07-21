import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as Icons from 'lucide-react'
import React from 'react'
import type { ComboBoxHandle } from './combo-box/combo-box.tsx'

// A vertical add/remove list in the style of the settings scope editor: one row per item with a removal X,
// and an Add button that swaps itself out for the host's picker so the control you clicked is the control
// you then pick from. Row content is host-rendered, so items can be arbitrarily rich.
export function ListEditor<Item>(props: {
	items: Item[]
	itemKey: (item: Item, index: number) => string
	renderItem: (item: Item, index: number) => React.ReactNode
	onRemove: (item: Item, index: number) => void
	// rendered in place of the Add button while an add is pending. Call `done` once the pick lands (the
	// cancel X beside it is provided here); `ref` autofocuses the picker on open.
	renderAddControl: (controls: { ref: React.RefObject<ComboBoxHandle | null>; done: () => void }) => React.ReactNode
	addLabel: string
	// the button stays, disabled, to say there's nothing left to pick
	addDisabled?: boolean
	// an empty list can mean something (e.g. "unrestricted"), which reads as a bug unless it's spelled out
	emptyLabel?: string
	className?: string
}) {
	// the not-yet-chosen row that Add opens. It lives here rather than with the host's items so an abandoned
	// Add can't write an empty entry back.
	const [adding, setAdding] = React.useState(false)
	// Add is one intent, so it opens the picker it just swapped itself out for rather than asking for a
	// second click. Driven off the transition, not a callback ref: an imperative handle rebuilt on the
	// popover's own `open` change would re-fire a ref callback and reopen a box the user just dismissed.
	const pendingRef = React.useRef<ComboBoxHandle>(null)
	React.useEffect(() => {
		if (adding) pendingRef.current?.focus()
	}, [adding])
	const done = React.useCallback(() => setAdding(false), [])

	return (
		<div className={cn('space-y-1', props.className)}>
			{props.items.length === 0 && !adding && props.emptyLabel && (
				<p className="text-xs leading-8 text-muted-foreground">{props.emptyLabel}</p>
			)}
			{props.items.map((item, index) => (
				<div key={props.itemKey(item, index)} className="flex items-center gap-1">
					{props.renderItem(item, index)}
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="h-8 w-8 shrink-0 text-destructive"
						onClick={() => props.onRemove(item, index)}
					>
						<Icons.X className="h-4 w-4" />
					</Button>
				</div>
			))}
			{adding
				? (
					<div className="flex items-center gap-1">
						{props.renderAddControl({ ref: pendingRef, done })}
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 shrink-0 text-destructive"
							onClick={done}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				)
				: (
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="h-7"
						disabled={props.addDisabled}
						onClick={() => setAdding(true)}
					>
						<Icons.Plus className="mr-1 h-3.5 w-3.5" />
						{props.addLabel}
					</Button>
				)}
		</div>
	)
}
