import { AdvancedVoteConfigEditor } from '@/components/advanced-vote-config-editor'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import type * as GenVoteFrame from '@/frames/gen-vote.frame.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useIsMobile } from '@/hooks/use-is-mobile.ts'

import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import * as Obj from '@/lib/object'
import { inline, useStableValue } from '@/lib/react.ts'
import * as ST from '@/lib/state-tree.ts'
import { statusCodeToTitleCase } from '@/lib/string.ts'
import { assertNever } from '@/lib/type-guards.ts'
import { resToOptional } from '@/lib/types.ts'
import * as Typo from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'

import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'

import * as UP from '@/models/user-presence'
import * as V from '@/models/vote.models.ts'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'

import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as DndKit from '@/systems/dndkit.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as VotesClient from '@/systems/vote.client'
import * as RQ from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import { StartActivityInteraction } from './activity.tsx'
import EditLayerDialog from './edit-layer-dialog.tsx'
import GenVoteDialog from './gen-vote-dialog.tsx'
import LayerDisplay from './layer-display.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import { MultiLayerSetDialog } from './multi-layer-set-dialog.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { Timer } from './timer.tsx'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'
import TabsList from './ui/tabs-list.tsx'

export function LayerList(
	props: { stores: SquadServerFrame.KeyProp },
) {
	const queueItemIds = ZusUtils.useStore(
		props.stores.squadServer,
		LayerQueuePrt.Sel.queueItemIds,
	)
	const serverId = props.stores.squadServer.serverId

	// -------- dispatch move events --------
	DndKit.useDragEnd(React.useCallback(async (event) => {
		const user = UsersClient.loggedInUser
		const upState = ZusUtils.getState(UPClient.Store)
		if (!user || !event.over) return
		if (!UPClient.Sel.isEditing(user.discordId)(upState)) return
		const target = event.over.slots[0]
		if (target.dragItem.type !== 'layer-item') return
		const cursors = LL.dropItemToLLItemCursors(event.over)
		if (cursors.length === 0) return
		const voteState = VotesClient.voteState$(serverId).getValue()
		const layerList = LayerQueuePrt.Sel.layerList(ZusUtils.getState(props.stores.squadServer))
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
			void LayerQueuePrt.Actions.dispatch({ queue: props.stores.squadServer }, {
				op: 'add',
				items: [{ type: 'single-list-item', layerId: entry.layerId }],
				index,
			})
		}

		if (event.active.type === 'layer-item') {
			void LayerQueuePrt.Actions.dispatch({ queue: props.stores.squadServer }, {
				op: 'move',
				cursor: cursor,
				itemId: event.active.id,
				newFirstItemId: LL.createItemId(),
			})
		}
	}, [props.stores.squadServer, serverId]))

	DndKit.useDraggingCallback(item => {
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
			<ul className="flex w-full flex-col">
				{queueItemIds.map((id) => (
					<LayerListItem
						key={id}
						itemId={id}
						stores={props.stores}
					/>
				))}
			</ul>
			<LoadedActivitiesRenderer stores={props.stores} />
		</>
	)
}

function LoadedActivitiesRenderer({ stores }: { stores: SquadServerFrame.KeyProp }) {
	const loadedActivities = ZusUtils.useStore(UPClient.Store, ZusUtils.useShallow(UPClient.Sel.loadedActivities))
	return (
		<>
			{loadedActivities.map((entry) => {
				if (entry.name === 'selectLayers') {
					return (
						<LoadedSelectLayersView
							key={entry.data.selectLayersFrame.instanceId}
							stores={stores}
							entry={entry}
						/>
					)
				}
				if (entry.name === 'genVote') {
					return (
						<LoadedGenVoteView
							key={entry.data.genVoteFrame.instanceId}
							stores={stores}
							entry={entry}
						/>
					)
				}
				if (entry.name === 'pasteRotation') {
					return (
						<LoadedPasteRotation
							key="paste-rotation"
							stores={stores}
							entry={entry}
						/>
					)
				}
				assertNever(entry)
			})}
		</>
	)
}

type AddLayersPosition = 'next' | 'after'

