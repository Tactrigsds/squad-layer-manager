import * as RQ from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'

import { AddRotationDialog } from '@/components/add-rotation-dialog'
import { AdvancedVoteConfigEditor } from '@/components/advanced-vote-config-editor'
import { AddNoteButton, LayerNoteDialog, LayerNotes } from '@/components/layer-notes'
import { LayerTagDialog, LayerTags } from '@/components/layer-tags'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import * as Typo from '@/components/typography'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
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
import * as ListHostPrt from '@/frame-partials/list-host.partial'
import type * as GenVoteFrame from '@/frames/gen-vote.frame.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as Browser from '@/lib/browser.ts'
import * as Obj from '@/lib/object-utils'
import { inline, useStable } from '@/lib/react.ts'
import * as Str from '@/lib/string-utils'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards.ts'
import { resToOptional } from '@/lib/types.ts'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand.ts'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as LNote_Msgs from '@/messages/layer-notes.messages'
import * as LTag_Msgs from '@/messages/layer-tags.messages'
import * as UP_Msgs from '@/messages/user-presence.messages'
import * as V_Msgs from '@/messages/vote.messages'
import * as DH from '@/models/display-helpers.models'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import type * as LTag from '@/models/layer-tags.models'
import * as L from '@/models/layer.models'
import * as UP from '@/models/user-presence.models'
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
import * as VoteClient from '@/systems/vote.client'

import { StartActivityInteraction } from './activity.tsx'
import EditLayerDialog from './edit-layer-dialog.tsx'
import GenVoteDialog from './gen-vote-dialog.tsx'
import { LayerMenuItems } from './layer-context-menu-options.tsx'
import LayerDisplay from './layer-display.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { Timer } from './timer.tsx'
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
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

// who may edit the list: queue:write on a server's queue, rotations:write on a rotation
function useListWriteDenied(host: LL.ListHost) {
	return RbacClient.usePermsCheck(
		host.type === 'server' ? RBAC.perm('queue:write', { serverId: host.serverId }) : RBAC.getWritePermReqForRotation(host.rotationId),
	)
}

