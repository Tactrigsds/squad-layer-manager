import React from 'react'

import HistoryEvents from '@/components/history-events'
import ShortLayerName from '@/components/short-layer-name'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import * as LH_Msgs from '@/messages/layer-history.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as HQ from '@/models/history.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as HistoryClient from '@/systems/history.client'
import { tr } from '@/systems/messages.client'

import { type LayerHistoryWindowProps, layerHistoryWindowId } from './layer-history-window.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowPinToggle, DraggableWindowTitle } from './ui/draggable-window'

DraggableWindowStore.getState().registerDefinition<LayerHistoryWindowProps, unknown>({
	type: WINDOW_ID.enum['layer-history'],
	component: LayerHistoryWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 340,
	minHeight: 320,
	defaultWidth: 560,
	defaultHeight: 640,
	getId: layerHistoryWindowId,
})

const noEntry = () => undefined

function LayerHistoryWindow(props: LayerHistoryWindowProps) {
	const { serverId, itemId, matchId } = props
	const squadServer = React.useMemo(
		() => frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverId)),
		[serverId],
	)
	// where the item sits in the queue now, absent once it has left the queue
	const queueEntry = Zus.useStore(squadServer, itemId === undefined ? noEntry : LayerQueuePrt.Sel.itemEntry(itemId))
	const query = React.useMemo(() => {
		const subject = itemId !== undefined ? { itemId } : matchId !== undefined ? { matchId } : undefined
		return subject ? HQ.itemHistoryQuery(serverId, subject) : undefined
	}, [serverId, itemId, matchId])

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>{tr.text(LH_Msgs.title())}</DraggableWindowTitle>
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="flex flex-col gap-2 border-b border-border/50 px-3 py-2 text-xs">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<ShortLayerName layerId={props.layerId} className="min-w-0 truncate text-sm" />
					{queueEntry && (
						<span className="rounded bg-muted px-1.5 text-muted-foreground">
							{tr.text(LH_Msgs.queuePosition(queueEntry.index.outerIndex + 1))}
						</span>
					)}
					{matchId !== undefined && (
						<span className="rounded bg-muted px-1.5 text-muted-foreground">{tr.text(LH_Msgs.playedInMatch(matchId))}</span>
					)}
				</div>
				{props.itemId === undefined && <p className="text-muted-foreground">{tr.text(LH_Msgs.noQueueItem())}</p>}
			</div>
			<div className="flex min-h-0 flex-1 flex-col px-3 py-1">
				{query && <HistoryEvents query={query} showTotal={false} linkable className="flex min-h-0 flex-1 flex-col gap-1" />}
			</div>
			{query && (
				<footer className="flex justify-end border-t border-border/50 px-3 py-1.5 text-xs">
					<a className="text-primary hover:underline" href={HistoryClient.historyUrl(query)}>
						{tr.text(LH_Msgs.openInHistory())}
					</a>
				</footer>
			)}
		</div>
	)
}
