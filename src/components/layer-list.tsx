import * as RQ from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'

import { AdvancedVoteConfigEditor } from '@/components/advanced-vote-config-editor'
import { LayerNoteDialog, LayerNotes } from '@/components/layer-notes'
import { LayerTagDialog, LayerTags } from '@/components/layer-tags'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import type * as GenVoteFrame from '@/frames/gen-vote.frame.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import { useIsMobile } from '@/hooks/use-is-mobile.ts'
import * as DH from '@/lib/display-helpers'
import * as Obj from '@/lib/object-utils'
import { inline, useStableValue } from '@/lib/react.ts'
import * as ST from '@/lib/state-tree.ts'
import * as Str from '@/lib/string-utils'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards.ts'
import { resToOptional } from '@/lib/types.ts'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand.ts'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as LNote_Msgs from '@/messages/layer-notes.messages'
import * as LTag_Msgs from '@/messages/layer-tags.messages'
import * as V_Msgs from '@/messages/vote.messages'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import type * as LTag from '@/models/layer-tags.models'
import * as UP from '@/models/user-presence'
import * as V from '@/models/vote.models.ts'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'
import * as DndKit from '@/systems/dndkit.client'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as VotesClient from '@/systems/vote.client'

import { StartActivityInteraction } from './activity.tsx'
import EditLayerDialog from './edit-layer-dialog.tsx'
import GenVoteDialog from './gen-vote-dialog.tsx'
import LayerDisplay from './layer-display.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import { MultiLayerSetDialog } from './multi-layer-set-dialog.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { Timer } from './timer.tsx'
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from './ui/dropdown-menu.tsx'
import TabsList from './ui/tabs-list.tsx'

// a touch long-press on a drag handle is a drag. The row's context menu opens on the same gesture, and then
// takes the drop, so the handle keeps the press to itself.
const dragHandleTouchProps = {
	onPointerDown: (e: React.PointerEvent) => {
		if (e.pointerType !== 'mouse') e.stopPropagation()
	},
	onContextMenu: (e: React.MouseEvent) => {
		if ((e.nativeEvent as PointerEvent).pointerType === 'mouse') return
		e.preventDefault()
		e.stopPropagation()
	},
}

export function LayerList(props: { stores: SquadServerFrame.KeyProp }) {
	const queueItemIds = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.queueItemIds)
	const serverId = props.stores.squadServer.serverId

	// -------- dispatch move events --------
	DndKit.useDragEnd(async (event) => {
		const user = UsersClient.loggedInUser
		const upState = Zus.getState(UPClient.Store)
		if (!user || !event.over) return
		if (!UPClient.Sel.isEditing(user.discordId)(upState)) return
		const target = event.over.slots[0]
		if (target.dragItem.type !== 'layer-item') return
		const cursors = LL.dropItemToLLItemCursors(event.over)
		if (cursors.length === 0) return
		const voteState = VotesClient.voteState$(serverId).getValue()
		const layerList = LayerQueuePrt.Sel.layerList(Zus.getState(props.stores.squadServer))
		if (voteState?.code === 'in-progress') {
			for (const cursor of cursors) {
				if (LL.isChildItem(cursor.itemId, voteState.itemId, layerList)) return
			}
		}

		const cursor = cursors[0]

		if (event.active.type === 'history-entry') {
			const history = await MatchHistoryClient.recentMatches$(serverId).getValue()
			const activeId = event.active.id
			const entry = history.find((entry) => entry.historyEntryId === activeId)
			if (!entry) return
			const index = LL.resolveCursorIndex(layerList, cursor)!
			void LayerQueuePrt.Actions.dispatch(
				{ queue: props.stores.squadServer },
				{
					op: 'add',
					items: [{ type: 'single-list-item', layerId: entry.layerId }],
					index,
				},
			)
		}

		if (event.active.type === 'layer-item') {
			void LayerQueuePrt.Actions.dispatch(
				{ queue: props.stores.squadServer },
				{
					op: 'move',
					cursor: cursor,
					itemId: event.active.id,
					newFirstItemId: LL.createItemId(),
				},
			)
		}
	})

	DndKit.useDraggingCallback((item) => {
		if (!item) {
			UPClient.Actions.updateActivity({ code: 'set-editing-queue-idle-if', currentIds: ['MOVING_ITEM', 'ADDING_ITEM_FROM_HISTORY'] })
			return
		}
		const { leaf } = ST.Match
		if (item?.type === 'layer-item') {
			UPClient.Actions.updateActivity({ code: 'set-editing-queue', variant: leaf('MOVING_ITEM', { itemId: item.id }) })
			return
		}

		if (item?.type === 'history-entry') {
			UPClient.Actions.updateActivity({ code: 'set-editing-queue', variant: leaf('ADDING_ITEM_FROM_HISTORY', {}) })
			return
		}
	})

	return (
		<>
			<ul className="flex w-full flex-col [&>li]:border-t-0">
				{queueItemIds.map((id) => (
					<LayerListItem key={id} itemId={id} stores={props.stores} />
				))}
			</ul>
			<LoadedActivitiesRenderer stores={props.stores} />
		</>
	)
}

function LoadedActivitiesRenderer({ stores }: { stores: SquadServerFrame.KeyProp }) {
	const loadedActivities = Zus.useStore(UPClient.Store, Zus.useShallow(UPClient.Sel.loadedActivities))
	return (
		<>
			{loadedActivities.map((entry) => {
				if (entry.name === 'selectLayers') {
					return <LoadedSelectLayersView key={entry.data.selectLayersFrame.instanceId} stores={stores} entry={entry} />
				}
				if (entry.name === 'genVote') {
					return <LoadedGenVoteView key={entry.data.genVoteFrame.instanceId} stores={stores} entry={entry} />
				}
				if (entry.name === 'pasteRotation') {
					return <LoadedPasteRotation key="paste-rotation" stores={stores} entry={entry} />
				}
				assertNever(entry)
			})}
		</>
	)
}

type AddLayersPosition = 'next' | 'after'

const ADD_LAYERS_CURSORS: Record<AddLayersPosition, LL.Cursor> = { next: { type: 'start' }, after: { type: 'end' } }

function selectAddLayersPosition(s: SelectLayersFrame.Types['state']): AddLayersPosition {
	return s.cursor?.type === 'end' ? 'after' : 'next'
}

