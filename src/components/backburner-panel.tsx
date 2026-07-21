import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TriStateCheckbox } from '@/components/ui/tri-state-checkbox'
import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial.ts'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as RequestFrame from '@/frames/backburner-request.frame'
import { frameManager } from '@/frames/frame-manager'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as BB from '@/models/backburner.models'
import * as CMDH from '@/models/command-help.models'
import * as CB from '@/models/constraint-builders'
import type * as DND from '@/models/dndkit.models'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as RBAC from '@/rbac.models'
import * as DndKit from '@/systems/dndkit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import { CopyableCommand } from './commands-page.tsx'

import { FilterCheckbox, PoolFilterCheckbox } from './applied-filters-panel.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import EmojiDisplay from './emoji-display.tsx'
import type { ComparisonHandle, MatchupActions } from './filter-card'
import { Comparison, MatchupConfig } from './filter-card'
import { FilterEntityLabel } from './filter-entity-select.tsx'
import { ListEditor } from './list-editor.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { ButtonGroup } from './ui/button-group'

type StoresProp = { stores: SquadServerFrame.KeyProp }

// sentinel drop target covering the whole panel, so a queue item can be dropped anywhere on it (including the
// empty state) to become a request. Only enabled while a layer-item is being dragged; the id is never read.
const PANEL_DROP_ITEM: DND.DropItem = {
	type: 'relative-to-drag-item',
	slots: [{ position: 'on', dragItem: { type: 'backburner-item', id: '__backburner-panel__' } }],
}

