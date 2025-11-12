import { Badge } from '@/components/ui/badge.tsx'
import { Button, ButtonProps } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { getFrameState, useNullableFrameStore } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useIsMobile } from '@/hooks/use-is-mobile.ts'
import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers.ts'
import * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import * as Obj from '@/lib/object'
import * as ST from '@/lib/state-tree.ts'
import { statusCodeToTitleCase } from '@/lib/string.ts'
import { resToOptional } from '@/lib/types.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import { BROADCASTS } from '@/messages.ts'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SLL from '@/models/shared-layer-list.ts'
import * as V from '@/models/vote.models.ts'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as DndKit from '@/systems.client/dndkit.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as RbacClient from '@/systems.client/rbac.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as UsersClient from '@/systems.client/users.client'
import * as VotesClient from '@/systems.client/votes.client'
import { Slot } from '@radix-ui/react-slot'
import * as RQ from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import EditLayerDialog from './edit-layer-dialog.tsx'
import LayerDisplay from './layer-display.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { Timer } from './timer.tsx'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'
import TabsList from './ui/tabs-list.tsx'

export function LayerList(
	props: { store: Zus.StoreApi<QD.LLStore> },
) {
	const user = UsersClient.useLoggedInUser()
	const queueItemIds = ZusUtils.useStoreDeep(props.store, (store) => store.layerList.map((item) => item.itemId), { dependencies: [] })
	const [activityState, frames] = Zus.useStore(
		props.store,
		ZusUtils.useShallow(state => [state._activityState, state.frames]),
	)
	DndKit.useDragEnd(React.useCallback(async (event) => {
		if (!user || !event.over) return
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
			props.store.getState().dispatch({ op: 'add', items: [{ layerId: entry.layerId }], index })
		}

		if (event.active.type === 'layer-item') {
			props.store.getState().dispatch({
				op: 'move',
				cursor: cursor,
				itemId: event.active.id,
				newFirstItemId: LL.createLayerListItemId(),
			})
		}
	}, [user, props.store]))

	const editAction = activityState?.child.EDITING?.child
	const onSelectLayersChange = (open: boolean) => {
		props.store.getState().updateActivity(SLL.idleActivity())
	}

	const onAddItems = (items: LL.NewLayerListItem[]) => {
		const state = props.store.getState()
		const activity = editAction as Extract<typeof editAction, { id: 'ADDING_ITEM' }>
		const cursor = activity.opts.cursor
		const index = LL.resolveCursorIndex(state.layerList, cursor)
		if (!index) return

		state.dispatch({
			op: 'add',
			items,
			index,
		})
	}

	const onEditedLayer = (layerId: L.LayerId) => {
		const state = props.store.getState()
		const activity = editAction as Extract<typeof editAction, { id: 'EDITING_ITEM' }>
		const itemId = activity.opts.itemId
		state.dispatch({
			op: 'edit-layer',
			itemId,
			newLayerId: layerId,
		})
	}

	type AddLayersPosition = 'next' | 'after'
	const positionCursors = (() => {
		const next: LQY.Cursor = { type: 'start' }
		const after: LQY.Cursor = { type: 'end' }
		return { next, after }
	})()
	const selectPosition = (s: SelectLayersFrame.Types['state'] | null) => {
		if (s?.cursor?.type === 'index' && Obj.deepEqual(s.cursor.index, positionCursors.after)) return 'next' as const
		return 'after' as const
	}

	const position = useNullableFrameStore(frames.selectLayers, selectPosition)

	const setPosition = (newPosition: AddLayersPosition) => {
		if (!frames.selectLayers) return
		const frameState = getFrameState(frames.selectLayers)
		frameState.setCursor(positionCursors[newPosition])
	}

	React.useEffect(() => {
		console.log('frames:', frames)
		console.log('activityState:', activityState)
	}, [frames, activityState])

	const addLayersTabsList = (
		<TabsList
			options={[
				{ label: 'Play Next', value: 'next' },
				{ label: 'Play After', value: 'after' },
			]}
			active={position}
			setActive={setPosition}
		/>
	)

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
			<SelectLayersDialog
				title={(editAction?.id === 'ADDING_ITEM' ? editAction.opts.title : undefined) ?? 'Add Layer'}
				frames={(frames.selectLayers) ? { selectLayers: frames.selectLayers } : {}}
				open={editAction?.id === 'ADDING_ITEM' && !!frames.selectLayers}
				onOpenChange={onSelectLayersChange}
				selectQueueItems={onAddItems}
				footerAdditions={(editAction?.id === 'ADDING_ITEM' && editAction.opts.variant === 'toggle-position') && addLayersTabsList}
			/>
			<EditLayerDialog
				frames={frames.selectLayers ? { selectLayers: frames.selectLayers } : {}}
				open={editAction?.id === 'EDITING_ITEM' && !!frames.selectLayers}
				onOpenChange={onSelectLayersChange}
				onSelectLayer={onEditedLayer}
			/>
		</>
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
	const itemRes = ZusUtils.useStoreDeep(props.llStore, s => LL.findItemById(s.layerList, props.itemId), { dependencies: [props.itemId] })
	if (!itemRes) return null
	const { item } = itemRes
	if (LL.isVoteItem(item)) {
		return <VoteLayerListItem {...props} />
	}
	return <SingleLayerListItem {...props} />
}

