import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { initMutationState } from '@/lib/item-mutations.ts'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import { assertNever } from '@/lib/type-guards.ts'
import { resToOptional } from '@/lib/types.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import * as L from '@/models/layer'
import * as LFM from '@/models/layer-filter-menu.models.ts'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import { useDragEnd } from '@/systems.client/dndkit.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import * as DndKit from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import deepEqual from 'fast-deep-equal'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import LayerDisplay from './layer-display.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'

export function LayerList(
	props: { store: Zus.StoreApi<QD.LLStore> },
) {
	const user = useLoggedInUser()
	const queueIds = ZusUtils.useStoreDeep(props.store, (store) => store.layerList.map((item) => item.itemId), { dependencies: [] })
	useDragEnd((event) => {
		if (!event.over) return
		const { layerList: layerQueue, move } = props.store.getState()
		const sourceIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.active.id as string))
		const targetIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.over.id as string))
		if (!user) return
		move(sourceIndex, targetIndex, user.discordId)
	})

	return (
		<ul className="flex w-full flex-col space-y-1">
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

type EditLayerQueueItemDialogProps = {
	children: React.ReactNode
} & InnerEditLayerListItemDialogProps

// index
// itemStore
type InnerEditLayerListItemDialogProps = {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	allowVotes?: boolean
	itemStore: Zus.StoreApi<QD.LLItemStore>
}

function EditLayerListItemDialogWrapper(props: EditLayerQueueItemDialogProps) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0 pb-2">
				<DragContextProvider>
					<EditLayerListItemDialog {...props} />
				</DragContextProvider>
			</DialogContent>
		</Dialog>
	)
}