function LoadedSelectLayersView({
	stores,
	entry: _entry,
}: {
	stores: SquadServerFrame.KeyProp
	entry: Extract<UPClient.LoadedActivityState, { name: 'selectLayers' }>
}) {
	const entry = useStableValue((e) => e, [_entry])

	const setPosition = (newPosition: AddLayersPosition) => {
		SelectLayersFrame.Actions.setCursor({ selectLayers: entry.data.selectLayersFrame }, ADD_LAYERS_CURSORS[newPosition])
	}

	const addLayersAtPosition = Zus.useStore(entry.data.selectLayersFrame, selectAddLayersPosition)

	const activity = entry.key
	const data = entry.data

	const [pendingTags, setPendingTags] = React.useState<LTag.TagId[]>([])

	const onAddItems = (items: LL.NewItem[]) => {
		if (activity.id !== 'ADDING_ITEM') return
		const layerList = LayerQueuePrt.Sel.layerList(Zus.getState(stores.squadServer))
		let cursor = Zus.getState(entry.data.selectLayersFrame).cursor
		let index: LL.ItemIndex
		const defaultIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) index = LL.resolveCursorIndex(layerList, cursor) ?? defaultIndex
		else index = defaultIndex
		void LayerQueuePrt.Actions.dispatch(
			{ queue: stores.squadServer },
			{
				op: 'add',
				items: LL.withTags(items, pendingTags),
				index,
			},
		)
	}

	const onEditedLayer = (layerId: L.LayerId) => {
		if (activity.id !== 'EDITING_ITEM') return
		const itemId = activity.opts.itemId
		void LayerQueuePrt.Actions.dispatch(
			{ queue: stores.squadServer },
			{
				op: 'edit-layer',
				itemId,
				newLayerId: layerId,
			},
		)
	}

	const onSelectLayersChange = (open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}

	const dialogStores = {
		selectLayers: data.selectLayersFrame,
		squadServer: stores.squadServer,
	}

	const addLayersTabsList = (
		<TabsList
			variant="seg"
			options={[
				{ label: 'Play Next', value: 'next' },
				{ label: 'Play After', value: 'after' },
			]}
			active={addLayersAtPosition}
			setActive={setPosition}
		/>
	)

	if (activity.id === 'EDITING_ITEM') {
		return <EditLayerDialog stores={dialogStores} open={entry.active} onOpenChange={onSelectLayersChange} onSelectLayer={onEditedLayer} />
	} else if (activity.id === 'ADDING_ITEM') {
		return (
			<SelectLayersDialog
				title={activity.opts.title ?? 'Add Layers'}
				stores={dialogStores}
				open={entry.active}
				onOpenChange={onSelectLayersChange}
				selectQueueItems={onAddItems}
				footerAdditions={activity.opts.variant === 'toggle-position' && addLayersTabsList}
				footerBeforeSubmit={
					<LayerTags
						tags={pendingTags}
						onAdd={(tagId) => setPendingTags((prev) => [...prev, tagId])}
						onRemove={(tagId) => setPendingTags((prev) => prev.filter((id) => id !== tagId))}
					/>
				}
			/>
		)
	}
	return null
}

function LoadedGenVoteView({
	stores,
	entry: _entry,
}: {
	stores: SquadServerFrame.KeyProp
	entry: Extract<UPClient.LoadedActivityState, { name: 'genVote' }>
}) {
	const entry = useStableValue((e) => e, [_entry])
	const data = entry.data

	const onOpenChange = (open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}

	const dialogStores = {
		genVote: data.genVoteFrame,
		squadServer: stores.squadServer,
	}
	const [pendingTags, setPendingTags] = React.useState<LTag.TagId[]>([])

	const onSubmit = (result: GenVoteFrame.Result, cursor?: LL.Cursor) => {
		const source: LL.Source = {
			type: 'manual',
			userId: UsersClient.loggedInUserId!,
		}

		const item = LL.withTags([LL.createVoteItem(result.choices, source, result.voteConfig)], pendingTags)[0]

		const layerList = LayerQueuePrt.Sel.layerList(Zus.getState(stores.squadServer))
		let index: LL.ItemIndex
		const defaultIndex: LL.ItemIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) {
			index = LL.resolveCursorIndex(layerList, cursor) ?? defaultIndex
		} else {
			index = defaultIndex
		}

		void LayerQueuePrt.Actions.dispatch(
			{ queue: stores.squadServer },
			{
				op: 'add',
				index: index ?? { outerIndex: 0, innerIndex: null },
				items: [item],
			},
		)
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}

	return (
		<GenVoteDialog
			title={tr.text(V_Msgs.generateVoteTitle())}
			stores={dialogStores}
			open={entry.active}
			onOpenChange={onOpenChange}
			onSubmit={onSubmit}
			tagsControl={
				<LayerTags
					tags={pendingTags}
					onAdd={(tagId) => setPendingTags((prev) => [...prev, tagId])}
					onRemove={(tagId) => setPendingTags((prev) => prev.filter((id) => id !== tagId))}
				/>
			}
		/>
	)
}

function LoadedPasteRotation({
	stores,
	entry: _entry,
}: {
	stores: SquadServerFrame.KeyProp
	entry: Extract<UPClient.LoadedActivityState, { name: 'pasteRotation' }>
}) {
	const entry = useStableValue((e) => e, [_entry])
	const [pastePosition, setPastePosition] = React.useState<'next' | 'after'>('next')
	const [pendingTags, setPendingTags] = React.useState<LTag.TagId[]>([])

	const onOpenChange = (open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}

	const onSubmit = (layers: L.UnvalidatedLayer[]) => {
		const layerIds = layers.map((l) => l.id)
		const cursor: LL.Cursor = pastePosition === 'next' ? { type: 'start' } : { type: 'end' }
		const layerList = LayerQueuePrt.Sel.layerList(Zus.getState(stores.squadServer))
		const index: LL.ItemIndex = LL.resolveCursorIndex(layerList, cursor) ?? { outerIndex: 0, innerIndex: null }
		void LayerQueuePrt.Actions.dispatch(
			{ queue: stores.squadServer },
			{
				op: 'add',
				index,
				items: LL.withTags(
					layerIds.map((layerId) => ({ type: 'single-list-item', layerId })),
					pendingTags,
				),
			},
		)
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}

	const positionTabsList = (
		<TabsList
			options={[
				{ label: 'Play Next', value: 'next' },
				{ label: 'Play After', value: 'after' },
			]}
			active={pastePosition}
			setActive={setPastePosition}
		/>
	)

	return (
		<MultiLayerSetDialog
			title={tr.text(LL_Msgs.pasteRotationTitle())}
			open={entry.active}
			onOpenChange={onOpenChange}
			onSubmit={onSubmit}
			extraFooter={
				<>
					{positionTabsList}
					<LayerTags
						tags={pendingTags}
						onAdd={(tagId) => setPendingTags((prev) => [...prev, tagId])}
						onRemove={(tagId) => setPendingTags((prev) => prev.filter((id) => id !== tagId))}
					/>
				</>
			}
		/>
	)
}

type LayerListItemProps = {
	itemId: string
	stores: SquadServerFrame.KeyProp
}

