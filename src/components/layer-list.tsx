import { AdvancedVoteConfigEditor } from '@/components/advanced-vote-config-editor'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, dropdownMenuItemClassesBase, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { getFrameState, useFrameStore } from '@/frames/frame-manager.ts'
import type * as GenVoteFrame from '@/frames/gen-vote.frame.ts'
import type * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
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

import * as SLL from '@/models/shared-layer-list.ts'
import * as V from '@/models/vote.models.ts'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'

import * as DndKit from '@/systems/dndkit.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as QD from '@/systems/queue-dashboard.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import * as VotesClient from '@/systems/vote.client'
import * as RQ from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
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
	props: { store: Zus.StoreApi<QD.LLStore> },
) {
	const queueItemIds = Zus.useStore(props.store, ZusUtils.useShallow((store) => store.layerList.map((item) => item.itemId)))

	// -------- dispatch move events --------
	DndKit.useDragEnd(React.useCallback(async (event) => {
		const user = UsersClient.loggedInUser
		const sllState = SLLClient.Store.getState()
		if (!user || !event.over) return
		if (!SLLClient.selectIsEditing(sllState, user)) return
		const target = event.over.slots[0]
		if (target.dragItem.type !== 'layer-item') return
		const cursors = LL.dropItemToLLItemCursors(event.over)
		if (cursors.length === 0) return
		const voteState = VotesClient.voteState$.getValue()
		const layerList = props.store.getState().layerList
		if (voteState?.code === 'in-progress') {
			for (const cursor of cursors) {
				if (LL.isChildItem(cursor.itemId, voteState.itemId, layerList)) return
			}
		}

		const cursor = cursors[0]

		if (event.active.type === 'history-entry') {
			const history = await MatchHistoryClient.recentMatches$.getValue()
			const activeId = event.active.id
			const entry = history.find((entry) => entry.historyEntryId === activeId)
			if (!entry) return
			const index = LL.resolveCursorIndex(layerList, cursor)!
			void props.store.getState().dispatch({ op: 'add', items: [{ type: 'single-list-item', layerId: entry.layerId }], index })
		}

		if (event.active.type === 'layer-item') {
			void props.store.getState().dispatch({
				op: 'move',
				cursor: cursor,
				itemId: event.active.id,
				newFirstItemId: LL.createItemId(),
			})
		}
	}, [props.store]))

	DndKit.useDraggingCallback(item => {
		const storeState = SLLClient.Store.getState()
		const getIsDraggingStuff = (root: SLL.RootActivity) => {
			const id = root.child?.EDITING?.chosen?.id
			return id === 'MOVING_ITEM' || id === 'ADDING_ITEM_FROM_HISTORY'
		}
		if (!item) {
			storeState.updateActivity(SLL.toEditIdleOrNone(getIsDraggingStuff))
			return
		}
		const { leaf } = ST.Match
		if (item?.type === 'layer-item') {
			storeState.updateActivity(SLL.createEditActivityVariant(leaf('MOVING_ITEM', { itemId: item.id })))
			return
		}

		if (item?.type === 'history-entry') {
			storeState.updateActivity(SLL.createEditActivityVariant(leaf('ADDING_ITEM_FROM_HISTORY', {})))
			return
		}
	})

	return (
		<>
			<ul className="flex w-full flex-col">
				{queueItemIds.map((id) => (
					<LayerListItem
						llStore={props.store}
						key={id}
						itemId={id}
					/>
				))}
			</ul>
			<LoadedActivitiesRenderer store={props.store} />
		</>
	)
}

