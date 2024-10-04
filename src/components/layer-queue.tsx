import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as Helpers from '@/displayHelpers'
import { useServerInfo } from '@/hooks/use-server-info'
import { trpc } from '@/lib/trpc'
import * as M from '@/models'
import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { produce } from 'immer'
import { EllipsisVertical, GripVertical } from 'lucide-react'
import { createContext, useContext, useRef, useState } from 'react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Separator } from './ui/separator'

const LayerQueueContext = createContext<{ getLayer: (layerId: string) => M.MiniLayer }>({ getLayer: () => null as unknown as M.MiniLayer })

export default function LayerQueue() {
	const [layerQueue, setLayerQueue] = useState(null as null | M.LayerQueue)
	const [nowPlaying, setNowPlaying] = useState(null as M.LayerQueueUpdate['nowPlaying'])
	// const serverInfo = useServerInfo()

	const lastUpdateRef = useRef(null as null | M.LayerQueueUpdate)
	const seqIdRef = useRef(-1)
	const editedQueueIndexes: number[] = []
	if (layerQueue && lastUpdateRef.current) {
		for (let i = 0; i < layerQueue.length; i++) {
			const item = layerQueue[i]
			if (item.layerId && item.layerId !== lastUpdateRef.current.queue[i].layerId) {
				editedQueueIndexes.push(i)
			}
		}
	}
	const editing = editedQueueIndexes.length === 0

	const layersRef = useRef(new Map<string, M.MiniLayer>())
	function getLayer(layerId: string) {
		return layersRef.current.get(layerId)!
	}
	trpc.watchLayerQueueUpdates.useSubscription(undefined, {
		onData: ({ data }) => {
			setLayerQueue(data.queue)
			setNowPlaying(data.nowPlaying)
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
	}
	function handleDragEnd(event: DragEndEvent) {
		if (!event.over) return
		const sourceIndex = event.active.id as number
		const targetIndex = event.over.id as number
		setLayerQueue(
			produce((draft) => {
				if (!draft) throw new Error('layerQueue is null')
				const [removed] = draft.splice(sourceIndex, 1)
				draft.splice(targetIndex + 1, 0, removed)
			})
		)
	}

	return (
		<LayerQueueContext.Provider value={{ getLayer }}>
			<DndContext onDragEnd={handleDragEnd}>
				<div className="w-full h-full">
					{nowPlaying && <NowPlaying nowPlaying={getLayer(nowPlaying)} />}
					<ScrollArea>
						<ul className="flex flex-col space-y-1 w-max">
							{/* -------- queue items -------- */}
							{layerQueue?.map((item, index) => <QueueItem item={item} index={index} isLast={index + 1 === layerQueue.length} />)}
						</ul>
					</ScrollArea>
					{editing && (
						<div>
							<Button onClick={save}>Save</Button>
							<Button onClick={reset} variant="secondary">
								Cancel
							</Button>
						</div>
					)}
				</div>
			</DndContext>
		</LayerQueueContext.Provider>
	)
}

function QueueItem(props: { item: M.LayerQueueItem; index: number; isLast: boolean }) {
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: props.index,
	})
	const ctx = useContext(LayerQueueContext)

	const style = { transform: CSS.Translate.toString(transform) }
	if (props.item.layerId) {
		const layer = ctx.getLayer(props.item.layerId)
		return (
			<>
				{props.index === 0 && <QueueItemSeparator afterIndex={-1} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...listeners}
					{...attributes}
					key={props.index}
					className={
						'px-1 pt-1 pb-2 flex items-center justify-between space-x-2 w-full group bg-background bg-opacity-10 rounded-md' +
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
			</>
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

export function NowPlaying(props: { nowPlaying: M.MiniLayer }) {
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
