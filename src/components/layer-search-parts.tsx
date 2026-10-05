import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import * as LayerSearchPrt from '@/frame-partials/layer-search.partial.ts'
import type * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as L_Msgs from '@/messages/layer.messages'
import type * as BB from '@/models/backburner.models'
import type * as F from '@/models/filter.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

import EmojiDisplay from './emoji-display.tsx'
import { errorKeys, exampleSearches, partColumnName, replaceToken } from './layer-search.helpers.ts'

// The pieces of the layer search shared by the phone and desktop pickers: the search read back as chips, the cards
// for words that matched nothing, and the recent searches or tips shown while the box is empty.

// The search read back while the box is not being edited: one chip per constraint, Advanced ones included
export function RichSearchField(props: { frameKey: SelectLayersFrame.Key; onOpen: () => void; className?: string }) {
	const parts = Zus.useStore(props.frameKey, LayerSearchPrt.Sel.parts)
	return (
		<div className={cn('relative flex min-w-0 flex-1', props.className)}>
			<button
				type="button"
				aria-label={tr.text(L_Msgs.searchLayers())}
				onClick={props.onOpen}
				className={cn(
					'fd-inp flex h-auto min-h-(--ctl) w-full cursor-text flex-wrap items-center gap-1 py-1 ps-9 text-start',
					parts.length > 0 ? 'pe-11' : 'pe-2',
				)}
			>
				<Icons.Search className="pointer-events-none absolute inset-s-2.5 top-[calc(var(--ctl)/2)] size-4.5 -translate-y-1/2 text-text-3" />
				{parts.length === 0 ? (
					<span className="text-text-3">{tr.text(L_Msgs.searchLayers())}</span>
				) : (
					parts.map((part) => <SearchPartChip key={part.key} part={part} />)
				)}
			</button>
			{parts.length > 0 && (
				<Button
					variant="ghost"
					size="icon"
					className="absolute inset-e-0 top-0"
					aria-label={tr.text(L_Msgs.clearSearch())}
					onClick={() => LayerSearchPrt.Actions.clear({ layerSearch: props.frameKey })}
				>
					<Icons.X />
				</Button>
			)}
		</div>
	)
}

function SearchPartChip(props: { part: LayerSearchPrt.Sel.Part }) {
	const { part } = props
	switch (part.type) {
		case 'item':
			return (
				<span className="fd-chip max-w-full gap-1 text-sm">
					<span className="text-text-3">
						{partColumnName(part.field)}
						{part.op !== 'eq' && ` ${tr.text(F_Msgs.compOpLabels[part.op])}`}
					</span>
					<span className="truncate text-text">{part.values.join(', ')}</span>
				</span>
			)
		case 'filter':
			return <SearchFilterChip filterId={part.filterId} />
		case 'error':
			return <span className="fd-chip max-w-full bg-danger/25 text-sm text-text">{part.token}</span>
		default:
			return null
	}
}

function SearchFilterChip(props: { filterId: F.FilterEntityId }) {
	const filter = FilterEntityClient.useFilterEntities().get(props.filterId)
	if (!filter) return null
	return (
		<span className="fd-chip max-w-full gap-1 text-sm">
			{filter.emoji && <EmojiDisplay size={14} emoji={filter.emoji} showTooltip={false} />}
			<span className="truncate text-text">{filter.name}</span>
		</span>
	)
}

export function SearchErrors(props: {
	frameKey: SelectLayersFrame.Key
	inputRef: React.RefObject<HTMLInputElement | null>
	setInput: (value: string) => void
}) {
	const errors = Zus.useStore(props.frameKey, LayerSearchPrt.Sel.errors)
	return errorKeys(errors).map(({ key, error }) => (
		<SearchError
			key={key}
			error={error}
			onPick={(suggestion) =>
				props.setInput(
					replaceToken(
						props.inputRef.current?.value ?? LayerSearchPrt.Sel.text(Zus.getState(props.frameKey)),
						error.token,
						suggestion,
					),
				)
			}
		/>
	))
}

// recent searches once there are some, else the search tips, while the box is empty
export function SearchSuggestions(props: { frameKey: SelectLayersFrame.Key; setInput: (value: string) => void }) {
	const empty = Zus.useStore(props.frameKey, (s) => LayerSearchPrt.Sel.text(s).trim().length === 0)
	const history = Zus.useStore(LayerSearchPrt.SearchPrefsStore, (s) => s.searches)
	const tipsDismissed = Zus.useStore(LayerSearchPrt.SearchPrefsStore, (s) => s.tipsDismissed)
	const [examples] = React.useState(exampleSearches)
	if (!empty) return null
	if (history.length > 0) {
		return (
			<section className="fd-panel flex flex-col">
				<div className="flex items-center gap-2 ps-3 pe-1">
					<h3 className="fd-lbl-k flex-1">{tr.text(L_Msgs.recentSearches())}</h3>
					<Button variant="ghost" size="sm" onClick={() => LayerSearchPrt.Actions.clearHistory()}>
						{tr.text(L_Msgs.clearRecentSearches())}
					</Button>
				</div>
				<ul>
					{history.map((search) => (
						<li key={search}>
							<button
								type="button"
								onClick={() => props.setInput(search)}
								className="flex min-h-(--mi-h) w-full items-center gap-2.5 border-t border-line px-3 text-start hover:bg-ctl"
							>
								<Icons.History className="size-4 shrink-0 text-text-3" />
								<span className="min-w-0 flex-1 truncate font-mono text-sm">{search}</span>
							</button>
						</li>
					))}
				</ul>
			</section>
		)
	}
	if (tipsDismissed) return null
	return (
		<div className="fd-panel flex items-start gap-1 py-2 ps-3 pe-1">
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<span className="text-sm text-text-2">{tr.text(L_Msgs.searchTips())}</span>
				<div className="flex flex-wrap gap-1.5">
					{examples.map((example) => (
						<Button key={example} size="sm" className="font-mono" onClick={() => props.setInput(example)}>
							{example}
						</Button>
					))}
				</div>
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={tr.text(L_Msgs.dismissSearchTips())}
				onClick={() => LayerSearchPrt.Actions.dismissTips()}
			>
				<Icons.X />
			</Button>
		</div>
	)
}

function SearchError(props: { error: BB.TokenError; onPick: (suggestion: string) => void }) {
	return (
		<div role="alert" className="flex flex-col gap-2 rounded-sm border border-danger/60 bg-danger/15 px-3 py-2.5">
			<span className="text-sm">{tr.text(props.error.msg)}</span>
			{props.error.suggestions.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-text-2">{tr.text(L_Msgs.didYouMean())}</span>
					{props.error.suggestions.map((suggestion) => (
						<Button key={suggestion} size="sm" onClick={() => props.onPick(suggestion)}>
							{suggestion}
						</Button>
					))}
				</div>
			)}
		</div>
	)
}
