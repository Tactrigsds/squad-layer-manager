import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as SandboxFrame from '@/frames/sandbox.frame'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type { EmuEvent } from '@/models/sandbox.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as Icons from 'lucide-react'
import React from 'react'
import type { SandboxPanelWindowProps } from './sandbox-panels.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'
import { useSandboxFrame } from './use-sandbox-frame'

// The admin list and the console are each rendered in two places: inline in the control window, and in a pop-out of
// their own. Both read the same frame, so a pop-out is another view rather than another copy.

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

DraggableWindowStore.getState().registerDefinition<SandboxPanelWindowProps, unknown>({
	type: WINDOW_ID.enum['sandbox-console'],
	component: SandboxConsoleWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 420,
	minHeight: 240,
	defaultWidth: 780,
	defaultHeight: 520,
	getId: (props) => `sandbox-console:${props.serverId}`,
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

function SandboxConsoleWindow(props: SandboxPanelWindowProps) {
	useDraggableWindow()
	const stores = useSandboxFrame(props.serverId)
	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>Server console: {props.serverId}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="min-h-0 grow p-2">
				<SandboxConsolePanel stores={stores} className="h-full" />
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
				{cfg
					? <pre className="p-2 font-mono text-xs whitespace-pre-wrap">{cfg}</pre>
					: <p className="p-2 text-xs text-muted-foreground">The emulated admin list is empty.</p>}
			</ScrollArea>
		</div>
	)
}

const CHANNEL_LABEL: Record<SandboxFrame.ConsoleChannel, string> = {
	unified: 'All',
	rcon: 'RCON',
	log: 'Logs',
	command: 'Player Commands',
}

function formatEvent(event: EmuEvent): { prefix: string; body: string; tone?: string } {
	switch (event.type) {
		case 'rcon':
			return {
				prefix: event.dir === 'recv' ? 'rcon <-' : 'rcon ->',
				body: event.body,
				tone: event.dir === 'recv' ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-600 dark:text-emerald-400',
			}
		case 'log':
			return { prefix: 'log', body: event.line, tone: 'text-muted-foreground' }
		case 'command':
			return { prefix: `${event.channel} ${event.player}`, body: event.message, tone: 'text-amber-600 dark:text-amber-500' }
	}
}

export function SandboxConsolePanel({ stores, className }: { stores: SandboxFrame.KeyProp; className?: string }) {
	const [{ events, hidden }, channel, hideNoise] = ZusUtils.useStore(
		stores.sandbox,
		(s) => [SandboxFrame.Sel.consoleView(s), s.channel, s.hideNoise] as const,
	)
	const scrollRef = React.useRef<HTMLDivElement>(null)
	// a console that does not follow its own tail is a worse version of the log file it is showing
	React.useEffect(() => {
		const el = scrollRef.current
		if (el) el.scrollTop = el.scrollHeight
	}, [events])

	return (
		<div className={cn('flex min-h-0 flex-col rounded-md border', className)}>
			<div className="flex items-center gap-1 border-b px-1 py-1">
				{SandboxFrame.CONSOLE_CHANNELS.map((c) => (
					<Button
						key={c}
						type="button"
						size="sm"
						variant={c === channel ? 'secondary' : 'ghost'}
						className="h-6 px-2 text-xs"
						onClick={() => SandboxFrame.Actions.setChannel(stores, c)}
					>
						{CHANNEL_LABEL[c]}
					</Button>
				))}
				<label className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
					<Checkbox
						checked={hideNoise}
						onCheckedChange={(on) => SandboxFrame.Actions.setHideNoise(stores, on === true)}
					/>
					Hide noise
					{hideNoise && hidden > 0 && <span className="tabular-nums">({hidden})</span>}
				</label>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-6 w-6"
					title="Clear"
					onClick={() => SandboxFrame.Actions.clearConsole(stores)}
				>
					<Icons.Eraser className="h-3.5 w-3.5" />
				</Button>
			</div>
			<div ref={scrollRef} className="min-h-0 grow overflow-y-auto bg-muted/30 p-1.5">
				{events.length === 0
					? <p className="text-xs text-muted-foreground">Nothing yet.</p>
					: (
						<ol className="space-y-0.5">
							{events.map((event, i) => {
								const { prefix, body, tone } = formatEvent(event)
								return (
									// oxlint-disable-next-line no-array-index-key
									<li key={i} className="flex items-start gap-1.5 font-mono text-[11px] leading-tight">
										<span className={cn('shrink-0', tone)}>{prefix}</span>
										<span className="min-w-0 whitespace-pre-wrap break-all">{body}</span>
									</li>
								)
							})}
						</ol>
					)}
			</div>
		</div>
	)
}