function LoadedSelectLayersView({
	stores,
	entry: _entry,
}: {
	stores: SquadServerFrame.KeyProp
	entry: Extract<UPClient.LoadedActivityState, { name: 'selectLayers' }>
}) {
	const entry = useStableValue((e) => e, [_entry])
	const positionCursors = React.useMemo(() => {
		const next: LL.Cursor = { type: 'start' }
		const after: LL.Cursor = { type: 'end' }
		return { next, after }
	}, [])

	const setPosition = React.useCallback((newPosition: AddLayersPosition) => {
		SelectLayersFrame.Actions.setCursor({ selectLayers: entry.data.selectLayersFrame }, positionCursors[newPosition])
	}, [entry.data.selectLayersFrame, positionCursors])

	const addLayersAtPosition = ZusUtils.useStore(
		entry.data.selectLayersFrame,
		React.useCallback((s: SelectLayersFrame.Types['state']) => {
			if (s.cursor?.type === 'end') return 'after' as const
			return 'next' as const
		}, []),
	)

	const activity = entry.key
	const data = entry.data

	const onAddItems = React.useCallback((items: LL.NewItem[]) => {
		if (activity.id !== 'ADDING_ITEM') return
		const layerList = LayerQueuePrt.Sel.layerList(ZusUtils.getState(stores.squadServer))
		let cursor = ZusUtils.getState(entry.data.selectLayersFrame).cursor
		let index: LL.ItemIndex
		const defaultIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) index = LL.resolveCursorIndex(layerList, cursor) ?? defaultIndex
		else index = defaultIndex
		void LayerQueuePrt.Actions.dispatch({ queue: stores.squadServer }, {
			op: 'add',
			items,
			index,
		})
	}, [activity.id, stores.squadServer, entry.data.selectLayersFrame])

	const onEditedLayer = React.useCallback((layerId: L.LayerId) => {
		if (activity.id !== 'EDITING_ITEM') return
		const itemId = activity.opts.itemId
		void LayerQueuePrt.Actions.dispatch({ queue: stores.squadServer }, {
			op: 'edit-layer',
			itemId,
			newLayerId: layerId,
		})
	}, [activity.id, activity.opts, stores.squadServer])

	const onSelectLayersChange = React.useCallback((open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}, [])

	const dialogStores = {
		selectLayers: data.selectLayersFrame,
		squadServer: stores.squadServer,
	}

	const addLayersTabsList = React.useMemo(() => (
		<TabsList
			options={[
				{ label: 'Play Next', value: 'next' },
				{ label: 'Play After', value: 'after' },
			]}
			active={addLayersAtPosition}
			setActive={setPosition}
		/>
	), [addLayersAtPosition, setPosition])

	if (activity.id === 'EDITING_ITEM') {
		return (
			<EditLayerDialog
				stores={dialogStores}
				open={entry.active}
				onOpenChange={onSelectLayersChange}
				onSelectLayer={onEditedLayer}
			/>
		)
	} else if (activity.id === 'ADDING_ITEM') {
		return (
			<SelectLayersDialog
				title={activity.opts.title ?? 'Add Layers'}
				stores={dialogStores}
				open={entry.active}
				onOpenChange={onSelectLayersChange}
				selectQueueItems={onAddItems}
				footerAdditions={activity.opts.variant === 'toggle-position' && addLayersTabsList}
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

	const onOpenChange = React.useCallback((open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}, [])

	const dialogStores = React.useMemo(() => ({
		genVote: data.genVoteFrame,
		squadServer: stores.squadServer,
	}), [data.genVoteFrame, stores.squadServer])

	const onSubmit = React.useCallback((result: GenVoteFrame.Result, cursor?: LL.Cursor) => {
		const source: LL.Source = {
			type: 'manual',
			userId: UsersClient.loggedInUserId!,
		}

		const item = LL.createVoteItem(result.choices, source, result.voteConfig)

		const layerList = LayerQueuePrt.Sel.layerList(ZusUtils.getState(stores.squadServer))
		let index: LL.ItemIndex
		const defaultIndex: LL.ItemIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) {
			index = LL.resolveCursorIndex(layerList, cursor) ?? defaultIndex
		} else {
			index = defaultIndex
		}

		void LayerQueuePrt.Actions.dispatch({ queue: stores.squadServer }, {
			op: 'add',
			index: index ?? { outerIndex: 0, innerIndex: null },
			items: [item],
		})
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}, [stores.squadServer])

	return (
		<GenVoteDialog
			title="Generate Vote"
			stores={dialogStores}
			open={entry.active}
			onOpenChange={onOpenChange}
			onSubmit={onSubmit}
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

	const onOpenChange = React.useCallback((open: boolean) => {
		if (open) return
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}, [])

	const onSubmit = React.useCallback((layers: L.UnvalidatedLayer[]) => {
		const layerIds = layers.map(l => l.id)
		const cursor: LL.Cursor = pastePosition === 'next' ? { type: 'start' } : { type: 'end' }
		const layerList = LayerQueuePrt.Sel.layerList(ZusUtils.getState(stores.squadServer))
		const index: LL.ItemIndex = LL.resolveCursorIndex(layerList, cursor) ?? { outerIndex: 0, innerIndex: null }
		void LayerQueuePrt.Actions.dispatch({ queue: stores.squadServer }, {
			op: 'add',
			index,
			items: layerIds.map(layerId => ({ type: 'single-list-item', layerId })),
		})
		UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
	}, [stores.squadServer, pastePosition])

	const positionTabsList = React.useMemo(() => (
		<TabsList
			options={[
				{ label: 'Play Next', value: 'next' },
				{ label: 'Play After', value: 'after' },
			]}
			active={pastePosition}
			setActive={setPastePosition}
		/>
	), [pastePosition])

	return (
		<MultiLayerSetDialog
			title="Paste Rotation"
			open={entry.active}
			onOpenChange={onOpenChange}
			onSubmit={onSubmit}
			extraFooter={positionTabsList}
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
	const itemRes = ZusUtils.useStore(
		props.stores.squadServer,
		LayerQueuePrt.Sel.findItem(props.itemId),
	)
	if (!itemRes) return null
	const { item } = itemRes
	if (LL.isVoteItem(item)) {
		return <VoteLayerListItem {...props} />
	}
	return <SingleLayerListItem {...props} />
})

const SingleLayerListItem = React.memo(function SingleLayerListItem(props: LayerListItemProps) {
	const parentItem = ZusUtils.useStore(
		props.stores.squadServer,
		LayerQueuePrt.Sel.parentItem(props.itemId),
	)

	const [item, index, isLocallyLast, displayedMutation] = ZusUtils.useStore(
		props.stores.squadServer,
		ZusUtils.useShallow((llState) => {
			const s = LayerQueuePrt.Sel.itemState(props.itemId)(llState)!
			return [s.item, s.index, s.isLocallyLast, getDisplayedMutation(s.mutationState)]
		}),
	)

	const user = UsersClient.useLoggedInUser()

	const isVoteChoice = !!parentItem

	const isModified = ZusUtils.useStore(props.stores.squadServer, LayerQueuePrt.Sel.isModified)
	const isEditing = ZusUtils.useStore(UPClient.Store, s => user ? UPClient.Sel.isEditing(user.discordId)(s) : false)
	const isLocked = ZusUtils.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const canEdit = !isLocked && !!isEditing

	const [itemPresence, itemActivityUser, activityHovered] = UPClient.useItemPresence(item.itemId)

	const globalVoteState = VotesClient.useVoteState(props.stores.squadServer.serverId)
	const voteState = (globalVoteState && globalVoteState?.itemId === parentItem?.itemId ? globalVoteState : undefined)
		?? parentItem?.endingVoteState

	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem, { feedback: 'move', disabled: !isEditing })

	const itemStores = { queue: props.stores.squadServer }

	const editActivity = React.useMemo(() => ({
		_tag: 'leaf' as const,
		id: 'EDITING_ITEM' as const,
		opts: { itemId: item.itemId, cursor: { type: 'item-relative' as const, itemId: item.itemId, position: 'on' as const } },
	}), [item.itemId])

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}, [canEdit, _setDropdownOpen])

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
		'data-is-editing': !!isEditing,
		disabled: !canEdit,
		className,
	})

	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		stores: props.stores,
		itemId: props.itemId,
	} satisfies Partial<ItemDropdownProps>

	const layersStatus = resToOptional(SquadServerClient.useLayersStatus(props.stores.squadServer.serverId))?.data
	const serverInfo = SquadServerClient.useServerInfo(props.stores.squadServer.serverId)
	const tally = voteState && V.isVoteStateWithVoteData(voteState) && serverInfo
		? V.tallyVotes(voteState, serverInfo.playerCount)
		: undefined

	const itemChoiceTallyPercentage = (isVoteChoice && voteState) ? tally?.percentages?.get(item.itemId) : undefined
	const isVoteWinner = isVoteChoice && voteState?.code === 'ended:winner' && voteState?.winnerId === item.itemId
	const voteCount = (isVoteChoice && voteState) ? tally?.totals?.get(item.itemId) : undefined
	const isFirstQueuedLayer = ZusUtils.useStore(
		props.stores.squadServer,
		s => index.innerIndex === 0 && LL.getNextLayerId(LayerQueuePrt.Sel.layerList(s)) === item.layerId,
	)
	const viewingQueue = UPClient.useActivityMatch(UP.Trans.viewingQueue(props.stores.squadServer.serverId).match)

	if (index.innerIndex === 0 && voteState?.code !== 'ended:winner') {
		badges.unshift(
			<Badge key="default-choice" variant="secondary">
				Default
			</Badge>,
		)
	}
	if (isVoteWinner) {
		badges.unshift(
			<Badge key="winner" variant="added">
				Selected
			</Badge>,
		)
	}

	if (
		!isModified && layersStatus?.nextLayer && isFirstQueuedLayer && voteState?.code !== 'in-progress'
		&& !L.areLayersCompatible(item.layerId, layersStatus.nextLayer, true)
	) {
		badges.push(
			<Tooltip key="not current next">
				<TooltipTrigger>
					<Badge variant="destructive">?</Badge>
				</TooltipTrigger>
				<TooltipContent>Not current next layer on server</TooltipContent>
			</Tooltip>,
		)
	}

	const GripElt = (props: { className?: string }) => (
		<Button
			ref={dragProps.handleRef}
			variant="ghost"
			size="icon"
			{...editButtonProps(
				cn('data-[can-edit=true]:cursor-grab data-[mobile=false]:not-group-hover/single-item:invisible', props.className),
			)}
		>
			<Icons.GripVertical />
		</Button>
	)
	const beforeItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'before', itemId: item.itemId }]
	const afterItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'after', itemId: item.itemId }]

	return (
		<>
			{(LL.isLocallyFirstIndex(index)) && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} disabled={!canEdit} />}
			<ItemContextMenu stores={props.stores} itemId={props.itemId} disabled={!canEdit}>
				<li
					ref={dragProps.ref}
					className={cn(
						Typo.LayerText,
						'group/single-item flex data-[is-voting=true]:border-added  data-[is-voting=true]:bg-secondary data-[is-dragging=false]:w-full min-w-10 min-h-5 max items-center justify-between space-x-2 bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline-solid rounded-md bg-opacity-30 cursor-default data-[is-hovered=true]:outline-solid',
					)}
					data-mutation={displayedMutation}
					data-is-dragging={dragProps.isDragging}
					data-is-voting={voteState?.code === 'in-progress'}
					data-is-hovered={activityHovered}
				>
					{dragProps.isDragging ? <span className="w-5 mx-auto">...</span> : (
						<>
							<span className="grid">
								<span
									data-mobile={isMobile}
									data-viewing-queue={viewingQueue}
									className="text-right m-auto font-mono text-s col-start-1 row-start-1 invisible data-[mobile=false]:data-[viewing-queue=true]:not-group-hover/single-item:visible"
								>
									{LL.getItemNumber(index)}
								</span>
								<GripElt className="col-start-1 row-start-1" />
							</span>
							<span className="rounded flex space-y-1 w-full flex-col">
								<LayerDisplay
									stores={props.stores}
									droppable={true}
									item={{ type: 'single-list-item', layerId: item.layerId, itemId: item.itemId }}
									badges={badges}
								/>
								{itemChoiceTallyPercentage !== undefined && (
									<span className="flex space-x-1 items-center">
										<Progress
											value={itemChoiceTallyPercentage}
											className={cn('h-2', isVoteWinner && '[&>div]:bg-added')}
										/>
										<span>{voteCount}</span>
									</span>
								)}
							</span>
							{sourceDisplay && (
								<>
									<Separator orientation="vertical" />
									{sourceDisplay}
								</>
							)}
							<StartActivityInteraction
								loaderName="selectLayers"
								createActivity={UP.createEditingQueueVariant(editActivity)}
								matchKey={key => Obj.deepEqualStrict(key, { ...editActivity, serverId: props.stores.squadServer.serverId })}
								preload="viewport"
								render={Button}
								variant="ghost"
								size="icon"
								title="Edit"
								disabled={!isEditing}
							>
								<Icons.Pencil />
							</StartActivityInteraction>
							<Button
								variant="ghost"
								size="icon"
								title="Swap Factions"
								disabled={!canEdit || !L.swapFactions(item.layerId)}
								onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'swap-factions' })}
							>
								<Icons.ArrowLeftRight />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								title="Delete"
								disabled={!canEdit}
								onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'delete' })}
							>
								<Icons.X />
							</Button>
							<ItemDropdown {...dropdownProps}>
								<Button
									{...editButtonProps()}
									variant="ghost"
									size="icon"
								>
									<Icons.EllipsisVertical />
								</Button>
							</ItemDropdown>
						</>
					)}
				</li>
			</ItemContextMenu>
			<QueueItemSeparator links={afterItemLinks} isAfterLast={isLocallyLast} disabled={!canEdit} />
		</>
	)
})

