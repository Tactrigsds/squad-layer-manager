import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as Helpers from '@/lib/display-helpers'
import * as FB from '@/lib/filterBuilders.ts'
import { sleep } from '@/lib/promise'
import { trpcReact } from '@/lib/trpc.client.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { produce } from 'immer'
import { EllipsisVertical, GripVertical, PlusIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import React from 'react'

import { Comparison } from './filter-card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Separator } from './ui/separator'

const LayerQueueContext = createContext<{ getLayer: (layerId: string) => M.MiniLayer }>({ getLayer: () => null as unknown as M.MiniLayer })

export default function LayerQueue() {
	const [layerQueue, setLayerQueue] = useState(null as null | M.LayerQueue)
	const [nowPlaying, setNowPlaying] = useState(null as M.LayerQueueUpdate['nowPlaying'])
	// TODO could use linked list model for editing so we can effectively diff it
	const [editedQueueIndexes, setEditedQueueIndexes] = useState([] as number[])
	const [deletedItemCount, setDeletedItemCount] = useState(0)
	function addEditedQueueIndex(index: number) {
		setEditedQueueIndexes((prev) => (!prev.includes(index) ? [...prev, index] : prev))
	}
	// const serverInfo = useServerInfo()

	const lastUpdateRef = useRef(null as null | M.LayerQueueUpdate)
	const seqIdRef = useRef(-1)
	const editing = editedQueueIndexes.length > 0

	const layersRef = useRef(new Map<string, M.MiniLayer>())
	function getLayer(layerId: string) {
		const layer = layersRef.current.get(layerId)!
		if (!layer) throw new Error(`Layer ${layerId} not found`)
		return layer
	}
	trpcReact.watchLayerQueueUpdates.useSubscription(undefined, {
		onData: ({ data }) => {
			setLayerQueue(data.queue)
			setNowPlaying(data.nowPlaying)
			setEditedQueueIndexes([])
			lastUpdateRef.current = data
			seqIdRef.current = data.seqId
			for (const layer of data.layers) {
				layersRef.current.set(layer.id, layer)
			}
		},
	})
	const updateQueueMutation = trpcReact.updateQueue.useMutation()
	function save() {
		if (!editing || !layerQueue) return
		updateQueueMutation.mutate({
			nowPlaying,
			queue: layerQueue,
			seqId: seqIdRef.current,
		})
	}
	function reset() {
		if (!editing || !layerQueue || !lastUpdateRef.current) return
		setLayerQueue(lastUpdateRef.current.queue)
		setNowPlaying(lastUpdateRef.current.nowPlaying)
		setEditedQueueIndexes([])
		setDeletedItemCount(0)
	}

	function handleDragEnd(event: DragEndEvent) {
		if (!event.over) return
		const sourceIndex = event.active.id as number
		const targetIndex = event.over.id as number
		if (sourceIndex === targetIndex || targetIndex + 1 === sourceIndex) return
		setLayerQueue(
			produce((draft) => {
				let insertIndex = targetIndex + 1
				if (!draft) throw new Error('layerQueue is null')
				const [removed] = draft.splice(sourceIndex, 1)
				if (insertIndex > sourceIndex) insertIndex--
				draft.splice(insertIndex, 0, removed)
				addEditedQueueIndex(insertIndex)
			})
		)
	}

	function addLayers(addedLayers: M.MiniLayer[], index?: number) {
		index ??= layerQueue!.length
		for (const layer of addedLayers) {
			layersRef.current.set(layer.id, layer)
		}
		setEditedQueueIndexes(
			produce((draft) => {
				for (let i = 0; i < addedLayers.length; i++) {
					if (draft.includes(i + index)) continue
					draft.push(i + index)
				}
			})
		)
		setLayerQueue((existing) => {
			existing ??= []
			const newItems = addedLayers.map((l) => ({ layerId: l.id, generated: false }))
			return [...existing.slice(0, index), ...newItems, ...existing.slice(index)]
		})
	}
	const [addLayersPopoverOpen, setAddLayersPopoverOpen] = useState(false)

	return (
		<div className="grid place-items-center">
			<LayerQueueContext.Provider value={{ getLayer }}>
				<DndContext onDragEnd={handleDragEnd}>
					<Card className="flex flex-col w-max">
						<div className="p-6 w-full flex justify-between">
							<h3 className={Typography.H3}>Layer Queue</h3>
							<AddLayerPopover addLayers={addLayers} open={addLayersPopoverOpen} onOpenChange={setAddLayersPopoverOpen}>
								<Button className="space-x-1 flex items-center w-min" variant="default">
									<PlusIcon />
									<span>Add Layers</span>
								</Button>
							</AddLayerPopover>
						</div>
						<CardContent className="flex space-x-4">
							<div>
								{/* ------- top card ------- */}
								<Card>
									{!editing && nowPlaying && (
										<>
											<CardHeader>
												<CardTitle>Now Playing</CardTitle>
											</CardHeader>
											<CardContent>{Helpers.toShortLayerName(getLayer(nowPlaying))}</CardContent>
										</>
									)}
									{!editing && !nowPlaying && <p className={Typography.P}>No active layer found</p>}
									{editing && (
										<div className="flex flex-col space-y-2">
											<Card>
												<CardHeader>
													<CardTitle>Changes pending</CardTitle>
													<CardDescription>
														{editedQueueIndexes.length} items edited, {deletedItemCount} items deleted
													</CardDescription>
												</CardHeader>
												<CardContent>
													<Button onClick={save}>Save</Button>
													<Button onClick={reset} variant="secondary">
														Cancel
													</Button>
												</CardContent>
											</Card>
										</div>
									)}
								</Card>

								<h4 className={Typography.H4}>Up Next</h4>
								<ScrollArea>
									<ul className="flex flex-col space-y-1 w-max">
										{/* -------- queue items -------- */}
										{layerQueue?.map((item, index) => {
											function dispatch(action: QueueItemAction) {
												if (action.code === 'delete') {
													setLayerQueue((existing) => {
														if (!existing) throw new Error('layerQueue is null')
														const newQueue = existing.filter((_, i) => i !== index)
														return newQueue
													})
													setEditedQueueIndexes((prev) => {
														const newIndexes = prev.filter((idx) => idx !== index)
														return newIndexes.map((idx) => (idx > index ? idx - 1 : idx))
													})
													setDeletedItemCount((prev) => prev + 1)
												} else if (action.code === 'swap-factions') {
													setLayerQueue((existing) => {
														return existing!.map((currentItem) => {
															if (currentItem.layerId && currentItem.layerId === item!.layerId) {
																return { ...currentItem, layerId: M.swapFactionsInId(currentItem.layerId) }
															}
															return currentItem
														})
													})
													addEditedQueueIndex(index)
												} else if (action.code === 'add-after') {
													addLayers(action.layers, index + 1)
												}
											}
											return (
												<QueueItem
													key={item.layerId + '-' + index}
													edited={editedQueueIndexes.some((idx) => idx === index)}
													item={item}
													index={index}
													isLast={index + 1 === layerQueue.length}
													dispatch={dispatch}
												/>
											)
										})}
									</ul>
								</ScrollArea>
							</div>
						</CardContent>
					</Card>
				</DndContext>
			</LayerQueueContext.Provider>
		</div>
	)
}

type QueueItemAction =
	| {
			code: 'swap-factions' | 'delete'
	  }
	| {
			code: 'add-after' | 'add-before'
			layers: M.MiniLayer[]
	  }

function QueueItem(props: {
	item: M.LayerQueueItem
	index: number
	isLast: boolean
	edited: boolean
	dispatch: React.Dispatch<QueueItemAction>
}) {
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: props.index,
	})
	const ctx = useContext(LayerQueueContext)
	const [addAfterPopoverOpen, _setAddAfterPopoverOpen] = useState(false)
	const [addBeforePopoverOpen, _setAddBeforePopoverOpen] = useState(false)
	const [dropdownOpen, _setDropdownOpen] = useState(false)

	function setAddAfterPopoverOpen(open: boolean) {
		if (!open) _setDropdownOpen(false)
		_setAddAfterPopoverOpen(open)
	}

	function setAddBeforePopoverOpen(open: boolean) {
		if (!open) _setDropdownOpen(false)
		_setAddBeforePopoverOpen(open)
	}

	function setDropdownOpen(open: boolean) {
		const popoversOpen = addAfterPopoverOpen || addBeforePopoverOpen
		if (popoversOpen) return
		_setDropdownOpen(open)
	}

	const style = { transform: CSS.Translate.toString(transform), scale: isDragging ? 5 : 1 }
	if (props.item.layerId) {
		const layer = ctx.getLayer(props.item.layerId)
		return (
			<div>
				{props.index === 0 && <QueueItemSeparator afterIndex={-1} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={`px-1 pt-1 pb-2 flex items-center justify-between space-x-2 w-full group ${props.edited ? 'bg-slate-400' : 'bg-background'}  bg-opacity-30 rounded-md ${isDragging ? ' border' : ''}`}
				>
					<div className="flex items-center">
						<Button {...listeners} variant="ghost" size="icon" className="cursor-grab group-hover:visible invisible">
							<GripVertical />
						</Button>
						{Helpers.toShortLevel(layer.Level)} {layer.Gamemode} {layer.LayerVersion || ''}
					</div>
					<div className="flex items-center min-h-0 space-x-1">
						<span>
							{layer.Faction_1} {Helpers.toShortSubfaction(layer.SubFac_1)} vs {layer.Faction_2}
						</span>
						<span>{Helpers.toShortSubfaction(layer.SubFac_2)})</span>
						<DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
							<DropdownMenuTrigger asChild>
								<Button className="group-hover:visible invisible" variant="ghost" size="icon">
									<EllipsisVertical />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem onClick={() => props.dispatch({ code: 'swap-factions' })}>Swap Factions</DropdownMenuItem>

								{/* ------ Add Layer Before ------ */}
								<AddLayerPopover
									open={addBeforePopoverOpen}
									onOpenChange={setAddBeforePopoverOpen}
									addLayers={(layers) => {
										props.dispatch({ code: 'add-before', layers })
									}}
								>
									<DropdownMenuItem>Add layers before</DropdownMenuItem>
								</AddLayerPopover>

								{/* ------ Add Layer After ------ */}
								<AddLayerPopover
									open={addAfterPopoverOpen}
									onOpenChange={setAddAfterPopoverOpen}
									addLayers={(layers) => {
										props.dispatch({ code: 'add-after', layers })
									}}
								>
									<DropdownMenuItem>Add layers after</DropdownMenuItem>
								</AddLayerPopover>

								<DropdownMenuItem
									onClick={() => {
										return props.dispatch({ code: 'delete' })
									}}
									className="bg-destructive focus:bg-red-600 text-destructive-foreground"
								>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</li>
				<QueueItemSeparator afterIndex={props.index} isLast={props.isLast} />
			</div>
		)
	}
	throw new Error('TODO implement')
}