// memoized so LayerList re-renders (e.g. queueItemIds reordering on a move) don't cascade into
// every item's subtree -- items re-render via their own store subscriptions instead
const LayerListItem = React.memo(function LayerListItem(props: LayerListItemProps) {
	const entry = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.itemEntry(props.itemId))
	if (!entry) return null
	if (LL.isVoteItem(entry.item)) {
		return <VoteLayerListItem {...props} />
	}
	return <SingleLayerListItem {...props} />
})

const SingleLayerListItem = React.memo(function SingleLayerListItem(props: LayerListItemProps) {
	const { item, index, isLocallyLast, displayedMutation, parentItem } = Zus.useStore(
		props.stores.squadServer,
		LayerQueuePrt.Sel.itemDisplay(props.itemId),
	)

	const user = UsersClient.useLoggedInUser()

	// the tutorial tour spotlights one row's controls; the head row stands in for "a layer". The first few rows all
	// carry the queue-item anchor: a plain 'queue-item' anchor still resolves to the head (first laid-out match), and
	// { all: 'queue-item' } bounds the run of rows, which the normalization step highlights as a sequence.
	const isTourRow = LL.isLocallyFirstIndex(index)
	const isTourSeqRow = index.innerIndex === null && index.outerIndex < 3

	const isVoteChoice = !!parentItem

	const isModified = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.isModified)
	const isLocked = Zus.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const writeDenied = RbacClient.usePermsCheck(RBAC.perm('queue:write', { serverId: props.stores.squadServer.serverId }))
	const canEdit = !isLocked && !writeDenied

	const [itemPresence, itemActivityUser, activityHovered] = UPClient.useItemPresence(item.itemId)

	const globalVoteState = VotesClient.useVoteState(props.stores.squadServer.serverId)
	const voteState =
		(globalVoteState && globalVoteState?.itemId === parentItem?.itemId ? globalVoteState : undefined) ?? parentItem?.endingVoteState

	const draggableItem = LL.layerItemToDragItem(item)
	// 'default' (clone) not 'move': with 'move' dnd-kit drags the real element and animates it into its final
	// slot over a 250ms drop animation, so the item visibly lags behind the mouse release. 'default' drags a
	// throwaway clone and places the real item instantly. Matches vote items (below) and the filter editor.
	const dragProps = DndKit.useDraggable(draggableItem, { feedback: 'default', disabled: !canEdit })

	const itemStores = { queue: props.stores.squadServer }

	const editActivity = React.useMemo(
		() => ({
			_tag: 'leaf' as const,
			id: 'EDITING_ITEM' as const,
			opts: { itemId: item.itemId, cursor: { type: 'item-relative' as const, itemId: item.itemId, position: 'on' as const } },
		}),
		[item.itemId],
	)

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback(
		(update) => {
			if (!canEdit) _setDropdownOpen(false)
			_setDropdownOpen(update)
		},
		[canEdit, _setDropdownOpen],
	)

	const isMobile = useIsMobile()

	const badges: React.ReactNode[] = []
	let sourceDisplay: React.ReactNode | undefined

	if (user && itemPresence?.itemActivity) {
		sourceDisplay = (
			<Badge key={`activity ${itemPresence.itemActivity.id}`} variant="info" className="text-nowrap">
				{UP.getAttributedHumanReadableActivity(itemPresence.activityState!, index, itemActivityUser.displayName)}...
			</Badge>
		)
	} else {
		sourceDisplay = <LayerSourceDisplay key={`source ${item.source.type}`} source={item.source} />
	}

	const editButtonProps = (className?: string) => ({
		'data-can-edit': canEdit,
		'data-mobile': isMobile,
		disabled: !canEdit,
		className,
	})

	// the phone menu's add tag / add note entries open these; the dialogs outlive the menu, so the row owns them
	const [phoneEditor, setPhoneEditor] = React.useState<'new-tag' | 'new-note' | null>(null)
	const onNewTag = () => setPhoneEditor('new-tag')
	const onAddNote = () => setPhoneEditor('new-note')

	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		stores: props.stores,
		itemId: props.itemId,
		onNewTag,
		onAddNote,
	} satisfies Partial<ItemDropdownProps>

	const layersStatus = resToOptional(SquadServerClient.useLayersStatus(props.stores.squadServer.serverId))?.data
	const serverInfo = SquadServerClient.useServerInfo(props.stores.squadServer.serverId)
	const tally =
		voteState && V.isVoteStateWithVoteData(voteState) && serverInfo ? V.tallyVotes(voteState, serverInfo.playerCount) : undefined

	const itemChoiceTallyPercentage = isVoteChoice && voteState ? tally?.percentages?.get(item.itemId) : undefined
	const isVoteWinner = isVoteChoice && voteState?.code === 'ended:winner' && voteState?.winnerId === item.itemId
	const voteCount = isVoteChoice && voteState ? tally?.totals?.get(item.itemId) : undefined
	const updatesDisabled = Zus.useStore(props.stores.squadServer, (s) => s.settings.saved.updatesToSquadServerDisabled)
	const committing = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.committing)
	const nextLayerSyncState = LayerQueueClient.useNextLayerSyncState(props.stores.squadServer.serverId)
	// the row whose layer the server should be holding as next: the head of the queue, or for a vote at the head,
	// whichever choice would win right now
	const isNextLayerCandidate =
		index.outerIndex === 0 && (parentItem ? LL.getChosenItem(parentItem).itemId === item.itemId : index.innerIndex === null)

	if (index.innerIndex === 0 && voteState?.code !== 'ended:winner') {
		badges.unshift(
			<Badge key="default-choice" variant="secondary">
				{tr.text(LL_Msgs.defaultChoice())}
			</Badge>,
		)
	}
	if (isVoteWinner) {
		badges.unshift(
			<Badge key="winner" variant="added">
				{tr.text(LL_Msgs.selectedChoice())}
			</Badge>,
		)
	}

	// a running vote is still deciding the next layer, so nothing said here would hold for long
	if (isNextLayerCandidate && voteState?.code !== 'in-progress') {
		const serverNextLayer = layersStatus?.nextLayer
		if (updatesDisabled) {
			badges.push(
				<Badge key="next-layer" data-tour={isTourRow ? 'queue-next-badge' : undefined} variant="destructive">
					{tr.text(LL_Msgs.notNextLayerBlocked())}
				</Badge>,
			)
		} else if (serverNextLayer && L.areLayersCompatible(item.layerId, serverNextLayer, true)) {
			badges.push(
				<Tooltip key="next-layer">
					<TooltipTrigger>
						<Badge data-tour={isTourRow ? 'queue-next-badge' : undefined} variant="added">
							{tr.text(LL_Msgs.isNextLayer())}
						</Badge>
					</TooltipTrigger>
					<TooltipContent>{tr.text(LL_Msgs.isNextLayerBlurb())}</TooltipContent>
				</Tooltip>,
			)
		} else if (serverNextLayer && isModified) {
			badges.push(
				<Tooltip key="next-layer">
					<TooltipTrigger>
						<Badge data-tour={isTourRow ? 'queue-next-badge' : undefined} variant="edited">
							{tr.text(LL_Msgs.notNextLayerUnsaved())}
						</Badge>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{tr.text(LL_Msgs.notNextLayerUnsavedBlurb(DH.toShortLayerNameFromId(serverNextLayer.id)))}
						<Icons.Sword className="ml-1 inline h-3 w-3" />
					</TooltipContent>
				</Tooltip>,
			)
		} else if (committing || nextLayerSyncState.code === 'syncing' || !serverNextLayer) {
			// committing is this save's own round trip; syncing is a write SLM started for another reason, such as
			// another admin's save. No next layer at all means SLM has yet to write one, which a roll and a status
			// read we have not made yet both look like: pending, not wrong.
			badges.push(
				<Tooltip key="next-layer">
					<TooltipTrigger>
						<Badge data-tour={isTourRow ? 'queue-next-badge' : undefined} variant="secondary" className="gap-1">
							<Icons.LoaderCircle className="h-3 w-3 animate-spin" />
							{tr.text(LL_Msgs.settingNextLayer())}
						</Badge>
					</TooltipTrigger>
					<TooltipContent>{tr.text(LL_Msgs.settingNextLayerBlurb())}</TooltipContent>
				</Tooltip>,
			)
		} else {
			badges.push(
				<Tooltip key="next-layer">
					<TooltipTrigger>
						<Badge data-tour={isTourRow ? 'queue-next-badge' : undefined} variant="destructive">
							{tr.text(LL_Msgs.notNextLayer())}
						</Badge>
					</TooltipTrigger>
					<TooltipContent>{tr.text(LL_Msgs.notCurrentNextLayer())}</TooltipContent>
				</Tooltip>,
			)
		}
	}

	const beforeItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'before', itemId: item.itemId }]
	const afterItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'after', itemId: item.itemId }]

	return (
		<>
			{LL.isLocallyFirstIndex(index) && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} disabled={!canEdit} />}
			<ItemContextMenu stores={props.stores} itemId={props.itemId} disabled={!canEdit} onNewTag={onNewTag} onAddNote={onAddNote}>
				<li
					ref={dragProps.ref}
					className={cn(
						Typo.LayerText,
						'group/single-item grid gap-1.5 items-center w-full min-h-(--row) px-1 border-t border-[#1f1f21] first:border-t-0 hover:bg-white/4 cursor-default',
						'shadow-[inset_3px_0_0_transparent] data-[mutation=added]:shadow-[inset_3px_0_0_var(--ok)] data-[mutation=moved]:shadow-[inset_3px_0_0_var(--info-c)] data-[mutation=edited]:shadow-[inset_3px_0_0_var(--warn)]',
						'data-[is-voting=true]:bg-[rgba(95,183,106,0.06)] data-[is-dragging=true]:outline-2 data-[is-dragging=true]:outline-solid data-[is-dragging=true]:outline-line-soft data-[is-dragging=true]:bg-transparent! [&[data-is-dragging=true]>*]:invisible data-[is-hovered=true]:outline-solid data-[is-hovered=true]:outline-1 data-[is-hovered=true]:outline-pri-lo',
						isMobile ? 'grid-cols-[24px_minmax(0,1fr)_auto]' : 'grid-cols-[26px_16px_minmax(0,1fr)_auto]',
					)}
					data-mutation={displayedMutation}
					data-tour={isTourSeqRow ? 'queue-item' : undefined}
					data-is-dragging={dragProps.isDragging}
					data-is-voting={voteState?.code === 'in-progress'}
					data-is-hovered={activityHovered}
				>
					<span data-mobile={isMobile} className="text-right font-mono text-text-3 data-[mobile=true]:hidden">
						{LL.getItemNumber(index)}
					</span>
					<button
						type="button"
						ref={dragProps.handleRef}
						data-tour={isTourRow ? 'queue-reorder' : undefined}
						{...editButtonProps(
							'flex size-4 pointer-coarse:size-6 touch-none items-center justify-center text-text-3 hover:text-text data-[can-edit=true]:cursor-grab disabled:opacity-40 [&_svg]:size-3.5 pointer-coarse:[&_svg]:size-4',
						)}
						{...dragHandleTouchProps}
					>
						<Icons.GripVertical />
					</button>
					<span
						data-tour={isTourRow ? 'queue-item-display' : undefined}
						className="flex w-full min-w-0 flex-col gap-0.5 py-0.5 data-[phone=true]:[&_.fd-layer-name>*:first-child]:basis-full data-[phone=true]:[&_.fd-layer-name>svg]:hidden"
						data-phone={isMobile || undefined}
					>
						<LayerDisplay
							stores={props.stores}
							droppable={true}
							layerNameTourId={isTourRow ? 'queue-layer-name' : undefined}
							indicatorsTourId={isTourRow ? 'layer-indicators' : undefined}
							item={{ type: 'single-list-item', layerId: item.layerId, itemId: item.itemId }}
							badges={badges}
							tags={
								item.type === 'single-list-item' && (
									<LayerTags
										tags={item.tags}
										setBy={item.tagsSetBy}
										disabled={!canEdit}
										revealAddOnHover
										onAdd={(tagId) => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'add-tag', tagId })}
										onRemove={(tagId) =>
											LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'remove-tag', tagId })
										}
									/>
								)
							}
							notes={
								item.type === 'single-list-item' && (
									<LayerNotes
										serverId={props.stores.squadServer.serverId}
										notes={item.notes}
										disabled={!canEdit}
										revealAddOnHover
										onAdd={(text) =>
											LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
												op: 'add-note',
												noteId: LNote.createNoteId(),
												text,
											})
										}
										onEdit={(noteId, text) =>
											LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
												op: 'edit-note',
												noteId,
												text,
											})
										}
										onDelete={(noteId) =>
											LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'delete-note', noteId })
										}
									/>
								)
							}
						/>
						{itemChoiceTallyPercentage !== undefined && (
							<span className="flex space-x-1 items-center">
								<Progress value={itemChoiceTallyPercentage} className={cn('h-2', isVoteWinner && '[&>div]:bg-added')} />
								<span>{voteCount}</span>
							</span>
						)}
					</span>
					<span className="flex items-center gap-1.5">
						{sourceDisplay && <span data-tour={isTourRow ? 'queue-item-source' : undefined}>{sourceDisplay}</span>}
						<span className={cn('fd-grp', isMobile && 'hidden')}>
							<StartActivityInteraction
								loaderName="selectLayers"
								createActivity={UP.createEditingQueueVariant(editActivity)}
								matchKey={(key) => Obj.deepEqualStrict(key, { ...editActivity, serverId: props.stores.squadServer.serverId })}
								preload="viewport"
								render={Button}
								data-tour={isTourRow ? 'queue-item-edit' : undefined}
								size="icon-sm"
								title={tr.text(LL_Msgs.editItem())}
								disabled={!canEdit}
							>
								<Icons.Pencil />
							</StartActivityInteraction>
							<Button
								size="icon-sm"
								data-tour={isTourRow ? 'queue-swap' : undefined}
								title={tr.text(LL_Msgs.swapFactions())}
								disabled={!canEdit || !L.swapFactions(item.layerId)}
								onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'swap-factions' })}
							>
								<Icons.ArrowLeftRight />
							</Button>
							<Button
								size="icon-sm"
								data-tour={isTourRow ? 'queue-delete' : undefined}
								title={tr.text(LL_Msgs.deleteItem())}
								disabled={!canEdit}
								onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'delete' })}
							>
								<Icons.X />
							</Button>
						</span>
						<ItemDropdown {...dropdownProps}>
							<Button {...editButtonProps()} data-tour={isTourRow ? 'queue-item-menu' : undefined} variant="ghost" size="icon-sm">
								<Icons.EllipsisVertical />
							</Button>
						</ItemDropdown>
					</span>
				</li>
			</ItemContextMenu>
			{isMobile && item.type === 'single-list-item' && (
				<>
					<LayerTagDialog
						state={phoneEditor === 'new-tag' ? 'new' : null}
						onClose={() => setPhoneEditor(null)}
						onCreated={(tagId) => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'add-tag', tagId })}
					/>
					<LayerNoteDialog
						state={phoneEditor === 'new-note' ? 'new' : null}
						onClose={() => setPhoneEditor(null)}
						onSubmit={(text) => {
							LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'add-note', noteId: LNote.createNoteId(), text })
							setPhoneEditor(null)
						}}
					/>
				</>
			)}
			<QueueItemSeparator links={afterItemLinks} isAfterLast={isLocallyLast} disabled={!canEdit} />
		</>
	)
})