export default function BackburnerPanel(props: StoresProp) {
	const serverId = props.stores.squadServer!.serverId
	const items = ZusUtils.useStore(props.stores.squadServer!, s => s.queue.backburner)
	const modified = ZusUtils.useStore(props.stores.squadServer!, s => s.queue.backburnerModified)
	const canWriteQueue = RbacClient.usePermsCheck(RBAC.perm('queue:write')) === null
	const perms = RbacClient.useLoggedInPerms()
	const canRequest = canWriteQueue || RBAC.maxLayerRequests(perms) !== undefined

	const [isEditing, setIsEditing] = UPClient.useEditingLayerRequestsState(serverId)
	const numEditors = ZusUtils.useStore(UPClient.Store, s => s.layerRequestEditors.size)
	const [forceSave, setForceSave] = React.useState(false)

	const [editorState, setEditorState] = React.useState<{ open: boolean; itemId: string | null }>({ open: false, itemId: null })
	// a request dragged onto the queue whose template still has a choice to make: the Select Layers dialog opens
	// seeded from it, and on commit the picked layer is added to the queue at `index` while the request is consumed
	const [queueDrop, setQueueDrop] = React.useState<{ itemId: string; filter: F.FilterNode; index: LL.ItemIndex } | null>(null)
	const dragging = DndKit.useDragging()
	const panelDrop = DndKit.useDroppable(PANEL_DROP_ITEM, { disabled: dragging?.type !== 'layer-item' || !canRequest })

	const satisfiable = useBackburnerSatisfiability(items)
	const combinableWith = useCombinability(items)

	const queueKey: LayerQueuePrt.KeyProp = React.useMemo(() => ({ queue: props.stores.squadServer! }), [props.stores.squadServer])

	const consumeRequest = React.useCallback((itemId: string, index: LL.ItemIndex, newItems: LL.NewItem[]) => {
		void LayerQueuePrt.Actions.dispatch(queueKey, { op: 'add', items: newItems, index })
		// consuming the request is a requests-draft edit, committed via the panel's own save
		LayerQueuePrt.Actions.removeBackburnerItems(queueKey, [itemId])
	}, [queueKey])

	const handleFinishOrSave = () => {
		const shouldSave = modified && (numEditors <= 1 || forceSave)
		// clears layer-request editing across all of this user's clients via the presence reducer fan-out
		setIsEditing(false)
		if (shouldSave) {
			LayerQueuePrt.Actions.saveBackburner(queueKey, { force: forceSave })
		}
		setForceSave(false)
	}

	const saveButtonLabel = forceSave
		? 'Force Save'
		: (numEditors <= 1 && modified)
		? 'Save'
		: 'Finish Editing'

	DndKit.useDragEnd(React.useCallback(event => {
		if (!event.over) return
		const backburnerSlot = event.over.slots.find(s => s.dragItem.type === 'backburner-item')
		const queueSlot = event.over.slots.find(s => s.dragItem.type === 'layer-item')

		if (event.active.type === 'backburner-item') {
			const activeId = event.active.id
			if (backburnerSlot) {
				// reorder or combine within the requests list
				const overId = backburnerSlot.dragItem.id.toString()
				if (activeId === overId) return
				if (backburnerSlot.position === 'on') {
					LayerQueuePrt.Actions.combineBackburnerItems(queueKey, overId, activeId)
					return
				}
				const currentItems = ZusUtils.getState(props.stores.squadServer!).queue.backburner
				const fromIndex = currentItems.findIndex(item => item.itemId === activeId)
				let targetIndex = currentItems.findIndex(item => item.itemId === overId)
				if (fromIndex === -1 || targetIndex === -1) return
				if (backburnerSlot.position === 'after') targetIndex++
				// the reorder op removes the item before re-inserting, which shifts downstream indices by one
				if (fromIndex < targetIndex) targetIndex--
				LayerQueuePrt.Actions.reorderBackburnerItem(queueKey, activeId, targetIndex)
				return
			}
			if (queueSlot && canWriteQueue) {
				const item = ZusUtils.getState(props.stores.squadServer!).queue.backburner.find(i => i.itemId === activeId)
				if (!item) return
				const queueList = LayerQueuePrt.Sel.layerList(ZusUtils.getState(props.stores.squadServer!))
				const cursors = LL.dropItemToLLItemCursors(event.over)
				const resolved = cursors[0] ? LL.resolveCursorIndex(queueList, cursors[0]) : undefined
				const index = resolved ?? { outerIndex: 0, innerIndex: null }
				void onlyMatchingLayer(item.filter).then(layerId => {
					// a template with a single solution has nothing left to pick, so skip the dialog
					if (layerId) consumeRequest(item.itemId, index, [{ type: 'single-list-item', layerId }])
					else setQueueDrop({ itemId: item.itemId, filter: item.filter, index })
				})
			}
			return
		}

		if (event.active.type === 'layer-item' && backburnerSlot && canRequest) {
			// dragged a queue item into the requests: create a template capturing its layer, and move it out of
			// the queue by removing the original
			const queueList = LayerQueuePrt.Sel.layerList(ZusUtils.getState(props.stores.squadServer!))
			const item = LL.findItemById(queueList, event.active.id)?.item
			if (!item || LL.isVoteItem(item) || !item.layerId) return
			LayerQueuePrt.Actions.addBackburnerItem(queueKey, { filter: BB.templateFromLayer(L.toLayer(item.layerId)) })
			if (canWriteQueue) LayerQueuePrt.Actions.dispatchItemOp(queueKey, event.active.id, { op: 'delete' })
		}
	}, [queueKey, props.stores.squadServer, canWriteQueue, canRequest, consumeRequest]))

	const commitQueueDrop = React.useCallback((newItems: LL.NewItem[]) => {
		// side effects must NOT live in a setState updater: StrictMode invokes updaters twice in dev, which
		// double-dispatched the add. Read the pending drop directly and clear it separately.
		if (!queueDrop) return
		consumeRequest(queueDrop.itemId, queueDrop.index, newItems)
		setQueueDrop(null)
	}, [queueDrop, consumeRequest])

	const commandSettings = ZusUtils.useStore(SettingsClient.PublicSettingsStore, s => s?.commands.requestLayer)
	const commandExamples = commandSettings ? CMDH.buildExamples('requestLayer', commandSettings, { reasons: [] }) : []
	const commandExample: CMDH.CommandExample | undefined = commandExamples[0]

	if (items.length === 0 && !canRequest) return null

	const showDropHint = dragging?.type === 'layer-item' && canRequest

	return (
		<div ref={panelDrop.ref} className={cn('rounded-md', showDropHint && 'ring-2 ring-inset ring-primary/50')}>
			<Separator />
			<CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
				<CardTitle className="flex items-center gap-2 text-base">
					Layer Requests ({items.length})
					{modified && <Badge variant="outline">unsaved</Badge>}
					<Tooltip>
						<TooltipTrigger asChild>
							<Icons.Info className="h-3.5 w-3.5 text-muted-foreground" />
						</TooltipTrigger>
						<TooltipContent className="max-w-72">
							<p>
								"Layer Requests" will be made part of the layer generation process if the layer queue runs out of explicitely set layers.
							</p>
							<br />
							<p>
								Ingame command example: <CopyableCommand cmdString={commandExample?.command} chatScope="ChatToAdmin" />
							</p>
						</TooltipContent>
					</Tooltip>
				</CardTitle>
				<span className="flex items-center gap-1">
					{canRequest && (
						isEditing
							? (
								<>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7"
												disabled={!modified}
												onClick={() => LayerQueuePrt.Actions.resetBackburner(queueKey)}
											>
												<Icons.Undo2 className="h-3.5 w-3.5" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>Revert to saved</TooltipContent>
									</Tooltip>
									<Button size="sm" variant="secondary" onClick={() => setEditorState({ open: true, itemId: null })}>
										<Icons.ListPlus className="mr-1 h-4 w-4" />
										Request layer
									</Button>
									<ButtonGroup>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													size="icon"
													className="h-8 w-8"
													variant={forceSave ? 'destructive' : 'secondary'}
													onClick={() => setForceSave(!forceSave)}
												>
													<Icons.Sword className="h-3.5 w-3.5" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>Toggle force save (save even if others are still editing)</TooltipContent>
										</Tooltip>
										<Button
											size="sm"
											variant={forceSave ? 'destructive' : 'default'}
											onClick={handleFinishOrSave}
										>
											{saveButtonLabel}
										</Button>
									</ButtonGroup>
								</>
							)
							: (
								<Button size="sm" variant="outline" aria-label="Edit layer requests" onClick={() => setIsEditing(true)}>
									<Icons.Edit className="mr-1 h-3.5 w-3.5" />
									Start Editing
								</Button>
							)
					)}
				</span>
			</CardHeader>
			<CardContent className="pb-3">
				{items.length === 0 && <span className="text-sm text-muted-foreground">No layer requests queued.</span>}
				<ul>
					{items.map((item, index) => (
						<React.Fragment key={item.itemId}>
							{index === 0 && <RowSeparator slot={{ position: 'before', itemId: item.itemId }} />}
							<BackburnerRow
								stores={props.stores}
								itemId={item.itemId}
								canWriteQueue={canWriteQueue}
								canRequest={canRequest}
								satisfiable={satisfiable?.[item.itemId]}
								combinable={combinableWith?.[item.itemId] ?? false}
								onEdit={() => setEditorState({ open: true, itemId: item.itemId })}
							/>
							<RowSeparator slot={{ position: 'after', itemId: item.itemId }} />
						</React.Fragment>
					))}
				</ul>
			</CardContent>
			<BackburnerItemDialog
				stores={props.stores}
				open={editorState.open}
				itemId={editorState.itemId}
				onClose={() => setEditorState(prev => ({ ...prev, open: false }))}
			/>
			<QueueDropDialog
				stores={props.stores}
				drop={queueDrop}
				onCommit={commitQueueDrop}
				onClose={() => setQueueDrop(null)}
			/>
		</div>
	)
}

