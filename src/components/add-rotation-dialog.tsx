import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { LayerTags } from '@/components/layer-tags'
import { LayerTextImportFields } from '@/components/layer-text-import'
import { splitNotes, useLayerTextImport } from '@/components/layer-text-import.helpers'
import ShortLayerName from '@/components/short-layer-name'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import TabsList from '@/components/ui/tabs-list'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ListHostPrt from '@/frame-partials/list-host.partial'
import { useDebounced } from '@/hooks/use-debounce'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import type * as LTag from '@/models/layer-tags.models'
import type * as ROT from '@/models/rotations.models'
import { tr } from '@/systems/messages.client'
import * as RotationClient from '@/systems/rotation.client'

type Tab = 'paste' | 'saved'

// Adds a rotation to the queue: one pasted as layer lines, YAML or plain text, or one saved on the rotations page
export function AddRotationDialog(props: {
	stores: ListHostPrt.KeyProp
	open: boolean
	onOpenChange: (open: boolean) => void
	installedMods?: readonly string[]
}) {
	const [tab, setTab] = React.useState<Tab>('paste')
	const [placement, setPlacement] = React.useState<LL.Placement>('start')
	const [tags, setTags] = React.useState<LTag.TagId[]>([])
	const [selectedId, setSelectedId] = React.useState<ROT.RotationId | null>(null)
	const pasted = useLayerTextImport({ installedMods: props.installedMods })
	const [adding, setAdding] = React.useState(false)
	const selectedRes = useQuery({ ...RotationClient.getQuery(selectedId ?? ''), enabled: tab === 'saved' && !!selectedId })
	const selected = selectedId ? (selectedRes.data ?? undefined) : undefined

	const setOpen = (open: boolean) => {
		if (!open) {
			pasted.reset()
			setSelectedId(null)
		}
		props.onOpenChange(open)
	}

	const count = tab === 'paste' ? pasted.itemCount : (selected?.items.length ?? 0)
	const blocked = adding || (tab === 'paste' ? !pasted.ready : count === 0)
	const queue = { queue: props.stores.listHost }

	const submit = async () => {
		if (blocked) return
		if (tab === 'saved') {
			void LayerQueuePrt.Actions.addRotation(queue, { rotation: { type: 'saved', rotation: selected! }, placement, tags })
			setOpen(false)
			return
		}
		setAdding(true)
		try {
			const built = await pasted.buildItems()
			if (!built) return
			// a queue takes notes on a new item only from a saved rotation, so pasted notes follow as the user's own
			const { items, notes } = splitNotes(built)
			const ok = await LayerQueuePrt.Actions.addRotation(queue, { rotation: { type: 'items', items }, placement, tags })
			if (!ok) return
			for (const note of notes) {
				LayerQueuePrt.Actions.dispatchItemOp(queue, note.itemId, { op: 'add-note', noteId: LNote.createNoteId(), text: note.text })
			}
			setOpen(false)
		} finally {
			setAdding(false)
		}
	}

	return (
		<Dialog open={props.open} onOpenChange={setOpen}>
			<DialogContent className="w-auto max-w-[95vw] min-w-[min(700px,95vw)]">
				<DialogHeader>
					<DialogTitle>{tr.text(LL_Msgs.addRotationTitle())}</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					<TabsList
						options={[
							{ label: tr.text(LL_Msgs.addRotationPasteTab()), value: 'paste' },
							{ label: tr.text(LL_Msgs.addRotationSavedTab()), value: 'saved' },
						]}
						active={tab}
						setActive={setTab}
					/>
					{tab === 'paste' ? (
						<LayerTextImportFields
							importer={pasted}
							label={tr.text(LL_Msgs.addRotationPasteTab())}
							placeholder={tr.text(LL_Msgs.pasteRotationPlaceholder())}
							validateToggle
						/>
					) : (
						<SavedRotationPicker
							stores={props.stores}
							insertAt={placement === 'end' ? 'end' : 'start'}
							selectedId={selectedId}
							selected={selected}
							onSelect={setSelectedId}
						/>
					)}
					<div className="flex flex-wrap items-center justify-end gap-2">
						<PlacementButtons placement={placement} onChange={setPlacement} />
						<LayerTags
							tags={tags}
							onAdd={(tagId) => setTags((prev) => [...prev, tagId])}
							onRemove={(tagId) => setTags((prev) => prev.filter((id) => id !== tagId))}
						/>
						<span className="flex-1" />
						<Button variant="outline" onClick={() => setOpen(false)}>
							{tr.text(UI_Msgs.cancel())}
						</Button>
						<Button submitChord="manual" variant="primary" onClick={() => void submit()} disabled={blocked}>
							{tr.text(tab === 'paste' && !pasted.hasVotes ? L_Msgs.addLayers(count) : LL_Msgs.addRotationItems(count))}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

function SavedRotationPicker(props: {
	stores: ListHostPrt.KeyProp
	insertAt: 'start' | 'end'
	selectedId: ROT.RotationId | null
	selected: ROT.Rotation | undefined
	onSelect: (id: ROT.RotationId) => void
}) {
	const { selected } = props
	const insertion = Zus.useStore(props.stores.listHost, Zus.useShallow(ListHostPrt.Sel.insertionPoint(props.insertAt)))
	const [query, setQuery] = React.useState('')
	const onQuery = useDebounced({ delay: 200, onChange: setQuery })
	const searchRes = useInfiniteQuery(RotationClient.searchQuery({ q: query, sort: 'name' }))
	const shown = searchRes.data?.pages.flatMap((page) => page.rotations) ?? []

	return (
		// the preview takes the width its layer names need, and only wraps them where even its own row is too narrow
		<div className="flex flex-wrap gap-3">
			<div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-2">
				<Input type="search" placeholder={tr.text(LL_Msgs.searchRotations())} onChange={(e) => onQuery(e.target.value)} />
				<ul
					aria-label={tr.text(LL_Msgs.addRotationSavedTab())}
					className="flex max-h-72 min-h-40 flex-col overflow-y-auto rounded-md border"
				>
					{searchRes.isSuccess && shown.length === 0 && (
						<li className="p-3 text-sm text-muted-foreground">{tr.text(LL_Msgs.noRotationsMatch())}</li>
					)}
					{shown.map((rotation) => (
						<li key={rotation.id}>
							<button
								type="button"
								aria-pressed={rotation.id === props.selectedId}
								onClick={() => props.onSelect(rotation.id)}
								className={cn(
									'flex w-full flex-col items-start px-3 py-1.5 text-start text-sm hover:bg-accent',
									rotation.id === props.selectedId && 'bg-accent',
								)}
							>
								<span className="w-full truncate font-medium">{rotation.name}</span>
								{rotation.description && (
									<span className="w-full truncate text-xs text-muted-foreground">{rotation.description}</span>
								)}
							</button>
						</li>
					))}
					{searchRes.hasNextPage && (
						<li>
							<Button
								variant="ghost"
								size="sm"
								className="w-full"
								disabled={searchRes.isFetchingNextPage}
								onClick={() => void searchRes.fetchNextPage()}
							>
								{tr.text(UI_Msgs.showMore())}
							</Button>
						</li>
					)}
				</ul>
			</div>
			<div className="min-w-0 max-w-full flex-[0_1_auto] rounded-md border p-2">
				{selected ? (
					<ol aria-label={selected.name} className="flex max-h-80 flex-col gap-0.5 overflow-y-auto text-sm">
						{selected.items.map((item, i) => (
							<li key={item.itemId} className="flex items-baseline gap-2">
								<span className="w-8 shrink-0 text-end font-mono text-xs text-muted-foreground">
									<bdi dir="ltr">{LL.getItemNumber({ outerIndex: insertion.queueOffset + i, innerIndex: null })}</bdi>
								</span>
								{item.type === 'vote-list-item' ? (
									<span className="flex min-w-0 flex-col gap-0.5">
										{item.choices.map((choice) => (
											<span key={choice.itemId} className="flex min-w-0 items-baseline gap-1">
												<Icons.Vote className="h-3 w-3 shrink-0 self-center text-muted-foreground" aria-hidden />
												<ShortLayerName layerId={choice.layerId} teamParity={insertion.parity + i} allowShowInfo={false} />
											</span>
										))}
									</span>
								) : (
									<ShortLayerName layerId={item.layerId} teamParity={insertion.parity + i} allowShowInfo={false} />
								)}
							</li>
						))}
					</ol>
				) : (
					<p className="p-2 text-sm text-muted-foreground">{tr.text(LL_Msgs.pickRotationToPreview())}</p>
				)}
			</div>
		</div>
	)
}

// where the added layers go, as one button group
export function PlacementButtons(props: { placement: LL.Placement; onChange: (placement: LL.Placement) => void }) {
	return (
		<TabsList
			variant="seg"
			options={[
				{ label: tr.text(LL_Msgs.placeReplace()), value: 'replace' },
				{ label: tr.text(LL_Msgs.placeStart()), value: 'start' },
				{ label: tr.text(LL_Msgs.placeEnd()), value: 'end' },
			]}
			active={props.placement}
			setActive={props.onChange}
		/>
	)
}