function VoteLayerListItem(props: LayerListItemProps) {
	const display = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.itemDisplay(props.itemId))
	const { index, isLocallyLast, displayedMutation } = display
	const item = display.item as LL.VoteItem

	const globalVoteState = VotesClient.useVoteState(props.stores.squadServer.serverId)
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? item.endingVoteState

	const isModified = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.isModified)
	const manageVoteDenied = RbacClient.usePermsCheck(RBAC.perm('vote:manage', { serverId: props.stores.squadServer.serverId }))
	const isEditing = UPClient.useIsEditing()
	const isLocked = Zus.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const writeDenied = RbacClient.usePermsCheck(RBAC.perm('queue:write', { serverId: props.stores.squadServer.serverId }))
	const canEdit = !isLocked && !writeDenied
	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem, { disabled: !canEdit })

	const itemStores = { queue: props.stores.squadServer }

	const [dropdownOpen, setDropdownOpen] = React.useState(false)
	const isMobile = useIsMobile()

	const editButtonProps = (className?: string) => ({
		['data-mobile']: isMobile,
		disabled: !canEdit,
		className: className,
		['data-can-edit']: canEdit,
	})

	const manageVoteButtonProps = (opts?: { className?: string }) => ({
		['data-mobile']: isMobile,
		disabled: !!manageVoteDenied,
		className: opts?.className,
	})

	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		stores: props.stores,
		itemId: props.itemId,
	} satisfies Partial<ItemDropdownProps>

	const beforeItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'before', itemId: item.itemId }]
	const afterItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'after', itemId: item.itemId }]

	// we're only using .useActivityState here because there's nothing to load with this activity at the moment
	const [configuringVote, setConfiguringVote] = UPClient.useActivityState({
		create: UP.createEditingQueueVariant({ _tag: 'leaf', id: 'CONFIGURING_VOTE', opts: { itemId: item.itemId } }),
		match: React.useCallback(
			(state) => {
				const node = UP.editingQueueNode(state)?.chosen
				return node?.id === 'CONFIGURING_VOTE' && node.opts.itemId === item.itemId
			},
			[item.itemId],
		),
		destroy: UP.toEditingQueueIdleOrNone,
	})

	const [_voteDisplayPropsOpen, _setVoteDisplayPropsOpen] = React.useState(false)
	const voteDisplayPropsOpen = configuringVote || _voteDisplayPropsOpen

	const setVoteDisplayPropsOpen: React.Dispatch<React.SetStateAction<boolean>> = (update) => {
		if (isEditing) setConfiguringVote(update)
		else _setVoteDisplayPropsOpen(update)
	}

	const serverId = props.stores.squadServer.serverId

	const startVoteMutation = RQ.useMutation(RPC.orpc.vote.startVote.mutationOptions())
	async function startVote() {
		const res = await startVoteMutation.mutateAsync({ serverId, itemId: item.itemId, ...item.voteConfig, ...{ voterType } })
		switch (res.code) {
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'ok':
				toast(...tr.toast(V_Msgs.adminReceipt.started()))
				break
			default:
				toast.error(res.msg)
		}
	}

	const abortVoteMutation = RQ.useMutation(RPC.orpc.vote.abortVote.mutationOptions())
	async function abortVote() {
		const res = await abortVoteMutation.mutateAsync({ serverId })
		switch (res.code) {
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'ok':
				toast(...tr.toast(V_Msgs.adminReceipt.aborted()))
				break
			default:
				toast.error(res.msg)
		}
	}

	const endVoteEarlyMutation = RQ.useMutation(RPC.orpc.vote.endVoteEarly.mutationOptions())
	async function endVoteEarly() {
		const res = await endVoteEarlyMutation.mutateAsync({ serverId })
		switch (res.code) {
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'ok':
				toast(...tr.toast(V_Msgs.adminReceipt.endedEarly()))
				break
			default:
				toast.error(res.msg)
		}
	}

	const cancelAutostartMutation = RQ.useMutation(RPC.orpc.vote.cancelVoteAutostart.mutationOptions())
	async function cancelAutostart() {
		const res = await cancelAutostartMutation.mutateAsync({ serverId })
		switch (res.code) {
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'ok':
				toast(...tr.toast(V_Msgs.adminReceipt.autostartCancelled()))
				break
			default:
				toast.error(res.msg)
		}
	}

	const serverInfoRes = SquadServerClient.useServerInfoRes(serverId)
	const serverInfo = serverInfoRes?.code === 'ok' ? serverInfoRes?.data : undefined

	const [voterType, setVoterType] = React.useState<V.VoterType>(voteState?.voterType ?? 'public')
	const internalVoteCheckboxId = React.useId()

	const canInitiateVote = Zus.useStore(
		props.stores.squadServer,
		LayerQueuePrt.Sel.canInitiateVote(item.itemId, voterType, globalVoteState ?? undefined, isModified),
	)
	const voteAutostartTime = voteState?.code === 'ready' ? voteState.autostartTime : undefined
	const voteTally = voteState && voteState.code !== 'ready' ? V.tallyVotes(voteState, serverInfo?.playerCount ?? 0) : undefined

	return (
		<>
			{LL.isLocallyFirstIndex(index) && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} disabled={!canEdit} />}
			<ItemContextMenu stores={props.stores} itemId={props.itemId} disabled={!canEdit}>
				<li
					ref={dragProps.ref}
					className={cn(
						'group/parent-item flex data-[is-dragging=false]:w-full min-w-10 min-h-5 items-center justify-between px-1 py-0 border-2 border-gray-400 rounded inset-2',
						`data-[mutation=added]:border-added data-[mutation=moved]:border-moved data-[mutation=edited]:border-edited data-[is-dragging=true]:outline-solid cursor-default`,
					)}
					data-mutation={displayedMutation}
					data-is-dragging={dragProps.isDragging}
				>
					{dragProps.isDragging ? (
						<span className="mx-auto w-5">...</span>
					) : (
						<div className="h-full flex flex-col grow">
							<div className="p-1 space-x-2 flex items-center justify-between w-full">
								<span className="flex items-center space-x-1">
									<Button
										ref={dragProps.handleRef}
										{...editButtonProps('touch-none data-[can-edit=true]:cursor-grab')}
										{...dragHandleTouchProps}
										variant="ghost"
										size="icon"
									>
										<Icons.GripHorizontal />
									</Button>
									<h3 className={cn(Typo.Label, 'bold')}>{tr.text(V_Msgs.heading())}</h3>
									{voteAutostartTime && (
										<>
											<span>:</span>
											<span className="whitespace-nowrap text-nowrap w-max text-sm flex flex-nowrap items-center space-x-2">
												<span>{tr.text(V_Msgs.startsIn())}</span> <Timer deadline={voteAutostartTime.getTime()} />
												<PermissionDeniedTooltip denied={manageVoteDenied}>
													<Button
														variant="ghost"
														size="icon"
														title={tr.text(V_Msgs.cancelAutostart())}
														onClick={cancelAutostart}
														{...manageVoteButtonProps()}
													>
														<Icons.X />
													</Button>
												</PermissionDeniedTooltip>
											</span>
										</>
									)}
									{voteState && voteState.code !== 'ready' && (
										<div className="flex space-x-2 items-center">
											<Icons.Dot width={20} height={20} />
											<span>{Str.statusCodeToTitleCase(voteState.code)}</span>
											<Icons.Dot width={20} height={20} />
											<span>
												{voteTally && serverInfo && (
													<span>{tr.text(V_Msgs.tally(voteTally.totalVotes, serverInfo.playerCount))}</span>
												)}
											</span>
											{voteState.code === 'in-progress' && (
												<>
													<Icons.Dot width={20} height={20} />
													<Badge variant="outline">
														<Timer
															className="font-mono"
															formatTime={(ms) => dateFns.format(new Date(ms), 'm:ss')}
															deadline={voteState.deadline}
															zeros
														/>
													</Badge>
												</>
											)}
											{voteState.code === 'in-progress' && (
												<PermissionDeniedTooltip denied={manageVoteDenied}>
													<Button
														title={tr.text(V_Msgs.endVoteEarly())}
														variant="ghost"
														size="icon"
														onClick={endVoteEarly}
														{...manageVoteButtonProps()}
													>
														<Icons.CheckCheck />
													</Button>
												</PermissionDeniedTooltip>
											)}
											{voteState.code === 'in-progress' && (
												<PermissionDeniedTooltip denied={manageVoteDenied}>
													<Button
														title={tr.text(V_Msgs.abortVote())}
														variant="ghost"
														size="icon"
														onClick={abortVote}
														{...manageVoteButtonProps()}
													>
														<Icons.Pause />
													</Button>
												</PermissionDeniedTooltip>
											)}
										</div>
									)}
								</span>
								<span className="flex items-center space-x-1">
									<PermissionDeniedTooltip denied={manageVoteDenied}>
										<div {...manageVoteButtonProps({ className: 'flex items-center space-x-2' })}>
											<Checkbox
												{...manageVoteButtonProps()}
												id={internalVoteCheckboxId}
												disabled={!!manageVoteDenied || voteState?.code === 'in-progress'}
												checked={voterType === 'internal'}
												onCheckedChange={(checked) => setVoterType(checked ? 'internal' : 'public')}
											/>
											<Label
												htmlFor={internalVoteCheckboxId}
												className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
											>
												{tr.text(V_Msgs.internalVote())}
											</Label>
										</div>
									</PermissionDeniedTooltip>
									<PermissionDeniedTooltip denied={manageVoteDenied}>
										<Button
											{...manageVoteButtonProps({ className: 'text-ok disabled:text-foreground' })}
											variant="ghost"
											size="icon"
											onClick={() => startVote()}
											disabled={!!manageVoteDenied || canInitiateVote.code !== 'ok'}
											title={tr.text(V_Msgs.startVote())}
										>
											<Icons.Play />
										</Button>
									</PermissionDeniedTooltip>

									{/* -------- add vote choices -------- */}
									{inline(() => {
										const activityTitle = tr.text(V_Msgs.addVoteChoices())
										return (
											<StartActivityInteraction
												loaderName="selectLayers"
												preload="intent"
												createActivity={UP.createEditingQueueVariant({
													_tag: 'leaf',
													id: 'ADDING_ITEM',
													opts: {
														cursor: {
															type: 'index',
															index: { outerIndex: index.outerIndex, innerIndex: item.choices.length },
														},
														action: 'add',
														title: activityTitle,
													},
												})}
												matchKey={(key) => key.id === 'ADDING_ITEM' && key.opts.title === activityTitle}
												render={Button}
												variant="ghost"
												size="icon"
												title={activityTitle}
												{...editButtonProps()}
											>
												<Icons.Plus />
											</StartActivityInteraction>
										)
									})}

									<VoteDisplayPropsPopover
										open={voteDisplayPropsOpen}
										onOpenChange={setVoteDisplayPropsOpen}
										stores={props.stores}
										itemId={props.itemId}
										readonly={!canEdit || !!manageVoteDenied}
									>
										<Button variant="ghost" size="icon" aria-label={tr.text(V_Msgs.configureVote())}>
											<Icons.Settings2 />
										</Button>
									</VoteDisplayPropsPopover>
									<Button
										variant="ghost"
										size="icon"
										title={tr.text(LL_Msgs.swapFactions())}
										disabled={!canEdit || !L.swapFactions(item.layerId)}
										onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'swap-factions' })}
									>
										<Icons.ArrowLeftRight />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										title={tr.text(LL_Msgs.deleteItem())}
										disabled={!canEdit}
										onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'delete' })}
									>
										<Icons.X />
									</Button>
									<ItemDropdown {...dropdownProps}>
										<Button variant="ghost" size="icon" {...editButtonProps()}>
											<Icons.EllipsisVertical />
										</Button>
									</ItemDropdown>
								</span>
							</div>
							<ol className="flex flex-col items-start">
								{item.choices!.map((choice) => {
									return <SingleLayerListItem key={choice.itemId} itemId={choice.itemId} stores={props.stores} />
								})}
							</ol>
						</div>
					)}
				</li>
			</ItemContextMenu>
			<QueueItemSeparator links={afterItemLinks} isAfterLast={isLocallyLast} disabled={!canEdit} />
		</>
	)
}

