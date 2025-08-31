import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useIsMobile } from '@/hooks/use-is-mobile.ts'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import { snakeCaseToTitleCase, statusCodeToTitleCase } from '@/lib/string.ts'
import { resToOptional } from '@/lib/types.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models'
import * as DndKit from '@/systems.client/dndkit.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as UsersClient from '@/systems.client/users.client'
import * as VotesClient from '@/systems.client/votes.client'
import { CSS } from '@dnd-kit/utilities'
import * as ReactQuery from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import EditLayerListItemDialog from './edit-layer-list-item-dialog.tsx'
import LayerDisplay from './layer-display.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { Timer } from './timer.tsx'
import { Alert, AlertDescription, AlertTitle } from './ui/alert.tsx'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'

export function LayerList(
	props: { store: Zus.StoreApi<QD.LLStore> },
) {
	const user = UsersClient.useLoggedInUser()
	const queueIds = ZusUtils.useStoreDeep(props.store, (store) => store.layerList.map((item) => item.itemId), { dependencies: [] })
	DndKit.useDragEnd(React.useCallback((event) => {
		if (!event.over) return
		if (!user || !event.over) return
		if (event.active.type !== 'layer-item') return
		const cursors = LL.dropItemToLLItemCursors(event.over)
		if (cursors.length === 0) return
		props.store.getState().move(event.active.id, cursors[0], user.discordId)
	}, [user, props.store]))

	return (
		<ul className="flex w-full flex-col">
			{queueIds.map((id, index) => (
				<LayerListItem
					llStore={props.store}
					key={id}
					itemId={id}
					isLast={index + 1 === queueIds.length}
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
	isLast: boolean
	itemId: string
	llStore: Zus.StoreApi<QD.LLStore>
}

function LayerListItem(props: LayerListItemProps) {
	const itemStore = QD.useLLItemStore(props.llStore, props.itemId)

	const item = ZusUtils.useStoreDeep(itemStore, (s) => s.item)
	const isVoteChoice = Zus.useStore(itemStore, (s) => s.isVoteChoice)
	const [canEdit, isEditing] = Zus.useStore(QD.QDStore, useShallow((s) => [s.canEditQueue, s.isEditing]))
	const user = UsersClient.useLoggedInUser()
	const canManageVote = user ? RBAC.rbacUserHasPerms(user, RBAC.perm('vote:manage')) : false
	const draggableItem = LL.layerItemToDragItem(item)
	const { attributes, listeners, setNodeRef, transform, isDragging } = DndKit.useDraggable(draggableItem)
	const [index, innerIndex] = Zus.useStore(itemStore, useShallow((s) => [s.index, s.innerIndex]))

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}, [canEdit, _setDropdownOpen])
	const [baseBackfillLayerId] = Zus.useStore(props.llStore, useShallow(s => [s.nextLayerBackfillId]))
	const backfillLayerId = index === 0 && baseBackfillLayerId && L.areLayersCompatible(LL.getActiveItemLayerId(item), baseBackfillLayerId)
		? baseBackfillLayerId
		: undefined

	const isMobile = useIsMobile()
	const style = { transform: CSS.Translate.toString(transform) }

	const badges: React.ReactNode[] = []

	badges.push(<LayerSourceDisplay key={`source ${item.source.type}`} source={item.source} />)
	if (innerIndex === 0) {
		badges.push(
			<Badge key="default-choice" variant="secondary">
				Default
			</Badge>,
		)
	}

	const queueItemStyles =
		`bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30 cursor-default`
	const parentQueueItemStyles =
		`data-[mutation=added]:border-added data-[mutation=moved]:border-moved data-[mutation=edited]:border-edited data-[is-dragging=true]:outline cursor-default`
	const layersStatus = resToOptional(SquadServerClient.useLayersStatus())?.data

	const addVoteChoiceInput = ZusUtils.useCombinedStoresDeep([QD.QDStore, itemStore], ([qdStore, itemStore]) => {
		const constraints = QD.selectBaseQueryConstraints(qdStore)
		const layerItem = LQY.getLayerItemForLayerListItem(itemStore.item)
		return {
			constraints,
			cursor: itemStore.item ? LQY.getQueryCursorForLayerItem(layerItem, 'add-vote-choice') : undefined,
		}
	}, { selectorDeps: [] })

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
	const dropdownProps = {
		open: dropdownOpen && canEdit,
		setOpen: setDropdownOpen,
		listStore: props.llStore,
		itemStore: itemStore,
	} satisfies Partial<ItemDropdownProps>

	const displayedMutation = Zus.useStore(itemStore, (s) => getDisplayedMutation(s.mutationState))
	const GripElt = (props: { orientation: 'horizontal' | 'vertical'; className?: string }) => (
		<Button
			{...listeners}
			disabled={!canEdit}
			variant="ghost"
			size="icon"
			data-canedit={canEdit}
			className={cn(props.className, 'invisible data-[canedit=true]:cursor-grab ')}
		>
			{props.orientation === 'horizontal' ? <Icons.GripHorizontal /> : <Icons.GripVertical />}
		</Button>
	)
	// const [prevItemId, nextItemId] = Zus.useStore(
	// 	props.llStore,
	// 	useShallow(s => [s.layerList[index - 1]?.itemId, s.layerList[index + 1]?.itemId]),
	// )
	const beforeItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'before', itemId: item.itemId }]
	// if (prevItemId) {
	// 	beforeItemLinks.push({ position: 'after', itemId: prevItemId })
	// }
	const afterItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'after', itemId: item.itemId }]
	// if (nextItemId) {
	// 	afterItemLinks.push({ position: 'before', itemId: nextItemId })
	// }
	//
	//

	const dropOnAttrs = DndKit.useDroppable(LL.llItemCursorsToDropItem([{ itemId: item.itemId, position: 'on' }]))

	const [addVoteChoicesOpen, setAddVoteChoicesOpen] = React.useState(false)

	const voteState = VotesClient.useVoteState()
	const startVoteMutation = ReactQuery.useMutation(VotesClient.startVoteOpts)
	const serverInfoRes = SquadServerClient.useServerInfo()
	const serverInfo = serverInfoRes.code === 'ok' ? serverInfoRes.data : undefined

	const [voterType, setVoterType] = React.useState<V.VoterType>('public')
	const internalVoteCheckboxId = React.useId()
	const [canInitiateVote, voteAutostartTime, voteTally] = ZusUtils.useStoreDeep(
		props.llStore,
		store => {
			const canInitiateVote = V.canInitiateVote(item.itemId, store.layerList, voterType, voteState ? { code: voteState.code } : undefined)
			return [
				canInitiateVote,
				(voteState?.code === 'ready' && voteState.itemId === item.itemId) ? voteState.autostartTime : undefined,
				voteState && voteState.code !== 'ready' ? V.tallyVotes(voteState, serverInfo?.playerCount ?? 0) : undefined,
			]
		},
		{
			dependencies: [item.itemId, voteState?.code, voterType, serverInfo?.playerCount],
		},
	)

	if (LL.isParentVoteItem(item)) {
		return (
			<>
				{index === 0 && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn(
						'group/parent-item flex data-[is-dragging=false]:w-full min-w-[40px] min-h-[20px] items-center justify-between px-1 py-0 border-2 border-gray-400 rounded inset-2',
						parentQueueItemStyles,
					)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					{isDragging ? <span className="mx-auto w-[20px]">...</span> : (
						<div className="h-full flex flex-col flex-grow">
							<div className="p-1 space-x-2 flex items-center justify-between w-full">
								<span className="flex items-center space-x-1">
									<GripElt className="data-[canedit=true]:group-hover/parent-item:visible" orientation="horizontal" />
									<h3 className={cn(Typography.Label, 'bold')}>Vote</h3>
									{voteAutostartTime && (
										<>
											<span>:</span>
											<span className="whitespace-nowrap text-nowrap w-max text-sm flex flex-nowrap items-center space-x-2">
												<span>starts in</span> <Timer deadline={voteAutostartTime.getTime()} />
											</span>
										</>
									)}
									{voteState && voteState.code === 'in-progress' && (
										<Alert variant="info">
											<AlertTitle>
												<span className="text-xs font-mono">{statusCodeToTitleCase(voteState.code)}</span>
											</AlertTitle>
											<AlertDescription>
												<span>{voteTally && serverInfo && <span>{voteTally.totalVotes} of {serverInfo.playerCount}</span>}</span>
												{voteState.code === 'in-progress' && <Timer deadline={voteState.deadline} />}
											</AlertDescription>
										</Alert>
									)}
								</span>
								<span className="flex items-center space-x-1">
									<div
										data-canedit={canManageVote}
										data-mobile={isMobile}
										className="flex items-center space-x-2 data-[mobile=false]:invisible data-[canedit=true]:group-hover/parent-item:visible"
									>
										<Checkbox
											id={internalVoteCheckboxId}
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
										variant="ghost"
										size="icon"
										data-canedit={canManageVote}
										data-mobile={isMobile}
										className="data-[mobile=false]:invisible data-[canedit=true]:group-hover/parent-item:visible text-green-500 disabled:text-foreground"
										onClick={() =>
											startVoteMutation.mutate({ itemId: item.itemId, ...(item.voteConfig ?? V.getDefaultVoteConfig()), ...{ voterType } })}
										disabled={canInitiateVote.code !== 'ok'}
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
											disabled={!canEdit}
											data-canedit={canEdit}
											data-mobile={isMobile}
											className="data-[mobile=false]:invisible data-[canedit=true]:group-hover/parent-item:visible"
										>
											<Icons.Plus />
										</Button>
									</SelectLayersDialog>
									<ItemDropdown {...dropdownProps}>
										<Button
											disabled={!canEdit}
											data-canedit={canEdit}
											data-mobile={isMobile}
											variant="ghost"
											size="icon"
											className={cn('data-[mobile=false]:invisible data-[canedit=true]:group-hover/parent-item:visible')}
										>
											<Icons.EllipsisVertical />
										</Button>
									</ItemDropdown>
								</span>
							</div>
							<ol className={'flex flex-col items-start'}>
								{item.choices!.map((choice, choiceIndex) => {
									const isLast = choiceIndex === item.choices.length - 1 && props.isLast
									const afterChoiceItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'after', itemId: choice.itemId }]
									// const nextItemId = item.choices[choiceIndex + 1]?.itemId
									const beforeChoiceItemLinks: LL.LLItemRelativeCursor[] = [{ position: 'before', itemId: choice.itemId }]
									// if (isLast) {
									// 	choiceItemLinks.push({ position: 'before', itemId: nextItemId })
									// }
									return (
										<LayerListItem
											key={choice.itemId}
											itemId={choice.itemId}
											llStore={props.llStore}
											isLast={isLast}
										/>
									)
								})}
							</ol>
						</div>
					)}
				</li>
				<QueueItemSeparator links={afterItemLinks} isAfterLast={props.isLast} />
			</>
		)
	}

	let addedLayerQueryInput: LQY.LayerQueryBaseInput | undefined
	if (isVoteChoice) {
		const cursor = LQY.getQueryCursorForItemIndex(index)
		addedLayerQueryInput = {
			patches: [{ type: 'splice', cursor, deleteCount: 1, insertions: [] }],
		}
	}
	return (
		<>
			{(isVoteChoice ? innerIndex! : index) === 0 && <QueueItemSeparator links={beforeItemLinks} isAfterLast={false} />}
			<li
				style={style}
				{...attributes}
				className={cn(
					`group/single-item flex data-[is-dragging=false]:w-full min-w-[40px] min-h-[20px] max items-center justify-between space-x-2 px-1 py-0`,
					queueItemStyles,
				)}
				data-mutation={displayedMutation}
				data-is-dragging={isDragging}
				ref={setNodeRef}
			>
				{isDragging ? <span className="w-[20px] mx-auto">...</span> : (
					<>
						<span className="grid">
							<span
								data-canedit={canEdit}
								className=" text-right m-auto font-mono text-s col-start-1 row-start-1 data-[canedit=true]:group-hover/single-item:invisible"
							>
								{index + 1}.{innerIndex != null ? innerIndex + 1 : ''}
							</span>
							<GripElt orientation="vertical" className="col-start-1 row-start-1 data-[canedit=true]:group-hover/single-item:visible" />
						</span>
						<span
							ref={dropOnAttrs.setNodeRef}
							data-over={dropOnAttrs.isOver}
							className="data-[over=true]:bg-secondary rounded flex space-x-1 w-full"
						>
							<LayerDisplay
								item={{ type: 'list-item', layerId: item.layerId, itemId: item.itemId }}
								badges={badges}
								backfillLayerId={backfillLayerId}
								addedLayerQueryInput={addedLayerQueryInput}
							/>
						</span>
						<ItemDropdown {...dropdownProps}>
							<Button
								disabled={!canEdit}
								data-canedit={canEdit}
								data-mobile={isMobile}
								variant="ghost"
								size="icon"
								className={cn('data-[mobile=false]:invisible data-[canedit=true]:group-hover/single-item:visible')}
							>
								<Icons.EllipsisVertical />
							</Button>
						</ItemDropdown>
					</>
				)}
			</li>
			<QueueItemSeparator links={afterItemLinks} isAfterLast={props.isLast} />
		</>
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
							disabled={props.allowVotes && !!item.layerId && layerIds?.has(L.swapFactionsInId(item.layerId))}
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
				selectQueueItems={(items) => {
					props.itemStore.getState().addVoteItems(items)
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
}) {
	const { isOver, setNodeRef } = DndKit.useDroppable(LL.llItemCursorsToDropItem(props.links))
	const isDragging = DndKit.useDragging()
	return (
		<Separator
			ref={setNodeRef}
			className="w-full min-w-0 bg-transparent h-2 data-[is-last=true]:invisible data-[is-over=true]:bg-primary" // data-is-last={props.isAfterLast && !isOver}
			data-is-over={isOver}
			data-is-dragging={!!isDragging}
		/>
	)
}