function QueueItemSeparator(props: { afterIndex: number; isLast: boolean }) {
	const { isOver, setNodeRef } = useDroppable({ id: props.afterIndex })
	return (
		<Separator
			ref={setNodeRef}
			className={'w-full min-w-0' + (isOver ? ' bg-green-400' : '') + (props.isLast && !isOver ? ' invisible' : '')}
		/>
	)
}

const DEFAULT_ADD_LAYER_FILTERS = {
	type: 'and',
	children: [
		{ type: 'comp', comp: { code: 'eq', column: 'Level' } },
		{ type: 'comp', comp: { code: 'eq', column: 'Gamemode' } },
		{ type: 'comp', comp: { code: 'eq', column: 'LayerVersion' } },
		{ type: 'comp', comp: { code: 'eq', column: 'Faction_1' } },
		{ type: 'comp', comp: { code: 'eq', column: 'SubFac_1' } },
		{ type: 'comp', comp: { code: 'eq', column: 'Faction_2' } },
		{ type: 'comp', comp: { code: 'eq', column: 'SubFac_2' } },
		{ type: 'comp', comp: { code: 'eq', column: 'id' } },
	],
} satisfies Extract<M.EditableFilterNode, { type: 'and' }>

function AddLayerPopover(props: {
	children: React.ReactNode
	addLayers: (ids: M.MiniLayer[]) => void
	open: boolean
	onOpenChange: (isOpen: boolean) => void
}) {
	const [filter, setFilter] = useState(DEFAULT_ADD_LAYER_FILTERS)

	const filterStates = filter.children.map((f) => f.type === 'comp' && M.isValidComparison(f.comp))
	const validFilter = filterStates.includes(true)
		? FB.and(...(filter.children.filter((f) => f.type === 'comp' && M.isValidComparison(f.comp)) as M.FilterNode[]))
		: undefined
	const shouldQuery = filterStates.includes(true)
	const seedRef = useRef(Math.ceil(Math.random() * Number.MAX_SAFE_INTEGER))
	//
	const res = trpcReact.getLayers.useQuery(
		{
			filter: validFilter,
			groupBy: ['id', 'Level', 'Gamemode', 'LayerVersion', 'Faction_1', 'SubFac_1', 'Faction_2', 'SubFac_2'],
			pageSize: 25,
			sort: {
				type: 'random',
				seed: seedRef.current,
			},
		},
		{
			enabled: shouldQuery,
			// TODO I would like to do state upstates which hook into query results before rerender, to do state updates like resetting filters if their current value is not part of the filter.
			// behavior: {
			// 	onFetch: (context, query) => {
			// 		console.log('onFetch', { context, query })
			// 	},
			// },
		}
	)
	const lastDataRef = useRef(res.data)
	useLayoutEffect(() => {
		if (res.data) {
			lastDataRef.current = res.data
		}
	}, [res.data, res.isError])

	const data = res.data ?? lastDataRef.current

	const layersToDisplay = data?.layers

	const [height, setHeight] = useState<number | null>(null)
	const contentRef = useRef<HTMLDivElement>(null)

	const [layersToAdd, setLayersToAdd] = useState<M.MiniLayer[]>([])
	function toggleLayerAdded(layerToAdd: M.MiniLayer) {
		setLayersToAdd((prevLayers) => {
			if (prevLayers.some((l) => l.id === layerToAdd.id)) {
				return prevLayers.filter((layer) => layer.id !== layerToAdd.id)
			} else {
				return [...prevLayers, layerToAdd]
			}
		})
	}

	function reset() {
		props.onOpenChange(false)
		setLayersToAdd([])
		setFilter(DEFAULT_ADD_LAYER_FILTERS)
		lastDataRef.current = undefined
	}

	function addAndClose() {
		props.addLayers(layersToAdd)
		reset()
	}

	function onOpenChange(open: boolean) {
		if (open) props.onOpenChange(true)
		else reset()
	}

	useEffect(() => {
		if (!props.open) return
		;(async () => {
			await sleep(0)
			if (contentRef.current) {
				setHeight(contentRef.current.getBoundingClientRect().height + 25)
			}
		})()
	}, [props.open])

	function swapFactions() {
		setFilter(
			produce((draft) => {
				let faction1Index!: number
				let faction2Index!: number
				let subFac1Index!: number
				let subFac2Index!: number

				for (let i = 0; i < draft.children.length; i++) {
					const node = draft.children[i]
					if (node.comp.column === 'Faction_1') {
						faction1Index = i
					}
					if (node.comp.column === 'Faction_2') {
						faction2Index = i
					}
					if (node.comp.column === 'SubFac_1') {
						subFac1Index = i
					}
					if (node.comp.column === 'SubFac_2') {
						subFac2Index = i
					}
				}

				const faction1 = { ...draft.children[faction1Index].comp }
				const subFac1 = { ...draft.children[subFac1Index].comp }

				draft.children[faction1Index].comp = { ...draft.children[faction2Index].comp, column: 'Faction_1' }
				draft.children[subFac1Index].comp = { ...draft.children[subFac2Index].comp, column: 'SubFac_1' }
				draft.children[faction2Index].comp = { ...faction1, column: 'Faction_2' }
				draft.children[subFac2Index].comp = { ...subFac1, column: 'SubFac_2' }
			})
		)
	}

	return (
		<Popover open={props.open} modal={true} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent side="bottom" className="w-max">
				<div className="flex items-center justify-between">
					<h3 className={Typography.H3}>Add Layers to Queue</h3>
					<div className="flex items-center space-x-1">
						<p className={Typography.P}>{layersToAdd.length} layers selected</p>
						<Button disabled={layersToAdd.length === 0 || !props.open} variant="secondary" onClick={() => setLayersToAdd([])}>
							Clear
						</Button>
						<Button disabled={layersToAdd.length === 0 || !props.open} onClick={addAndClose}>
							Add Selected
						</Button>
					</div>
				</div>
				<div ref={contentRef} style={height ? { height } : {}} className="flex items-center space-x-2 min-h-0">
					{/* ------ filter config ------ */}
					<div className="grid grid-cols-[auto_min-content_auto] gap-2">
						{filter.children.map((_node, index) => {
							const setComp = (updateCallback: (prevComp: M.EditableComparison) => M.EditableComparison) => {
								setFilter(
									produce((draft) => {
										const node = draft.children[index] as Extract<M.EditableFilterNode, { type: 'comp' }>
										node.comp = updateCallback(node.comp)
									})
								)
							}
							const appliedFilters: M.FilterNode[] | undefined = []
							for (let i = 0; i < index; i++) {
								if (!filterStates[i]) continue
								appliedFilters.push(filter.children[i] as M.FilterNode)
							}
							const autocompleteFilter = appliedFilters.length === 0 ? undefined : FB.and(...appliedFilters)
							const node = _node as Extract<M.EditableFilterNode, { type: 'comp' }>
							return (
								<React.Fragment key={index}>
									{node.comp.column === 'Faction_2' && (
										<>
											<span />
											<Button onClick={swapFactions} variant="outline">
												Swap Factions
											</Button>
											<span />
										</>
									)}
									{(node.comp.column === 'id' || node.comp.column === 'Faction_1') && (
										<>
											<Separator className="col-span-3" />
										</>
									)}
									<Comparison columnEditable={false} comp={node.comp} setComp={setComp} valueAutocompleteFilter={autocompleteFilter} />
								</React.Fragment>
							)
						})}
					</div>
					{/* ------ filter results ------ */}
					<div className="min-w-[300px] h-full">
						{layersToDisplay && (
							<ScrollArea className={`h-full min-h-0`}>
								<div className="h-full min-h-0 text-xs">
									{!res.isFetchedAfterMount && layersToDisplay.length === 0 && (
										<div className="p-2 text-sm text-gray-500">Set filter to see results</div>
									)}
									{res.isFetchedAfterMount && layersToDisplay.length === 0 && (
										<div className="p-2 text-sm text-gray-500">No results found</div>
									)}
									{layersToDisplay.length > 0 &&
										layersToDisplay.map((layer, index) => {
											const layerAdded = layersToAdd.includes(layer)
											return (
												<React.Fragment key={layer.id}>
													{index > 0 && <Separator />}
													<button
														className={cn('w-full py-2 text-left', Typography.Small, layerAdded && 'bg-accent')}
														onClick={() => toggleLayerAdded(layer)}
													>
														{Helpers.toShortLayerName(layer)}
													</button>
												</React.Fragment>
											)
										})}
								</div>
							</ScrollArea>
						)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