function VoteLayerListItem(props: LayerListItemProps) {
	const [item, index, displayedMutation, isLocallyLast, endingVoteState] = ZusUtils.useStore(
		props.stores.squadServer,
		ZusUtils.useShallow((llState) => {
			const s = LayerQueuePrt.Sel.itemState(props.itemId)(llState)!
			const voteItem = s.item as LL.VoteItem
			return [voteItem, s.index, getDisplayedMutation(s.mutationState), s.isLocallyLast, voteItem.endingVoteState]
		}),
	)

	const globalVoteState = VotesClient.useVoteState(props.stores.squadServer.serverId)
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? endingVoteState

	const isModified = ZusUtils.useStore(props.stores.squadServer, LayerQueuePrt.Sel.isModified)
	const manageVoteDenied = RbacClient.usePermsCheck(RBAC.perm('vote:manage'))
	const isEditing = UPClient.useIsEditing()
	const isLocked = ZusUtils.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const canEdit = !isLocked && !!isEditing
	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem, { disabled: !isEditing })

	const itemStores = { queue: props.stores.squadServer }

	const [dropdownOpen, setDropdownOpen] = React.useState(false)
	const isMobile = useIsMobile()

	const editButtonProps = (className?: string) => ({
		['data-mobile']: isMobile,
		disabled: !canEdit,
		className: className,
		['data-can-edit']: canEdit,
	})

	const manageVoteButtonProps = (opts?: { className?: string; hideWhenNotHovering?: boolean }) => {
		opts ??= {}
		opts.hideWhenNotHovering ??= true
		return ({
			['data-mobile']: isMobile,
			disabled: !!manageVoteDenied,
			className: opts?.className,
		})
	}

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
				const node = state ? UP.Trans.editingQueue(state.opts.serverId).match(state)?.chosen : null
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
				globalToast$.next({ title: 'Vote started!' })
				break
			default:
				globalToast$.next({ variant: 'destructive', title: res.msg })
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
				globalToast$.next({ title: 'Vote aborted!' })
				break
			default:
				globalToast$.next({ variant: 'destructive', title: res.msg })
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
				globalToast$.next({ title: 'Vote ended early!' })
				break
			default:
				globalToast$.next({ variant: 'destructive', title: res.msg })
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
				globalToast$.next({ title: 'Vote aborted!' })
				break
			default:
				globalToast$.next({ variant: 'destructive', title: res.msg })
		}

		globalToast$.next({ title: 'Vote autostart cancelled!' })
	}

	const serverInfoRes = SquadServerClient.useServerInfoRes(serverId)
	const serverInfo = serverInfoRes?.code === 'ok' ? serverInfoRes?.data : undefined

	const [voterType, setVoterType] = React.useState<V.VoterType>(voteState?.voterType ?? 'public')
	const internalVoteCheckboxId = React.useId()
	const memoizedSelector = React.useCallback(
		ZusUtils.useDeep((store: SquadServerFrame.Types['state']) => {
			const canInitiateVote = V.canInitiateVote(
				item.itemId,
				LayerQueuePrt.Sel.layerList(store),
				voterType,
				globalVoteState ? { code: globalVoteState.code } : undefined,
				isModified,
			)
			const res = {
				canInitiateVote,
				voteAutostartTime: (voteState?.code === 'ready') ? voteState.autostartTime : undefined,
				voteTally: voteState && voteState.code !== 'ready' ? V.tallyVotes(voteState, serverInfo?.playerCount ?? 0) : undefined,
			}
			return res
		}),
		[item.itemId, voterType, globalVoteState, isModified, voteState, serverInfo?.playerCount],
	)

	const { canInitiateVote, voteAutostartTime, voteTally } = ZusUtils.useStore(
		props.stores.squadServer,
		memoizedSelector,
		// dependencies: [item.itemId, voteState, globalVoteState?.code, voterType, serverInfo?.playerCount, isModified],
	)

	return (
		<>
			{LL.isLocallyFirstIndex(index) && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} />}
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
					{dragProps.isDragging
						? <span className="mx-auto w-5">...</span>
						: (
							<div className="h-full flex flex-col grow">
								<div className="p-1 space-x-2 flex items-center justify-between w-full">
									<span className="flex items-center space-x-1">
										<Button
											ref={dragProps.handleRef}
											{...editButtonProps('data-[can-edit=true]:cursor-grab')}
											variant="ghost"
											size="icon"
										>
											<Icons.GripHorizontal />
										</Button>
										<h3 className={cn(Typo.Label, 'bold')}>Vote</h3>
										{voteAutostartTime && (
											<>
												<span>:</span>
												<span className="whitespace-nowrap text-nowrap w-max text-sm flex flex-nowrap items-center space-x-2">
													<span>starts in</span> <Timer deadline={voteAutostartTime.getTime()} />
													<PermissionDeniedTooltip denied={manageVoteDenied}>
														<Button
															variant="ghost"
															size="icon"
															title="Cancel Autostart"
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
												<span>{statusCodeToTitleCase(voteState.code)}</span>
												<Icons.Dot width={20} height={20} />
												<span>
													{voteTally && serverInfo && <span>{voteTally.totalVotes} of {serverInfo.playerCount} votes received</span>}
												</span>
												{voteState.code === 'in-progress' && (
													<>
														<Icons.Dot width={20} height={20} />
														<Badge variant="outline">
															<Timer
																className="font-mono"
																formatTime={ms => dateFns.format(new Date(ms), 'm:ss')}
																deadline={voteState.deadline}
																zeros
															/>
														</Badge>
													</>
												)}
												{voteState.code === 'in-progress' && (
													<PermissionDeniedTooltip denied={manageVoteDenied}>
														<Button
															title="End Vote Early"
															variant="ghost"
															size="icon"
															onClick={endVoteEarly}
															{...manageVoteButtonProps({ hideWhenNotHovering: false })}
														>
															<Icons.CheckCheck />
														</Button>
													</PermissionDeniedTooltip>
												)}
												{voteState.code === 'in-progress' && (
													<PermissionDeniedTooltip denied={manageVoteDenied}>
														<Button
															title="Abort Vote"
															variant="ghost"
															size="icon"
															onClick={abortVote}
															{...manageVoteButtonProps({ hideWhenNotHovering: false })}
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
											<div
												{...manageVoteButtonProps({ className: 'flex items-center space-x-2' })}
											>
												<Checkbox
													{...manageVoteButtonProps()}
													id={internalVoteCheckboxId}
													disabled={!!manageVoteDenied || voteState?.code === 'in-progress'}
													checked={voterType === 'internal'}
													onCheckedChange={checked => setVoterType(checked ? 'internal' : 'public')}
												/>
												<Label
													htmlFor={internalVoteCheckboxId}
													className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
												>
													Internal
												</Label>
											</div>
										</PermissionDeniedTooltip>
										<PermissionDeniedTooltip denied={manageVoteDenied}>
											<Button
												{...manageVoteButtonProps({ className: 'text-green-500 disabled:text-foreground' })}
												variant="ghost"
												size="icon"
												onClick={() => startVote()}
												disabled={!!manageVoteDenied || canInitiateVote.code !== 'ok'}
												title="Start Vote"
											>
												<Icons.Play />
											</Button>
										</PermissionDeniedTooltip>

										{/* -------- add vote choices -------- */}
										{inline(() => {
											const activityTitle = 'Add Vote Choices'
											return (
												<StartActivityInteraction
													loaderName="selectLayers"
													preload="intent"
													createActivity={UP.createEditingQueueVariant(
														{
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
														},
													)}
													matchKey={key => key.id === 'ADDING_ITEM' && key.opts.title === activityTitle}
													render={Button}
													variant="ghost"
													size="icon"
													title="Add Vote Choices"
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
											<Button variant="ghost" size="icon">
												<Icons.Settings2 />
											</Button>
										</VoteDisplayPropsPopover>
										<Button
											variant="ghost"
											size="icon"
											title="Swap Factions"
											disabled={!canEdit || !L.swapFactions(item.layerId)}
											onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'swap-factions' })}
										>
											<Icons.ArrowLeftRight />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											title="Delete"
											disabled={!canEdit}
											onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'delete' })}
										>
											<Icons.X />
										</Button>
										<ItemDropdown {...dropdownProps}>
											<Button
												variant="ghost"
												size="icon"
												{...editButtonProps()}
											>
												<Icons.EllipsisVertical />
											</Button>
										</ItemDropdown>
									</span>
								</div>
								<ol className="flex flex-col items-start">
									{item.choices!.map((choice) => {
										return (
											<SingleLayerListItem
												key={choice.itemId}
												itemId={choice.itemId}
												stores={props.stores}
											/>
										)
									})}
								</ol>
							</div>
						)}
				</li>
			</ItemContextMenu>
			<QueueItemSeparator links={afterItemLinks} isAfterLast={isLocallyLast} />
		</>
	)
}