export function VoteDisplayPropsPopover(props: {
	itemId: LL.ItemId
	stores: SquadServerFrame.KeyProp
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	children: React.ReactNode
	readonly?: boolean
}) {
	return (
		<Popover open={props.open} onOpenChange={props.onOpenChange}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			{/* the pending config lives in the content, so closing the popover discards it rather than needing a reset */}
			<PopoverContent className="w-80">
				<VoteDisplayPropsForm itemId={props.itemId} stores={props.stores} readonly={props.readonly} onOpenChange={props.onOpenChange} />
			</PopoverContent>
		</Popover>
	)
}

function VoteDisplayPropsForm(props: {
	itemId: LL.ItemId
	stores: SquadServerFrame.KeyProp
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	readonly?: boolean
}) {
	const vote = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.voteItemConfig(props.itemId))
	const [localConfig, setLocalConfig] = React.useState<Partial<V.AdvancedVoteConfig> | null>(null)

	function handleSave() {
		LayerQueuePrt.Actions.dispatchItemOp({ queue: props.stores.squadServer }, props.itemId, {
			op: 'configure-vote',
			config: localConfig,
		})
		props.onOpenChange(false)
	}

	return (
		<>
			<AdvancedVoteConfigEditor
				stores={props.stores}
				config={localConfig ?? vote?.voteConfig ?? null}
				readonly={props.readonly}
				choices={vote?.choices ?? []}
				onChange={setLocalConfig}
			/>
			{!props.readonly && (
				<Button className="w-full mt-4" size="sm" onClick={handleSave}>
					{tr.text(V_Msgs.saveVoteConfig())}
				</Button>
			)}
		</>
	)
}

