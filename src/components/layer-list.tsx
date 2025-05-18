import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useLayerStatuses } from '@/hooks/use-layer-queries.ts'
import * as DH from '@/lib/display-helpers'
import { initMutationState } from '@/lib/item-mutations.ts'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import * as SM from '@/lib/rcon/squad-models.ts'
import * as Text from '@/lib/text'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import { useDragEnd } from '@/systems.client/dndkit.ts'
import { useLoggedInUser } from '@/systems.client/logged-in-user'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as PartsSys from '@/systems.client/parts.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as DndKit from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import deepEqual from 'fast-deep-equal'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import LayerDisplay from './layer-display.tsx'
import LayerFilterMenu, { useFilterMenuStore, useQueryContextWithMenuFilter } from './layer-filter-menu.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'
import { Label } from './ui/label.tsx'
import TabsList from './ui/tabs-list.tsx'

export function LayerList(props: { store: Zus.StoreApi<QD.LLStore>; onStartEdit?: () => void; queryLayerContext: M.LayerQueryContext }) {
	const user = useLoggedInUser()
	const queueIds = ZusUtils.useStoreDeep(props.store, (store) => store.layerList.map((item) => item.itemId))
	const isVoteChoice = Zus.useStore(props.store, store => store.isVoteChoice)
	const allowVotes = !isVoteChoice
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
					allowVotes={allowVotes}
					key={id}
					itemId={id}
					index={index}
					isLast={index + 1 === queueIds.length}
					onStartEdit={props.onStartEdit}
					layerQueryContext={props.queryLayerContext}
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
	layerQueryContext: M.LayerQueryContext
}

function EditLayerListItemDialogWrapper(props: EditLayerQueueItemDialogProps) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0">
				<DragContextProvider>
					<EditLayerListItemDialog {...props} />
				</DragContextProvider>
			</DialogContent>
		</Dialog>
	)
}