export function LayerList(props: { stores: ListHostPrt.KeyProp }) {
	const queueItemIds = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.queueItemIds)
	const serverId = Zus.useStore(props.stores.listHost, ListHostPrt.Sel.serverId)

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
		const voteState = serverId ? VoteClient.voteState$(serverId).getValue() : undefined
		const layerList = LayerQueuePrt.Sel.layerList(Zus.getState(props.stores.listHost))
		if (voteState?.code === 'in-progress') {
			for (const cursor of cursors) {
				if (LL.isChildItem(cursor.itemId, voteState.itemId, layerList)) return
			}
		}

		const cursor = cursors[0]

		if (event.active.type === 'history-entry' && serverId) {
			const history = await MatchHistoryClient.recentMatches$(serverId).getValue()
			const activeId = event.active.id
			const entry = history.find((entry) => entry.historyEntryId === activeId)
			if (!entry) return
			const index = LL.resolveCursorIndex(layerList, cursor)!
			void LayerQueuePrt.Actions.dispatch(
				{ queue: props.stores.listHost },
				{
					op: 'add',
					items: [{ type: 'single-list-item', layerId: entry.layerId }],
					index,
				},
			)
		}

		if (event.active.type === 'layer-item') {
			void LayerQueuePrt.Actions.dispatch(
				{ queue: props.stores.listHost },
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
			UPClient.Actions.updateActivity({ code: 'set-editing-queue-idle-if', currentCodes: ['MOVING_ITEM', 'ADDING_ITEM_FROM_HISTORY'] })
			return
		}
		if (item?.type === 'layer-item') {
			UPClient.Actions.updateActivity({ code: 'set-editing-queue', activity: { code: 'MOVING_ITEM', itemId: item.id } })
			return
		}

		if (item?.type === 'history-entry') {
			UPClient.Actions.updateActivity({ code: 'set-editing-queue', activity: { code: 'ADDING_ITEM_FROM_HISTORY' } })
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

function LoadedActivitiesRenderer({ stores }: { stores: ListHostPrt.KeyProp }) {
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
				if (entry.name === 'addRotation') {
					return <LoadedAddRotation key="add-rotation" stores={stores} entry={entry} />
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
	stores: ListHostPrt.KeyProp
	entry: Extract<UPClient.LoadedActivityState, { name: 'selectLayers' }>
}) {
	const entry = useStable(_entry)

	const setPosition = (newPosition: AddLayersPosition) => {
		SelectLayersFrame.Actions.setCursor({ selectLayers: entry.data.selectLayersFrame }, ADD_LAYERS_CURSORS[newPosition])
	}

	const addLayersAtPosition = Zus.useStore(entry.data.selectLayersFrame, selectAddLayersPosition)

	const activity = entry.key
	const data = entry.data

	const [pendingTags, setPendingTags] = React.useState<LTag.TagId[]>([])

	const onAddItems = (items: LL.NewItem[]) => {
		if (activity.code !== 'ADDING_ITEM') return
		const layerList = LayerQueuePrt.Sel.layerList(Zus.getState(stores.listHost))
		let cursor = Zus.getState(entry.data.selectLayersFrame).cursor
		let index: LL.ItemIndex
		const defaultIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) index = LL.resolveCursorIndex(layerList, cursor) ?? defaultIndex
		else index = defaultIndex
		void LayerQueuePrt.Actions.dispatch(
			{ queue: stores.listHost },
			{
				op: 'add',
				items: LL.withTags(items, pendingTags),
				index,
			},
		)
	}

	const onEditedLayer = (layerId: L.LayerId) => {
		if (activity.code !== 'EDITING_ITEM') return
		const itemId = activity.itemId
		void LayerQueuePrt.Actions.dispatch(
			{ queue: stores.listHost },
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
		listHost: stores.listHost,
	}

	const addLayersTabsList = (
		<TabsList
			variant="seg"
			options={[
				{ label: tr.text(LL_Msgs.placeStart()), value: 'next' },
				{ label: tr.text(LL_Msgs.placeEnd()), value: 'after' },
			]}
			active={addLayersAtPosition}
			setActive={setPosition}
		/>
	)

	if (activity.code === 'EDITING_ITEM') {
		return <EditLayerDialog stores={dialogStores} open={entry.active} onOpenChange={onSelectLayersChange} onSelectLayer={onEditedLayer} />
	} else if (activity.code === 'ADDING_ITEM') {
		return (
			<SelectLayersDialog
				title={activity.title ?? tr.text(LL_Msgs.addLayers())}
				stores={dialogStores}
				open={entry.active}
				onOpenChange={onSelectLayersChange}
				selectQueueItems={onAddItems}
				modeSwitchAdditions={activity.variant === 'toggle-position' && addLayersTabsList}
				modeSwitchAdditionsLabel={tr.text(LL_Msgs.addPosition())}
				footerBeforeSubmitLabel={tr.text(LL_Msgs.addTags())}
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
	stores: ListHostPrt.KeyProp
	entry: Extract<UPClient.LoadedActivityState, { name: 'genVote' }>
}) {
	const entry = useStable(_entry)
	const data = entry.data

	const onOpenChange = (open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}

	const dialogStores = {
		genVote: data.genVoteFrame,
		listHost: stores.listHost,
	}
	const [pendingTags, setPendingTags] = React.useState<LTag.TagId[]>([])

	const onSubmit = (result: GenVoteFrame.Result, cursor?: LL.Cursor) => {
		const source: LL.Source = {
			type: 'manual',
			userId: UsersClient.loggedInUserId!,
		}

		const item = LL.withTags([LL.createVoteItem(result.choices, source, result.voteConfig)], pendingTags)[0]

		const layerList = LayerQueuePrt.Sel.layerList(Zus.getState(stores.listHost))
		let index: LL.ItemIndex
		const defaultIndex: LL.ItemIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) {
			index = LL.resolveCursorIndex(layerList, cursor) ?? defaultIndex
		} else {
			index = defaultIndex
		}

		void LayerQueuePrt.Actions.dispatch(
			{ queue: stores.listHost },
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

function LoadedAddRotation({
	stores,
	entry: _entry,
}: {
	stores: ListHostPrt.KeyProp
	entry: Extract<UPClient.LoadedActivityState, { name: 'addRotation' }>
}) {
	const entry = useStable(_entry)
	const installedMods = Zus.useStore(
		stores.listHost,
		Zus.useShallow((s: ListHostPrt.Store) => s.settings.saved.installedMods),
	)
	const onOpenChange = (open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}
	return <AddRotationDialog stores={stores} open={entry.active} onOpenChange={onOpenChange} installedMods={installedMods} />
}

type LayerListItemProps = {
	itemId: string
	stores: ListHostPrt.KeyProp
}

// memoized so LayerList re-renders (e.g. queueItemIds reordering on a move) don't cascade into
// every item's subtree -- items re-render via their own store subscriptions instead
const LayerListItem = React.memo(function LayerListItem(props: LayerListItemProps) {
	const entry = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.itemEntry(props.itemId))
	if (!entry) return null
	if (LL.isVoteItem(entry.item)) {
		return <VoteLayerListItem {...props} />
	}
	return <SingleLayerListItem {...props} />
})

// what a row shows only on a server's queue: the vote running on it, and whether its head is the server's next layer
type ServerRowState = {
	globalVoteState: ReturnType<typeof VoteClient.useVoteState>
	layersStatus:
		| NonNullable<ReturnType<typeof resToOptional<NonNullable<ReturnType<typeof SquadServerClient.useLayersStatus>>>>>['data']
		| undefined
	playerCount: ReturnType<typeof SquadServerClient.usePlayerCount>
	nextLayerSyncState: ReturnType<typeof LayerQueueClient.useNextLayerSyncState>
}

function useServerRowState(serverId: string): ServerRowState {
	return {
		globalVoteState: VoteClient.useVoteState(serverId),
		layersStatus: resToOptional(SquadServerClient.useLayersStatus(serverId))?.data,
		playerCount: SquadServerClient.usePlayerCount(serverId),
		nextLayerSyncState: LayerQueueClient.useNextLayerSyncState(serverId),
	}
}

const SingleLayerListItem = React.memo(function SingleLayerListItem(props: LayerListItemProps) {
	const serverId = Zus.useStore(props.stores.listHost, ListHostPrt.Sel.serverId)
	if (serverId) return <ServerSingleLayerListItem {...props} serverId={serverId} />
	return <SingleLayerListRow {...props} />
})

function ServerSingleLayerListItem(props: LayerListItemProps & { serverId: string }) {
	const server = useServerRowState(props.serverId)
	return <SingleLayerListRow {...props} server={server} />
}

function SingleLayerListRow(props: LayerListItemProps & { server?: ServerRowState }) {
	const host = Zus.useStore(props.stores.listHost, ListHostPrt.Sel.host)
	const { item, index, isLocallyLast, displayedMutation, parentItem } = Zus.useStore(
		props.stores.listHost,
		LayerQueuePrt.Sel.itemDisplay(props.itemId),
	)

	const user = UsersClient.useLoggedInUser()

	// the tutorial tour spotlights one row's controls; the head row stands in for "a layer". The first few rows all
	// carry the queue-item anchor: a plain 'queue-item' anchor still resolves to the head (first laid-out match), and
	// { all: 'queue-item' } bounds the run of rows, which the normalization step highlights as a sequence.
	const isTourRow = LL.isLocallyFirstIndex(index)
	const isTourSeqRow = index.innerIndex === null && index.outerIndex < 3

	const isVoteChoice = !!parentItem

	const isModified = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.isModified)
	const isLocked = Zus.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const writeDenied = useListWriteDenied(host)
	const canEdit = !isLocked && !writeDenied

	const [itemPresence, itemActivityUser, activityHovered] = UPClient.useItemPresence(item.itemId)

	const globalVoteState = props.server?.globalVoteState
	const voteState =
		(globalVoteState && globalVoteState?.itemId === parentItem?.itemId ? globalVoteState : undefined) ?? parentItem?.endingVoteState

	const draggableItem = LL.layerItemToDragItem(item)
	// 'default' (clone) not 'move': with 'move' dnd-kit drags the real element and animates it into its final
	// slot over a 250ms drop animation, so the item visibly lags behind the mouse release. 'default' drags a
	// throwaway clone and places the real item instantly. Matches vote items (below) and the filter editor.
	const {
		ref: dragRef,
		handleRef: dragHandleRef,
		isDragging,
	} = DndKit.useDraggable(draggableItem, { feedback: 'default', disabled: !canEdit })

	const itemStores = { queue: props.stores.listHost }

	const editActivity = React.useMemo(
		() => ({
			code: 'EDITING_ITEM' as const,
			itemId: item.itemId,
			cursor: { type: 'item-relative' as const, itemId: item.itemId, position: 'on' as const },
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

	const isPhone = Browser.useIsSmallViewport()

	const badges: React.ReactNode[] = []
	let sourceDisplay: React.ReactNode | undefined

	if (user && itemPresence?.itemActivity) {
		sourceDisplay = (
			<Badge key={`activity ${itemPresence.itemActivity.code}`} variant="info" className="text-nowrap">
				{attributedActivityText(itemPresence.activityState!, index, itemActivityUser.displayName)}
			</Badge>
		)
	} else if (host.type === 'server') {
		// a rotation's items are anonymous, so only a queue item says where it came from
		sourceDisplay = <LayerSourceDisplay key={`source ${item.source.type}`} source={item.source} />
	}

	const editButtonProps = (className?: string) => ({
		'data-can-edit': canEdit,
		'data-mobile': isPhone,
		disabled: !canEdit,
		className,
	})

	// the item menu's tag and note entries open these; the dialogs outlive the menu, so the row owns them
	const [rowEditor, setRowEditor] = React.useState<{ type: 'new-tag' } | { type: 'note'; note: LNote.Note | null } | null>(null)
	const onNewTag = () => setRowEditor({ type: 'new-tag' })
	const onAddNote = () => setRowEditor({ type: 'note', note: null })
	const onEditNote = (note: LNote.Note) => setRowEditor({ type: 'note', note })

	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		stores: props.stores,
		itemId: props.itemId,
		onNewTag,
		onAddNote,
		onEditNote,
	} satisfies Partial<ItemDropdownProps>

	const layersStatus = props.server?.layersStatus
	const playerCount = props.server?.playerCount ?? null
	const tally =
		voteState && V.isVoteStateWithVoteData(voteState) && playerCount !== null ? V.tallyVotes(voteState, playerCount) : undefined

	const itemChoiceTallyPercentage = isVoteChoice && voteState ? tally?.percentages?.get(item.itemId) : undefined
	const isVoteWinner = isVoteChoice && voteState?.code === 'ended:winner' && voteState?.winnerId === item.itemId
	const voteCount = isVoteChoice && voteState ? tally?.totals?.get(item.itemId) : undefined
	const updatesDisabled = Zus.useStore(props.stores.listHost, (s) => s.settings.saved.updatesToSquadServerDisabled)
	const committing = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.committing)
	const nextLayerSyncState = props.server?.nextLayerSyncState
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

	// a running vote is still deciding the next layer, so nothing said here would hold for long. A rotation has no
	// server to hold a next layer
	if (props.server && isNextLayerCandidate && voteState?.code !== 'in-progress') {
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
						<Icons.Sword className="ms-1 inline h-3 w-3" />
					</TooltipContent>
				</Tooltip>,
			)
		} else if (committing || nextLayerSyncState?.code === 'syncing' || !serverNextLayer) {
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
			<ItemContextMenu
				stores={props.stores}
				itemId={props.itemId}
				disabled={!canEdit}
				onNewTag={onNewTag}
				onAddNote={onAddNote}
				onEditNote={onEditNote}
			>
				<li
					ref={dragRef}
					className={cn(
						Typo.LayerText,
						'group/single-item grid gap-1.5 items-center w-full min-h-(--row) px-1 border-t border-[#1f1f21] first:border-t-0 hover:bg-white/4 cursor-default',
						'shadow-[inset_3px_0_0_transparent] data-[mutation=added]:shadow-[inset_3px_0_0_var(--ok)] data-[mutation=moved]:shadow-[inset_3px_0_0_var(--info-c)] data-[mutation=edited]:shadow-[inset_3px_0_0_var(--warn)] rtl:data-[mutation=added]:shadow-[inset_-3px_0_0_var(--ok)] rtl:data-[mutation=moved]:shadow-[inset_-3px_0_0_var(--info-c)] rtl:data-[mutation=edited]:shadow-[inset_-3px_0_0_var(--warn)]',
						'data-[is-voting=true]:bg-[rgba(95,183,106,0.06)] data-[is-dragging=true]:outline-2 data-[is-dragging=true]:outline-solid data-[is-dragging=true]:outline-line-soft data-[is-dragging=true]:bg-transparent! [&[data-is-dragging=true]>*]:invisible data-[is-hovered=true]:outline-solid data-[is-hovered=true]:outline-1 data-[is-hovered=true]:outline-pri-lo',
						isPhone ? 'grid-cols-[28px_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(26px,max-content)_16px_minmax(0,1fr)_auto]',
					)}
					data-mutation={displayedMutation}
					data-tour={isTourSeqRow ? 'queue-item' : undefined}
					data-is-dragging={isDragging}
					data-is-voting={voteState?.code === 'in-progress'}
					data-is-hovered={activityHovered}
				>
					<span data-mobile={isPhone} className="text-end font-mono whitespace-nowrap text-text-3 data-[mobile=true]:hidden">
						<bdi dir="ltr">{LL.getItemNumber(index)}</bdi>
					</span>
					<button
						type="button"
						ref={dragHandleRef}
						data-tour={isTourRow ? 'queue-reorder' : undefined}
						{...editButtonProps(
							'flex size-4 pointer-coarse:size-(--ctl) max-phone:h-full! max-phone:w-full! max-phone:self-stretch touch-none select-none [-webkit-touch-callout:none] items-center justify-center text-text-3 hover:text-text data-[can-edit=true]:cursor-grab disabled:opacity-40 [&_svg]:size-3.5 pointer-coarse:[&_svg]:size-6',
						)}
						{...dragHandleTouchProps}
					>
						<Icons.GripVertical />
					</button>
					<span data-tour={isTourRow ? 'queue-item-display' : undefined} className="flex w-full min-w-0 flex-col gap-0.5 py-0.5">
						<LayerDisplay
							stores={props.stores}
							droppable={true}
							stacked={isPhone}
							trailing={
								isPhone && sourceDisplay ? (
									<span data-tour={isTourRow ? 'queue-item-source' : undefined}>{sourceDisplay}</span>
								) : undefined
							}
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
										hideAdd={isPhone}
										onAdd={(tagId) => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'add-tag', tagId })}
										onRemove={(tagId) =>
											LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'remove-tag', tagId })
										}
									/>
								)
							}
							addNote={
								item.type === 'single-list-item' &&
								!isPhone && (
									<AddNoteButton
										disabled={!canEdit}
										revealOnHover
										onAdd={(text) =>
											LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
												op: 'add-note',
												noteId: LNote.createNoteId(),
												text,
											})
										}
									/>
								)
							}
							notes={
								item.type === 'single-list-item' && (
									<LayerNotes
										host={host}
										notes={item.notes}
										disabled={!canEdit}
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
					<span className="flex items-center gap-1.5 max-phone:self-stretch">
						{sourceDisplay && !isPhone && <span data-tour={isTourRow ? 'queue-item-source' : undefined}>{sourceDisplay}</span>}
						<span className={cn('fd-grp', isPhone && 'hidden')}>
							<StartActivityInteraction
								loaderName="selectLayers"
								createActivity={UP.createEditingQueueVariant(editActivity)}
								matchKey={(key) => Obj.deepEqualStrict(key, { ...editActivity, host })}
								preload="intent"
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
							<Button
								{...editButtonProps('max-phone:h-full!')}
								data-tour={isTourRow ? 'queue-item-menu' : undefined}
								variant="ghost"
								size="icon-sm"
							>
								<Icons.EllipsisVertical />
							</Button>
						</ItemDropdown>
					</span>
				</li>
			</ItemContextMenu>
			{item.type === 'single-list-item' && (
				<>
					<LayerTagDialog
						state={rowEditor?.type === 'new-tag' ? 'new' : null}
						onClose={() => setRowEditor(null)}
						onCreated={(tagId) => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'add-tag', tagId })}
					/>
					<LayerNoteDialog
						state={rowEditor?.type === 'note' ? (rowEditor.note ? { note: rowEditor.note } : 'new') : null}
						onClose={() => setRowEditor(null)}
						onSubmit={(text) => {
							const note = rowEditor?.type === 'note' ? rowEditor.note : null
							LayerQueuePrt.Actions.dispatchItemOp(
								itemStores,
								props.itemId,
								note ? { op: 'edit-note', noteId: note.id, text } : { op: 'add-note', noteId: LNote.createNoteId(), text },
							)
							setRowEditor(null)
						}}
					/>
				</>
			)}
			<QueueItemSeparator links={afterItemLinks} isAfterLast={isLocallyLast} disabled={!canEdit} />
		</>
	)
}