function LoadedActivitiesRenderer({ store }: { store: Zus.StoreApi<QD.LLStore> }) {
	return (
		<>
			{SLLClient.useLoadedActivities().map((entry) => {
				if (entry.name === 'selectLayers') {
					return (
						<LoadedSelectLayersView
							key={entry.data.selectLayersFrame.instanceId}
							store={store}
							entry={entry}
						/>
					)
				}
				if (entry.name === 'genVote') {
					return (
						<LoadedGenVoteView
							key={entry.data.genVoteFrame.instanceId}
							store={store}
							entry={entry}
						/>
					)
				}
				if (entry.name === 'pasteRotation') {
					return (
						<LoadedPasteRotation
							key="paste-rotation"
							store={store}
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
	store,
	entry: _entry,
}: {
	store: Zus.StoreApi<QD.LLStore>
	entry: Extract<SLLClient.LoadedActivityState, { name: 'selectLayers' }>
}) {
	const entry = useStableValue((e) => e, [_entry])
	const positionCursors = React.useMemo(() => {
		const next: LL.Cursor = { type: 'start' }
		const after: LL.Cursor = { type: 'end' }
		return { next, after }
	}, [])

	const setPosition = React.useCallback((newPosition: AddLayersPosition) => {
		const frameState = getFrameState(entry.data.selectLayersFrame)
		frameState.setCursor(positionCursors[newPosition])
	}, [entry.data.selectLayersFrame, positionCursors])

	const addLayersAtPosition = useFrameStore(
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
		const state = store.getState()
		let cursor = getFrameState(entry.data.selectLayersFrame).cursor
		let index: LL.ItemIndex
		const defaultIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) index = LL.resolveCursorIndex(state.layerList, cursor) ?? defaultIndex
		else index = defaultIndex
		void state.dispatch({
			op: 'add',
			items,
			index,
		})
	}, [activity.id, store, entry.data.selectLayersFrame])

	const onEditedLayer = React.useCallback((layerId: L.LayerId) => {
		if (activity.id !== 'EDITING_ITEM') return
		const state = store.getState()
		const itemId = activity.opts.itemId
		void state.dispatch({
			op: 'edit-layer',
			itemId,
			newLayerId: layerId,
		})
	}, [activity.id, activity.opts, store])

	const onSelectLayersChange = React.useCallback((open: boolean) => {
		if (open) return
		store.getState().updateActivity(SLL.toEditIdleOrNone())
	}, [store])

	const frames = React.useMemo(() => ({
		selectLayers: data.selectLayersFrame,
	}), [data.selectLayersFrame])

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
				frames={frames}
				open={entry.active}
				onOpenChange={onSelectLayersChange}
				onSelectLayer={onEditedLayer}
			/>
		)
	} else if (activity.id === 'ADDING_ITEM') {
		return (
			<SelectLayersDialog
				title={activity.opts.title ?? 'Add Layers'}
				frames={frames}
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
	store,
	entry: _entry,
}: {
	store: Zus.StoreApi<QD.LLStore>
	entry: Extract<SLLClient.LoadedActivityState, { name: 'genVote' }>
}) {
	const entry = useStableValue((e) => e, [_entry])
	const data = entry.data

	const onOpenChange = React.useCallback((open: boolean) => {
		if (open) return
		store.getState().updateActivity(SLL.toEditIdleOrNone())
	}, [store])

	const frames = React.useMemo(() => ({
		genVote: data.genVoteFrame,
	}), [data.genVoteFrame])

	const onSubmit = React.useCallback((result: GenVoteFrame.Result, cursor?: LL.Cursor) => {
		const state = store.getState()
		const source: LL.Source = {
			type: 'manual',
			userId: UsersClient.loggedInUserId!,
		}

		const item = LL.createVoteItem(result.choices, source, result.voteConfig)

		let index: LL.ItemIndex
		const defaultIndex: LL.ItemIndex = { outerIndex: 0, innerIndex: null }
		if (cursor) {
			index = LL.resolveCursorIndex(state.layerList, cursor) ?? defaultIndex
		} else {
			index = defaultIndex
		}

		void state.dispatch({ op: 'add', index: index ?? { outerIndex: 0, innerIndex: null }, items: [item] })
		state.updateActivity(SLL.toEditIdleOrNone())
	}, [store])

	return (
		<GenVoteDialog
			title="Generate Vote"
			frames={frames}
			open={entry.active}
			onOpenChange={onOpenChange}
			onSubmit={onSubmit}
		/>
	)
}

function LoadedPasteRotation({
	store,
	entry: _entry,
}: {
	store: Zus.StoreApi<QD.LLStore>
	entry: Extract<SLLClient.LoadedActivityState, { name: 'pasteRotation' }>
}) {
	const entry = useStableValue((e) => e, [_entry])
	const [pastePosition, setPastePosition] = React.useState<'next' | 'after'>('next')

	const onOpenChange = React.useCallback((open: boolean) => {
		if (open) return
		store.getState().updateActivity(SLL.toEditIdleOrNone())
	}, [store])

	const onSubmit = React.useCallback((layers: L.UnvalidatedLayer[]) => {
		const state = store.getState()
		const layerIds = layers.map(l => l.id)
		const cursor: LL.Cursor = pastePosition === 'next' ? { type: 'start' } : { type: 'end' }
		const index: LL.ItemIndex = LL.resolveCursorIndex(state.layerList, cursor) ?? { outerIndex: 0, innerIndex: null }
		void state.dispatch({
			op: 'add',
			index,
			items: layerIds.map(layerId => ({ type: 'single-list-item', layerId })),
		})
		state.updateActivity(SLL.toEditIdleOrNone())
	}, [store, pastePosition])

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

export type QueueItemAction =
	| {
		code: 'move'
		sourceId: string
		destinationId: string
	}
	| {
		code: 'edit'
		item: LL.Item
	}
	| {
		code: 'delete'
		id: string
	}
	| {
		code: 'add-after' | 'add-before'
		items: LL.Item[]
		id?: string
	}

type LayerListItemProps = {
	itemId: string
	llStore: Zus.StoreApi<QD.LLStore>
}

function LayerListItem(props: LayerListItemProps) {
	const itemRes = Zus.useStore(props.llStore, ZusUtils.useDeep(s => LL.findItemById(s.layerList, props.itemId)))
	if (!itemRes) return null
	const { item } = itemRes
	if (LL.isVoteItem(item)) {
		return <VoteLayerListItem {...props} />
	}
	return <SingleLayerListItem {...props} />
}

function SingleLayerListItem(props: LayerListItemProps) {
	const parentItem = Zus.useStore(
		props.llStore,
		s => LL.findParentItem(s.layerList, props.itemId),
	)

	const [item, index, isLocallyLast, displayedMutation] = Zus.useStore(
		props.llStore,
		ZusUtils.useDeep((llState) => {
			const s = QD.selectLLItemState(llState, props.itemId)!
			return [s.item, s.index, s.isLocallyLast, getDisplayedMutation(s.mutationState)]
		}),
	)
	const isVoteChoice = !!parentItem

	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)
	const isEditing = SLLClient.useIsEditing()
	const canEdit = !SLLClient.useIsItemLocked(item.itemId) && isEditing

	const [itemPresence, itemActivityUser, activityHovered] = SLLClient.useItemPresence(item.itemId)

	const globalVoteState = VotesClient.useVoteState()
	const voteState = (globalVoteState && globalVoteState?.itemId === parentItem?.itemId ? globalVoteState : undefined)
		?? parentItem?.endingVoteState

	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem, { feedback: 'move', disabled: !isEditing })
	const user = UsersClient.useLoggedInUser()

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}, [canEdit, _setDropdownOpen])

	const isMobile = useIsMobile()

	const badges: React.ReactNode[] = []
	let sourceDisplay: React.ReactNode | undefined

	if (user && itemPresence?.itemActivity && itemActivityUser.discordId !== user.discordId) {
		sourceDisplay = (
			<Badge key={`activity ${itemPresence.itemActivity.id}`} variant="info" className="text-nowrap">
				{SLL.getAttributedHumanReadableActivity(itemPresence.activityState!, index, itemActivityUser.displayName)}...
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
		listStore: props.llStore,
		itemId: props.itemId,
	} satisfies Partial<ItemDropdownProps>

	const layersStatus = resToOptional(SquadServerClient.useLayersStatus())?.data
	const serverInfo = SquadServerClient.useServerInfo()
	const tally = voteState && V.isVoteStateWithVoteData(voteState) && serverInfo
		? V.tallyVotes(voteState, serverInfo.playerCount)
		: undefined

	const itemChoiceTallyPercentage = (isVoteChoice && voteState) ? tally?.percentages?.get(item.itemId) : undefined
	const isVoteWinner = isVoteChoice && voteState?.code === 'ended:winner' && voteState?.winnerId === item.itemId
	const voteCount = (isVoteChoice && voteState) ? tally?.totals?.get(item.itemId) : undefined
	const isFirstQueuedLayer = Zus.useStore(
		props.llStore,
		s => index.innerIndex === 0 && LL.getNextLayerId(s.layerList) === item.layerId,
	)

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
								className="text-right m-auto font-mono text-s col-start-1 row-start-1 invisible data-[mobile=false]:not-group-hover/single-item:visible"
							>
								{LL.getItemNumber(index)}
							</span>
							<GripElt className="col-start-1 row-start-1" />
						</span>
						<span className="rounded flex space-y-1 w-full flex-col">
							<LayerDisplay
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
			<QueueItemSeparator links={afterItemLinks} isAfterLast={isLocallyLast} disabled={!canEdit} />
		</>
	)
}

