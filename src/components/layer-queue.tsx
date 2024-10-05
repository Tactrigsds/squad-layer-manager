import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useServerInfo } from '@/hooks/use-server-info'
import * as Helpers from '@/lib/displayHelpers'
import { sleep } from '@/lib/promise'
import { trpc } from '@/lib/trpc'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { produce } from 'immer'
import { EllipsisVertical, GripVertical, PlusIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
	function addEditedQueueIndex(index: number) {
		setEditedQueueIndexes((prev) => [...prev, index])
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
	trpc.watchLayerQueueUpdates.useSubscription(undefined, {
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
	const updateQueueMutation = trpc.updateQueue.useMutation()
	function save() {
		if (!editing || !layerQueue) return
		updateQueueMutation.mutate({
			nowPlaying,
			queue: layerQueue,
			seqId: seqIdRef.current + 1,
		})
	}
	function reset() {
		if (!editing || !layerQueue || !lastUpdateRef.current) return
		setLayerQueue(lastUpdateRef.current.queue)
		setNowPlaying(lastUpdateRef.current.nowPlaying)
		setEditedQueueIndexes([])
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

	function addLayers(addedLayers: M.MiniLayer[]) {
		for (const layer of addedLayers) {
			layersRef.current.set(layer.id, layer)
		}
		setEditedQueueIndexes(
			produce((draft) => {
				for (let i = 0; i < addedLayers.length; i++) {
					draft.push(i + (layerQueue?.length || 0))
				}
			})
		)
		setLayerQueue((existing) => {
			existing ??= []
			existing = existing.concat(addedLayers.map((l) => ({ layerId: l.id, generated: false })))
			return existing
		})
	}
	const [addLayersPopoverOpen, setAddLayersPopoverOpen] = useState(false)

	useEffect(() => {
		console.log('addLayersPopoverOpen changed', addLayersPopoverOpen)
	}, [addLayersPopoverOpen])

	return (
		<LayerQueueContext.Provider value={{ getLayer }}>
			<DndContext onDragEnd={handleDragEnd}>
				<div className="w-full h-full flex space-x-2">
					<div>
						{nowPlaying && <NowPlaying nowPlaying={getLayer(nowPlaying)} />}
						<ScrollArea>
							<ul className="flex flex-col space-y-1 w-max">
								{/* -------- queue items -------- */}
								{layerQueue?.map((item, index) => {
									return (
										<QueueItem
											key={item.layerId + '-'}
											edited={!!editedQueueIndexes.find((idx) => idx === index)}
											item={item}
											index={index}
											isLast={index + 1 === layerQueue.length}
										/>
									)
								})}
							</ul>
						</ScrollArea>
					</div>
					<div className="flex flex-col space-y-2">
						<AddLayerPopover addLayers={addLayers} open={addLayersPopoverOpen} onOpenChange={setAddLayersPopoverOpen}>
							<Button variant="ghost" size="icon">
								<PlusIcon />
							</Button>
						</AddLayerPopover>
						{editing && (
							<Card>
								<CardHeader>
									<CardTitle>Changes pending</CardTitle>
								</CardHeader>
								<CardContent>
									<Button onClick={save}>Save</Button>
									<Button onClick={reset} variant="secondary">
										Cancel
									</Button>
								</CardContent>
							</Card>
						)}
					</div>
				</div>
			</DndContext>
		</LayerQueueContext.Provider>
	)
}

function QueueItem(props: { item: M.LayerQueueItem; index: number; isLast: boolean; edited: boolean }) {
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: props.index,
	})
	const ctx = useContext(LayerQueueContext)

	const style = { transform: CSS.Translate.toString(transform) }
	if (props.item.layerId) {
		const layer = ctx.getLayer(props.item.layerId)
		return (
			<div>
				{props.index === 0 && <QueueItemSeparator afterIndex={-1} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...listeners}
					{...attributes}
					className={
						`px-1 pt-1 pb-2 flex items-center justify-between space-x-2 w-full group ${props.edited ? 'bg-slate-400' : 'bg-background'}  bg-opacity-30 rounded-md` +
						(isDragging ? ' border' : '')
					}
				>
					<div className="flex items-center">
						<Button variant="ghost" size="icon" className="cursor-grab group-hover:visible invisible">
							<GripVertical />
						</Button>
						{Helpers.toShortLevel(layer.Level)} {layer.Gamemode}
					</div>
					<div className="flex items-center min-h-0 space-x-1">
						<span>
							{layer.Faction_1} {Helpers.toShortSubfaction(layer.SubFac_1)} vs {layer.Faction_2}
						</span>
						<span>{Helpers.toShortSubfaction(layer.SubFac_2)})</span>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button className="group-hover:visible invisible" variant="ghost" size="icon">
									<EllipsisVertical />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem>Import Item</DropdownMenuItem>
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

function NowPlaying(props: { nowPlaying: M.MiniLayer }) {
	const serverInfo = useServerInfo()

	return (
		<Card className="w-max">
			<CardContent>
				<div>
					<div className="text-sm">now playing</div> {serverInfo && Helpers.toShortLayerName(serverInfo?.currentLayer)}
				</div>
			</CardContent>
		</Card>
	)
}

function AddLayerPopover(props: {
	children: React.ReactNode
	addLayers: (ids: M.MiniLayer[]) => void
	open: boolean
	onOpenChange: (isOpen: boolean) => void
}) {
	const [filter, setFilter] = useState<Extract<M.EditableFilterNode, { type: 'and' }>>({
		type: 'and',
		children: [
			{ type: 'comp', comp: { code: 'eq', column: 'Level' } },
			{ type: 'comp', comp: { code: 'eq', column: 'Gamemode' } },
			{ type: 'comp', comp: { code: 'eq', column: 'LayerVersion' } },
			{ type: 'comp', comp: { code: 'eq', column: 'Faction_1' } },
			{ type: 'comp', comp: { code: 'eq', column: 'Faction_2' } },
		],
	})

	const validFilter = { ...filter }
	validFilter.children = filter.children.filter((node) => {
		return M.isValidFilterNode(node)
	})

	const shouldQuery = validFilter.children.length > 0

	const res = trpc.getLayers.useQuery(
		{
			pageSize: 15,
			filter: validFilter as M.FilterNode,
			sort: {
				type: 'column',
				sortBy: 'Level',
				sortDirection: 'ASC',
			},
		},
		{
			enabled: shouldQuery,
		}
	)
	const lastDataRef = useRef(res.data)
	useLayoutEffect(() => {
		if (res.data) {
			lastDataRef.current = res.data
		}
	}, [res.data])
	const data = res.data ?? lastDataRef.current

	const layersToDisplay = shouldQuery ? (data?.layers ?? []) : []

	const [height, setHeight] = useState<number | null>(null)
	const contentRef = useRef<HTMLDivElement>(null)
	console.log('height', height)

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
	}

	function addAndClose() {
		props.addLayers(layersToAdd)
		reset()
	}

	function onOpenChange(open: boolean) {
		console.log('on open change: ', open)
		if (open) props.onOpenChange(true)
		else reset()
	}

	useEffect(() => {
		;(async () => {
			await sleep(0)
			if (contentRef.current) {
				setHeight(contentRef.current.getBoundingClientRect().height + 25)
			}
		})()
	}, [props.open])

	return (
		<Popover open={props.open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent className="w-max">
				<div className="flex items-center justify-between">
					<h3 className={Typography.H3}>Add Layers to Queue</h3>
					<div className="flex items-center space-x-1">
						<p className={Typography.P}>{layersToAdd.length} layers selected</p>
						<Button variant="secondary" onClick={() => setLayersToAdd([])}>
							Clear
						</Button>
						<Button disabled={layersToAdd.length === 0 || !props.open} onClick={addAndClose}>
							Add Selected
						</Button>
					</div>
				</div>
				<div ref={contentRef} style={height ? { height } : {}} className="flex items-center space-x-2 min-h-0">
					{/* ------ filter config ------ */}
					<div className="flex flex-col space-y-2">
						{filter.children.map((_node, index) => {
							const setComp = (updateCallback: (prevComp: M.EditableComparison) => M.EditableComparison) => {
								setFilter(
									produce((draft) => {
										const node = draft.children[index] as Extract<M.EditableFilterNode, { type: 'comp' }>
										node.comp = updateCallback(node.comp)
									})
								)
							}

							const node = _node as Extract<M.EditableFilterNode, { type: 'comp' }>
							return (
								<div key={index}>
									<Comparison columnEditable={false} key={index} comp={node.comp} setComp={setComp} />
								</div>
							)
						})}
					</div>
					{/* ------ filter results ------ */}
					<div className="min-w-[300px] h-full">
						{res.isFetching && (
							<div className="flex justify-center items-center h-full">
								<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
							</div>
						)}
						{!res.isFetching && (
							<ScrollArea className="h-full min-h-0 ">
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
												<>
													{index > 0 && <Separator />}
													<button
														className={cn('w-full py-2 text-left', Typography.Small, layerAdded && 'bg-accent')}
														onClick={() => toggleLayerAdded(layer)}
														key={layer.id}
													>
														{Helpers.toShortLayerName(layer)}
													</button>
												</>
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
