import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useIsMobile } from '@/hooks/use-is-mobile.ts'
import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers.ts'
import * as FRM from '@/lib/frame'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import * as Obj from '@/lib/object'
import { statusCodeToTitleCase } from '@/lib/string.ts'
import { assertNever } from '@/lib/type-guards.ts'
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

export function LayerList(
	props: { store: Zus.StoreApi<QD.LLStore> },
) {
	const user = UsersClient.useLoggedInUser()
	const queueItemIds = ZusUtils.useStoreDeep(props.store, (store) => store.layerList.map((item) => item.itemId), { dependencies: [] })
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
			const index = LL.resolveQualfiedIndexFromCursorForMove(layerList, cursor)!
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

	return (
		<ul className="flex w-full flex-col">
			{queueItemIds.map((id) => (
				<LayerListItem
					llStore={props.store}
					key={id}
					itemId={id}
				/>
			))}
		</ul>
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

	if (user && itemPresence && itemActivityUser.discordId !== user.discordId) {
		sourceDisplay = (
			<Badge key={`activity ${itemPresence.currentActivity.code}`} variant="info" className="text-nowrap">
				{SLL.getHumanReadableActivityWithUser(itemPresence.currentActivity.code, itemActivityUser.displayName)}...
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
								item={{ type: 'list-item', layerId: item.layerId, itemId: item.itemId }}
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

	const itemActions = () => QD.getLLItemActions(props.llStore.getState(), props.itemId)

	const globalVoteState = VotesClient.useVoteState()
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? endingVoteState

	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)
	const canEdit = !SLLClient.useIsItemLocked(item.itemId)
	const user = UsersClient.useLoggedInUser()
	const canManageVote = user ? RBAC.rbacUserHasPerms(user, RBAC.perm('vote:manage')) : false
	const draggableItem = LL.layerItemToDragItem(item)
	const dragProps = DndKit.useDraggable(draggableItem)

	const [dropdownOpen, setDropdownOpen] = React.useState(false)
	const layerItem = LQY.getLayerItemForLayerListItem(item)
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
	const [addVoteChoicesOpen, setAddVoteChoicesOpen] = SLLClient.useActivityState({ code: 'editing-item', itemId: item.itemId })
	const [voteDisplayPropsOpen, setVoteDisplayPropsOpen] = SLLClient.useActivityState({ code: 'configuring-vote', itemId: item.itemId })

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
								<SelectLayersDialog
									title="Add Vote Choices"
									pinMode="layers"
									selectQueueItems={(items) => itemActions().addVoteItems(items)}
									open={addVoteChoicesOpen}
									onOpenChange={setAddVoteChoicesOpen}
									cursor={LQY.getQueryCursorForLayerItem(layerItem, 'add-vote-choice')}
								>
									<Button
										variant="ghost"
										size="icon"
										title="Add Vote Choices"
										{...editButtonProps()}
									>
										<Icons.Plus />
									</Button>
								</SelectLayersDialog>
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
	const allowVotes = props.allowVotes ?? true

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

	const [cursors, dropdownMapping] = React.useMemo(() => {
		const cursors = {
			'add-after': LQY.getQueryCursorForItemIndex(index),
			'create-vote': LQY.getQueryCursorForLayerItem(item.itemId, 'edit'),
			'add-before': LQY.getQueryCursorForLayerItem(item.itemId, 'edit'),
			'edit': LQY.getQueryCursorForLayerItem(item.itemId, 'edit'),
		} satisfies { [k in SubDropdownState]: any }
		const dropdownMapping: Record<SubDropdownState, SLL.Activity> = {
			edit: { code: 'editing-item', itemId: item.itemId },
			'create-vote': { code: 'editing-item', itemId: item.itemId },
			'add-after': { code: 'adding-item' },
			'add-before': { code: 'adding-item' },
		}
		return [cursors, dropdownMapping] as const
	}, [item.itemId])

	const [subDropdownState, _setSubDropdownState] = SLLClient.useActivityKeyState(dropdownMapping)
	function setSubDropdownState(state: SubDropdownState | null) {
		if (state === null) props.setOpen(false)
		_setSubDropdownState(state)
	}

	const isLocked = SLLClient.useIsItemLocked(item.itemId)
	const itemActions = () => QD.getLLItemActions(props.listStore.getState(), props.itemId)

	const user = UsersClient.useLoggedInUser()
	return (
		<>
			<DropdownMenu modal={false} open={props.open || !!subDropdownState} onOpenChange={props.setOpen}>
				<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuGroup>
						{!LL.isVoteItem(item) && (
							<DropdownMenuItem
								onClick={() => setSubDropdownState('edit')}
							>
								Edit
							</DropdownMenuItem>
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
						<DropdownMenuItem
							disabled={isLocked}
							onClick={() => setSubDropdownState('create-vote')}
						>
							Create Vote
						</DropdownMenuItem>
					)}

					<DropdownMenuSeparator />

					<DropdownMenuGroup>
						<DropdownMenuItem disabled={isLocked} onClick={() => setSubDropdownState('add-before')}>Add layers before</DropdownMenuItem>
						<DropdownMenuItem disabled={isLocked} onClick={() => setSubDropdownState('add-after')}>Add layers after</DropdownMenuItem>
					</DropdownMenuGroup>

					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem
							disabled={(index.innerIndex ?? index.outerIndex) === 0 || isLocked}
							onClick={() => {
								if (!user) return
								const firstItem = props.listStore.getState().layerList[0]
								itemActions().dispatch({
									op: 'move',
									newFirstItemId: LL.createLayerListItemId(),
									cursor: { type: 'item-relative', itemId: firstItem.itemId, position: 'before' },
								})
							}}
						>
							Send to Front
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={(index.innerIndex ?? index.outerIndex) === lastLocalIndex || isLocked}
							onClick={() => {
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
							}}
						>
							Send to Back
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Dialogs rendered separately */}
			{!LL.isVoteItem(item) && (
				<EditLayerDialog
					cursor={cursors.edit}
					open={subDropdownState === 'edit'}
					onOpenChange={(update) => {
						const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
						return setSubDropdownState(open ? 'edit' : null)
					}}
					layerId={item.layerId}
					onSelectLayer={async (layerId) => {
						const list = props.listStore.getState().layerList
						const parentVoteItem = LL.resolveParentVoteItem(item.itemId, list)
						if (parentVoteItem) {
							const otherChoices = parentVoteItem?.choices.filter(choice => choice.itemId !== props.itemId)
							if (Arr.deref('layerId', otherChoices).includes(layerId)) {
								await sleep(250)
								globalToast$.next({
									variant: 'destructive',
									title: 'Layer already exists in vote',
								})
								return
							}
						}
						itemActions().dispatch({
							op: 'edit-layer',
							newLayerId: layerId,
						})
					}}
				/>
			)}

			<SelectLayersDialog
				title="Create Vote"
				description="Select additional layers vote on"
				open={subDropdownState === 'create-vote'}
				onOpenChange={(open) => setSubDropdownState(open ? 'create-vote' : null)}
				cursor={cursors['create-vote']}
				pinMode="layers"
				defaultSelected={Array.from(LL.getAllItemLayerIds(item))}
				selectQueueItems={(newItems) => {
					if (index.innerIndex === null) return
					const layerList = props.listStore.getState().layerList
					const targetIndex = LL.getLastLocalIndexForItem(item.itemId, layerList)!
					if (targetIndex?.innerIndex !== null) targetIndex.innerIndex++
					const source: LL.Source = { type: 'manual', userId: UsersClient.loggedInUserId! }
					props.listStore.getState().dispatch({
						op: 'create-vote',
						itemId: item.itemId,
						otherLayers: newItems.map((item) => LL.createLayerListItem(item, source)),
						newFirstItemId: LL.createLayerListItemId(),
					})
				}}
			/>

			<SelectLayersDialog
				title="Add layers before"
				description="Select layers to add before"
				open={subDropdownState === 'add-before'}
				cursor={cursors['add-before']}
				onOpenChange={(open) => setSubDropdownState(open ? 'add-before' : null)}
				pinMode={!allowVotes ? 'layers' : undefined}
				selectQueueItems={(items) => {
					const state = props.listStore.getState()
					const index = LL.getItemIndex(state.layerList, item.itemId)!
					state.dispatch({ op: 'add', items, index })
				}}
			/>

			<SelectLayersDialog
				title="Add layers after"
				description="Select layers to add after"
				open={subDropdownState === 'add-after'}
				cursor={cursors['add-after']}
				onOpenChange={(open) => setSubDropdownState(open ? 'add-after' : null)}
				pinMode={!allowVotes ? 'layers' : undefined}
				selectQueueItems={(items) => {
					const state = props.listStore.getState()
					const index = LL.getItemIndex(state.layerList, item.itemId)!
					if (index.innerIndex !== null) index.innerIndex++
					else index.outerIndex++
					state.dispatch({ op: 'add', items, index })
				}}
			/>
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

export function AddLayersDialog() {
}