export function VoteDisplayPropsPopover(
	props: {
		itemId: LL.ItemId
		stores: SquadServerFrame.KeyProp
		open: boolean
		onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
		children: React.ReactNode
		readonly?: boolean
	},
) {
	const [voteConfig, choices] = ZusUtils.useStore(
		props.stores.squadServer,
		ZusUtils.useDeep(React.useCallback((store: SquadServerFrame.Types['state']) => {
			const s = LayerQueuePrt.Sel.itemState(props.itemId)(store)
			const voteItem = s.item as LL.VoteItem
			const choices = voteItem.choices.map(c => c.layerId)
			return [voteItem.voteConfig, choices] as const
		}, [props.itemId])),
	)

	const [localConfig, setLocalConfig] = React.useState<Partial<V.AdvancedVoteConfig> | null>(null)

	React.useEffect(() => {
		if (props.open) {
			setLocalConfig(null)
		}
	}, [props.open])

	const currentConfig = localConfig ?? voteConfig ?? null

	function handleConfigChange(config: Partial<V.AdvancedVoteConfig> | null) {
		setLocalConfig(config)
	}

	function handleSave() {
		LayerQueuePrt.Actions.dispatchItemOp({ queue: props.stores.squadServer }, props.itemId, {
			op: 'configure-vote',
			config: localConfig,
		})
		props.onOpenChange(false)
	}

	return (
		<Popover open={props.open} onOpenChange={props.onOpenChange}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent className="w-80">
				<AdvancedVoteConfigEditor
					config={currentConfig}
					readonly={props.readonly}
					choices={choices}
					onChange={handleConfigChange}
				/>
				{!props.readonly && (
					<Button
						className="w-full mt-4"
						size="sm"
						onClick={handleSave}
					>
						Save
					</Button>
				)}
			</PopoverContent>
		</Popover>
	)
}