export function EditLayerListItemDialog(props: InnerEditLayerListItemDialogProps) {
	const allowVotes = props.allowVotes ?? true

	const [initialItem, index] = ZusUtils.useStoreDeep(
		props.itemStore,
		(s) => [s.item, s.index],
		{ dependencies: [] },
	)

	const editedItemStore = React.useMemo(() => {
		return Zus.create<QD.LLItemStore>((set, get) =>
			QD.createLLItemStore(set, get, { item: initialItem, mutationState: initMutationState(), index })
		)
	}, [initialItem, index])
	const editedItem = Zus.useStore(editedItemStore, (s) => s.item)

	const editedVoteChoiceStore = QD.useVoteChoiceStore(editedItemStore)

	const loggedInUser = useLoggedInUser()
	const [itemType, setItemType] = React.useState<'vote' | 'set-layer'>(editedItem.vote ? 'vote' : 'set-layer')

	const [addLayersOpen, setAddLayersOpen] = React.useState(false)

	const filterMenuStore = LFM.useFilterMenuStore(editedItem.layerId ? L.toLayer(editedItem.layerId) : undefined)

	const canSubmitSetLayer = Zus.useStore(
		editedItemStore,
		(s) => !deepEqual(initialItem, s.item) && (!s.item.vote || s.item.vote.choices.length > 0),
	)
	const canSubmitVoteChoices = Zus.useStore(editedVoteChoiceStore, s => s.layerList.length > 0)
	const canSubmit = itemType === 'set-layer' ? canSubmitSetLayer : canSubmitVoteChoices

	// const voteChoiceAddLayersQueryContext = React.useMemo(() => (
	// 	LQY.getQueryContextForAddingVoteChoice(fullQueryContext, editedItem.itemId)
	// ), [editedItem.itemId, fullQueryContext])
	//

	function submit() {
		if (!canSubmit) return
		props.onOpenChange(false)
		const source: LL.LayerSource = { type: 'manual', userId: loggedInUser!.discordId }
		if (itemType === 'vote') {
			const itemState = editedItemStore.getState()
			const choices = editedVoteChoiceStore.getState().layerList.map(item => item.layerId!)
			if (choices.length === 0) {
				return
			}
			if (choices.length === 1) {
				props.itemStore.getState().setItem({ ...itemState.item, vote: undefined, layerId: choices[0], source })
				return
			}
			const defaultChoice = choices.length > 0 ? choices[0] : L.DEFAULT_LAYER_ID

			// ensure that if this vote has already been decideed then we overwrite it when the choice is remove
			let layerId: string | undefined
			if (itemState.item.layerId) {
				if (choices.includes(itemState.item.layerId)) {
					layerId = itemState.item.layerId
				} else {
					layerId = choices[0]
				}
			}

			props.itemStore.getState().setItem({ itemId: itemState.item.itemId, layerId, vote: { choices, defaultChoice }, source })
		} else {
			props.itemStore.getState().setItem({ ...editedItemStore.getState().item, source })
		}
	}
	const layerItemsState = QD.useLayerItemsState()

	const queryInputs = ZusUtils.useCombinedStoresDeep(
		[QD.QDStore, filterMenuStore, editedItemStore],
		(args) => {
			const [qdState, filterMenuState, editedLayerListItemState] = args
			const constraints = QD.selectBaseQueryConstraints(qdState)
			const addVoteChoice: LQY.LayerQueryBaseInput = LQY.getBaseQueryInputForAddingVoteChoice(
				layerItemsState,
				constraints,
				editedLayerListItemState.item.itemId,
			)
			const editItem = {
				constraints,
				cursor: LQY.getQueryCursorForLayerItem(LQY.getLayerItemForLayerListItem(editedLayerListItemState.item), 'edit'),
			} satisfies LQY.LayerQueryBaseInput
			const editItemWithFilterMenu: LQY.LayerQueryBaseInput = {
				cursor: editItem.cursor,
				constraints: [...constraints, ...LFM.selectFilterMenuConstraints(filterMenuState)],
				patches: [{
					type: 'splice',
					deleteCount: 1,
					cursor: editItem.cursor,
					insertions: [LQY.getLayerItemForLayerListItem(editedLayerListItemState.item) as LQY.LayerItem],
				}],
			}
			return {
				addVoteChoice,
				editItem,
				editItemWithFilterMenu,
			}
		},
		{ selectorDeps: [layerItemsState] },
	)

	function toggleItemType() {
		if (!allowVotes) return
		const newItemType = itemType === 'vote' ? 'set-layer' : 'vote'
		setItemType(newItemType)
		switch (newItemType) {
			case 'vote': {
				const newState = QD.getVoteChoiceStateFromItem(editedItemStore.getState())
				if (editedItem.layerId) {
					newState.layerList = [LL.createLayerListItem({ layerId: editedItem.layerId, source: editedItem.source })]
				} else {
					newState.layerList = []
				}
				editedVoteChoiceStore.setState(newState)
				editedItemStore.getState().setItem({
					itemId: editedItem.itemId,
					vote: { choices: [editedItem.layerId!], defaultChoice: editedItem.layerId! },
					source: editedItem.source,
				})
				break
			}
			case 'set-layer': {
				editedItemStore.getState().setItem(prev => {
					const selectedLayerIds = itemToLayerIds(prev)
					return {
						...prev,
						itemId: prev.itemId,
						layerId: selectedLayerIds[0],
						vote: undefined,
					} satisfies LL.LayerListItem
				})
				break
			}
			default:
				assertNever(newItemType)
		}
	}

	if (!props.allowVotes && editedItem.vote) throw new Error('Invalid queue item')

	return (
		<>
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<DialogTitle>Edit</DialogTitle>
					<div className="mx-8 font-light">-</div>
					<DialogDescription>Change the layer or vote choices for this queue item.</DialogDescription>
				</div>
				<div className="flex items-center space-x-2">
					{allowVotes && (
						<Button
							variant="outline"
							onClick={toggleItemType}
						>
							{itemType === 'vote' ? 'Convert to Set Layer' : 'Convert to Vote'}
						</Button>
					)}
				</div>
			</DialogHeader>

			{itemType === 'vote'
				? (
					<div className="flex flex-col">
						<div className="flex w-min"></div>
						<div>
							<LayerList store={editedVoteChoiceStore} />
							<div>
								<div className="flex justify-end space-x-2">
									<SelectLayersDialog
										title="Add"
										description="Select layers to add to the voting pool"
										open={addLayersOpen}
										pinMode="layers"
										onOpenChange={setAddLayersOpen}
										layerQueryBaseInput={queryInputs.addVoteChoice}
										selectQueueItems={(items) => {
											editedVoteChoiceStore.getState().add(items)
										}}
									>
										<Button variant="secondary" size="sm" onClick={() => setAddLayersOpen(true)}>Add layers</Button>
									</SelectLayersDialog>
									<Button disabled={!canSubmit} onClick={submit}>
										Submit
									</Button>
								</div>
							</div>
						</div>
					</div>
				)
				: (
					<div className="flex items-start space-x-2 min-h-0">
						<LayerFilterMenu layerQueryBaseInput={queryInputs.editItem} filterMenuStore={filterMenuStore} />
						<div className="flex flex-col h-full justify-between">
							<TableStyleLayerPicker
								defaultPageSize={12}
								queryContext={queryInputs.editItemWithFilterMenu}
								maxSelected={1}
								selected={[editedItem.layerId!]}
								onSelect={(update) => {
									const id = (typeof update === 'function' ? update([]) : update)[0]
									if (!id) return
									return editedItemStore.getState().setItem((prev) => ({ ...prev, layerId: id }))
								}}
								extraPanelItems={<PoolCheckboxes />}
							/>
							<div className="flex justify-end">
								<Button disabled={!canSubmit} onClick={submit}>
									Submit
								</Button>
							</div>
						</div>
					</div>
				)}
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

function getIndexFromQueueItemId(items: LL.LayerListItem[], id: string | null) {
	if (id === null) return -1
	return items.findIndex((item) => item.itemId === id)
}

type QueueItemProps = {
	isLast: boolean
	itemId: string
	llStore: Zus.StoreApi<QD.LLStore>
}

function LayerListItem(props: QueueItemProps) {
	const itemStore = React.useMemo(() => QD.deriveLLItemStore(props.llStore, props.itemId), [props.llStore, props.itemId])
	const item = Zus.useStore(itemStore, (s) => s.item)
	const [canEdit, isEditing] = Zus.useStore(QD.QDStore, useShallow((s) => [s.canEditQueue, s.isEditing]))
	const draggableItemId = QD.toDraggableItemId(item.itemId)
	const { attributes, listeners, setNodeRef, transform, isDragging } = DndKit.useDraggable({
		id: draggableItemId,
	})
	const index = Zus.useStore(itemStore, (s) => s.index)

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = (update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}
	const [baseBackfillLayerId, isVoteChoice] = Zus.useStore(props.llStore, useShallow(s => [s.nextLayerBackfillId, s.isVoteChoice]))
	const backfillLayerId = index === 0 && baseBackfillLayerId && L.areLayersCompatible(LL.getActiveItemLayerId(item), baseBackfillLayerId)
		? baseBackfillLayerId
		: undefined

	const style = { transform: CSS.Translate.toString(transform) }
	const itemDropdown = (
		<ItemDropdown
			open={dropdownOpen && canEdit}
			setOpen={setDropdownOpen}
			listStore={props.llStore}
			itemStore={itemStore}
		>
			<Button
				disabled={!canEdit}
				data-canedit={canEdit}
				className="invisible data-[canedit=true]:group-hover:visible"
				variant="ghost"
				size="icon"
			>
				<Icons.EllipsisVertical />
			</Button>
		</ItemDropdown>
	)
	const badges: React.ReactNode[] = []

	badges.push(<LayerSourceDisplay key={`source ${item.source.type}`} source={item.source} />)

	const queueItemStyles =
		`bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30 cursor-default`
	const layersStatus = resToOptional(SquadServerClient.useLayersStatus())?.data

	if (
		!isEditing && layersStatus?.nextLayer && index === 0 && !isVoteChoice
		&& !L.areLayersCompatible(LL.getActiveItemLayerId(item), layersStatus.nextLayer, true)
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

	const displayedMutation = Zus.useStore(itemStore, (s) => getDisplayedMutation(s.mutationState))
	const gripElt = (
		<Button
			{...listeners}
			disabled={!canEdit}
			variant="ghost"
			size="icon"
			data-canedit={canEdit}
			className="invisible data-[canedit=true]:cursor-grab data-[canedit=true]:group-hover:visible"
		>
			<Icons.GripVertical />
		</Button>
	)
	const indexElt = <span className="mr-2 font-light">{index + 1}.</span>

	if (item.vote) {
		return (
			<>
				{index === 0 && <QueueItemSeparator itemId={QD.toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn('group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1', queueItemStyles)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					<div className="flex items-center">{gripElt}</div>
					{indexElt}
					<div className="h-full flex flex-col flex-grow">
						<label className={Typography.Muted}>Vote</label>
						<ol className={'flex flex-col space-y-1 items-start'}>
							{item.vote.choices.map((choice, index) => {
								const badges = choice === item.layerId ? [<Badge variant="added" key="layer chosen">chosen</Badge>] : []
								return (
									<li key={choice} className="flex items-center ">
										<span className="mr-2">{index + 1}.</span>
										<LayerDisplay
											item={{ type: 'vote-item', itemId: item.itemId, layerId: choice, choiceIndex: index }}
											badges={badges}
										/>
									</li>
								)
							})}
						</ol>
						<div className="flex space-x-1 items-center">{badges}</div>
					</div>
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</>
		)
	}

	if (item.layerId) {
		let addedLayerQueryInput: LQY.LayerQueryBaseInput | undefined
		if (isVoteChoice) {
			const cursor = LQY.getQueryCursorForItemIndex(index)
			addedLayerQueryInput = {
				patches: [{ type: 'splice', cursor, deleteCount: 1, insertions: [] }],
			}
		}
		return (
			<>
				{index === 0 && <QueueItemSeparator itemId={QD.toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn(`group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1 min-w-0`, queueItemStyles)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					{gripElt}
					{indexElt}
					<div className="flex flex-col w-max flex-grow">
						<div className="flex items-center flex-shrink-0">
							<LayerDisplay
								item={{ type: 'list-item', layerId: item.layerId, itemId: item.itemId }}
								backfillLayerId={backfillLayerId}
								addedLayerQueryInput={addedLayerQueryInput}
							/>
						</div>
						<div className="flex space-x-1 items-center">{badges}</div>
					</div>
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</>
		)
	}
	throw new Error('Unknown layer queue item layout ' + JSON.stringify(item))
}

function ItemDropdown(props: {
	children: React.ReactNode
	open: boolean
	setOpen: React.Dispatch<React.SetStateAction<boolean>>
	itemStore: Zus.StoreApi<QD.LLItemStore>
	listStore: Zus.StoreApi<QD.LLStore>
	allowVotes?: boolean
}) {
	const allowVotes = props.allowVotes ?? true

	type SubDropdownState = 'add-before' | 'add-after' | 'edit' | null
	const [subDropdownState, _setSubDropdownState] = React.useState(null as SubDropdownState)

	function setSubDropdownState(state: SubDropdownState) {
		if (state === null) props.setOpen(false)
		_setSubDropdownState(state)
	}
	const layerId = Zus.useStore(props.itemStore, s => s.item.layerId)

	const queryContexts = ZusUtils.useCombinedStoresDeep([QD.QDStore, props.itemStore], ([qdStore, itemStore]) => {
		const constraints = QD.selectBaseQueryConstraints(qdStore)
		return {
			addLayersBefore: {
				constraints,
				cursor: LQY.getQueryCursorForQueueIndex(itemStore.index),
			},
			addLayersAfter: {
				constraints,
				cursor: LQY.getQueryCursorForQueueIndex(itemStore.index + 1),
			},
		}
	}, { selectorDeps: [] })

	const layerIds = ZusUtils.useStoreDeep(props.itemStore, state => LL.getAllItemLayerIds(state.item), { dependencies: [] })

	const user = useLoggedInUser()
	return (
		<DropdownMenu open={props.open || !!subDropdownState} onOpenChange={props.setOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuGroup>
					<EditLayerListItemDialogWrapper
						allowVotes={allowVotes}
						open={subDropdownState === 'edit'}
						onOpenChange={(update) => {
							const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
							return setSubDropdownState(open ? 'edit' : null)
						}}
						itemStore={props.itemStore}
					>
						<DropdownMenuItem>Edit</DropdownMenuItem>
					</EditLayerListItemDialogWrapper>
					<DropdownMenuItem
						disabled={props.allowVotes && !!layerId && layerIds?.has(L.swapFactionsInId(layerId))}
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

				<DropdownMenuSeparator />

				<DropdownMenuGroup>
					<SelectLayersDialog
						title="Add layers before"
						description="Select layers to add before"
						open={subDropdownState === 'add-before'}
						onOpenChange={(open) => setSubDropdownState(open ? 'add-before' : null)}
						pinMode={!allowVotes ? 'layers' : undefined}
						selectingSingleLayerQueueItem={true}
						selectQueueItems={(items) => {
							const state = props.listStore.getState()
							state.add(items, props.itemStore.getState().index)
						}}
						layerQueryBaseInput={queryContexts.addLayersBefore}
					>
						<DropdownMenuItem>Add layers before</DropdownMenuItem>
					</SelectLayersDialog>

					<SelectLayersDialog
						title="Add layers after"
						description="Select layers to add after"
						open={subDropdownState === 'add-after'}
						onOpenChange={(open) => setSubDropdownState(open ? 'add-after' : null)}
						pinMode={!allowVotes ? 'layers' : undefined}
						selectQueueItems={(items) => {
							const state = props.listStore.getState()
							state.add(items, props.itemStore.getState().index + 1)
						}}
						layerQueryBaseInput={queryContexts.addLayersAfter}
					>
						<DropdownMenuItem>Add layers after</DropdownMenuItem>
					</SelectLayersDialog>
				</DropdownMenuGroup>

				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={() => {
							if (!user) return
							const item = props.itemStore.getState().item
							const itemIdx = props.listStore.getState().layerList.findIndex((i) => i.itemId === item.itemId)
							props.listStore.getState().move(itemIdx, -1, user.discordId)
						}}
					>
						Send to Front
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							if (!user) return
							const layerList = props.listStore.getState().layerList
							const item = props.itemStore.getState().item
							const itemIdx = layerList.findIndex((i) => i.itemId === item.itemId)
							const lastIdx = layerList.length - 1
							props.listStore.getState().move(itemIdx, lastIdx, user.discordId)
						}}
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
	itemId: string
	isLast: boolean
}) {
	const { isOver, setNodeRef } = DndKit.useDroppable({ id: props.itemId })
	return (
		<Separator
			ref={setNodeRef}
			className="w-full min-w-0 bg-transparent data-[is-last=true]:invisible data-[is-over=true]:bg-secondary-foreground"
			data-is-last={props.isLast && !isOver}
			data-is-over={isOver}
		/>
	)
}

function itemToLayerIds(item: LL.LayerListItem): L.LayerId[] {
	let layers: L.LayerId[]
	if (item.vote) {
		layers = item.vote.choices
	} else if (item.layerId) {
		layers = [item.layerId]
	} else {
		throw new Error('Invalid LayerQueueItem')
	}
	return layers
}
