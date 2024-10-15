import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { sleepUntil } from '@/lib/async'
import * as Helpers from '@/lib/display-helpers'
import * as FB from '@/lib/filter-builders.ts'
import { trpcReact } from '@/lib/trpc.client.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { produce } from 'immer'
import * as diffpatch from 'jsondiffpatch'
import { EllipsisVertical, GripVertical, PlusIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import React from 'react'

import AddLayerPopover from './add-layer-popover'
import ComboBox from './combo-box'
import * as CB from './combo-box'
import { Comparison } from './filter-card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Separator } from './ui/separator'

const LayerQueueContext = createContext<{ getLayer: (layerId: string) => M.MiniLayer }>({ getLayer: () => null as unknown as M.MiniLayer })

export default function LayerQueue() {
	const [layerQueue, setLayerQueue] = useState(null as null | M.LayerQueue)
	const [nowPlaying, setNowPlaying] = useState(null as M.ServerState['nowPlaying'])
	const [poolFilterId, setPoolFilterId] = useState(null as M.ServerState['poolFilterId'])
	// TODO could use linked list model for editing so we can effectively diff it

	const lastUpdateRef = useRef(null as null | M.ServerState)
	const seqIdRef = useRef(-1)
	const poolFilterEdited = !!lastUpdateRef.current && lastUpdateRef.current.poolFilterId !== poolFilterId
	function updatePoolFilter(filterId: M.ServerState['poolFilterId']) {
		setPoolFilterId(filterId)
	}
	const queueDiff: ArrayDelta | undefined =
		lastUpdateRef.current && layerQueue ? differ.diff(lastUpdateRef.current.queue, layerQueue) : undefined
	if (queueDiff) console.log(queueDiff)
	// const editing = queueDiff && !queueDiff.some((change) => change.added || change.removed)
	const editing = !!queueDiff

	const layersRef = useRef(new Map<string, M.MiniLayer>())
	function getLayer(layerId: string) {
		const layer = layersRef.current.get(layerId)!
		if (!layer) throw new Error(`Layer ${layerId} not found`)
		return layer
	}
	trpcReact.watchServerUpdates.useSubscription(undefined, {
		onData: ({ data }) => {
			setLayerQueue(data.queue)
			setNowPlaying(data.nowPlaying)
			setPoolFilterId(data.poolFilterId)
			lastUpdateRef.current = data
			seqIdRef.current = data.seqId
			for (const layer of data.layers) {
				layersRef.current.set(layer.id, layer)
			}
		},
	})
	const updateQueueMutation = trpcReact.updateQueue.useMutation()
	function save() {
		if (!editing || !layerQueue || !lastUpdateRef.current) return
		updateQueueMutation.mutate({
			nowPlaying,
			queue: layerQueue,
			seqId: seqIdRef.current,
			poolFilterId: lastUpdateRef.current.poolFilterId,
		})
	}
	function reset() {
		if (!editing || !layerQueue || !lastUpdateRef.current) return
		setLayerQueue(lastUpdateRef.current.queue)
		setNowPlaying(lastUpdateRef.current.nowPlaying)
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
			})
		)
	}

	function addLayers(addedLayers: M.MiniLayer[], index?: number) {
		index ??= layerQueue!.length
		for (const layer of addedLayers) {
			layersRef.current.set(layer.id, layer)
		}
		setLayerQueue((existing) => {
			existing ??= []
			const newItems = addedLayers.map((l) => ({ layerId: l.id, generated: false }))
			return [...existing.slice(0, index), ...newItems, ...existing.slice(index)]
		})
	}
	const [addLayersPopoverOpen, setAddLayersPopoverOpen] = useState(false)
	// we could be more sophisticated with the kind of diffing info we display
	// https://github.com/benjamine/jsondiffpatch
	let addedItemCount = 0
	let editedItemCount = 0
	let movedItemCount = 0
	let deletedItemCount = 0

	if (queueDiff) {
		for (const [k, v] of Object.entries(queueDiff)) {
			if (!k.startsWith('_') && v instanceof Array) {
				addedItemCount++
				continue
			}
			if (!k.startsWith('_') && typeof v === 'object') {
				editedItemCount++
				continue
			}
			if (k.startsWith('_') && v[0] === '') {
				movedItemCount++
				continue
			}

			if (k.startsWith('_') && typeof v[0] === 'object') {
				deletedItemCount++
				continue
			}
		}
	}

	return (
		<div className="grid place-items-center">
			<LayerQueueContext.Provider value={{ getLayer }}>
				<span className="flex space-x-4">
					{/*
					<pre>
						<code>{JSON.stringify(lastUpdateRef.current?.queue, null, 2)}</code>
					</pre>
					<pre>
						<code>{JSON.stringify(queueDiff, null, 2)}</code>
					</pre>
					<pre>
						<code>{JSON.stringify(layerQueue, null, 2)}</code>
					</pre>
					*/}
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
															{addedItemCount} added, {movedItemCount} moved, {editedItemCount} edited, {deletedItemCount} deleted
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
													} else if (action.code === 'swap-factions') {
														setLayerQueue((existing) => {
															return existing!.map((currentItem) => {
																if (currentItem.layerId && currentItem.layerId === item!.layerId) {
																	return { ...currentItem, layerId: M.swapFactionsInId(currentItem.layerId) }
																}
																return currentItem
															})
														})
													} else if (action.code === 'add-after') {
														addLayers(action.layers, index + 1)
													}
												}
												let edited = false
												if (queueDiff) {
													if (queueDiff[index.toString()]) edited = true
													for (const [k, v] of Object.entries(queueDiff)) {
														if (!v) continue
														//@ts-expect-error idk
														if (k.startsWith('_') && v[0] === '' && v[1] === index) {
															edited = true
															break
														}
													}
												}
												return (
													<QueueItem
														key={item.layerId + '-' + index}
														edited={edited}
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
					<PoolConfigurationPanel poolFilterId={poolFilterId} poolFilterEdited={poolFilterEdited} updateFilter={updatePoolFilter} />
				</span>
			</LayerQueueContext.Provider>
		</div>
	)
}

function PoolConfigurationPanel(props: {
	poolFilterId: M.ServerState['poolFilterId']
	poolFilterEdited: boolean
	updateFilter: (filter: M.ServerState['poolFilterId']) => void
}) {
	const filtersRes = trpcReact.getFilters.useQuery()
	const filterOptions = filtersRes.data?.map((f) => ({ value: f.id, label: f.name }))
	const selected = props.poolFilterId
	return (
		<Card className="">
			<CardHeader>
				<CardTitle>Pool Configuration</CardTitle>
			</CardHeader>
			<CardContent>
				<ComboBox title="Pool Filter" options={filterOptions ?? CB.LOADING} value={selected} onSelect={props.updateFilter} />
			</CardContent>
		</Card>
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

const differ = diffpatch.create({ arrays: { detectMove: true, includeValueOnMove: false } })