export function EditLayerListItemDialog(props: InnerEditLayerListItemDialogProps) {
	const allowVotes = props.allowVotes ?? true

	const initialItem = Zus.useStore(props.itemStore, (s) => s.item)

	const editedItemStore = React.useMemo(() => {
		return Zus.create<QD.LLItemStore>((set, get) =>
			QD.createLLItemStore(set, get, { item: initialItem, mutationState: initMutationState() })
		)
	}, [initialItem])
	const editedItem = Zus.useStore(editedItemStore, (s) => s.item)

	const editedVoteChoiceStore = QD.useVoteChoiceStore(editedItemStore)

	const loggedInUser = useLoggedInUser()

	const [addLayersOpen, setAddLayersOpen] = React.useState(false)

	const unvalidatedLayer = editedItem.layerId ? M.getUnvalidatedLayerFromId(editedItem.layerId) : undefined
	const filterMenuStore = useFilterMenuStore(unvalidatedLayer ? M.getLayerDetailsFromUnvalidated(unvalidatedLayer) : undefined)

	const canSubmit = Zus.useStore(
		editedItemStore,
		(s) => !deepEqual(initialItem, s.item) && (!s.item.vote || s.item.vote.choices.length > 0),
	)
	function submit() {
		if (!canSubmit) return
		props.onOpenChange(false)
		props.itemStore.getState().setItem(editedItem)
	}
	const numChoices = Zus.useStore(editedVoteChoiceStore, s => s.layerList.length)

	const queryContextWithMenuFilter = useQueryContextWithMenuFilter(props.layerQueryContext, filterMenuStore)
	const addVoteQueryContext = QD.useDerivedQueryContextForLQIndex(numChoices, props.layerQueryContext, editedVoteChoiceStore)
	const [poolApplyAs, setPoolApplyAs] = Zus.useStore(QD.QDStore, useShallow(s => [s.poolApplyAs, s.setPoolApplyAs]))
	const hideFiltered = poolApplyAs.filter === 'where-condition'
	const setHideFiltered = React.useCallback((hideFiltered: boolean) => {
		const applyAs = hideFiltered ? 'where-condition' : 'field'
		setPoolApplyAs('filter', applyAs)
		setPoolApplyAs('dnr', applyAs)
	}, [setPoolApplyAs])
	const hideFilteredId = React.useId()

	if (!props.allowVotes && editedItem.vote) throw new Error('Invalid queue item')

	return (
		<div className="w-full h-full">
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<DialogTitle>Edit</DialogTitle>
					<div className="mx-8 font-light">-</div>
					<DialogDescription>Change the layer or vote choices for this queue item.</DialogDescription>
				</div>
				<div className="flex items-center space-x-2">
					{allowVotes && (
						<TabsList
							options={[
								{ label: 'Vote', value: 'vote' },
								{ label: 'Set Layer', value: 'layer' },
							]}
							active={editedItem.vote ? 'vote' : 'layer'}
							setActive={(itemType) => {
								editedItemStore.getState().setItem((prev) => {
									const selectedLayerIds = itemToLayerIds(prev)
									const layerSource: M.LayerSource = { type: 'manual', userId: loggedInUser!.discordId }
									if (itemType === 'vote') {
										return {
											itemId: prev.itemId,
											vote: {
												choices: selectedLayerIds,
												defaultChoice: selectedLayerIds[0],
											},
											source: layerSource,
										}
									} else if (itemType === 'layer') {
										return {
											itemId: prev.itemId,
											layerId: selectedLayerIds[0],
											source: layerSource,
										}
									} else {
										assertNever(itemType)
									}
								})
							}}
						/>
					)}
				</div>
			</DialogHeader>

			{editedItem.vote
				? (
					<div className="flex flex-col">
						<div className="flex w-min"></div>
						<LayerList store={editedVoteChoiceStore} queryLayerContext={props.layerQueryContext} />
					</div>
				)
				: (
					<div className="flex items-start space-x-2 min-h-0">
						<LayerFilterMenu queryContext={props.layerQueryContext} filterMenuStore={filterMenuStore} />
						<TableStyleLayerPicker
							queryContext={queryContextWithMenuFilter}
							maxSelected={1}
							selected={[editedItem.layerId!]}
							onSelect={(update) => {
								const id = (typeof update === 'function' ? update([]) : update)[0]
								if (!id) return
								return editedItemStore.getState().setItem((prev) => ({ ...prev, layerId: id }))
							}}
							extraPanelItems={<PoolCheckboxes />}
						/>
					</div>
				)}

			<DialogFooter>
				{editedItem.vote && (
					<SelectLayersDialog
						title="Add"
						description="Select layers to add to the voting pool"
						open={addLayersOpen}
						pinMode="layers"
						onOpenChange={setAddLayersOpen}
						layerQueryContext={addVoteQueryContext}
						selectQueueItems={(items) => {
							editedVoteChoiceStore.getState().add(items)
						}}
					>
						<DropdownMenuItem>Add layers</DropdownMenuItem>
					</SelectLayersDialog>
				)}
				<Button disabled={!canSubmit} onClick={submit}>
					Submit
				</Button>
			</DialogFooter>
		</div>
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
		item: M.LayerListItem
	}
	| {
		code: 'delete'
		id: string
	}
	| {
		code: 'add-after' | 'add-before'
		items: M.LayerListItem[]
		id?: string
	}

function getIndexFromQueueItemId(items: M.LayerListItem[], id: string | null) {
	if (id === null) return -1
	return items.findIndex((item) => item.itemId === id)
}

type QueueItemProps = {
	index: number
	isLast: boolean
	allowVotes?: boolean
	itemId: string
	llStore: Zus.StoreApi<QD.LLStore>
	onStartEdit?: () => void
	layerQueryContext: M.LayerQueryContext
}

function LayerListItem(props: QueueItemProps) {
	const itemStore = React.useMemo(() => QD.deriveLLItemStore(props.llStore, props.itemId), [props.llStore, props.itemId])
	const allowVotes = props.allowVotes ?? true
	const item = Zus.useStore(itemStore, (s) => s.item)
	const [canEdit, isEditing] = Zus.useStore(QD.QDStore, useShallow((s) => [s.canEditQueue, s.isEditing]))
	const draggableItemId = QD.toDraggableItemId(item.itemId)
	const { attributes, listeners, setNodeRef, transform, isDragging } = DndKit.useDraggable({
		id: draggableItemId,
	})

	const currentMatch = MatchHistoryClient.useCurrentMatchDetails()
	const normTeamOffset = currentMatch ? SM.getNormTeamOffsetForQueueIndex(currentMatch, props.index) : undefined

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = (update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}

	const layerQueryContext = QD.useDerivedQueryContextForLQIndex(props.index, props.layerQueryContext, props.llStore)
	const style = { transform: CSS.Translate.toString(transform) }
	const itemDropdown = (
		<ItemDropdown
			allowVotes={allowVotes}
			index={props.index}
			open={dropdownOpen && canEdit}
			setOpen={setDropdownOpen}
			listStore={props.llStore}
			itemStore={itemStore}
			onStartEdit={props.onStartEdit}
			layerQueryContext={layerQueryContext}
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
	const serverStatus = SquadServerClient.useSquadServerStatus()
	let squadServerNextLayer: M.UnvalidatedMiniLayer | null = null
	if (serverStatus?.code === 'ok') squadServerNextLayer = serverStatus?.data.nextLayer ?? null

	const activeUnvalidatedLayer = M.getUnvalidatedLayerFromId(M.getActiveItemLayerId(item))

	if (
		!isEditing && squadServerNextLayer && props.index === 0 && !M.isLayerIdPartialMatch(activeUnvalidatedLayer.id, squadServerNextLayer.id)
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
	const indexElt = <span className="mr-2 font-light">{props.index + 1}.</span>

	if (item.vote) {
		return (
			<>
				{props.index === 0 && <QueueItemSeparator itemId={QD.toDraggableItemId(null)} isLast={false} />}
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
											itemId={props.itemId}
											layerId={choice}
											isVoteChoice={true}
											badges={badges}
											normTeamOffset={normTeamOffset}
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
		return (
			<>
				{props.index === 0 && <QueueItemSeparator itemId={QD.toDraggableItemId(null)} isLast={false} />}
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
							<LayerDisplay layerId={item.layerId} itemId={item.itemId} normTeamOffset={normTeamOffset} />
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
	index: number
	open: boolean
	setOpen: React.Dispatch<React.SetStateAction<boolean>>
	itemStore: Zus.StoreApi<QD.LLItemStore>
	listStore: Zus.StoreApi<QD.LLStore>
	allowVotes?: boolean
	layerQueryContext: M.LayerQueryContext
	onStartEdit?: () => void
}) {
	const allowVotes = props.allowVotes ?? true

	type SubDropdownState = 'add-before' | 'add-after' | 'edit' | null
	const [subDropdownState, _setSubDropdownState] = React.useState(null as SubDropdownState)

	function setSubDropdownState(state: SubDropdownState) {
		if (state === null) props.setOpen(false)
		props.onStartEdit?.()
		_setSubDropdownState(state)
	}

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
						layerQueryContext={props.layerQueryContext}
					>
						<DropdownMenuItem>Edit</DropdownMenuItem>
					</EditLayerListItemDialogWrapper>
					<DropdownMenuItem
						onClick={() => {
							const id = props.itemStore.getState().item.itemId
							props.listStore.getState().remove(id)
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
							state.add(items, props.index)
						}}
						layerQueryContext={props.layerQueryContext}
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
							state.add(items, props.index + 1)
						}}
						layerQueryContext={props.layerQueryContext}
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

function itemToLayerIds(item: M.LayerListItem): M.LayerId[] {
	let layers: M.LayerId[]
	if (item.vote) {
		layers = item.vote.choices
	} else if (item.layerId) {
		layers = [item.layerId]
	} else {
		throw new Error('Invalid LayerQueueItem')
	}
	return layers
}