// the Select Layers dialog shown when a request is dragged into the queue: the menu is seeded from the request's
// template (matchup left -> Team 1, right -> Team 2) so the user only has to narrow to a concrete layer
function QueueDropDialog(
	props: StoresProp & {
		drop: { itemId: string; filter: F.FilterNode; index: LL.ItemIndex } | null
		onCommit: (items: LL.NewItem[]) => void
		onClose: () => void
	},
) {
	const [frameKey, setFrameKey] = React.useState<SelectLayersFrame.Key | null>(null)
	const filter = props.drop?.filter
	React.useEffect(() => {
		if (!filter) {
			setFrameKey(null)
			return
		}
		const input = SelectLayersFrame.createInput({ startingTemplate: filter, squadServer: props.stores.squadServer })
		const key = frameManager.ensureSetup(SelectLayersFrame.frame, input)
		setFrameKey(key)
		return () => {
			setFrameKey(null)
			frameManager.dropKey(key)
		}
	}, [filter, props.stores.squadServer])

	if (!props.drop || !frameKey) return null
	return (
		<SelectLayersDialog
			title="Add requested layer"
			open={true}
			onOpenChange={open => !open && props.onClose()}
			stores={{ selectLayers: frameKey, squadServer: props.stores.squadServer }}
			selectQueueItems={props.onCommit}
		/>
	)
}

