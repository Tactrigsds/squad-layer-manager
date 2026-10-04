import React from 'react'

import * as MH_Msgs from '@/messages/match-history.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { DraggableWindowStore, frameDependency } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'

import { chartWindowId, type ChartWindowProps } from './charts-window.helpers'
import { ChartBody } from './stats-panel'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'

DraggableWindowStore.getState().registerDefinition<ChartWindowProps, unknown>({
	type: WINDOW_ID.enum.chart,
	component: ChartWindow,
	initialPosition: 'below',
	resizable: true,
	minWidth: 360,
	minHeight: 200,
	defaultWidth: 640,
	defaultHeight: 380,
	initialSize: (props) => props.size,
	// one window per chart per server; opening it again raises the one already open
	getId: (props) => chartWindowId(props.stores.squadServer.serverId, props.tab),
	dependsOn: (props) => [frameDependency(props.stores.squadServer)],
})

function ChartWindow(props: ChartWindowProps) {
	useDraggableWindow()
	return (
		<div data-tour={`chart-window-${props.tab}`} className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>{tr.text(MH_Msgs.chartWindowTitle(props.tab))}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<React.Suspense fallback={null}>
				<ChartBody stores={props.stores} tab={props.tab} inWindow />
			</React.Suspense>
		</div>
	)
}