type ItemDropdownProps = {
	children: React.ReactNode
	open: boolean
	setOpen: React.Dispatch<React.SetStateAction<boolean>>
	stores: SquadServerFrame.KeyProp
	allowVotes?: boolean
	itemId: LL.ItemId
	onNewTag?: () => void
	onAddNote?: () => void
}

type SubDropdownState = 'add-before' | 'add-after' | 'create-vote'

// lets the same item menu render inside either a DropdownMenu or a ContextMenu
type ItemMenuItemProps = {
	children?: React.ReactNode
	className?: string
	disabled?: boolean
	onClick?: React.MouseEventHandler
	onMouseEnter?: React.MouseEventHandler
	onMouseLeave?: React.MouseEventHandler
}

type ItemMenuComponents = {
	Group: React.ComponentType<React.PropsWithChildren>
	Item: React.FunctionComponent<ItemMenuItemProps>
	Separator: React.ComponentType
	Sub: React.ComponentType<React.PropsWithChildren>
	SubTrigger: React.FunctionComponent<ItemMenuItemProps>
	SubContent: React.FunctionComponent<React.PropsWithChildren<{ className?: string }>>
}

const dropdownMenuComponents: ItemMenuComponents = {
	Group: DropdownMenuGroup,
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent,
}

const contextMenuComponents: ItemMenuComponents = {
	Group: ContextMenuGroup,
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent,
}