// the one layer a template leaves to pick, or null when there is still a choice to make (also on a failed
// query, which falls back to the picker). The matchup is locked the way the dialog seeds it -- left spec to
// team 1 -- so an either-orientation template of a single layer counts as one option rather than two
async function onlyMatchingLayer(filter: F.FilterNode): Promise<L.LayerId | null> {
	const parts = BB.parseTemplateParts(filter)
	const oriented = parts.matchup
		? BB.buildTemplateFilter({ ...parts, matchup: { ...parts.matchup, locked: true } })
		: filter
	try {
		const packet = await Rx.firstValueFrom(
			LayerQueriesClient.queryLayers$({
				constraints: [CB.filterAnon('backburner-drop', oriented)],
				pageSize: 2,
				sort: null,
			}).pipe(Rx.filter(packet => packet.code === 'layers-page')),
		)
		return packet.totalCount === 1 ? packet.layers[0]?.id ?? null : null
	} catch (error) {
		console.warn('backburner drop match query failed:', error)
		return null
	}
}

// per-item "still has solutions" flags, refreshed when the items change. Templates carry their own filters
// (incl. pool membership), so the probe applies nothing on top; do-not-repeat rules stay out (transient),
// matching the server's request-time validation.
function useBackburnerSatisfiability(items: BB.BackburnerItem[]) {
	// items carry bigint owner ids, which dep keys can't stringify; the templates are the queried part anyway
	const templates = React.useMemo(() => items.map(item => ({ itemId: item.itemId, filter: item.filter })), [items])
	const depKey = LayerQueriesClient.useDepKey({ templates })
	return useQuery({
		queryKey: ['backburner-satisfiable', depKey],
		enabled: items.length > 0,
		queryFn: async () => {
			const res = await LayerQueriesClient.checkBackburnerTemplates({ constraints: [], templates })
			return res.code === 'ok' ? res.satisfiable : {}
		},
	}).data
}

// while a backburner row is being dragged: which OTHER rows its template can merge into. A merge that fails
// outright (conflicting filters) or would have no solutions is uncombinable; the server re-validates on dispatch.
function useCombinability(items: BB.BackburnerItem[]) {
	const dragging = DndKit.useDragging()
	const draggingId = dragging?.type === 'backburner-item' ? dragging.id : null
	const dragged = draggingId ? items.find(item => item.itemId === draggingId) : undefined
	// each candidate probed as if the dragged template were merged into it (bigint owner ids kept out of the key)
	const { templates, conflicted } = React.useMemo(() => {
		const templates: { itemId: string; filter: F.FilterNode }[] = []
		const conflicted: string[] = []
		if (dragged) {
			for (const item of items) {
				if (item.itemId === dragged.itemId) continue
				const merged = BB.mergeTemplateFilters(item.filter, dragged.filter)
				if (merged.code === 'ok') templates.push({ itemId: item.itemId, filter: merged.filter })
				else conflicted.push(item.itemId)
			}
		}
		return { templates, conflicted }
	}, [items, dragged])
	const depKey = LayerQueriesClient.useDepKey({ templates, conflicted })
	return useQuery({
		queryKey: ['backburner-combinable', depKey],
		enabled: templates.length > 0 || conflicted.length > 0,
		queryFn: async () => {
			const res = await LayerQueriesClient.checkBackburnerTemplates({ constraints: [], templates })
			const satisfiable = res.code === 'ok' ? { ...res.satisfiable } : {}
			for (const itemId of conflicted) satisfiable[itemId] = false
			return satisfiable
		},
	}).data
}

function RowSeparator(props: { slot: { position: 'before' | 'after'; itemId: string } }) {
	const dropItem: DND.DropItem = {
		type: 'relative-to-drag-item',
		slots: [{ position: props.slot.position, dragItem: { type: 'backburner-item', id: props.slot.itemId } }],
	}
	// the pointer decides the target: over a row = combine, in the (drag-expanded) gap = reorder. Without
	// this, shape-overlap collision lets the full-height rows swallow every drop and reordering is impossible.
	// isDropTarget must be read unconditionally: the read is what subscribes this component to target changes
	const { ref, isDropTarget } = DndKit.useDroppable(dropItem, { collisionDetector: DndKit.livePointerIntersection })
	const dragging = DndKit.useDragging()
	const active = dragging?.type === 'backburner-item'
	return (
		<Separator
			ref={ref}
			className={cn('w-full', active ? 'h-5' : 'h-1', active && isDropTarget ? 'bg-accent' : 'bg-transparent')}
		/>
	)
}