type ItemDropdownProps = {
	children: React.ReactNode
	open: boolean
	setOpen: React.Dispatch<React.SetStateAction<boolean>>
	stores: SquadServerFrame.KeyProp
	allowVotes?: boolean
	itemId: LL.ItemId
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
}

const dropdownMenuComponents: ItemMenuComponents = {
	Group: DropdownMenuGroup,
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
}

const contextMenuComponents: ItemMenuComponents = {
	Group: ContextMenuGroup,
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
}

function ItemDropdown(props: ItemDropdownProps) {
	return (
		<DropdownMenu modal={false} open={props.open} onOpenChange={props.setOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<ItemMenuItems stores={props.stores} itemId={props.itemId} menu={dropdownMenuComponents} />
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function ItemContextMenu(props: {
	children: React.ReactNode
	stores: SquadServerFrame.KeyProp
	itemId: LL.ItemId
	disabled?: boolean
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
				<ItemMenuItems stores={props.stores} itemId={props.itemId} menu={contextMenuComponents} />
			</ContextMenuContent>
		</ContextMenu>
	)
}

function ItemMenuItems(props: {
	stores: SquadServerFrame.KeyProp
	itemId: LL.ItemId
	menu: ItemMenuComponents
}) {
	const Menu = props.menu
	const [item, index, lastLocalIndex] = ZusUtils.useStore(
		props.stores.squadServer,
		ZusUtils.useShallow((llStore) => {
			const itemState = LayerQueuePrt.Sel.itemState(props.itemId)(llStore)
			return [
				itemState.item,
				itemState.index,
				LayerQueuePrt.Sel.lastLocalIndex(props.itemId)(llStore),
			] as const
		}),
	)

	const [activities] = React.useMemo(() => {
		const activities = {
			'add-after': ({
				_tag: 'leaf',
				id: 'ADDING_ITEM',
				opts: { cursor: { type: 'item-relative', itemId: item.itemId, position: 'after' }, action: 'add' },
			}),
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

		return [activities] as const
	}, [item.itemId])

	const isLocked = ZusUtils.useStore(UPClient.Store, UPClient.Sel.isSllItemLocked(item.itemId))
	const isEditing = UPClient.useIsEditing()
	const itemStores = { queue: props.stores.squadServer }

	function sendToFront() {
		if (!user) return
		const firstItem = LayerQueuePrt.Sel.layerList(ZusUtils.getState(props.stores.squadServer))[0]
		LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, {
			op: 'move',
			newFirstItemId: LL.createItemId(),
			cursor: { type: 'item-relative', itemId: firstItem.itemId, position: 'before' },
		})
	}
	function sendToBack() {
		if (!user) return
		const state = ZusUtils.getState(props.stores.squadServer)
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
	return (
		<>
			<Menu.Group>
				<Menu.Item
					disabled={!isEditing || isLocked}
					onClick={() => LayerQueuePrt.Actions.dispatchItemOp(itemStores, props.itemId, { op: 'clone', itemId: item.itemId })}
				>
					<Icons.Copy />Clone
				</Menu.Item>
			</Menu.Group>
			<Menu.Separator />
			<Menu.Group>
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={UP.createEditingQueueVariant(activities['add-before'])}
					matchKey={key => Obj.deepEqualStrict(key, { ...activities['add-before'], serverId: props.stores.squadServer.serverId })}
					preload="viewport"
					render={Menu.Item}
					disabled={!isEditing}
				>
					Add Layers Before
				</StartActivityInteraction>
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={UP.createEditingQueueVariant(activities['add-after'])}
					matchKey={key => Obj.deepEqualStrict(key, { ...activities['add-after'], serverId: props.stores.squadServer.serverId })}
					preload="viewport"
					render={Menu.Item}
					disabled={!isEditing}
				>
					Add Layers After
				</StartActivityInteraction>
			</Menu.Group>

			<Menu.Separator />
			<Menu.Group>
				<Menu.Item
					disabled={!isEditing || (index.innerIndex ?? index.outerIndex) === 0 || isLocked}
					onClick={sendToFront}
				>
					Send to Front
				</Menu.Item>
				<Menu.Item
					disabled={!isEditing || lastLocalIndex && LL.indexesEqual(index, lastLocalIndex) || isLocked}
					onClick={sendToBack}
				>
					Send to Back
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
	const { ref, isDropTarget } = DndKit.useDroppable(LL.llItemCursorsToDropItem(props.links))
	const disabled = props.disabled || false
	return (
		<Separator
			ref={ref}
			className="w-full min-w-0 bg-transparent h-2 data-[is-last=true]:invisible data-[is-over=true]:bg-primary" // data-is-last={props.isAfterLast && !isOver}
			data-is-over={!disabled && isDropTarget}
		/>
	)
}