function SingleLayerListItem(props: LayerListItemProps) {
	const parentItem = ZusUtils.useStoreDeep(props.llStore, s => {
		const parentItem = LL.findParentItem(s.layerList, props.itemId)
		if (!parentItem || !LL.isVoteItem(parentItem)) return undefined
		return parentItem
	}, {
		dependencies: [props.itemId],
	})

	const [item, index, isLocallyLast, displayedMutation] = Zus.useStore(
		props.llStore,
		ZusUtils.useDeep((llState) => {
			const s = QD.selectLLItemState(llState, props.itemId)!
			return [s.item, s.index, s.isLocallyLast, getDisplayedMutation(s.mutationState)]
		}),
	)
	const isVoteChoice = LL.isVoteItem(item)

	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)
	const canEdit = !SLLClient.useIsItemLocked(item.itemId)

	const [itemPresence, itemActivityUser, activityHovered] = SLLClient.useItemPresence(item.itemId)

	const globalVoteState = VotesClient.useVoteState()
	const voteState = (globalVoteState && globalVoteState?.itemId === parentItem?.itemId ? globalVoteState : undefined)
		?? parentItem?.endingVoteState

	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem, { feedback: 'move' })
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
				{SLL.getHumanReadableActivityWithUser(itemPresence.activityState!, itemActivityUser.displayName)}...
			</Badge>
		)
	} else {
		sourceDisplay = <LayerSourceDisplay key={`source ${item.source.type}`} source={item.source} />
	}

	const editButtonProps = (className?: string) => ({
		'data-can-edit': canEdit,
		'data-mobile': isMobile,
		disabled: !canEdit,
		className: cn('data-[mobile=false]:invisible group-hover/single-item:visible', className),
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

	const itemChoiceTallyPercentage = (isVoteChoice && voteState) ? tally?.percentages?.get(item.layerId) : undefined
	const isVoteWinner = isVoteChoice && voteState?.code === 'ended:winner' && voteState?.winner === item.layerId
	const voteCount = (isVoteChoice && voteState) ? tally?.totals?.get(item.layerId) : undefined

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
		!isModified && layersStatus?.nextLayer && index.outerIndex === 0 && (index.innerIndex === 0 || index.innerIndex === null)
		&& !isVoteChoice
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
			{...editButtonProps(cn('data-[can-edit=true]:cursor-grab', props.className))}
		>
			<Icons.GripVertical />
		</Button>
	)
	const beforeItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'before', itemId: item.itemId }]
	const afterItemLinks: LL.ItemRelativeCursor[] = [{ type: 'item-relative', position: 'after', itemId: item.itemId }]

	const dropOnAttrs = DndKit.useDroppable(LL.llItemCursorsToDropItem([{ type: 'item-relative', itemId: item.itemId, position: 'on' }]))

	return (
		<>
			{(LL.isLocallyFirstIndex(index)) && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} disabled={!canEdit} />}
			<li
				ref={dragProps.ref}
				className="group/single-item flex data-[is-voting=true]:border-added  data-[is-voting=true]:bg-secondary data-[is-dragging=false]:w-full min-w-[40px] min-h-[20px] max items-center justify-between space-x-2 px-1 py-0 bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30 cursor-default data-[is-hovered=true]:outline"
				data-mutation={displayedMutation}
				data-is-dragging={dragProps.isDragging}
				data-is-voting={voteState?.code === 'in-progress'}
				data-is-hovered={activityHovered}
			>
				{dragProps.isDragging ? <span className="w-[20px] mx-auto">...</span> : (
					<>
						<span className="grid">
							<span
								data-can-edit={canEdit}
								className=" text-right m-auto font-mono text-s col-start-1 row-start-1 group-hover/single-item:invisible"
							>
								{LL.getItemNumber(index)}
							</span>
							<GripElt className="col-start-1 row-start-1" />
						</span>
						<span
							ref={dropOnAttrs.ref}
							data-over={canEdit && dropOnAttrs.isDropTarget}
							className="data-[over=true]:bg-secondary rounded flex space-y-1 w-full flex-col"
						>
							<LayerDisplay
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
	const [item, index, displayedMutation, isLocallyLast, endingVoteState] = ZusUtils.useStoreDeep(
		props.llStore,
		(llState) => {
			const s = QD.selectLLItemState(llState, props.itemId)!
			return [s.item as LL.ParentVoteItem, s.index, getDisplayedMutation(s.mutationState), s.isLocallyLast, s.item.endingVoteState]
		},
	)

	const globalVoteState = VotesClient.useVoteState()
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? endingVoteState

	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)
	const canEdit = !SLLClient.useIsItemLocked(item.itemId)
	const user = UsersClient.useLoggedInUser()
	const canManageVote = user ? RBAC.rbacUserHasPerms(user, RBAC.perm('vote:manage')) : false
	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem)

	const [dropdownOpen, setDropdownOpen] = React.useState(false)
	const isMobile = useIsMobile()

	const editButtonProps = (className?: string) => ({
		['data-mobile']: isMobile,
		disabled: !canEdit,
		className: cn('data-[mobile=false]:invisible group-hover/parent-item:visible', className),
	})

	const manageVoteButtonProps = (opts?: { className?: string; hideWhenNotHovering?: boolean }) => {
		opts ??= {}
		opts.hideWhenNotHovering ??= true
		return ({
			['data-mobile']: isMobile,
			disabled: !canManageVote,
			className: cn(opts.hideWhenNotHovering ? 'data-[mobile=false]:invisible group-hover/parent-item:visible' : '', opts?.className),
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
	const [voteDisplayPropsOpen, setVoteDisplayPropsOpen] = SLLClient.useActivityState({
		createActivity: SLL.createQueueEditActivity({ _tag: 'leaf', id: 'CONFIGURING_VOTE', opts: { itemId: item.itemId } }),
		matchActivity: state => state.child.EDITING?.child.id === 'CONFIGURING_VOTE',
		removeActivity: SLL.idleActivity(),
	})

	const startVoteMutation = RQ.useMutation(RPC.orpc.layerQueue.startVote.mutationOptions())
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

	const abortVoteMutation = RQ.useMutation(RPC.orpc.layerQueue.abortVote.mutationOptions())
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

	const cancelAutostartMutation = RQ.useMutation(RPC.orpc.layerQueue.cancelVoteAutostart.mutationOptions())
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
					'group/parent-item flex data-[is-dragging=false]:w-full min-w-[40px] min-h-[20px] items-center justify-between px-1 py-0 border-2 border-gray-400 rounded inset-2',
					`data-[mutation=added]:border-added data-[mutation=moved]:border-moved data-[mutation=edited]:border-edited data-[is-dragging=true]:outline cursor-default`,
				)}
				data-mutation={displayedMutation}
				data-is-dragging={dragProps.isDragging}
			>
				{dragProps.isDragging ? <span className="mx-auto w-[20px]">...</span> : (
					<div className="h-full flex flex-col flex-grow">
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
								<h3 className={cn(Typography.Label, 'bold')}>Vote</h3>
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
										<span>{voteTally && serverInfo && <span>{voteTally.totalVotes} of {serverInfo.playerCount} votes received</span>}</span>
										{voteState.code === 'in-progress' && (
											<>
												<Icons.Dot width={20} height={20} />
												<Badge variant="outline">
													<Timer
														className="font-mono"
														formatTime={ms => dateFns.format(new Date(ms), 'm:ss')}
														deadline={voteState.deadline}
														zeros={true}
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
								<StartActivityInteraction
									preload="intent"
									createActivity={(() => {
										const cursor = {
											type: 'index',
											index: { outerIndex: index.outerIndex, innerIndex: item.choices.length },
										} satisfies LQY.Cursor
										return SLL.createQueueEditActivity(
											ST.Match.leaf('ADDING_ITEM', {
												cursor,
												title: 'Add Vote Choices',
											}) satisfies SLL.QueueEditActivity<'ADDING_ITEM'>,
										)
									})()}
								>
									<Button
										variant="ghost"
										size="icon"
										title="Add Vote Choices"
										{...editButtonProps()}
									>
										<Icons.Plus />
									</Button>
								</StartActivityInteraction>
								<VoteDisplayPropsPopover
									open={voteDisplayPropsOpen}
									onOpenChange={setVoteDisplayPropsOpen}
									listStore={props.llStore}
									itemId={props.itemId}
								>
									<Button variant="ghost" size="icon" {...editButtonProps()} disabled={!canEdit || !canManageVote}>
										<Icons.Settings2 />
									</Button>
								</VoteDisplayPropsPopover>
								<ItemDropdown {...dropdownProps}>
									<Button
										disabled={!canEdit}
										data-canedit={canEdit}
										data-mobile={isMobile}
										variant="ghost"
										size="icon"
										className={cn('data-[mobile=false]:invisible group-hover/parent-item:visible')}
									>
										<Icons.EllipsisVertical />
									</Button>
								</ItemDropdown>
							</span>
						</div>
						<ol className={'flex flex-col items-start'}>
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
	},
) {
	const config = ConfigClient.useConfig()
	const itemActions = () => QD.getLLItemActions(props.listStore.getState(), props.itemId)
	const [statuses, usingDefault, preview, valid] = ZusUtils.useStoreDeep(props.listStore, store => {
		const s = QD.selectLLItemState(store, props.itemId)
		const itemDisplayProps = s.item.displayProps
		const displayProps = itemDisplayProps ?? config?.vote.voteDisplayProps ?? []
		const choices = s.item.choices?.map(c => c.layerId) ?? []
		const preview = BROADCASTS.vote.started({ choices, voterType: 'public' }, config?.vote.voteDuration ?? 120, displayProps)
		const valid = V.validateChoicesWithDisplayProps(choices, displayProps)
		return [DH.toDisplayPropStatuses(displayProps), !itemDisplayProps && !!config?.vote.voteDisplayProps, preview, valid]
	}, { dependencies: [config] })

	function setDisplayProps(update: Partial<DH.LayerDisplayPropsStatuses>) {
		update = { ...update }

		const updated = { ...statuses, ...update }
		if (update.layer) {
			updated.map = true
			updated.gamemode = true
		} else if (update.layer === false) {
			updated.map = false
			updated.gamemode = false
		} else if (update.gamemode === false || update.map === false) {
			updated.layer = false
		}

		const actions = itemActions()
		if (config && Obj.deepEqual(updated, DH.toDisplayPropStatuses(config.vote.voteDisplayProps))) {
			actions.dispatch({ op: 'configure-vote', displayProps: null })
		} else {
			actions.dispatch({ op: 'configure-vote', displayProps: DH.fromDisplayPropStatuses(updated) })
		}
	}

	function resetToDefault() {
		if (usingDefault) return
		const actions = itemActions()
		actions.dispatch({ op: 'configure-vote', displayProps: null })
	}

	return (
		<Popover open={props.open} onOpenChange={props.onOpenChange}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent className="w-80">
				<div className="grid gap-4">
					<div className="space-y-2">
						<h4 className="font-medium leading-none">Vote Display Options</h4>
						<p className="text-sm text-muted-foreground">
							Choose what to show in vote choices
						</p>
					</div>
					<div className="grid gap-4">
						<div className="grid grid-cols-2 gap-4">
							<div className="space-y-2">
								<div className="grid gap-2">
									<div className="flex items-center space-x-2">
										<Checkbox
											id="layer"
											checked={statuses.layer}
											onCheckedChange={(checked) => setDisplayProps({ layer: checked === true })}
										/>
										<Label htmlFor="layer">Layer</Label>
									</div>
									<div className="ml-6 grid gap-2">
										<div className="flex items-center space-x-2">
											<Checkbox
												id="map"
												checked={statuses.map}
												onCheckedChange={(checked) => setDisplayProps({ map: checked === true })}
											/>
											<Label htmlFor="map">
												Map
											</Label>
										</div>
										<div className="flex items-center space-x-2">
											<Checkbox
												id="gamemode"
												checked={statuses.gamemode}
												onCheckedChange={(checked) => setDisplayProps({ gamemode: checked === true })}
											/>
											<Label htmlFor="gamemode">
												Gamemode
											</Label>
										</div>
									</div>
								</div>
							</div>
							<div className="space-y-2">
								<div className="grid gap-2">
									<div className="flex items-center space-x-2">
										<Checkbox
											id="factions"
											checked={statuses.factions}
											onCheckedChange={(checked) => setDisplayProps({ factions: checked === true })}
										/>
										<Label htmlFor="factions">Factions</Label>
									</div>
									<div className="flex items-center space-x-2">
										<Checkbox
											id="units"
											checked={statuses.units}
											onCheckedChange={(checked) => setDisplayProps({ units: checked === true })}
										/>
										<Label htmlFor="units">Units</Label>
									</div>
								</div>
							</div>
						</div>
						{!valid && (
							<div className="bg-destructive/10 border border-destructive rounded p-2">
								<p className="text-sm text-destructive">
									Warning: Can't distinguish between vote choices.
								</p>
							</div>
						)}
						<div className="space-y-2">
							<Label>Preview</Label>
							<pre className="font-mono text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap">
         {preview}
							</pre>
						</div>
						<Separator />
						<Button
							variant="outline"
							size="sm"
							onClick={resetToDefault}
							disabled={usingDefault}
						>
							Reset to Defaults
						</Button>
					</div>
				</div>
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
				LL.getLastLocalIndexForItem(itemState.item.itemId, llStore.layerList) ?? llStore.layerList.length,
			] as const
		}),
	)

	const [activities] = React.useMemo(() => {
		const activities = {
			'add-after': SLL.createQueueEditActivity({
				_tag: 'leaf',
				id: 'ADDING_ITEM',
				opts: { cursor: { type: 'item-relative', itemId: item.itemId, position: 'after' } },
			}),
			'add-before': SLL.createQueueEditActivity({
				_tag: 'leaf',
				id: 'ADDING_ITEM',
				opts: { cursor: { type: 'item-relative', itemId: item.itemId, position: 'before' } },
			}),
			'create-vote': SLL.createQueueEditActivity({
				_tag: 'leaf',
				id: 'ADDING_ITEM',
				opts: { cursor: { type: 'item-relative', itemId: item.itemId, position: 'on' }, title: 'Create Vote' },
			}),
			'edit': SLL.createQueueEditActivity({
				_tag: 'leaf',
				id: 'EDITING_ITEM',
				opts: { itemId: item.itemId },
			}),
		} satisfies { [k in SubDropdownState]: any }

		return [activities] as const
	}, [item.itemId])

	const isLocked = SLLClient.useIsItemLocked(item.itemId)
	const itemActions = () => QD.getLLItemActions(props.listStore.getState(), props.itemId)

	function sendToFront() {
		if (!user) return
		const firstItem = props.listStore.getState().layerList[0]
		itemActions().dispatch({
			op: 'move',
			newFirstItemId: LL.createLayerListItemId(),
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
			newFirstItemId: LL.createLayerListItemId(),
			cursor: { type: 'item-relative', itemId: targetItemId, position: 'after' },
		})
	}

	const user = UsersClient.useLoggedInUser()
	return (
		<>
			<DropdownMenu modal={false} open={props.open} onOpenChange={props.setOpen}>
				<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuGroup>
						{!LL.isVoteItem(item) && (
							<StartActivityInteraction
								createActivity={activities['edit']}
								preload="viewport"
							>
								<DropdownMenuItem>Edit</DropdownMenuItem>
							</StartActivityInteraction>
						)}
						<DropdownMenuItem
							disabled={isLocked}
							onClick={() => itemActions().dispatch({ op: 'swap-factions' })}
						>
							Swap Factions
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							disabled={isLocked}
							onClick={() => {
								itemActions().dispatch({ op: 'delete' })
							}}
							className="bg-destructive text-destructive-foreground focus:bg-red-600"
						>
							Delete
						</DropdownMenuItem>
					</DropdownMenuGroup>

					{!LL.isVoteItem(item) && (
						<StartActivityInteraction
							createActivity={activities['create-vote']!}
							preload="viewport"
						>
							<DropdownMenuItem
								disabled={isLocked}
							>
								Create Vote
							</DropdownMenuItem>
						</StartActivityInteraction>
					)}

					<DropdownMenuSeparator />

					<DropdownMenuGroup>
						<StartActivityInteraction createActivity={activities['add-after']} preload="viewport">
							<DropdownMenuItem>
								Add Layers Before
							</DropdownMenuItem>
						</StartActivityInteraction>
						<StartActivityInteraction createActivity={activities['add-before']} preload="viewport">
							<DropdownMenuItem>
								Add Layers After
							</DropdownMenuItem>
						</StartActivityInteraction>
					</DropdownMenuGroup>

					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem
							disabled={(index.innerIndex ?? index.outerIndex) === 0 || isLocked}
							onClick={sendToFront}
						>
							Send to Front
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={(index.innerIndex ?? index.outerIndex) === lastLocalIndex || isLocked}
							onClick={sendToBack}
						>
							Send to Back
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
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

export function StartActivityInteraction(
	props: {
		// can't be changed on rerender
		createActivity: (prev: SLL.Activity) => SLL.Activity
		preload: 'intent' | 'viewport' | 'render'
		intentDelay?: number
		children: React.ReactNode
	},
) {
	const createActivityRef = React.useRef(props.createActivity)
	const buttonRef = React.useRef<HTMLDivElement>(null)

	const startActivity = () => {
		return SLLClient.Store.getState().updateActivity(createActivityRef.current)
	}

	const preloadActivity = React.useCallback(
		() => {
			return SLLClient.Store.getState().preloadActivity(createActivityRef.current)
		},
		[],
	)

	const [intentTimeout, setIntentTimeout] = React.useState<NodeJS.Timeout | null>(null)

	React.useEffect(() => {
		if (props.preload === 'render') {
			preloadActivity()
		}
	}, [props.preload, preloadActivity])

	// Use IntersectionObserver for viewport-based preloading
	React.useEffect(() => {
		if (props.preload !== 'viewport' || !buttonRef.current) return

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						preloadActivity()
					}
				})
			},
			{ threshold: 0.1 }, // Trigger when 10% of the button is visible
		)

		observer.observe(buttonRef.current)

		return () => {
			observer.disconnect()
		}
	}, [props.preload, preloadActivity, buttonRef])

	const handleMouseEnter = () => {
		if (props.preload === 'intent') {
			const delay = props.intentDelay ?? 150
			const timeout = setTimeout(() => {
				preloadActivity()
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

	return (
		<Slot
			ref={buttonRef}
			onClick={handleClick}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			{props.children}
		</Slot>
	)
}
