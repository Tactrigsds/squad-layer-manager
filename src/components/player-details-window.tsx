import EventFilterSelect from '@/components/event-filter-select'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import * as ZusUtils from '@/lib/zustand'
import * as CHAT from '@/models/chat.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as RPC from '@/orpc.client'
import { getPlayerBansAndNotesQueryOptions, getPlayerFlagsQueryOptions, getPlayerProfileQueryOptions, sortFlagsByHierarchy, usePlayerFlagColor } from '@/systems/battlemetrics.client'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useQuery } from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import type { PlayerDetailsWindowProps } from './player-details-window.helpers'
import { ServerEvent } from './server-event'

import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowPinToggle, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

DraggableWindowStore.getState().registerDefinition<PlayerDetailsWindowProps, unknown>({
	type: WINDOW_ID.enum['player-details'],
	component: PlayerDetailsWindow,
	initialPosition: 'left',
	getId: (props) => props.playerId,
	loadAsync: async ({ props }) => {
		await Promise.all([
			RPC.queryClient.fetchQuery(RPC.orpc.matchHistory.getPlayerDetails.queryOptions({ input: { playerId: props.playerId } })),
			RPC.queryClient.fetchQuery(getPlayerFlagsQueryOptions(props.playerId)),
			RPC.queryClient.fetchQuery(getPlayerProfileQueryOptions(props.playerId)),
			RPC.queryClient.fetchQuery(getPlayerBansAndNotesQueryOptions(props.playerId)),
		])
	},
})

