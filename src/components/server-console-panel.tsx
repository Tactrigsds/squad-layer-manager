import * as Icons from 'lucide-react'
import React from 'react'

import { SubtreeFindBar } from '@/components/subtree-find-bar'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSubtreeFind } from '@/components/use-subtree-find'
import * as ConsoleFrame from '@/frames/server-console.frame'
import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as SC_Msgs from '@/messages/server-console.messages'
import type { ConsoleEvent } from '@/models/server-console.models'
import * as SC from '@/models/server-console.models'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
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
	const { scrollAreaRef, contentRef, showScrollButton, scrollToBottom } = useTailingScroll()
	const scrollToBottomZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)
	const find = useSubtreeFind()

	// each channel is its own tail, so switching to one starts at its end
	React.useEffect(() => {
		scrollToBottom()
	}, [tab, scrollToBottom])

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
			<div ref={find.scopeRef} className="relative min-h-0 grow bg-muted/30">
				<SubtreeFindBar stores={find.stores} className="absolute right-3 top-2" />
				<ScrollArea ref={scrollAreaRef} role="tabpanel" aria-label={tr.text(SC_Msgs.tabOutput(tab))} className="h-full">
					<div ref={contentRef} className="p-1.5">
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
				</ScrollArea>
				{showScrollButton && (
					<Button
						onClick={() => scrollToBottom()}
						variant="secondary"
						style={{ zIndex: scrollToBottomZIndex }}
						className="absolute bottom-0 left-0 right-0 h-6 w-full rounded-none bg-opacity-20! shadow-lg backdrop-blur-sm"
						title={tr.text(CHAT_Msgs.scrollToBottom())}
					>
						<Icons.ChevronDown className="h-3 w-3" />
						<span className="text-xs">{tr.text(CHAT_Msgs.scrollToBottom())}</span>
					</Button>
				)}
			</div>
		</div>
	)
}