function ItemDropdown(props: ItemDropdownProps) {
	return (
		<DropdownMenu modal={false} open={props.open} onOpenChange={props.setOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<ItemMenuItems
					stores={props.stores}
					itemId={props.itemId}
					menu={dropdownMenuComponents}
					onNewTag={props.onNewTag}
					onAddNote={props.onAddNote}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function ItemContextMenu(props: {
	children: React.ReactNode
	stores: SquadServerFrame.KeyProp
	itemId: LL.ItemId
	disabled?: boolean
	onNewTag?: () => void
	onAddNote?: () => void
}) {
	return (
		<ContextMenu modal={false}>
			<ContextMenuTrigger
				asChild
				disabled={props.disabled}
				// vote choice items are nested inside the vote item's trigger -- only open the innermost menu
				onContextMenu={(e: React.MouseEvent) => e.stopPropagation()}
			>
				{props.children}
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ItemMenuItems
					stores={props.stores}
					itemId={props.itemId}
					menu={contextMenuComponents}
					onNewTag={props.onNewTag}
					onAddNote={props.onAddNote}
				/>
			</ContextMenuContent>
		</ContextMenu>
	)
}

function ItemMenuItems(props: {
	stores: SquadServerFrame.KeyProp
	itemId: LL.ItemId
	menu: ItemMenuComponents
	onNewTag?: () => void
	onAddNote?: () => void
}) {
	const Menu = props.menu
	const entry = Zus.useStore(props.stores.squadServer, LayerQueuePrt.Sel.itemEntry(props.itemId))!
	const { item, index, lastLocalIndex } = entry

	const activities = React.useMemo(() => {
		return {
			'add-after': {
				_tag: 'leaf',
				id: 'ADDING_ITEM',
				opts: { cursor: { type: 'item-relative', itemId: item.itemId, position: 'after' }, action: 'add' },
			},
			'add-before': {
				_tag: 'leaf',
				id: 'ADDING_ITEM',
				opts: { cursor: { type: 'item-relative', itemId: item.itemId, position: 'before' }, action: 'add' },
			},
			'create-vote': {
				_tag: 'leaf',
				id: 'ADDING_ITEM',
				opts: { cursor: { type: 'item-relative', itemId: item.itemId, position: 'on' }, title: 'Create Vote', action: 'edit' },
			},
		} satisfies { [k in SubDropdownState]: UP.QueueEditingActivity }
	}, [item.itemId])

	const isLocked = Zus.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const writeDenied = RbacClient.usePermsCheck(RBAC.perm('queue:write', { serverId: props.stores.squadServer.serverId }))
	const canEdit = !isLocked && !writeDenied
	const itemStores = { queue: props.stores.squadServer }

	function sendToFront() {
		if (!user) return
		const firstItem = LayerQueuePrt.Sel.layerList(Zus.getState(props.stores.squadServer))[0]
		LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
			op: 'move',
			newFirstItemId: LL.createItemId(),
			cursor: { type: 'item-relative', itemId: firstItem.itemId, position: 'before' },
		})
	}
	function sendToBack() {
		if (!user) return
		const state = Zus.getState(props.stores.squadServer)
		const itemState = LayerQueuePrt.Sel.itemState(props.itemId)(state)
		const layerList = LayerQueuePrt.Sel.layerList(state)
		const lastLocalIndex = LL.getLastLocalIndexForItem(itemState.item.itemId, layerList)!
		const targetItemId = LL.resolveItemForIndex(layerList, lastLocalIndex)!.itemId
		LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
			op: 'move',
			newFirstItemId: LL.createItemId(),
			cursor: { type: 'item-relative', itemId: targetItemId, position: 'after' },
		})
	}

	const user = UsersClient.useLoggedInUser()
	const isMobile = useIsMobile()
	const configuredTags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.layerTags ?? [])
	const canManageTags = !RbacClient.usePermsCheck(RBAC.perm('queue:manage-tags'))
	const appliedTags = item.type === 'single-list-item' ? (item.tags ?? []) : []
	const availableTags = configuredTags.filter((t) => !appliedTags.includes(t.id))
	const editActivity = {
		_tag: 'leaf' as const,
		id: 'EDITING_ITEM' as const,
		opts: { itemId: item.itemId, cursor: { type: 'item-relative' as const, itemId: item.itemId, position: 'on' as const } },
	}
	return (
		<>
			{isMobile && (
				<>
					<Menu.Group>
						<StartActivityInteraction
							loaderName="selectLayers"
							createActivity={UP.createEditingQueueVariant(editActivity)}
							matchKey={(key) => Obj.deepEqualStrict(key, { ...editActivity, serverId: props.stores.squadServer.serverId })}
							preload="viewport"
							render={Menu.Item}
							disabled={!canEdit}
						>
							<Icons.Pencil />
							{tr.text(LL_Msgs.editItem())}
						</StartActivityInteraction>
						<Menu.Item
							disabled={!canEdit || !L.swapFactions(item.layerId)}
							onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'swap-factions' })}
						>
							<Icons.ArrowLeftRight />
							{tr.text(LL_Msgs.swapFactions())}
						</Menu.Item>
						<Menu.Item
							disabled={!canEdit}
							onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'delete' })}
						>
							<Icons.X />
							{tr.text(LL_Msgs.deleteItem())}
						</Menu.Item>
					</Menu.Group>
					<Menu.Separator />
					{item.type === 'single-list-item' && props.onAddNote && (
						<>
							<Menu.Group>
								<Menu.Sub>
									<Menu.SubTrigger disabled={!canEdit}>
										<Icons.Tag />
										{tr.text(LTag_Msgs.addTag())}
									</Menu.SubTrigger>
									<Menu.SubContent className="max-h-72 max-w-72 overflow-y-auto">
										{availableTags.map((tag) => (
											<Menu.Item
												key={tag.id}
												onClick={() =>
													LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'add-tag', tagId: tag.id })
												}
											>
												<span className="mr-2 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
												{tag.label}
											</Menu.Item>
										))}
										{availableTags.length === 0 && <Menu.Item disabled>{tr.text(LTag_Msgs.noTagsAvailable())}</Menu.Item>}
										{canManageTags && props.onNewTag && (
											<>
												<Menu.Separator />
												<Menu.Item onClick={props.onNewTag}>
													<Icons.Plus />
													{tr.text(LTag_Msgs.newTagItem())}
												</Menu.Item>
											</>
										)}
									</Menu.SubContent>
								</Menu.Sub>
								<Menu.Item disabled={!canEdit} onClick={props.onAddNote}>
									<Icons.MessageSquarePlus />
									{tr.text(LNote_Msgs.addNoteItem())}
								</Menu.Item>
							</Menu.Group>
							<Menu.Separator />
						</>
					)}
				</>
			)}
			<Menu.Group>
				<Menu.Item
					disabled={!canEdit}
					onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'clone', itemId: item.itemId })}
				>
					<Icons.Copy />
					{tr.text(LL_Msgs.cloneItem())}
				</Menu.Item>
			</Menu.Group>
			<Menu.Separator />
			<Menu.Group>
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={UP.createEditingQueueVariant(activities['add-before'])}
					matchKey={(key) => Obj.deepEqualStrict(key, { ...activities['add-before'], serverId: props.stores.squadServer.serverId })}
					preload="viewport"
					render={Menu.Item}
					disabled={!canEdit}
				>
					{tr.text(LL_Msgs.addLayersBefore())}
				</StartActivityInteraction>
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={UP.createEditingQueueVariant(activities['add-after'])}
					matchKey={(key) => Obj.deepEqualStrict(key, { ...activities['add-after'], serverId: props.stores.squadServer.serverId })}
					preload="viewport"
					render={Menu.Item}
					disabled={!canEdit}
				>
					{tr.text(LL_Msgs.addLayersAfter())}
				</StartActivityInteraction>
			</Menu.Group>

			<Menu.Separator />
			<Menu.Group>
				<Menu.Item disabled={!canEdit || (index.innerIndex ?? index.outerIndex) === 0} onClick={sendToFront}>
					{tr.text(LL_Msgs.sendToFront())}
				</Menu.Item>
				<Menu.Item disabled={!canEdit || (!!lastLocalIndex && LL.indexesEqual(index, lastLocalIndex))} onClick={sendToBack}>
					{tr.text(LL_Msgs.sendToBack())}
				</Menu.Item>
			</Menu.Group>
		</>
	)
}

function QueueItemSeparator(props: {
	// null means we're before the first item in the list
	links: LL.ItemRelativeCursor[]
	isAfterLast?: boolean
	disabled?: boolean
}) {
	const dragging = DndKit.useDragging()
	// a request dragged in from the backburner is a thin, expanding target the pointer must track exactly; queue
	// reorder (layer-item) keeps the default shape collision so its behaviour is unchanged
	const collisionDetector = dragging?.type === 'backburner-item' ? DndKit.livePointerIntersection : undefined
	const { ref, isDropTarget } = DndKit.useDroppable(LL.llItemCursorsToDropItem(props.links), { collisionDetector })
	const disabled = props.disabled || false
	// taller (bigger drop target) only while an item is actually being dragged; compact otherwise
	const expanded = !disabled && (dragging?.type === 'layer-item' || dragging?.type === 'backburner-item')
	return (
		<Separator
			ref={ref}
			className={cn(
				'w-full min-w-0 bg-transparent shadow-none data-[is-last=true]:invisible data-[is-over=true]:bg-pri',
				expanded ? 'h-5' : 'h-0',
			)} // data-is-last={props.isAfterLast && !isOver}
			data-is-over={!disabled && isDropTarget}
		/>
	)
}