function PlayerDetailsWindow({ playerId }: PlayerDetailsWindowProps) {
	const { data } = useQuery(RPC.orpc.matchHistory.getPlayerDetails.queryOptions({ input: { playerId } }))
	const { data: rawFlags } = useQuery(getPlayerFlagsQueryOptions(playerId))
	const flags = rawFlags ? sortFlagsByHierarchy(rawFlags) : undefined
	const flagColor = usePlayerFlagColor(playerId)
	const { data: profile } = useQuery(getPlayerProfileQueryOptions(playerId))
	const { data: bansAndNotes } = useQuery(getPlayerBansAndNotesQueryOptions(playerId))
	const currentMatchEvents = Zus.useStore(
		SquadServerClient.ChatStore,
		ZusUtils.useShallow(s => s.chatState.eventBuffer.filter(e => CHAT.getAssocPlayer(e, playerId) || e.type === 'NEW_GAME')),
	)

	const allEvents = [...(data?.events ?? []), ...(currentMatchEvents.some(e => CHAT.getAssocPlayer(e, playerId)) ? currentMatchEvents : [])]
	const livePlayer = Zus.useStore(
		SquadServerClient.ChatStore,
		(s) => s.chatState.interpolatedState.players.find((p) => p.ids.steam === playerId) ?? null,
	)
	const player = livePlayer ?? CHAT.findLastPlayerInstance(allEvents, playerId)
	const currentMatch = MatchHistoryClient.useCurrentMatch()
	const connectionStatus = data?.connectionStatus ?? null
	const elapsed = useElapsed(connectionStatus?.status === 'online' ? connectionStatus.connectedSince : null)
	const globalFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.secondaryFilterState)
	const [filterState, setFilterState] = React.useState<CHAT.SecondaryFilterState>(globalFilterState)
	const filteredEvents = allEvents.filter(e => !CHAT.isEventFilteredBySecondary(e, filterState))
	const { scrollAreaRef, contentRef, bottomRef, showScrollButton, scrollToBottom } = useTailingScroll()
	const { setIsPinned, zIndex } = useDraggableWindow()

	return (
		<div className="min-w-0 min-h-0 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle style={flagColor ? { color: flagColor } : undefined}>
					{player?.ids.username ?? 'Player Details'}
					{livePlayer && (livePlayer.teamId !== null || livePlayer.squadId !== null) && (
						<span className="text-muted-foreground font-normal ml-1">
							({livePlayer.teamId !== null && currentMatch
								? (
									<>
										<MatchTeamDisplay matchId={currentMatch.historyEntryId} teamId={livePlayer.teamId} />
										{livePlayer.squadId !== null && ', '}
									</>
								)
								: null}
							{livePlayer.squadId !== null && <>Squad {livePlayer.squadId}</>})
						</span>
					)}
				</DraggableWindowTitle>
				{connectionStatus && (
					connectionStatus.status === 'online'
						? <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" title={`Online${elapsed ? ` for ${elapsed}` : ''}`} />
						: (
							<span
								className="h-2 w-2 rounded-full bg-muted-foreground shrink-0"
								title={connectionStatus.lastSeen
									? `Last seen ${dateFns.formatDistanceToNow(connectionStatus.lastSeen, { addSuffix: true })}`
									: 'Offline'}
							/>
						)
				)}
				{flags && flags.length > 0 && <PlayerFlagsList flags={flags} zIndex={zIndex} />}
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="px-3 py-2 space-y-1.5 text-xs border-b border-border/50">
				{player?.role && <div className="text-muted-foreground">{player.role}</div>}
				<div className="flex items-center gap-2 text-muted-foreground">
					<CopySteamIdButton steamId={playerId} zIndex={zIndex} />
					<ExtLink href={`https://steamcommunity.com/profiles/${playerId}`}>Steam</ExtLink>
					<ExtLink href={`https://communitybanlist.com/search/${playerId}`}>CBL</ExtLink>
					<ExtLink href={`https://mysquadstats.com/search/${playerId}#player`}>MySquadStats</ExtLink>
					<ExtLink
						href={profile
							? profile.profileUrl
							: `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${playerId}&filter%5Bservers%5D=false&filter%5BplayerFlags%5D=&sort=score&showServers=true&method=quick`}
					>
						BattleMetrics
					</ExtLink>
				</div>
				{profile && (
					<div className="flex items-center gap-2 text-muted-foreground">
						<span>{profile.hoursPlayed}h played on org servers</span>
						{bansAndNotes && (
							<>
								<span>|</span>
								<span>{bansAndNotes.banCount} bans</span>
								<span>|</span>
								<span>{bansAndNotes.noteCount} notes</span>
							</>
						)}
					</div>
				)}
			</div>
			<Separator />
			<div className="px-3 py-0.5">
				<div className="inline-flex items-baseline gap-1 justify-between w-full">
					<h3 className="inline">
						Server Activity
					</h3>
					{/* explicitely setting zIndex here is another hack to get around bad interations between draggable windows and other kinds of floating elements TODO probably just need to find a nice way to set portals correctly on sleemnts inside drag windows */}
					<EventFilterSelect
						zIndex={zIndex + 10}
						variant="ghost"
						value={filterState}
						onOpenChange={(open) => {
							// hack to get around close on click-out behaviour. TODO find better pattern
							if (open) setIsPinned(true)
						}}
						onValueChange={v => {
							setFilterState(v)
							setIsPinned(true)
						}}
					/>
				</div>
				<ScrollArea ref={scrollAreaRef} className="h-75">
					<div ref={contentRef} className="flex flex-col gap-0.5 min-h-0 w-full max-w-175">
						{groupEventsByDate(filteredEvents).map(([dateKey, events]) => (
							<div key={dateKey}>
								<div className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm px-2 py-0.5 text-[10px] text-muted-foreground font-medium border-b border-border/50">
									{formatDateLabel(dateKey)}
								</div>
								{events.map(e => <ServerEvent key={e.id} event={e} />)}
							</div>
						))}
					</div>
					<div ref={bottomRef} />
					{showScrollButton && (
						<Button
							onClick={() => scrollToBottom()}
							variant="secondary"
							className="absolute bottom-0 left-0 right-0 w-full h-6 shadow-lg flex items-center justify-center z-10 bg-opacity-20! rounded-none backdrop-blur-sm"
							title="Scroll to bottom"
						>
							<Icons.ChevronDown className="h-3 w-3" />
							<span className="text-xs">Scroll to bottom</span>
						</Button>
					)}
				</ScrollArea>
			</div>
		</div>
	)
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-0.5 text-blue-400 hover:underline"
		>
			{children}
			<Icons.ExternalLink className="h-2.5 w-2.5" />
		</a>
	)
}

function CopySteamIdButton({ steamId, zIndex }: { steamId: string; zIndex: number }) {
	const [open, setOpen] = React.useState(false)
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(null)

	const handleClick = () => {
		void navigator.clipboard.writeText(steamId)
		setOpen(true)
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
		timeoutRef.current = setTimeout(() => setOpen(false), 1500)
	}

	React.useEffect(() => () => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
	}, [])

	return (
		<Tooltip open={open}>
			<TooltipTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
					title="Copy Steam ID"
					onClick={handleClick}
				>
					<span className="font-mono">{steamId}</span>
					<Icons.Copy className="h-3 w-3" />
				</button>
			</TooltipTrigger>
			<TooltipContent style={{ zIndex: zIndex + 10 }}>Copied!</TooltipContent>
		</Tooltip>
	)
}

