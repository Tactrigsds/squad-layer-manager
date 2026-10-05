import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import * as LayerSearchPrt from '@/frame-partials/layer-search.partial.ts'
import type * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { tr } from '@/systems/messages.client'

import { RichSearchField, SearchErrors, SearchSuggestions } from './layer-search-parts.tsx'
import { useSearchInput } from './layer-search.helpers.ts'
import { Input } from './ui/input.tsx'

// The desktop picker's search bar above the results, with the toggle for Advanced search beside it. While the box is
// not being edited it reads the search back as chips; a click turns it into a plain text input, with the words that
// matched nothing, or the recent searches, in a panel beneath. Leaving the input turns it back.
export default function LayerSearchBar(props: { frameKey: SelectLayersFrame.Key }) {
	const [editing, setEditing] = React.useState(false)
	const advancedOpen = Zus.useStore(LayerSearchPrt.SearchPrefsStore, (s) => s.advancedOpen)
	return (
		<div role="search" className="flex shrink-0 gap-1.5">
			{editing ? (
				<SearchEditor frameKey={props.frameKey} onDone={() => setEditing(false)} />
			) : (
				<RichSearchField frameKey={props.frameKey} onOpen={() => setEditing(true)} />
			)}
			<Button
				className="shrink-0"
				aria-pressed={advancedOpen}
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => LayerSearchPrt.Actions.setAdvancedOpen(!advancedOpen)}
			>
				<Icons.SlidersHorizontal />
				{tr.text(L_Msgs.advancedSearchToggle())}
			</Button>
		</div>
	)
}

function SearchEditor(props: { frameKey: SelectLayersFrame.Key; onDone: () => void }) {
	const { frameKey } = props
	const { inputRef, initialText, setTextDebounced, finish, setInput, keepFocus } = useSearchInput(frameKey)
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)
	const hasErrors = Zus.useStore(frameKey, (s) => LayerSearchPrt.Sel.errors(s).length > 0)
	const empty = Zus.useStore(frameKey, (s) => LayerSearchPrt.Sel.text(s).trim().length === 0)
	const hasSuggestions = Zus.useStore(LayerSearchPrt.SearchPrefsStore, (s) => s.searches.length > 0 || !s.tipsDismissed)
	const showPanel = hasErrors || (empty && hasSuggestions)

	return (
		<div className="relative min-w-0 flex-1">
			<Icons.Search className="pointer-events-none absolute inset-s-2.5 top-1/2 z-1 size-4 -translate-y-1/2 text-text-3" />
			<Input
				ref={inputRef}
				type="search"
				// the editor mounts from a click on the search box, so focus is what the user asked for
				autoFocus
				autoComplete="off"
				aria-label={tr.text(L_Msgs.searchLayers())}
				placeholder={tr.text(L_Msgs.searchLayers())}
				defaultValue={initialText}
				className="ps-8 font-mono"
				onChange={(e) => setTextDebounced(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === 'Escape') {
						// Escape is the search box's, not the dialog's
						e.stopPropagation()
						e.currentTarget.blur()
					}
				}}
				onBlur={() => {
					finish()
					props.onDone()
				}}
			/>
			{showPanel && (
				<div
					className="fd-pop absolute inset-x-0 top-full mt-1 flex max-h-96 flex-col gap-2 overflow-y-auto p-2"
					style={{ zIndex }}
					onMouseDown={keepFocus}
				>
					<SearchErrors frameKey={frameKey} inputRef={inputRef} setInput={setInput} />
					<SearchSuggestions frameKey={frameKey} setInput={setInput} />
				</div>
			)}
		</div>
	)
}
