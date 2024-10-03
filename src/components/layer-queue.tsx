import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import * as Helpers from '@/displayHelpers'
import { trpc } from '@/lib/trpc'
import * as M from '@/models'
import { EllipsisVertical, GripVertical } from 'lucide-react'
import { useRef, useState } from 'react'

import { ContextMenuItem } from './ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

export default function LayerQueue() {
	const [layerQueue, setLayerQueue] = useState(null as null | M.LayerQueue)
	const [nowPlaying, setNowPlaying] = useState(null as M.LayerQueueUpdate['nowPlaying'])
	const serverInfoRes = trpc.getServerInfo.useQuery()

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

	return (
		<div className="w-full">
			{nowPlaying && <NowPlaying nowPlaying={getLayer(nowPlaying)} />}
			<ScrollArea>
				<ul className="flex flex-col space-y-1 w-max">
					{/* -------- queue items -------- */}
					{layerQueue?.map((elt, i) => {
						if (elt.layerId) {
							const layer = getLayer(elt.layerId)
							return (
								<li key={i} className="border-b px-1 pt-1 pb-2 flex items-center justify-between space-x-2 w-full group">
									<div className="flex items-center">
										<Button variant="ghost" size="icon" className="cursor-grab">
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
							)
						}
						throw new Error('TODO implement')
					})}
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
	)
}

export function NowPlaying(props: { nowPlaying: M.MiniLayer }) {
	const serverInfoRes = trpc.getServerInfo.useQuery()

	return (
		<Card className="w-max">
			<CardContent>
				<div>now playing {Helpers.toShortLayerName(props.nowPlaying)}</div>
			</CardContent>
			<pre>
				<code>{JSON.stringify(serverInfoRes?.data, undefined, 2)}</code>
			</pre>
		</Card>
	)
}