function VoteLayerListItem(props: LayerListItemProps) {
	const [item, index, displayedMutation, isLocallyLast, endingVoteState] = Zus.useStore(
		props.llStore,
		ZusUtils.useDeep((llState) => {
			const s = QD.selectLLItemState(llState, props.itemId)!
			const voteItem = s.item as LL.VoteItem
			return [voteItem, s.index, getDisplayedMutation(s.mutationState), s.isLocallyLast, voteItem.endingVoteState]
		}),
	)

	const globalVoteState = VotesClient.useVoteState()
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? endingVoteState

	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)
	const user = UsersClient.useLoggedInUser()
	const canManageVote = user ? RBAC.rbacUserHasPerms(user, RBAC.perm('vote:manage')) : false
	const isEditing = SLLClient.useIsEditing()
	const canEdit = !SLLClient.useIsItemLocked(item.itemId) && isEditing
	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem, { disabled: !isEditing })

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
			disabled: !canManageVote,
			className: opts?.className,
		})
	}

	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		listStore: props.llStore,
		itemId: props.itemId,
	} satisfies Partial<ItemDropdownProps>

	const beforeItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'before', itemId: item.itemId }]
	const afterItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'after', itemId: item.itemId }]

	// we're only using .useActivityState here because there's nothing to load with this activity at the moment
	const [configuringVote, setConfiguringVote] = SLLClient.useActivityState({
		createActivity: SLL.createEditActivityVariant({ _tag: 'leaf', id: 'CONFIGURING_VOTE', opts: { itemId: item.itemId } }),
		matchActivity: React.useCallback(
			(state) => state.child.EDITING?.chosen.id === 'CONFIGURING_VOTE' && state.child.EDITING?.chosen.opts.itemId === item.itemId,
			[item.itemId],
		),
		removeActivity: SLL.toEditIdleOrNone(),
	})

	const [_voteDisplayPropsOpen, _setVoteDisplayPropsOpen] = React.useState(false)
	const voteDisplayPropsOpen = configuringVote || _voteDisplayPropsOpen

	const setVoteDisplayPropsOpen: React.Dispatch<React.SetStateAction<boolean>> = (update) => {
		if (isEditing) setConfiguringVote(update)
		else _setVoteDisplayPropsOpen(update)
	}

	const startVoteMutation = RQ.useMutation(RPC.orpc.vote.startVote.mutationOptions())
	async function startVote() {
		const res = await startVoteMutation.mutateAsync({ itemId: item.itemId, ...item.voteConfig, ...{ voterType } })
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
		const res = await abortVoteMutation.mutateAsync(undefined)
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

	const cancelAutostartMutation = RQ.useMutation(RPC.orpc.vote.cancelVoteAutostart.mutationOptions())
	async function cancelAutostart() {
		const res = await cancelAutostartMutation.mutateAsync(undefined)
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

	const serverInfoRes = SquadServerClient.useServerInfoRes()
	const serverInfo = serverInfoRes.code === 'ok' ? serverInfoRes.data : undefined

	const [voterType, setVoterType] = React.useState<V.VoterType>(voteState?.voterType ?? 'public')
	const internalVoteCheckboxId = React.useId()
	const { canInitiateVote, voteAutostartTime, voteTally } = ZusUtils.useStoreDeep(
		props.llStore,
		store => {
			const canInitiateVote = V.canInitiateVote(
				item.itemId,
				store.layerList,
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
		},
		{
			dependencies: [item.itemId, voteState, globalVoteState?.code, voterType, serverInfo?.playerCount, isModified],
		},
	)

	return (
		<>
			{LL.isLocallyFirstIndex(index) && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} />}
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
												<Button variant="ghost" size="icon" title="Cancel Autostart" onClick={cancelAutostart} {...manageVoteButtonProps()}>
													<Icons.X />
												</Button>
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
												<Button
													title="Abort Vote"
													variant="ghost"
													size="icon"
													onClick={abortVote}
													{...manageVoteButtonProps({ hideWhenNotHovering: false })}
												>
													<Icons.X />
												</Button>
											)}
										</div>
									)}
								</span>
								<span className="flex items-center space-x-1">
									<div
										{...manageVoteButtonProps({ className: 'flex items-center space-x-2' })}
									>
										<Checkbox
											{...manageVoteButtonProps()}
											id={internalVoteCheckboxId}
											disabled={!canManageVote || voteState?.code === 'in-progress'}
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
									<Button
										{...manageVoteButtonProps({ className: 'text-green-500 disabled:text-foreground' })}
										variant="ghost"
										size="icon"
										onClick={() => startVote()}
										disabled={!canManageVote || canInitiateVote.code !== 'ok'}
										title="Start Vote"
									>
										<Icons.Play />
									</Button>

									{/* -------- add vote choices -------- */}
									{inline(() => {
										const activityTitle = 'Add Vote Choices'
										return (
											<StartActivityInteraction
												loaderName="selectLayers"
												preload="intent"
												createActivity={SLL.createEditActivityVariant(
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
										listStore={props.llStore}
										itemId={props.itemId}
										readonly={!canEdit || !canManageVote}
									>
										<Button variant="ghost" size="icon">
											<Icons.Settings2 />
										</Button>
									</VoteDisplayPropsPopover>
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
											llStore={props.llStore}
										/>
									)
								})}
							</ol>
						</div>
					)}
			</li>
			<QueueItemSeparator links={afterItemLinks} isAfterLast={isLocallyLast} />
		</>
	)
}