function BackburnerRow(
	props: StoresProp & {
		itemId: string
		canWriteQueue: boolean
		canRequest: boolean
		satisfiable: boolean | undefined
		combinable: boolean
		onEdit: () => void
	},
) {
	const item = ZusUtils.useStore(props.stores.squadServer!, LayerQueuePrt.Sel.backburnerItem(props.itemId))
	const displayedMutation = ZusUtils.useStore(
		props.stores.squadServer!,
		s => getDisplayedMutation(LayerQueuePrt.Sel.backburnerItemMutation(props.itemId)(s)),
	)
	const loggedInUserId = UsersClient.loggedInUserId
	const dragging = DndKit.useDragging()

	const dragProps = DndKit.useDraggable({ type: 'backburner-item', id: props.itemId }, { feedback: 'default' })
	const { ref: dropRef, isDropTarget } = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position: 'on', dragItem: { type: 'backburner-item', id: props.itemId } }],
	}, { collisionDetector: DndKit.livePointerIntersection })

	if (!item) return null
	const isOwn = loggedInUserId !== undefined && item.source.discordId === loggedInUserId
	const canEdit = props.canWriteQueue || isOwn
	const draggingOther = dragging?.type === 'backburner-item' && dragging.id !== props.itemId
	const combineTarget = draggingOther && isDropTarget

	const queueKey: LayerQueuePrt.KeyProp = { queue: props.stores.squadServer! }

	return (
		<li
			ref={el => {
				dragProps.ref(el)
				dropRef(el)
			}}
			data-is-dragging={dragProps.isDragging}
			data-mutation={displayedMutation}
			className={cn(
				'flex items-center gap-2 rounded-md border border-transparent px-1 py-1 text-sm data-[is-dragging=true]:opacity-50',
				'bg-opacity-30 data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited',
				combineTarget && (props.combinable ? 'border-primary bg-primary/10' : 'border-destructive/50'),
			)}
		>
			<button
				type="button"
				ref={dragProps.handleRef}
				className={cn('cursor-grab text-muted-foreground', !canEdit && 'invisible')}
				disabled={!canEdit}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			{props.satisfiable !== undefined && (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className={cn('h-2 w-2 shrink-0 rounded-full', props.satisfiable ? 'bg-green-500' : 'bg-amber-500')} />
					</TooltipTrigger>
					<TooltipContent>
						{props.satisfiable
							? 'This request has matching layers'
							: 'No layers match this request right now; it stays queued for later'}
					</TooltipContent>
				</Tooltip>
			)}
			<TemplateDisplay filter={item.filter} className="min-w-0 flex-1 truncate" />
			<OwnerName source={item.source} />
			{(canEdit || props.canRequest) && (
				<span className="flex items-center">
					{props.canRequest && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									className="h-7 w-7"
									onClick={() => LayerQueuePrt.Actions.addBackburnerItem(queueKey, { filter: item.filter })}
								>
									<Icons.Copy className="h-3.5 w-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Clone this request as your own</TooltipContent>
						</Tooltip>
					)}
					{canEdit && (
						<>
							<Button size="icon" variant="ghost" className="h-7 w-7" onClick={props.onEdit}>
								<Icons.Pencil className="h-3.5 w-3.5" />
							</Button>
							<Button
								size="icon"
								variant="ghost"
								className="h-7 w-7 text-destructive"
								aria-label="Remove request"
								onClick={() => LayerQueuePrt.Actions.removeBackburnerItems(queueKey, [props.itemId])}
							>
								<Icons.X className="h-3.5 w-3.5" />
							</Button>
						</>
					)}
				</span>
			)}
		</li>
	)
}

function OwnerName(props: { source: BB.BackburnerItem['source'] }) {
	const { data: userRes } = UsersClient.useUser(props.source.discordId, { enabled: props.source.discordId !== undefined })
	const name = (userRes?.code === 'ok' ? userRes.user.displayName : undefined)
		?? (props.source.steamId ? `steam:${props.source.steamId}` : 'unknown')
	return <span className="max-w-32 truncate text-xs text-muted-foreground" title={name}>{name}</span>
}

