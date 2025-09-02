import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useIsMobile } from '@/hooks/use-is-mobile.ts'
import * as DH from '@/lib/display-helpers.ts'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import { statusCodeToTitleCase } from '@/lib/string.ts'
import { resToOptional } from '@/lib/types.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import { BROADCASTS } from '@/messages.ts'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as DndKit from '@/systems.client/dndkit.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as RbacClient from '@/systems.client/rbac.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as UsersClient from '@/systems.client/users.client'
import * as VotesClient from '@/systems.client/votes.client'
import { CSS } from '@dnd-kit/utilities'
import * as ReactQuery from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import deepEqual from 'fast-deep-equal'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import EditLayerListItemDialog from './edit-layer-list-item-dialog.tsx'
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
	DndKit.useDragEnd(React.useCallback((event) => {
		if (!event.over) return
		if (!user || !event.over) return
		if (event.active.type !== 'layer-item') return
		const cursors = LL.dropItemToLLItemCursors(event.over)
		if (cursors.length === 0) return
		const voteState = VotesClient.voteState$.getValue()
		const layerList = props.store.getState().layerList
		if (voteState?.code === 'in-progress') {
			for (const cursor of cursors) {
				if (LL.isChildItem(cursor.itemId, voteState.itemId, layerList)) return
			}
		}
		props.store.getState().move(event.active.id, cursors[0], user.discordId)
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
		item: LL.LayerListItem
	}
	| {
		code: 'delete'
		id: string
	}
	| {
		code: 'add-after' | 'add-before'
		items: LL.LayerListItem[]
		id?: string
	}

type LayerListItemProps = {
	itemId: string
	llStore: Zus.StoreApi<QD.LLStore>
}

function LayerListItem(props: LayerListItemProps) {
	const itemRes = ZusUtils.useStoreDeep(props.llStore, s => LL.findItemById(s.layerList, props.itemId), { dependencies: [props.itemId] })
	if (!itemRes) return null
	const item = itemRes.item
	if (LL.isParentVoteItem(item)) {
		return <VoteLayerListItem {...props} />
	}
	return <SingleLayerListItem {...props} />
}

function SingleLayerListItem(props: LayerListItemProps) {
	const itemStore = QD.useLLItemStore(props.llStore, props.itemId)
	const parentItem = ZusUtils.useStoreDeep(props.llStore, s => {
		const parentItem = LL.findParentItem(props.itemId, s.layerList)
		if (!parentItem || !LL.isParentVoteItem(parentItem)) return undefined
		return parentItem
	}, {
		dependencies: [props.itemId],
	})

	const [item, isVoteChoice, index, innerIndex, backfillLayerId, isLocallyLast, displayedMutation] = ZusUtils.useStoreDeep(
		itemStore,
		(s) => [s.item, s.isVoteChoice, s.index, s.innerIndex, s.backfillLayerId, s.isLocallyLast, getDisplayedMutation(s.mutationState)],
	)

	const [_canEdit, isEditing] = Zus.useStore(QD.QDStore, useShallow((s) => [s.canEditQueue, s.isEditing]))

	const globalVoteState = VotesClient.useVoteState()
	const voteState = (globalVoteState && globalVoteState?.itemId === parentItem?.itemId ? globalVoteState : undefined)
		?? parentItem?.endingVoteState
	const voteInProgress = voteState?.code === 'in-progress'
	const canEdit = _canEdit && !voteInProgress

	const draggableItem = LL.layerItemToDragItem(item)
	const { attributes, listeners, setNodeRef, transform, isDragging } = DndKit.useDraggable(draggableItem)

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}, [canEdit, _setDropdownOpen])

	const isMobile = useIsMobile()
	const style = { transform: CSS.Translate.toString(transform) }

	const badges: React.ReactNode[] = []

	badges.push(<LayerSourceDisplay key={`source ${item.source.type}`} source={item.source} />)

	const editButtonProps = (className?: string) => ({
		'data-can-edit': canEdit,
		'data-is-editing': isEditing,
		'data-mobile': isMobile,
		disabled: !canEdit,
		className: cn('data-[mobile=false]:invisible group-hover/single-item:visible', className),
	})

	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		listStore: props.llStore,
		itemStore: itemStore,
	} satisfies Partial<ItemDropdownProps>

	const layersStatus = resToOptional(SquadServerClient.useLayersStatus())?.data
	const serverInfo = SquadServerClient.useServerInfo()
	const tally = voteState && V.isVoteStateWithVoteData(voteState) && serverInfo
		? V.tallyVotes(voteState, serverInfo.playerCount)
		: undefined

	const itemChoiceTallyPercentage = (isVoteChoice && voteState) ? tally?.percentages?.get(item.layerId) : undefined
	const isVoteWinner = isVoteChoice && voteState?.code === 'ended:winner' && voteState?.winner === item.layerId
	const voteCount = (isVoteChoice && voteState) ? tally?.totals?.get(item.layerId) : undefined

	if (innerIndex === 0 && voteState?.code !== 'ended:winner') {
		badges.push(
			<Badge key="default-choice" variant="secondary">
				Default
			</Badge>,
		)
	}
	if (isVoteWinner) {
		badges.push(
			<Badge key="winner" variant="added">
				Selected
			</Badge>,
		)
	}

	if (
		!isEditing && layersStatus?.nextLayer && index === 0 && !isVoteChoice
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
			{...listeners}
			variant="ghost"
			size="icon"
			{...editButtonProps(cn('data-[can-edit=true]:cursor-grab', props.className))}
		>
			<Icons.GripVertical />
		</Button>
	)
	const beforeItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'before', itemId: item.itemId }]
	const afterItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'after', itemId: item.itemId }]

	const dropOnAttrs = DndKit.useDroppable(LL.llItemCursorsToDropItem([{ itemId: item.itemId, position: 'on' }]))

	let addedLayerQueryInput: LQY.LayerQueryBaseInput | undefined
	if (isVoteChoice) {
		const cursor = LQY.getQueryCursorForItemIndex(index)
		addedLayerQueryInput = {
			patches: [{ type: 'splice', cursor, deleteCount: 1, insertions: [] }],
		}
	}
	return (
		<>
			{(isVoteChoice ? innerIndex! : index) === 0 && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} disabled={!canEdit} />}
			<li
				style={style}
				{...attributes}
				className="group/single-item flex data-[is-voting=true]:border-added  data-[is-voting=true]:bg-secondary data-[is-dragging=false]:w-full min-w-[40px] min-h-[20px] max items-center justify-between space-x-2 px-1 py-0 bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30 cursor-default"
				data-mutation={displayedMutation}
				data-is-dragging={isDragging}
				data-is-voting={voteState?.code === 'in-progress'}
				ref={setNodeRef}
			>
				{isDragging ? <span className="w-[20px] mx-auto">...</span> : (
					<>
						<span className="grid">
							<span
								data-can-edit={canEdit}
								className=" text-right m-auto font-mono text-s col-start-1 row-start-1 group-hover/single-item:invisible"
							>
								{index + 1}.{innerIndex != null ? innerIndex + 1 : ''}
							</span>
							<GripElt className="col-start-1 row-start-1" />
						</span>
						<span
							ref={dropOnAttrs.setNodeRef}
							data-over={canEdit && dropOnAttrs.isOver}
							className="data-[over=true]:bg-secondary rounded flex space-x-1 w-full flex-col"
						>
							<LayerDisplay
								item={{ type: 'list-item', layerId: item.layerId, itemId: item.itemId }}
								badges={badges}
								backfillLayerId={backfillLayerId}
								addedLayerQueryInput={addedLayerQueryInput}
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
	const itemStore = QD.useLLItemStore(props.llStore, props.itemId)

	const [item, index, displayedMutation, isLocallyLast, endingVoteState] = ZusUtils.useStoreDeep(
		itemStore,
		(s) => [s.item as LL.ParentVoteItem, s.index, getDisplayedMutation(s.mutationState), s.isLocallyLast, s.item.endingVoteState],
	)
	const globalVoteState = VotesClient.useVoteState()
	const voteState = (globalVoteState?.itemId === item.itemId ? globalVoteState : undefined) ?? endingVoteState

	const [_canEdit, isEditing] = Zus.useStore(QD.QDStore, useShallow((s) => [s.canEditQueue, s.isEditing]))
	const canEdit = _canEdit && voteState?.code !== 'in-progress'
	const user = UsersClient.useLoggedInUser()
	const canManageVote = user ? RBAC.rbacUserHasPerms(user, RBAC.perm('vote:manage')) : false
	const draggableItem = LL.layerItemToDragItem(item)
	const { attributes, listeners, setNodeRef, transform, isDragging } = DndKit.useDraggable(draggableItem)

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}, [canEdit, _setDropdownOpen])

	const isMobile = useIsMobile()
	const style = { transform: CSS.Translate.toString(transform) }

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

	const addVoteChoiceInput = ZusUtils.useCombinedStoresDeep([QD.QDStore, itemStore], ([qdStore, itemStore]) => {
		const constraints = QD.selectBaseQueryConstraints(qdStore)
		const layerItem = LQY.getLayerItemForLayerListItem(itemStore.item)
		return {
			constraints,
			cursor: itemStore.item ? LQY.getQueryCursorForLayerItem(layerItem, 'add-vote-choice') : undefined,
		}
	}, { selectorDeps: [] })

	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		listStore: props.llStore,
		itemStore: itemStore,
	} satisfies Partial<ItemDropdownProps>

	const beforeItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'before', itemId: item.itemId }]
	const afterItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'after', itemId: item.itemId }]
	const [addVoteChoicesOpen, setAddVoteChoicesOpen] = React.useState(false)
	const [voteDisplayPropsOpen, setVoteDisplayPropsOpen] = React.useState(false)

	const startVoteMutation = ReactQuery.useMutation(VotesClient.startVoteOpts)
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

	const abortVoteMutation = ReactQuery.useMutation(VotesClient.abortVoteOpts)
	async function abortVote() {
		const res = await abortVoteMutation.mutateAsync()
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

	const cancelAutostartMutation = ReactQuery.useMutation(VotesClient.cancelVoteAutostartOpts)
	async function cancelAutostart() {
		const res = await cancelAutostartMutation.mutateAsync()
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
				isEditing,
			)
			const res = {
				canInitiateVote,
				voteAutostartTime: (voteState?.code === 'ready') ? voteState.autostartTime : undefined,
				voteTally: voteState && voteState.code !== 'ready' ? V.tallyVotes(voteState, serverInfo?.playerCount ?? 0) : undefined,
			}
			return res
		},
		{
			dependencies: [item.itemId, voteState, globalVoteState?.code, voterType, serverInfo?.playerCount, isEditing],
		},
	)
	React.useEffect(() => {
		console.log({ voteState })
	}, [voteState])

	return (
		<>
			{index === 0 && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} />}
			<li
				ref={setNodeRef}
				style={style}
				{...attributes}
				className={cn(
					'group/parent-item flex data-[is-dragging=false]:w-full min-w-[40px] min-h-[20px] items-center justify-between px-1 py-0 border-2 border-gray-400 rounded inset-2',
					`data-[mutation=added]:border-added data-[mutation=moved]:border-moved data-[mutation=edited]:border-edited data-[is-dragging=true]:outline cursor-default`,
				)}
				data-mutation={displayedMutation}
				data-is-dragging={isDragging}
			>
				{isDragging ? <span className="mx-auto w-[20px]">...</span> : (
					<div className="h-full flex flex-col flex-grow">
						<div className="p-1 space-x-2 flex items-center justify-between w-full">
							<span className="flex items-center space-x-1">
								<Button
									{...listeners}
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
									selectQueueItems={(items) => itemStore.getState().addVoteItems(items)}
									layerQueryBaseInput={addVoteChoiceInput}
									open={addVoteChoicesOpen}
									onOpenChange={setAddVoteChoicesOpen}
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
								<VoteDisplayPropsPopover llItemStore={itemStore} open={voteDisplayPropsOpen} onOpenChange={setVoteDisplayPropsOpen}>
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
		llItemStore: Zus.StoreApi<QD.LLItemStore>
		open: boolean
		onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
		children: React.ReactNode
	},
) {
	const config = ConfigClient.useConfig()
	const [statuses, usingDefault, preview, valid] = ZusUtils.useStoreDeep(props.llItemStore, s => {
		const itemDisplayProps = s.item.displayProps
		const displayProps = itemDisplayProps ?? config?.defaults.voteDisplayProps ?? []
		const choices = s.item.choices?.map(c => c.layerId) ?? []
		const preview = BROADCASTS.vote.started({ choices, voterType: 'public' }, config?.defaults.voteDuration ?? 120, displayProps)
		const valid = V.validateChoicesWithDisplayProps(choices, displayProps)
		return [DH.toDisplayPropStatuses(displayProps), !itemDisplayProps && !!config?.defaults.voteDisplayProps, preview, valid]
	}, { dependencies: [config] })

	function setDisplayProps(update: Partial<DH.LayerDisplayPropsStatuses>) {
		update = { ...update }

		props.llItemStore.getState().setItem(state =>
			Im.produce(state, draft => {
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

				if (config && deepEqual(updated, DH.toDisplayPropStatuses(config.defaults.voteDisplayProps))) {
					delete draft.displayProps
				} else {
					draft.displayProps = DH.fromDisplayPropStatuses(updated)
				}
			})
		)
	}

	function resetToDefault() {
		if (usingDefault) return
		props.llItemStore.getState().setItem(state =>
			Im.produce(state, draft => {
				delete draft.displayProps
			})
		)
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
	itemStore: Zus.StoreApi<QD.LLItemStore>
	listStore: Zus.StoreApi<QD.LLStore>
	allowVotes?: boolean
}

function ItemDropdown(props: ItemDropdownProps) {
	const allowVotes = props.allowVotes ?? true

	type SubDropdownState = 'add-before' | 'add-after' | 'edit' | 'create-vote' | null
	const [subDropdownState, _setSubDropdownState] = React.useState(null as SubDropdownState)

	function setSubDropdownState(state: SubDropdownState) {
		if (state === null) props.setOpen(false)
		_setSubDropdownState(state)
	}
	const item = Zus.useStore(props.itemStore, s => s.item)

	const queryContexts = ZusUtils.useCombinedStoresDeep([QD.QDStore, props.itemStore], ([qdStore, itemStore]) => {
		const constraints = QD.selectBaseQueryConstraints(qdStore)
		const layerItem = LQY.getLayerItemForLayerListItem(itemStore.item)
		return {
			addLayersAfter: {
				constraints,
				cursor: itemStore.item ? LQY.getQueryCursorForLayerItem(layerItem, 'add-after') : undefined,
			},
			editOrInsert: {
				constraints,
				cursor: itemStore.item ? LQY.getQueryCursorForLayerItem(layerItem, 'edit') : undefined,
			},
		}
	}, { selectorDeps: [] })

	const layerIds = ZusUtils.useStoreDeep(props.itemStore, state => LL.getAllItemLayerIds(state.item), { dependencies: [] })

	const user = UsersClient.useLoggedInUser()
	return (
		<>
			<DropdownMenu modal={false} open={props.open || !!subDropdownState} onOpenChange={props.setOpen}>
				<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuGroup>
						{!LL.isParentVoteItem(item) && <DropdownMenuItem onClick={() => setSubDropdownState('edit')}>Edit</DropdownMenuItem>}
						<DropdownMenuItem
							disabled={!!item.layerId && layerIds?.has(L.swapFactionsInId(item.layerId))}
							onClick={() => props.itemStore.getState().swapFactions()}
						>
							Swap Factions
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								props.itemStore.getState().remove?.()
							}}
							className="bg-destructive text-destructive-foreground focus:bg-red-600"
						>
							Delete
						</DropdownMenuItem>
					</DropdownMenuGroup>

					{!LL.isParentVoteItem(item) && (
						<DropdownMenuItem onClick={() => setSubDropdownState('create-vote')}>
							Create Vote
						</DropdownMenuItem>
					)}

					<DropdownMenuSeparator />

					<DropdownMenuGroup>
						<DropdownMenuItem onClick={() => setSubDropdownState('add-before')}>Add layers before</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setSubDropdownState('add-after')}>Add layers after</DropdownMenuItem>
					</DropdownMenuGroup>

					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem
							onClick={() => {
								if (!user) return
								const item = props.itemStore.getState().item
								const firstItem = props.listStore.getState().layerList[0]
								props.listStore.getState().move(item.itemId, { itemId: firstItem.itemId, position: 'before' }, user.discordId)
							}}
						>
							Send to Front
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => {
								if (!user) return
								const layerList = props.listStore.getState().layerList
								const item = props.itemStore.getState().item
								const firstItem = layerList[layerList.length - 1]
								props.listStore.getState().move(item.itemId, { itemId: firstItem.itemId, position: 'after' }, user.discordId)
							}}
						>
							Send to Back
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Dialogs rendered separately */}
			{!LL.isParentVoteItem(item) && (
				<EditLayerListItemDialog
					open={subDropdownState === 'edit'}
					layerQueryBaseInput={queryContexts.editOrInsert}
					onOpenChange={(update) => {
						const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
						return setSubDropdownState(open ? 'edit' : null)
					}}
					itemStore={props.itemStore}
				/>
			)}

			<SelectLayersDialog
				title="Create Vote"
				description="Select additional layers vote on"
				open={subDropdownState === 'create-vote'}
				onOpenChange={(open) => setSubDropdownState(open ? 'create-vote' : null)}
				pinMode="layers"
				defaultSelected={Array.from(LL.getAllItemLayerIds(item))}
				selectQueueItems={(newItems) => {
					const items = newItems.map(choiceItem => LL.createLayerListItem(choiceItem))
					props.itemStore.getState().setItem({
						itemId: item.itemId,
						choices: items as LL.LayerListItem[],
						layerId: items[0].layerId,
						source: items[0].source!,
					})
				}}
				layerQueryBaseInput={queryContexts.editOrInsert}
			/>

			<SelectLayersDialog
				title="Add layers before"
				description="Select layers to add before"
				open={subDropdownState === 'add-before'}
				onOpenChange={(open) => setSubDropdownState(open ? 'add-before' : null)}
				pinMode={!allowVotes ? 'layers' : undefined}
				selectQueueItems={(items) => {
					const state = props.listStore.getState()
					const item = props.itemStore.getState().item
					state.add(items, { itemId: item.itemId, position: 'before' })
				}}
				layerQueryBaseInput={queryContexts.editOrInsert}
			/>

			<SelectLayersDialog
				title="Add layers after"
				description="Select layers to add after"
				open={subDropdownState === 'add-after'}
				onOpenChange={(open) => setSubDropdownState(open ? 'add-after' : null)}
				pinMode={!allowVotes ? 'layers' : undefined}
				selectQueueItems={(items) => {
					const state = props.listStore.getState()
					const item = props.itemStore.getState().item
					state.add(items, { itemId: item.itemId, position: 'after' })
				}}
				layerQueryBaseInput={queryContexts.addLayersAfter}
			/>
		</>
	)
}

function QueueItemSeparator(props: {
	// null means we're before the first item in the list
	links: LL.LLItemRelativeCursor[]
	isAfterLast?: boolean
	disabled?: boolean
}) {
	const { isOver, setNodeRef } = DndKit.useDroppable(LL.llItemCursorsToDropItem(props.links))
	const disabled = props.disabled || false
	return (
		<Separator
			ref={setNodeRef}
			className="w-full min-w-0 bg-transparent h-2 data-[is-last=true]:invisible data-[is-over=true]:bg-primary" // data-is-last={props.isAfterLast && !isOver}
			data-is-over={!disabled && isOver}
		/>
	)
}