export function VoteDisplayPropsPopover(
	props: {
		itemId: LL.ItemId
		listStore: Zus.StoreApi<QD.LLStore>
		open: boolean
		onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
		children: React.ReactNode
		readonly?: boolean
	},
) {
	const itemActions = () => QD.getLLItemActions(props.listStore.getState(), props.itemId)
	const [voteConfig, choices] = ZusUtils.useStoreDeep(props.listStore, store => {
		const s = QD.selectLLItemState(store, props.itemId)
		const voteItem = s.item as LL.VoteItem
		const choices = voteItem.choices.map(c => c.layerId)
		return [voteItem.voteConfig, choices]
	})

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
		const actions = itemActions()
		actions.dispatch({ op: 'configure-vote', config: localConfig })
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
	listStore: Zus.StoreApi<QD.LLStore>
	allowVotes?: boolean
	itemId: LL.ItemId
}

type SubDropdownState = 'add-before' | 'add-after' | 'edit' | 'create-vote'

function ItemDropdown(props: ItemDropdownProps) {
	const [item, index, lastLocalIndex] = Zus.useStore(
		props.listStore,
		ZusUtils.useDeep((llStore) => {
			const itemState = QD.selectLLItemState(llStore, props.itemId)
			return [
				itemState.item,
				itemState.index,
				LL.getLastLocalIndexForItem(itemState.item.itemId, llStore.layerList),
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
			'edit': {
				_tag: 'leaf',
				id: 'EDITING_ITEM',
				opts: { itemId: item.itemId, cursor: { type: 'item-relative', itemId: item.itemId, position: 'on' } },
			},
		} satisfies { [k in SubDropdownState]: SLL.QueueEditActivity }
		// activities.edit = activities['add-after']

		return [activities] as const
	}, [item.itemId])

	const isLocked = SLLClient.useIsItemLocked(item.itemId)
	const isEditing = SLLClient.useIsEditing()
	const itemActions = () => QD.getLLItemActions(props.listStore.getState(), props.itemId)

	function sendToFront() {
		if (!user) return
		const firstItem = props.listStore.getState().layerList[0]
		itemActions().dispatch({
			op: 'move',
			newFirstItemId: LL.createItemId(),
			cursor: { type: 'item-relative', itemId: firstItem.itemId, position: 'before' },
		})
	}
	function sendToBack() {
		if (!user) return
		const itemState = QD.selectLLItemState(props.listStore.getState(), props.itemId)
		const state = props.listStore.getState()
		const layerList = state.layerList
		const lastLocalIndex = LL.getLastLocalIndexForItem(itemState.item.itemId, layerList)!
		const targetItemId = LL.resolveItemForIndex(layerList, lastLocalIndex)!.itemId
		itemActions().dispatch({
			op: 'move',
			newFirstItemId: LL.createItemId(),
			cursor: { type: 'item-relative', itemId: targetItemId, position: 'after' },
		})
	}

	const user = UsersClient.useLoggedInUser()
	return (
		<DropdownMenu modal={false} open={props.open} onOpenChange={props.setOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuGroup>
					{!LL.isVoteItem(item) && (
						<StartActivityInteraction
							loaderName="selectLayers"
							createActivity={SLL.createEditActivityVariant(activities['edit'])}
							matchKey={key => Obj.deepEqualStrict(key, activities['edit'])}
							preload="viewport"
							render={DropdownMenuItem}
							disabled={!isEditing}
						>
							Edit
						</StartActivityInteraction>
					)}
					<DropdownMenuItem
						disabled={!isEditing || isLocked || !L.swapFactions(item.layerId)}
						onClick={() => itemActions().dispatch({ op: 'swap-factions' })}
					>
						Swap Factions
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={!isEditing || isLocked}
						onClick={() => {
							itemActions().dispatch({ op: 'delete' })
						}}
						className="bg-destructive text-destructive-foreground focus:bg-red-600"
					>
						Delete
					</DropdownMenuItem>
				</DropdownMenuGroup>
				{
					/*{!LL.isVoteItem(item) && (
					<StartActivityInteraction
						loaderName="selectLayers"
						createActivity={SLL.createEditActivityVariant(activities['create-vote'])}
						// we're using deepEqualStrict here so that his breaks if the definition for key changes
						matchKey={key => Obj.deepEqualStrict(key, activities['create-vote'])}
						preload="viewport"
						disabled={isLocked}
						render={DropdownMenuItem}
					>
						Create Vote
					</StartActivityInteraction>
				)}*/
				}

				<DropdownMenuSeparator />

				<DropdownMenuGroup>
					<StartActivityInteraction
						loaderName="selectLayers"
						className={dropdownMenuItemClassesBase}
						createActivity={SLL.createEditActivityVariant(activities['add-after'])}
						matchKey={key => Obj.deepEqualStrict(key, activities['add-after'])}
						preload="viewport"
						render={DropdownMenuItem}
						disabled={!isEditing}
					>
						Add Layers Before
					</StartActivityInteraction>
					<StartActivityInteraction
						loaderName="selectLayers"
						className={dropdownMenuItemClassesBase}
						createActivity={SLL.createEditActivityVariant(activities['add-before'])}
						matchKey={key => Obj.deepEqualStrict(key, activities['add-before'])}
						preload="viewport"
						render={DropdownMenuItem}
						disabled={!isEditing}
					>
						Add Layers After
					</StartActivityInteraction>
				</DropdownMenuGroup>

				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						disabled={!isEditing || (index.innerIndex ?? index.outerIndex) === 0 || isLocked}
						onClick={sendToFront}
					>
						Send to Front
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!isEditing || lastLocalIndex && LL.indexesEqual(index, lastLocalIndex) || isLocked}
						onClick={sendToBack}
					>
						Send to Back
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
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

type ChildPropsBase = {
	ref?: React.Ref<any>
	onClick: () => void
	onMouseEnter: () => void
	onMouseLeave: () => void
}
export function StartActivityInteraction<
	Loader extends SLLClient.ConfiguredLoaderConfig = SLLClient.ConfiguredLoaderConfig,
	Component extends React.FunctionComponent<ChildPropsBase> = never,
>(
	_props: {
		loaderName: Loader['name']
		createActivity: (root: SLL.RootActivity) => SLL.RootActivity
		matchKey: (predicate: SLLClient.LoaderCacheKey<Loader>) => boolean

		preload: 'intent' | 'viewport' | 'render'
		intentDelay?: number
		render: Component
		ref?: any
	} & Omit<React.ComponentProps<Component>, keyof ChildPropsBase>,
) {
	const eltRef = React.useRef<Element | null>(null)
	const [props, otherEltProps] = Obj.partition(
		_props,
		// stop ref from being passed to child so we don't get into weird situations
		'ref',
		'loaderName',
		'createActivity',
		'matchKey',
		'preload',
		'intentDelay',
		'render',
	)
	const [isLoaded, _isActive] = SLLClient.useActivityLoaderData({
		loaderName: props.loaderName,
		matchKey: props.matchKey,
		trace: `StartActivityInteraction:${props.loaderName}`,
		select: ZusUtils.useShallow(entry => [!!entry?.data, !!entry?.active] as const),
	})

	const startActivity = () => {
		return SLLClient.Store.getState().updateActivity(props.createActivity)
	}

	// NOTE: preloadActivity should be implemented such that it runs the work lazily

	const preloadActivity = React.useCallback(
		async () => {
			// this is mostly redundant(maybe slightly better perf) but shows intent
			if (isLoaded) return

			SLLClient.Store.getState().preloadActivity(props.createActivity)
		},
		[props.createActivity, isLoaded],
	)

	const [intentTimeout, setIntentTimeout] = React.useState<NodeJS.Timeout | null>(null)

	React.useEffect(() => {
		// preloadActivity depends on isLoaded above
		if (props.preload === 'render') {
			void preloadActivity()
		}
	}, [props.preload, preloadActivity])

	React.useEffect(() => {
		if (props.preload !== 'viewport' || !eltRef.current || isLoaded) return

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						void preloadActivity()
					}
				})
			},
			{ threshold: 0.1 }, // Trigger when 10% of the element is visible
		)

		observer.observe(eltRef.current as unknown as Element)

		return () => {
			observer.disconnect()
		}
	}, [props.preload, preloadActivity, eltRef, isLoaded])

	const handleMouseEnter = () => {
		if (props.preload === 'intent' && !isLoaded) {
			const delay = props.intentDelay ?? 150
			const timeout = setTimeout(() => {
				void preloadActivity()
			}, delay)
			setIntentTimeout(timeout)
		}
	}

	const handleMouseLeave = () => {
		if (intentTimeout) {
			clearTimeout(intentTimeout)
			setIntentTimeout(null)
		}
	}

	const handleClick = () => {
		startActivity()
	}

	const childProps = {
		...otherEltProps,
		ref: eltRef,
		onClick: handleClick,
		onMouseEnter: handleMouseEnter,
		onMouseLeave: handleMouseLeave,
	} as any

	return <props.render {...childProps} />
}