function useElapsed(since: number | null): string | null {
	const [, setTick] = React.useState(0)
	React.useEffect(() => {
		if (since === null) return
		const id = setInterval(() => setTick(t => t + 1), 30_000)
		return () => clearInterval(id)
	}, [since])

	if (since === null) return null
	return dateFns.formatDistanceToNow(since)
}

function groupEventsByDate(events: CHAT.EventEnriched[]): [string, CHAT.EventEnriched[]][] {
	const groups = new Map<string, CHAT.EventEnriched[]>()
	for (const event of events) {
		const key = dateFns.format(event.time, 'yyyy-MM-dd')
		let group = groups.get(key)
		if (!group) {
			group = []
			groups.set(key, group)
		}
		group.push(event)
	}
	return Array.from(groups.entries())
}

function formatDateLabel(dateKey: string): string {
	const date = dateFns.parseISO(dateKey)
	if (dateFns.isToday(date)) return 'Today'
	if (dateFns.isYesterday(date)) return 'Yesterday'
	return dateFns.format(date, 'EEE, MMM d')
}

interface PlayerFlagsListProps {
	flags: NonNullable<ReturnType<typeof sortFlagsByHierarchy>>
	zIndex: number
}

function PlayerFlagsList({ flags, zIndex }: PlayerFlagsListProps) {
	const containerRef = React.useRef<HTMLDivElement>(null)
	const [visibleCount, setVisibleCount] = React.useState(flags.length)
	const [isPopoverOpen, setIsPopoverOpen] = React.useState(false)

	React.useEffect(() => {
		if (!containerRef.current) return

		const container = containerRef.current
		const children = Array.from(container.children) as HTMLElement[]
		let totalWidth = 0
		let count = 0
		const maxWidth = 450
		const ellipsisWidth = 40 // approximate width for ellipsis button

		for (let i = 0; i < children.length - 1; i++) { // -1 to exclude the ellipsis button
			const child = children[i]
			const childWidth = child.offsetWidth
			const gap = 2 // gap-0.5 = 2px

			if (totalWidth + childWidth + (count > 0 ? gap : 0) > maxWidth - ellipsisWidth) {
				break
			}

			totalWidth += childWidth + (count > 0 ? gap : 0)
			count++
		}

		setVisibleCount(count === flags.length ? flags.length : count)
	}, [flags])

	const visibleFlags = flags.slice(0, visibleCount)
	const hasOverflow = visibleCount < flags.length

	return (
		<div className="flex items-center gap-0.5 min-w-0" ref={containerRef}>
			{visibleFlags.map((flag) => (
				<span
					key={flag.id}
					className="inline-flex items-center gap-0.5 rounded px-1 py-0 text-[10px] font-medium leading-tight shrink-0"
					style={{ backgroundColor: flag.color ? `${flag.color}33` : undefined, color: flag.color ?? undefined }}
					title={flag.description ?? undefined}
				>
					{flag.icon && <span className="material-symbols-outlined leading-none" style={{ fontSize: '12px' }}>{flag.icon}</span>}
					{flag.name}
				</span>
			))}
			{hasOverflow && (
				<Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="inline-flex items-center gap-0.5 rounded px-1 py-0 text-[10px] font-medium leading-tight shrink-0 bg-muted hover:bg-muted/80 transition-colors"
							title="Show all tags"
						>
							<Icons.MoreHorizontal className="h-3 w-3" />
						</button>
					</PopoverTrigger>
					<PopoverContent style={{ zIndex: zIndex + 10 }} className="w-auto max-w-md p-2">
						<div className="flex flex-wrap gap-1">
							{flags.map((flag) => (
								<span
									key={flag.id}
									className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-tight"
									style={{ backgroundColor: flag.color ? `${flag.color}33` : undefined, color: flag.color ?? undefined }}
									title={flag.description ?? undefined}
								>
									{flag.icon && <span className="material-symbols-outlined leading-none" style={{ fontSize: '12px' }}>{flag.icon}</span>}
									{flag.name}
								</span>
							))}
						</div>
					</PopoverContent>
				</Popover>
			)}
			<div style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none' }}>
				{flags.map((flag) => (
					<span
						key={flag.id}
						className="inline-flex items-center gap-0.5 rounded px-1 py-0 text-[10px] font-medium leading-tight shrink-0"
						style={{ backgroundColor: flag.color ? `${flag.color}33` : undefined, color: flag.color ?? undefined }}
					>
						{flag.icon && <span className="material-symbols-outlined leading-none" style={{ fontSize: '12px' }}>{flag.icon}</span>}
						{flag.name}
					</span>
				))}
			</div>
		</div>
	)
}
