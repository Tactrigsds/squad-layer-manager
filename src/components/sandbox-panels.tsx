import { ScrollArea } from '@/components/ui/scroll-area'
import * as SandboxFrame from '@/frames/sandbox.frame'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'

import type { SandboxPanelWindowProps } from './sandbox-panels.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'
import { useSandboxFrame } from './use-sandbox-frame'

// The admin list is rendered in two places: inline in the control window, and in a pop-out of its own. Both read
// the same frame, so a pop-out is another view rather than another copy.

DraggableWindowStore.getState().registerDefinition<SandboxPanelWindowProps, unknown>({
	type: WINDOW_ID.enum['sandbox-admin-list'],
	component: SandboxAdminListWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 320,
	minHeight: 200,
	defaultWidth: 460,
	defaultHeight: 380,
	getId: (props) => `sandbox-admin-list:${props.serverId}`,
})

function SandboxAdminListWindow(props: SandboxPanelWindowProps) {
	useDraggableWindow()
	const stores = useSandboxFrame(props.serverId)
	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>Admins.cfg: {props.serverId}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="min-h-0 grow p-2">
				<SandboxAdminListPanel stores={stores} className="h-full" />
			</div>
		</div>
	)
}

// The list exactly as a squad server would be handed it, rendered from the same text the app parses. Read-only:
// it is edited through the players table, where membership belongs.
export function SandboxAdminListPanel({ stores, className }: { stores: SandboxFrame.KeyProp; className?: string }) {
	const cfg = ZusUtils.useStore(stores.sandbox, SandboxFrame.Sel.adminsCfg)
	return (
		<div className={cn('min-h-0 rounded-md border bg-muted/30', className)}>
			<ScrollArea className="h-full">
				{cfg ? (
					<pre className="p-2 font-mono text-xs whitespace-pre-wrap">{cfg}</pre>
				) : (
					<p className="p-2 text-xs text-muted-foreground">The emulated admin list is empty.</p>
				)}
			</ScrollArea>
		</div>
	)
}