function VoteLayerListItem(props: LayerListItemProps) {
	const host = Zus.useStore(props.stores.listHost, ListHostPrt.Sel.host)
	const display = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.itemDisplay(props.itemId))
	const { index, isLocallyLast, displayedMutation } = display
	const item = display.item as LL.VoteItem
	const serverId = host.type === 'server' ? host.serverId : undefined

	const isEditing = UPClient.useIsEditing()
	const isLocked = Zus.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const writeDenied = useListWriteDenied(host)
	const canEdit = !isLocked && !writeDenied
	const draggableItem = LL.layerItemToDragItem(item)
	const { ref: dragRef, handleRef: dragHandleRef, isDragging } = DndKit.useDraggable(draggableItem, { disabled: !canEdit })

	const itemStores = { queue: props.stores.listHost }

	const [dropdownOpen, setDropdownOpen] = React.useState(false)
	const isPhone = Browser.useIsSmallViewport()

	const editButtonProps = (className?: string) => ({
		['data-mobile']: isPhone,
		disabled: !canEdit,
		className: className,
		['data-can-edit']: canEdit,
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
		create: UP.createEditingQueueVariant({ code: 'CONFIGURING_VOTE', itemId: item.itemId }),
		match: React.useCallback(
			(state) => {
				const edit = UP.editingQueue(state)
				return edit?.code === 'CONFIGURING_VOTE' && edit.itemId === item.itemId
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

	return (
		<>
			{LL.isLocallyFirstIndex(index) && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} disabled={!canEdit} />}
			<ItemContextMenu stores={props.stores} itemId={props.itemId} disabled={!canEdit}>
				<li
					ref={dragRef}
					className={cn(
						'group/parent-item flex data-[is-dragging=false]:w-full min-w-10 min-h-5 items-center justify-between px-1 py-0 border-2 border-gray-400 rounded inset-2',
						`data-[mutation=added]:border-added data-[mutation=moved]:border-moved data-[mutation=edited]:border-edited data-[is-dragging=true]:outline-solid cursor-default`,
					)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					{isDragging ? (
						<span className="mx-auto w-5">...</span>
					) : (
						<div className="h-full flex flex-col grow">
							<div className="p-1 space-x-2 flex items-center justify-between w-full">
								<span className="flex items-center space-x-1">
									<Button
										ref={dragHandleRef}
										{...editButtonProps('touch-none data-[can-edit=true]:cursor-grab')}
										{...dragHandleTouchProps}
										variant="ghost"
										size="icon"
									>
										<Icons.GripHorizontal />
									</Button>
									<h3 className={cn(Typo.Label, 'bold')}>{tr.text(V_Msgs.heading())}</h3>
									{serverId && <VoteServerStatus serverId={serverId} item={item} />}
								</span>
								<span className="flex items-center space-x-1">
									{serverId && <VoteServerStart serverId={serverId} item={item} stores={props.stores} />}

									{/* -------- add vote choices -------- */}
									{inline(() => {
										const activityTitle = tr.text(V_Msgs.addVoteChoices())
										return (
											<StartActivityInteraction
												loaderName="selectLayers"
												preload="intent"
												createActivity={UP.createEditingQueueVariant({
													code: 'ADDING_ITEM',
													cursor: {
														type: 'index',
														index: { outerIndex: index.outerIndex, innerIndex: item.choices.length },
													},
													action: 'add',
													title: activityTitle,
												})}
												matchKey={(key) => key.code === 'ADDING_ITEM' && key.title === activityTitle}
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

									<VoteDisplayPropsButton
										serverId={serverId}
										open={voteDisplayPropsOpen}
										onOpenChange={setVoteDisplayPropsOpen}
										stores={props.stores}
										itemId={props.itemId}
										canEdit={canEdit}
									/>
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

// a vote's display settings can be edited by anyone who may edit the list, and on a server, only by those who may
// also manage its votes
function VoteDisplayPropsButton(props: {
	serverId: string | undefined
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	stores: ListHostPrt.KeyProp
	itemId: LL.ItemId
	canEdit: boolean
}) {
	const button = (readonly: boolean) => (
		<VoteDisplayPropsPopover
			open={props.open}
			onOpenChange={props.onOpenChange}
			stores={props.stores}
			itemId={props.itemId}
			readonly={readonly}
		>
			<Button variant="ghost" size="icon" aria-label={tr.text(V_Msgs.configureVote())}>
				<Icons.Settings2 />
			</Button>
		</VoteDisplayPropsPopover>
	)
	if (!props.serverId) return button(!props.canEdit)
	return <ServerVoteDisplayPropsButton serverId={props.serverId} render={(manageDenied) => button(!props.canEdit || manageDenied)} />
}

function ServerVoteDisplayPropsButton(props: { serverId: string; render: (manageDenied: boolean) => React.ReactNode }) {
	const manageVoteDenied = RbacClient.usePermsCheck(RBAC.perm('vote:manage', { serverId: props.serverId }))
	return props.render(!!manageVoteDenied)
}

// the autostart countdown, the running vote's status and tally, and the controls to end or abort it
function VoteServerStatus(props: { serverId: string; item: LL.VoteItem }) {
	const { serverId, item } = props
	const globalVoteState = VoteClient.useVoteState(serverId)
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? item.endingVoteState
	const manageVoteDenied = RbacClient.usePermsCheck(RBAC.perm('vote:manage', { serverId }))
	const isPhone = Browser.useIsSmallViewport()
	const manageVoteButtonProps = (opts?: { className?: string }) => ({
		['data-mobile']: isPhone,
		disabled: !!manageVoteDenied,
		className: opts?.className,
	})

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
	const voteAutostartTime = voteState?.code === 'ready' ? voteState.autostartTime : undefined
	const voteTally = voteState && voteState.code !== 'ready' ? V.tallyVotes(voteState, serverInfo?.playerCount ?? 0) : undefined

	return (
		<>
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
					<span>{voteTally && serverInfo && <span>{tr.text(V_Msgs.tally(voteTally.totalVotes, serverInfo.playerCount))}</span>}</span>
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
		</>
	)
}

// the internal-vote switch and the button that starts the vote
function VoteServerStart(props: { serverId: string; item: LL.VoteItem; stores: ListHostPrt.KeyProp }) {
	const { serverId, item } = props
	const globalVoteState = VoteClient.useVoteState(serverId)
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? item.endingVoteState
	const isModified = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.isModified)
	const manageVoteDenied = RbacClient.usePermsCheck(RBAC.perm('vote:manage', { serverId }))
	const isPhone = Browser.useIsSmallViewport()
	const manageVoteButtonProps = (opts?: { className?: string }) => ({
		['data-mobile']: isPhone,
		disabled: !!manageVoteDenied,
		className: opts?.className,
	})

	const [voterType, setVoterType] = React.useState<V.VoterType>(voteState?.voterType ?? 'public')
	const internalVoteCheckboxId = React.useId()

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

	const canInitiateVote = Zus.useStore(
		props.stores.listHost,
		LayerQueuePrt.Sel.canInitiateVote(item.itemId, voterType, globalVoteState ?? undefined, isModified),
	)

	return (
		<>
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
		</>
	)
}

export function VoteDisplayPropsPopover(props: {
	itemId: LL.ItemId
	stores: ListHostPrt.KeyProp
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
	stores: ListHostPrt.KeyProp
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	readonly?: boolean
}) {
	const vote = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.voteItemConfig(props.itemId))
	const [localConfig, setLocalConfig] = React.useState<Partial<V.AdvancedVoteConfig> | null>(null)

	function handleSave() {
		LayerQueuePrt.Actions.dispatchItemOp({ queue: props.stores.listHost }, props.itemId, {
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
				<Button submitChord variant="primary" className="w-full mt-4" size="sm" onClick={handleSave}>
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
	stores: ListHostPrt.KeyProp
	allowVotes?: boolean
	itemId: LL.ItemId
	onNewTag?: () => void
	onAddNote?: () => void
	onEditNote?: (note: LNote.Note) => void
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
	Label: React.ComponentType<React.PropsWithChildren>
	Item: React.FunctionComponent<ItemMenuItemProps>
	Separator: React.ComponentType
	Sub: React.ComponentType<React.PropsWithChildren>
	SubTrigger: React.FunctionComponent<ItemMenuItemProps>
	SubContent: React.FunctionComponent<React.PropsWithChildren<{ className?: string }>>
}

const dropdownMenuComponents: ItemMenuComponents = {
	Group: DropdownMenuGroup,
	Label: DropdownMenuLabel,
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent,
}

const contextMenuComponents: ItemMenuComponents = {
	Group: ContextMenuGroup,
	Label: ContextMenuLabel,
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
					onEditNote={props.onEditNote}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function ItemContextMenu(props: {
	children: React.ReactNode
	stores: ListHostPrt.KeyProp
	itemId: LL.ItemId
	disabled?: boolean
	onNewTag?: () => void
	onAddNote?: () => void
	onEditNote?: (note: LNote.Note) => void
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
					onEditNote={props.onEditNote}
				/>
			</ContextMenuContent>
		</ContextMenu>
	)
}

function ItemMenuItems(props: {
	stores: ListHostPrt.KeyProp
	itemId: LL.ItemId
	menu: ItemMenuComponents
	onNewTag?: () => void
	onAddNote?: () => void
	onEditNote?: (note: LNote.Note) => void
}) {
	const Menu = props.menu
	const entry = Zus.useStore(props.stores.listHost, LayerQueuePrt.Sel.itemEntry(props.itemId))!
	const { item, index, lastLocalIndex } = entry

	const activities = React.useMemo(() => {
		return {
			'add-after': {
				code: 'ADDING_ITEM',
				cursor: { type: 'item-relative', itemId: item.itemId, position: 'after' },
				action: 'add',
			},
			'add-before': {
				code: 'ADDING_ITEM',
				cursor: { type: 'item-relative', itemId: item.itemId, position: 'before' },
				action: 'add',
			},
			'create-vote': {
				code: 'ADDING_ITEM',
				cursor: { type: 'item-relative', itemId: item.itemId, position: 'on' },
				title: tr.text(V_Msgs.createVote()),
				action: 'edit',
			},
		} satisfies { [k in SubDropdownState]: UP.QueueEditingActivity }
	}, [item.itemId])

	const host = Zus.useStore(props.stores.listHost, ListHostPrt.Sel.host)
	const isLocked = Zus.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const writeDenied = useListWriteDenied(host)
	const canEdit = !isLocked && !writeDenied
	const itemStores = { queue: props.stores.listHost }

	function sendToFront() {
		if (!user) return
		const firstItem = LayerQueuePrt.Sel.layerList(Zus.getState(props.stores.listHost))[0]
		LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
			op: 'move',
			newFirstItemId: LL.createItemId(),
			cursor: { type: 'item-relative', itemId: firstItem.itemId, position: 'before' },
		})
	}
	function sendToBack() {
		if (!user) return
		const state = Zus.getState(props.stores.listHost)
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
	const configuredTags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.layerTags ?? [])
	const canManageTags = !RbacClient.useAccess('settings.global.upsertLayerTag')
	const appliedTags = item.type === 'single-list-item' ? (item.tags ?? []) : []
	// someone else's note needs queue:manage-all-notes on a queue; a rotation's notes are anyone's who may edit it
	const manageAllNotesDenied = RbacClient.usePermsCheck(
		host.type === 'server'
			? RBAC.perm('queue:manage-all-notes', { serverId: host.serverId })
			: RBAC.getWritePermReqForRotation(host.rotationId),
	)
	const editActivity = {
		code: 'EDITING_ITEM' as const,
		itemId: item.itemId,
		cursor: { type: 'item-relative' as const, itemId: item.itemId, position: 'on' as const },
	}
	const layerIds = item.type === 'single-list-item' ? [item.layerId] : item.choices.map((choice) => choice.layerId)
	const notes = item.type === 'single-list-item' ? (item.notes ?? []) : []
	return (
		<>
			<LayerMenuItems layerIds={layerIds} slots={props.menu} labelled />
			<Menu.Separator />
			<Menu.Label>{tr.text(LL_Msgs.queueItemGroup())}</Menu.Label>
			<Menu.Group>
				{item.type === 'single-list-item' && (
					<>
						<StartActivityInteraction
							loaderName="selectLayers"
							createActivity={UP.createEditingQueueVariant(editActivity)}
							matchKey={(key) => Obj.deepEqualStrict(key, { ...editActivity, host })}
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
					</>
				)}
				<Menu.Item disabled={!canEdit} onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'delete' })}>
					<Icons.X />
					{tr.text(LL_Msgs.deleteItem())}
				</Menu.Item>
			</Menu.Group>
			<Menu.Separator />
			{item.type === 'single-list-item' && (
				<>
					<Menu.Group>
						<Menu.Sub>
							<Menu.SubTrigger disabled={!canEdit}>
								<Icons.Tag />
								{tr.text(LTag_Msgs.tagsSub())}
							</Menu.SubTrigger>
							<Menu.SubContent className="max-h-72 max-w-72 overflow-y-auto">
								{configuredTags.map((tag) => {
									const applied = appliedTags.includes(tag.id)
									return (
										<Menu.Item
											key={tag.id}
											onClick={() =>
												LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
													op: applied ? 'remove-tag' : 'add-tag',
													tagId: tag.id,
												})
											}
										>
											{applied ? <Icons.Check /> : <span className="size-4 shrink-0" />}
											<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
											<span className="truncate">{tag.label}</span>
										</Menu.Item>
									)
								})}
								{configuredTags.length === 0 && <Menu.Item disabled>{tr.text(LTag_Msgs.noTagsAvailable())}</Menu.Item>}
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
						<Menu.Sub>
							<Menu.SubTrigger disabled={!canEdit}>
								<Icons.MessageSquare />
								{tr.text(LNote_Msgs.notesSub())}
							</Menu.SubTrigger>
							<Menu.SubContent className="max-h-72 max-w-80 overflow-y-auto">
								{props.onAddNote && (
									<Menu.Item onClick={props.onAddNote}>
										<Icons.MessageSquarePlus />
										{tr.text(LNote_Msgs.addNoteItem())}
									</Menu.Item>
								)}
								{notes.length > 0 && <Menu.Separator />}
								{notes.map((note) => {
									const canManage = LNote.isAuthor(note, user?.discordId) || manageAllNotesDenied === null
									return (
										<Menu.Sub key={note.id}>
											<Menu.SubTrigger disabled={!canManage}>
												<span className="max-w-60 truncate">{note.text}</span>
											</Menu.SubTrigger>
											<Menu.SubContent>
												{props.onEditNote && (
													<Menu.Item onClick={() => props.onEditNote!(note)}>
														<Icons.Pencil />
														{tr.text(LNote_Msgs.edit())}
													</Menu.Item>
												)}
												<Menu.Item
													className="text-destructive"
													onClick={() =>
														LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
															op: 'delete-note',
															noteId: note.id,
														})
													}
												>
													<Icons.Trash />
													{tr.text(LNote_Msgs.deleteNote())}
												</Menu.Item>
											</Menu.SubContent>
										</Menu.Sub>
									)
								})}
							</Menu.SubContent>
						</Menu.Sub>
					</Menu.Group>
					<Menu.Separator />
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
					matchKey={(key) => Obj.deepEqualStrict(key, { ...activities['add-before'], host })}
					preload="viewport"
					render={Menu.Item}
					disabled={!canEdit}
				>
					{tr.text(LL_Msgs.addLayersBefore())}
				</StartActivityInteraction>
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={UP.createEditingQueueVariant(activities['add-after'])}
					matchKey={(key) => Obj.deepEqualStrict(key, { ...activities['add-after'], host })}
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

function attributedActivityText(activity: UP.RootActivity, index: LL.ItemIndex, displayName: string) {
	const described = UP.describeActivity(activity, index)
	if (!described) return null
	return tr.text(UP_Msgs.attributedActivity(displayName, described))
}
