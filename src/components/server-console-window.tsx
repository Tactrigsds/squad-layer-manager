import * as SC_Msgs from '@/messages/server-console.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'

import { ServerConsolePanel } from './server-console-panel'
import type { ServerConsoleWindowProps } from './server-console-window.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'
import { useServerConsoleFrame } from './use-server-console-frame'

DraggableWindowStore.getState().registerDefinition<ServerConsoleWindowProps, unknown>({
	type: WINDOW_ID.enum['server-console'],
	component: ServerConsoleWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 420,
	minHeight: 240,
	defaultWidth: 780,
	defaultHeight: 520,
	getId: (props) => `server-console:${props.serverId}`,
})

function ServerConsoleWindow(props: ServerConsoleWindowProps) {
	useDraggableWindow()
	const stores = useServerConsoleFrame(props.serverId)
	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>{tr.text(SC_Msgs.windowTitle(props.serverId))}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="min-h-0 grow p-2">
				<ServerConsolePanel stores={stores} className="h-full" />
			</div>
		</div>
	)
}
