import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import * as FindFrame from '@/frames/subtree-find.frame'
import * as Find from '@/lib/subtree-find'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as SF_Msgs from '@/messages/subtree-find.messages'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { tr } from '@/systems/messages.client'

// A find bar over one subtree, provisioned by `useSubtreeFind`. Nothing about a match is rendered here: the frame
// paints matches through the CSS Custom Highlight API (styled in src/index.css), so typing repaints thousands of
// them without React seeing any of it. Only the counter re-renders, and only when the counts actually change.

type Props = {
	stores: FindFrame.KeyProp
	className?: string
	/** Show the bar from the start, rather than waiting for ctrl+F within the searched subtree. */
	defaultOpen?: boolean
	/** Leave off for a bar that is only ever opened by the caller. */
	hotkey?: boolean
	/** Leave off to collapse to nothing rather than to a button, for a bar reachable by ctrl+F alone. */
	trigger?: boolean
}

export function SubtreeFindBar({ stores, className, defaultOpen = false, hotkey = true, trigger = true }: Props) {
	const [open, counter, caseSensitive, wholeWord, supported] = Zus.useStore(
		stores.subtreeFind,
		(s) => [s.open, FindFrame.Sel.counter(s), s.caseSensitive, s.wholeWord, s.supported] as const,
	)
	const inputRef = React.useRef<HTMLInputElement>(null)
	const barRef = React.useRef<HTMLDivElement>(null)
	const zIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)

	React.useEffect(() => {
		if (defaultOpen) FindFrame.Actions.open(stores)
	}, [defaultOpen, stores])

	// ctrl+F is only intercepted while the reader is at the subtree this bar searches, so the browser's own find
	// still answers everywhere else on the page. Hover counts as well as focus, because the usual thing to search
	// is a scrolling region holding nothing focusable to have clicked on. `:hover` is read on the keystroke rather
	// than tracked, so watching for it costs nothing.
	React.useEffect(() => {
		if (!hotkey) return
		const onKeyDown = (e: KeyboardEvent) => {
			const isFind = e.key === 'f' && !e.altKey && (e.ctrlKey || e.metaKey)
			if (!isFind && e.key !== 'Escape') return
			const state = Zus.getState(stores.subtreeFind)
			const root = state.engine.root
			const active = document.activeElement
			const focused = !!active && (!!root?.contains(active) || !!barRef.current?.contains(active))
			if (isFind) {
				if (!focused && !root?.matches(':hover')) return
				e.preventDefault()
				FindFrame.Actions.open(stores)
				inputRef.current?.select()
				return
			}
			// escape dismisses the search the reader is looking at, from anywhere inside it -- clicking a result
			// blurs the input, and until it is dismissed every match stays painted. Hover does not count here: a
			// pointer resting over the region is not a reason to swallow the key from whatever owns focus. Stopped
			// rather than only prevented, so a dialog holding this bar does not close itself out from under it.
			if (!focused || !state.open) return
			e.preventDefault()
			e.stopPropagation()
			FindFrame.Actions.close(stores)
		}
		document.addEventListener('keydown', onKeyDown, true)
		return () => document.removeEventListener('keydown', onKeyDown, true)
	}, [hotkey, stores])

	React.useEffect(() => {
		if (open) inputRef.current?.focus()
	}, [open])

	// collapsed, the bar is the button that opens it, in the same slot the caller positioned. Anything relying on
	// ctrl+F alone stays undiscoverable, and the searched region is usually not somewhere a reader thinks to press it.
	if (!open) {
		if (!trigger) return null
		return (
			<Button
				type="button"
				size="icon"
				variant="secondary"
				style={{ zIndex }}
				aria-label={tr.text(SF_Msgs.label())}
				title={tr.text(SF_Msgs.label())}
				{...{ [Find.IGNORE_ATTR]: '' }}
				className={cn('h-7 w-7 shadow-md', className)}
				onClick={() => FindFrame.Actions.open(stores)}
			>
				<Icons.Search className="h-4 w-4" />
			</Button>
		)
	}

	const onKeyDown = (e: React.KeyboardEvent) => {
		switch (e.key) {
			case 'Enter':
			case 'ArrowDown':
			case 'ArrowUp': {
				e.preventDefault()
				const back = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)
				if (back) FindFrame.Actions.prev(stores)
				else FindFrame.Actions.next(stores)
				return
			}
			case 'Escape':
				e.preventDefault()
				FindFrame.Actions.close(stores)
				return
		}
	}

	const empty = counter !== null && counter.total === 0

	return (
		<div
			ref={barRef}
			role="search"
			aria-label={tr.text(SF_Msgs.label())}
			style={{ zIndex }}
			// the bar sits inside the searched subtree often enough that indexing itself would be a live hazard
			{...{ [Find.IGNORE_ATTR]: '' }}
			className={cn('flex items-center gap-1 rounded-md border bg-background p-1 shadow-md', className)}
		>
			<Icons.Search className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<input
				ref={inputRef}
				type="search"
				aria-label={tr.text(SF_Msgs.label())}
				placeholder={tr.text(SF_Msgs.placeholder())}
				defaultValue=""
				spellCheck={false}
				autoComplete="off"
				onInput={(e) => FindFrame.Actions.setQuery(stores, e.currentTarget.value)}
				onKeyDown={onKeyDown}
				className={cn(
					'h-7 w-40 min-w-0 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground',
					empty && 'text-destructive',
				)}
			/>
			<span
				aria-live="polite"
				className={cn('min-w-16 shrink-0 text-right text-xs tabular-nums', empty ? 'text-destructive' : 'text-muted-foreground')}
			>
				{counter === null
					? null
					: counter.total === 0
						? tr.text(SF_Msgs.noMatches())
						: tr.text(
								counter.truncated
									? SF_Msgs.counterTruncated(counter.current, counter.total)
									: SF_Msgs.counter(counter.current, counter.total),
							)}
			</span>
			<Button
				type="button"
				size="icon"
				variant={caseSensitive ? 'secondary' : 'ghost'}
				aria-pressed={caseSensitive}
				title={tr.text(SF_Msgs.caseSensitive())}
				aria-label={tr.text(SF_Msgs.caseSensitive())}
				className="h-7 w-7"
				onClick={() => FindFrame.Actions.setCaseSensitive(stores, !caseSensitive)}
			>
				<Icons.CaseSensitive className="h-4 w-4" />
			</Button>
			<Button
				type="button"
				size="icon"
				variant={wholeWord ? 'secondary' : 'ghost'}
				aria-pressed={wholeWord}
				title={tr.text(SF_Msgs.wholeWord())}
				aria-label={tr.text(SF_Msgs.wholeWord())}
				className="h-7 w-7"
				onClick={() => FindFrame.Actions.setWholeWord(stores, !wholeWord)}
			>
				<Icons.WholeWord className="h-4 w-4" />
			</Button>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				disabled={!counter || counter.total === 0}
				aria-label={tr.text(SF_Msgs.previous())}
				title={tr.text(SF_Msgs.previous())}
				className="h-7 w-7"
				onClick={() => FindFrame.Actions.prev(stores)}
			>
				<Icons.ChevronUp className="h-4 w-4" />
			</Button>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				disabled={!counter || counter.total === 0}
				aria-label={tr.text(SF_Msgs.next())}
				title={tr.text(SF_Msgs.next())}
				className="h-7 w-7"
				onClick={() => FindFrame.Actions.next(stores)}
			>
				<Icons.ChevronDown className="h-4 w-4" />
			</Button>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				aria-label={tr.text(SF_Msgs.closeBar())}
				title={tr.text(SF_Msgs.closeBar())}
				className="h-7 w-7"
				onClick={() => FindFrame.Actions.close(stores)}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
			{!supported && <span className="px-1 text-xs text-destructive">{tr.text(SF_Msgs.unsupported())}</span>}
		</div>
	)
}