// what a template constrains, LayerDisplay-style but without team color-coding
function TemplateDisplay(props: { filter: F.FilterNode; className?: string }) {
	const filterEntities = FilterEntityClient.useFilterEntities()
	const parts = BB.templateDisplayParts(props.filter, id => filterEntities.get(id)?.name)
	return (
		<span className={cn('font-mono text-sm', props.className)} title={parts.map(part => part.text).join(' \u00b7 ')}>
			{parts.map((part, index) => {
				const entity = part.filterId ? filterEntities.get(part.filterId) : undefined
				// an excluded filter is indicated by its miss indicator, the same way the applied-filters panel reads it
				const emoji = part.excluded ? entity?.invertedEmoji ?? entity?.emoji : entity?.emoji
				return (
					<React.Fragment key={part.filterId ?? part.text}>
						{index > 0 && <span className="text-muted-foreground">{' \u00b7 '}</span>}
						<span className="inline-flex items-center gap-1 align-middle">
							{emoji && <EmojiDisplay emoji={emoji} size="sm" />}
							<span>{part.text}</span>
						</span>
					</React.Fragment>
				)
			})}
		</span>
	)
}

function BackburnerItemDialog(props: StoresProp & { open: boolean; itemId: string | null; onClose: () => void }) {
	const item = ZusUtils.useStore(
		props.stores.squadServer!,
		React.useCallback(
			(s: SquadServerFrame.State) => (props.itemId ? s.queue.backburner.find(i => i.itemId === props.itemId) : undefined),
			[props.itemId],
		),
	)

	const [frameKey, setFrameKey] = React.useState<RequestFrame.Key | null>(null)
	React.useEffect(() => {
		if (!props.open) return
		const input = RequestFrame.createInput({ startingFilter: item?.filter, squadServer: props.stores.squadServer })
		const key = frameManager.ensureSetup(RequestFrame.frame, input)
		setFrameKey(key)
		return () => {
			setFrameKey(null)
			frameManager.dropKey(key)
		}
		// the item is captured when the dialog opens; later live updates shouldn't reseed the form mid-edit
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.open, props.itemId])

	function save() {
		if (!frameKey) return
		const filter = RequestFrame.Sel.templateFilter(ZusUtils.getState(frameKey))
		if (filter.type === 'and' && filter.children.length === 0) {
			toast.warning('Empty request', { description: 'Pick at least one of layer, map, gamemode, version, matchup or a filter' })
			return
		}
		const queueKey: LayerQueuePrt.KeyProp = { queue: props.stores.squadServer! }
		if (props.itemId) LayerQueuePrt.Actions.updateBackburnerItem(queueKey, props.itemId, { filter })
		else LayerQueuePrt.Actions.addBackburnerItem(queueKey, { filter })
		props.onClose()
	}

	return (
		<Dialog open={props.open} onOpenChange={open => !open && props.onClose()}>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle>{props.itemId ? 'Edit layer request' : 'Request a layer'}</DialogTitle>
				</DialogHeader>
				{frameKey && <RequestEditor stores={{ backburnerRequest: frameKey, squadServer: props.stores.squadServer }} />}
				<DialogFooter className="items-center">
					{frameKey && <MatchingCount stores={{ backburnerRequest: frameKey }} />}
					<Button variant="outline" onClick={props.onClose}>Cancel</Button>
					<Button onClick={save}>{props.itemId ? 'Apply' : 'Add request'}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function RequestEditor(props: { stores: RequestFrame.KeyProp & Partial<SquadServerFrame.KeyProp> }) {
	const key = props.stores.backburnerRequest
	const [activeTab, matchup, preserved] = ZusUtils.useStore(
		key,
		ZusUtils.useDeep(s => [s.activeTab, s.matchup, s.preserved] as const),
	)
	const matchupSideOptions = ZusUtils.useStore(key, ZusUtils.useDeep(s => s.matchupSideOptions))
	// per side and dimension: only values that keep at least one layer possible, given everything else picked
	const allowedTeamValues = React.useCallback(
		(side: 0 | 1, column: F.TeamColumn): string[] | undefined => matchupSideOptions?.[side]?.[column],
		[matchupSideOptions],
	)

	const matchupActions: MatchupActions = React.useMemo(() => ({
		// the operator select is hidden: a layer request is always allow-matchups
		setType: () => {},
		setLocked: locked => RequestFrame.Actions.updateMatchup(props.stores, node => ({ ...node, locked })),
		swapTeams: () => RequestFrame.Actions.updateMatchup(props.stores, node => ({ ...node, teams: [node.teams[1], node.teams[0]] })),
		setTeamValues: (teamIndex, column, values) =>
			RequestFrame.Actions.updateMatchup(props.stores, node => {
				const teams: [F.MatchupTeamSpec, F.MatchupTeamSpec] = [...node.teams]
				teams[teamIndex] = { ...teams[teamIndex], [column]: values.length > 0 ? values : undefined }
				return { ...node, teams }
			}),
	}), [props.stores])

	// parts the form doesn't edit but a chat request may carry; preserved on save
	const extras = [
		...preserved.sizes,
		...(preserved.other.length > 0
			? [`${preserved.other.length} custom condition${preserved.other.length === 1 ? '' : 's'}`]
			: []),
	]

	const menuGridClass = 'grid grid-cols-[auto_min-content_auto_auto] gap-2 [&_button[role=combobox]]:w-full [&_button[role=combobox]]:px-2'

	return (
		<div className="flex gap-4">
			<div className="min-w-0 flex-1 space-y-3">
				<Tabs value={activeTab} onValueChange={value => RequestFrame.Actions.setActiveTab(props.stores, value as RequestFrame.IdentityTab)}>
					<TabsList className="grid w-full grid-cols-2">
						<TabsTrigger value="components">Components</TabsTrigger>
						<TabsTrigger value="layer">Specific layer</TabsTrigger>
					</TabsList>
					<TabsContent value="components">
						<div className={menuGridClass}>
							{RequestFrame.COMPONENT_FIELDS.map(field => <RequestMenuField key={field} field={field} stores={props.stores} />)}
						</div>
					</TabsContent>
					<TabsContent value="layer">
						<div className={menuGridClass}>
							<RequestMenuField field="Layer" stores={props.stores} />
						</div>
					</TabsContent>
				</Tabs>
				<div className="flex items-start gap-2">
					<span className="w-20 shrink-0 pt-2 text-sm text-muted-foreground">Matchup</span>
					<MatchupConfig
						node={matchup}
						actions={matchupActions}
						allowedTeamValues={allowedTeamValues}
						showTypeSelect={false}
					/>
				</div>
				{extras.length > 0 && (
					<p className="text-xs text-muted-foreground">
						Also constrained by {extras.join(', ')} (kept as-is).
					</p>
				)}
			</div>
			<RequestFiltersColumn stores={props.stores} />
		</div>
	)
}

// The dialog's filter column: the pool's configured quick-pick filters as pinned tri-state checkboxes,
// and below them the freely-chosen filters as one row each (picker + invert toggle + remove)
function RequestFiltersColumn(props: { stores: RequestFrame.KeyProp & Partial<SquadServerFrame.KeyProp> }) {
	const key = props.stores.backburnerRequest
	const filterEntities = FilterEntityClient.useFilterEntities()
	const poolFilterId = ZusUtils.useStore(
		props.stores.squadServer ?? null,
		s => s ? s.settings.saved.queue.mainPool.poolFilter?.filterId ?? null : null,
	)
	const selectableFilterIds = ZusUtils.useStore(
		props.stores.squadServer ?? null,
		ZusUtils.useShallow(s => s ? s.settings.saved.queue.mainPool.defaultSelectable.map(c => c.filterId) : []),
	)
	const extraIds = ZusUtils.useStore(key, ZusUtils.useDeep(s => Array.from(s.appliedFilters.localExtraFilters ?? [])))
		.filter(id => !selectableFilterIds.includes(id))
	const filterStates = ZusUtils.useStore(key, ZusUtils.useDeep(s => Object.fromEntries(s.appliedFilters.filterStates)))

	const appliedKey: AppliedFiltersPrt.KeyProp = { appliedFilters: key }
	const taken = new Set([...(poolFilterId ? [poolFilterId] : []), ...selectableFilterIds, ...extraIds])
	const optionsFor = (own?: string) =>
		Array.from(filterEntities.values())
			.filter(filter => filter.id !== poolFilterId && !selectableFilterIds.includes(filter.id))
			.map(filter => ({
				value: filter.id,
				label: <FilterEntityLabel filter={filter} />,
				keywords: [filter.name],
				disabled: filter.id !== own && taken.has(filter.id),
			}))
	const exhausted = optionsFor().every(option => option.disabled)

	const addExtra = (filterId: string) => {
		AppliedFiltersPrt.Actions.selectExtraFilters(appliedKey, prev => [...prev, filterId])
		AppliedFiltersPrt.Actions.setAppliedFilterState(appliedKey, filterId, 'regular')
	}
	const removeExtra = (filterId: string) =>
		AppliedFiltersPrt.Actions.selectExtraFilters(appliedKey, prev => prev.filter(id => id !== filterId))
	const replaceExtra = (previousId: string, nextId: string) => {
		const applyAs = filterStates[previousId] ?? 'regular'
		AppliedFiltersPrt.Actions.selectExtraFilters(appliedKey, prev => prev.map(id => (id === previousId ? nextId : id)))
		AppliedFiltersPrt.Actions.setAppliedFilterState(appliedKey, nextId, applyAs)
	}

	return (
		<div className="w-64 shrink-0 space-y-2 border-l pl-4">
			<span className="text-sm font-medium">Filters</span>
			{(poolFilterId !== null || selectableFilterIds.length > 0) && (
				<div className="flex flex-col items-start gap-1">
					<PoolFilterCheckbox stores={{ squadServer: props.stores.squadServer, appliedFilters: key }} />
					{selectableFilterIds.map(filterId => <FilterCheckbox key={filterId} filterId={filterId} stores={appliedKey} />)}
				</div>
			)}
			<ListEditor
				items={extraIds}
				itemKey={filterId => filterId}
				addLabel="Add filter"
				addDisabled={exhausted}
				onRemove={removeExtra}
				renderItem={filterId => (
					<>
						<ComboBox
							title="filter"
							className="w-full min-w-0"
							value={filterId}
							options={optionsFor(filterId)}
							onSelect={next => next && next !== filterId && replaceExtra(filterId, next)}
						/>
						<TriStateCheckbox
							checked={filterStates[filterId] ?? 'disabled'}
							onCheckedChange={applyAs => AppliedFiltersPrt.Actions.setAppliedFilterState(appliedKey, filterId, applyAs)}
						/>
					</>
				)}
				renderAddControl={({ ref, done }) => (
					<ComboBox
						ref={ref}
						title="filter"
						className="w-full min-w-0"
						placeholder="Select filter..."
						value={undefined}
						options={optionsFor()}
						onSelect={next => {
							if (next) addExtra(next)
							done()
						}}
					/>
				)}
			/>
		</div>
	)
}

// one row of the pared-down filter menu: a comparison locked to its column plus a clear button, options
// narrowed to the values that still have matches (same behavior as the layer-select menu)
function RequestMenuField(props: { field: string; stores: RequestFrame.KeyProp }) {
	const key = props.stores.backburnerRequest
	const ref = React.useRef<ComparisonHandle>(null)
	const [comp, possibleValues] = ZusUtils.useStore(
		key,
		ZusUtils.useDeep(s => [s.filterMenu.menuItems[props.field], s.filterMenuItemPossibleValues?.[props.field]] as const),
	)
	if (!comp) return null
	return (
		<>
			<Comparison
				ref={ref}
				columnEditable={false}
				node={comp}
				allowedEnumValues={possibleValues}
				lockOnSingleOption
				highlight={F.editableCompHasValue(comp)}
				onSetAllValuesAllowed={() => ZusUtils.getState(key).resetAllConstraints()}
				onSetAllValuesAllowedLabel="Remove all other constraints and select this one"
				setNode={update => RequestFrame.Actions.setMenuComparison(props.stores, props.field, update)}
			/>
			<Button
				disabled={!F.editableCompHasValue(comp)}
				variant="ghost"
				size="icon"
				onClick={() => {
					RequestFrame.Actions.resetMenuField(props.stores, props.field)
					ref.current?.clear(true)
				}}
			>
				<Icons.Trash />
			</Button>
		</>
	)
}

function MatchingCount(props: { stores: RequestFrame.KeyProp }) {
	const count = ZusUtils.useStore(props.stores.backburnerRequest, s => s.matchingCount)
	if (count === null) return null
	return (
		<span className={cn('mr-auto text-xs', count === 0 ? 'text-amber-500' : 'text-muted-foreground')}>
			{count === 0 ? 'No layers in the pool match this request' : `${count} layer${count === 1 ? '' : 's'} match`}
		</span>
	)
}
