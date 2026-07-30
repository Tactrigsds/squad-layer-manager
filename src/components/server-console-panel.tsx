import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import * as ConsoleFrame from '@/frames/server-console.frame'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as SC_Msgs from '@/messages/server-console.messages'
import type { ConsoleEvent } from '@/models/server-console.models'
import * as SC from '@/models/server-console.models'
import { tr } from '@/systems/messages.client'

// The tail of what a squad server is saying and being told. Read-only by design: issuing rcon from here would
// route around every other permission and leave no app event behind.

function formatEvent(event: ConsoleEvent): { prefix: string; body: string; tone?: string } {
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

export function ServerConsolePanel({ stores, className }: { stores: ConsoleFrame.KeyProp; className?: string }) {
	const [{ events, hidden }, tab, hideNoise, denied] = Zus.useStore(
		stores.serverConsole,
		(s) => [ConsoleFrame.Sel.view(s), s.tab, s.hideNoise, s.denied] as const,
	)
	const scrollRef = React.useRef<HTMLDivElement>(null)
	// a console that does not follow its own tail is a worse version of the log file it is showing
	React.useEffect(() => {
		const el = scrollRef.current
		if (el) el.scrollTop = el.scrollHeight
	}, [events])

	if (denied) {
		return (
			<div className={cn('flex min-h-0 items-center justify-center rounded-md border p-3', className)}>
				<p className="text-sm text-muted-foreground">{tr.text(SC_Msgs.denied())}</p>
			</div>
		)
	}

	return (
		<div className={cn('flex min-h-0 flex-col rounded-md border', className)}>
			<div className="flex items-center gap-1 border-b px-1 py-1">
				<div role="tablist" aria-label={tr.text(SC_Msgs.channelTablist())} className="flex items-center gap-1">
					{SC.TABS.map((t) => (
						<Button
							key={t}
							type="button"
							role="tab"
							aria-selected={t === tab}
							size="sm"
							variant={t === tab ? 'secondary' : 'ghost'}
							className="h-6 px-2 text-xs"
							onClick={() => ConsoleFrame.Actions.setTab(stores, t)}
						>
							{tr.text(SC_Msgs.tabNames[t])}
						</Button>
					))}
				</div>
				<label className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
					<Checkbox
						checked={hideNoise}
						aria-label={tr.text(SC_Msgs.hideNoise())}
						onCheckedChange={(on) => ConsoleFrame.Actions.setHideNoise(stores, on === true)}
					/>
					{tr.text(SC_Msgs.hideNoise())}
					{hideNoise && hidden > 0 && <span className="tabular-nums">({hidden})</span>}
				</label>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-6 w-6"
					title={tr.text(SC_Msgs.clear())}
					onClick={() => ConsoleFrame.Actions.clear(stores)}
				>
					<Icons.Eraser className="h-3.5 w-3.5" />
				</Button>
			</div>
			<div
				ref={scrollRef}
				role="tabpanel"
				aria-label={tr.text(SC_Msgs.tabOutput(tab))}
				className="min-h-0 grow overflow-y-auto bg-muted/30 p-1.5"
			>
				{events.length === 0 ? (
					<p className="text-xs text-muted-foreground">{tr.text(SC_Msgs.empty())}</p>
				) : (
					<ol className="space-y-0.5">
						{events.map((event) => {
							const { prefix, body, tone } = formatEvent(event)
							return (
								<li key={event.seq} className="flex items-start gap-1.5 font-mono text-[11px] leading-tight">
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
