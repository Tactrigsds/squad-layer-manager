import { PlayerFlagsButton } from '@/components/bm-flag-workflows'
import EventFilterSelect from '@/components/event-filter-select'
import { PlayerMenuItems } from '@/components/player-context-menu-options'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as ChatPrt from '@/frame-partials/chat.partial'

import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import * as CHAT from '@/models/chat.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as RPC from '@/orpc.client'
import { useOrgFlags, usePlayerGroupColor, useRefreshPlayerBmData } from '@/systems/battlemetrics.client'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import { CopyIdButton } from './copy-id-button'
import type { PlayerDetailsWindowProps } from './player-details-window.helpers'
import { ServerEvent } from './server-event'
import WarnChatBox from './warn-chat-box'

import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowPinToggle, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'
import { Separator } from './ui/separator'
import { Spinner } from './ui/spinner'

const PLAYER_DETAILS_FILTER_OPTIONS = CHAT.SECONDARY_FILTER_STATE.options.filter(o => o !== 'SELECTED_PLAYERS')

const dropdownMenuSlots = {
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent,
}

DraggableWindowStore.getState().registerDefinition<PlayerDetailsWindowProps, unknown>({
	type: WINDOW_ID.enum['player-details'],
	component: PlayerDetailsWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 340,
	minHeight: 320,
	defaultHeight: 660,
	getId: (props) => props.playerId,
	loadAsync: async ({ props }) => {
		const serverId = props.stores.squadServer.serverId
		await Promise.all([
			RPC.queryClient.fetchQuery(RPC.orpc.matchHistory.getPlayerDetails.queryOptions({ input: { serverId, playerId: props.playerId } })),
			RPC.queryClient.fetchInfiniteQuery(playerEventsInfiniteOptions(serverId, props.playerId)),
			RPC.queryClient.fetchQuery(
				RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId: props.playerId }, staleTime: Infinity }),
			),
		])
	},
})

function PlayerDetailsWindow({ playerId, stores }: PlayerDetailsWindowProps) {
	const squadServerFrameKey = stores.squadServer
	const serverId = squadServerFrameKey.serverId
	const { data } = useQuery({
		...RPC.orpc.matchHistory.getPlayerDetails.queryOptions({ input: { serverId, playerId } }),
		select: RPC.selectLoaded,
	})
	const eventsQuery = useInfiniteQuery(playerEventsInfiniteOptions(serverId, playerId))
	const { data: bmData } = useQuery(RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId }, staleTime: Infinity }))
	const orgFlags = useOrgFlags()
	const flags = bmData && orgFlags ? BM.resolveFlags(bmData.flagIds, orgFlags) : undefined
	const profile = bmData ? (({ flagIds: _, ...rest }) => rest)(bmData) : null
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const currentMatchEvents = ZusUtils.useStore(
		squadServerFrameKey,
		ZusUtils.useShallow(s =>
			currentMatch
				? ChatPrt.Sel.chatEvents(s).filter(e =>
					e.matchId === currentMatch.historyEntryId && (e.type === 'NEW_GAME' || CHAT.hasAssocPlayer(e, playerId))
				)
				: []
		),
	)

	// pages arrive most-recent-match first; reverse to interleave chronologically ahead of the live current-match events
	const historicalEvents = (eventsQuery.data?.pages ?? []).slice().reverse().flatMap(p => RPC.selectLoaded(p)?.events ?? [])
	const allEvents = [...historicalEvents, ...currentMatchEvents]
	// while the player is connected we render their full details; once they aren't, only what a RecentPlayer carries
	// (their ids, and that they're an admin) is still true of them, so team/squad/role drop off rather than going stale.
	const livePlayer = ZusUtils.useStore(squadServerFrameKey, (s) => ChatPrt.Sel.player(playerId)(s) ?? null)
	const recentPlayer = ZusUtils.useStore(squadServerFrameKey, (s) => ChatPrt.Sel.recentPlayer(playerId)(s) ?? null)
	const ids = livePlayer?.ids ?? recentPlayer?.ids
	const groupColor = usePlayerGroupColor(playerId, livePlayer?.adminGroups ?? recentPlayer?.adminGroups ?? [])

	const connectionStatus = data?.connectionStatus ?? null
	const elapsed = useElapsed(connectionStatus?.status === 'online' ? connectionStatus.connectedSince : null)
	const isOnline = !!livePlayer
	const globalFilterState = ZusUtils.useStore(squadServerFrameKey, ChatPrt.Sel.secondaryFilterState)
	// this window's feed is already scoped to one player, so the selection-based filter has nothing to add here
	const [filterState, setFilterState] = React.useState<CHAT.SecondaryFilterState>(
		globalFilterState === 'SELECTED_PLAYERS' ? 'ALL' : globalFilterState,
	)
	const filteredEvents = allEvents.filter(e => CHAT.isRenderableInFeed(e) && CHAT.showEventInFeed(e, filterState))
	const { scrollAreaRef, contentRef, showScrollButton, isAtTop, scrollToBottom, anchorForPrepend } = useTailingScroll()
	const { setIsPinned } = useDraggableWindow()
	const aboveChatZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle style={groupColor ? { color: groupColor } : undefined}>
					{ids?.username ?? 'Player Details'}
					{livePlayer && (livePlayer.teamId !== null || livePlayer.squadId !== null) && (
						<span className="text-muted-foreground font-normal ml-1">
							({livePlayer.teamId !== null && currentMatch
								? (
									<>
										<MatchTeamDisplay matchId={currentMatch.historyEntryId} teamId={livePlayer.teamId} stores={stores} />
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
				{flags && flags.length > 0 && <PlayerFlagsList flags={flags} />}
				<PlayerBmRefreshButton playerId={playerId} />
				<PlayerFlagsButton playerId={playerId} />
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
							title="Player actions"
						>
							<Icons.Ellipsis className="h-3.5 w-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<PlayerMenuItems playerId={playerId} slots={dropdownMenuSlots} stores={stores} omitWarn />
					</DropdownMenuContent>
				</DropdownMenu>
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="px-3 py-2 space-y-1.5 text-xs border-b border-border/50">
				<PlayerTimeoutStatus playerId={playerId} />
				<div className="inline-flex gap-1 items-baseline">
					{livePlayer?.role && <div className="text-muted-foreground">{livePlayer.role}</div>}
					<CopyIdButton label="eos" id={playerId} />
					{(ids?.steam ?? profile?.playerIds.steam) && <CopyIdButton label="steam" id={(ids?.steam ?? profile?.playerIds.steam)!} />}
					{ids?.epic && <CopyIdButton label="epic" id={ids.epic} />}
				</div>
				<div className="flex items-center gap-2 text-muted-foreground">
					{(ids?.steam ?? profile?.playerIds.steam)
						? (
							<>
								<ExtLink href={`https://steamcommunity.com/profiles/${ids?.steam ?? profile?.playerIds.steam}`}>Steam</ExtLink>
								<ExtLink href={`https://communitybanlist.com/search/${ids?.steam ?? profile?.playerIds.steam}`}>CBL</ExtLink>
								<ExtLink href={`https://mysquadstats.com/search/${ids?.steam ?? profile?.playerIds.steam}#vanillaStats`}>
									MySquadStats
								</ExtLink>
							</>
						)
						: <span className="italic">(no steam id)</span>}
					<ExtLink
						href={profile
							? profile.profileUrl
							: `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${playerId}&filter%5Bservers%5D=false&filter%5BplayerFlags%5D=&sort=score&showServers=true&method=quick`}
					>
						BattleMetrics
					</ExtLink>
					{!!profile?.hoursPlayed && <span title="Hours played on this org's servers">{profile.hoursPlayed}h</span>}
				</div>
			</div>
			<Separator />
			<div className="px-3 py-0.5 flex-1 min-h-0 flex flex-col">
				<div className="inline-flex items-baseline gap-1 justify-between w-full">
					<h3 className="inline">
						Server Activity
					</h3>
					<EventFilterSelect
						variant="ghost"
						value={filterState}
						options={PLAYER_DETAILS_FILTER_OPTIONS}
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
				<div className="relative flex-1 min-h-0">
					<ScrollArea ref={scrollAreaRef} className="h-full">
						<div ref={contentRef} className="flex flex-col gap-0.5 min-h-0 w-full max-w-175">
							{eventsQuery.isPending && filteredEvents.length === 0 && (
								<div className="flex items-center justify-center py-6">
									<Spinner className="size-5" />
								</div>
							)}
							{filteredEvents.map((e, i) => (
								<React.Fragment key={e.id}>
									<EventSeparator time={e.time} prevTime={i > 0 ? filteredEvents[i - 1].time : null} />
									<ServerEvent event={e} stores={stores} />
								</React.Fragment>
							))}
						</div>
					</ScrollArea>
					{eventsQuery.hasNextPage && isAtTop && (
						<Button
							onClick={() => {
								anchorForPrepend()
								void eventsQuery.fetchNextPage()
							}}
							disabled={eventsQuery.isFetchingNextPage}
							variant="secondary"
							style={{ zIndex: aboveChatZIndex }}
							className="absolute top-0 left-0 right-0 w-full h-6 shadow-lg flex items-center justify-center bg-opacity-20! rounded-none backdrop-blur-sm"
							title="Load older events"
						>
							{eventsQuery.isFetchingNextPage ? <Spinner className="h-3 w-3" /> : <Icons.ChevronUp className="h-3 w-3" />}
							<span className="text-xs">Load older events</span>
						</Button>
					)}
					{showScrollButton && (
						<Button
							onClick={() => scrollToBottom()}
							variant="secondary"
							style={{ zIndex: aboveChatZIndex }}
							className="absolute bottom-0 left-0 right-0 w-full h-6 shadow-lg flex items-center justify-center bg-opacity-20! rounded-none backdrop-blur-sm"
							title="Scroll to bottom"
						>
							<Icons.ChevronDown className="h-3 w-3" />
							<span className="text-xs">Scroll to bottom</span>
						</Button>
					)}
				</div>
			</div>
			{isOnline && (
				<div className="px-3 py-2 border-t border-border/50">
					<WarnChatBox
						serverId={serverId}
						playerIds={[playerId]}
						focusTarget={{ kind: 'player', playerId }}
						placeholder={`Warn ${ids?.username ?? 'player'}…`}
					/>
				</div>
			)}
		</div>
	)
}

// on-demand bust of this player's cached BM data; the fresh flags/profile arrive over the watch stream
function PlayerBmRefreshButton({ playerId }: { playerId: string }) {
	const refresh = useRefreshPlayerBmData()
	return (
		<button
			type="button"
			disabled={refresh.isPending}
			onClick={async () => {
				const res = await refresh.mutateAsync({ playerIds: [playerId] })
				if (res.failed.length > 0) toast.error('Failed to refresh BattleMetrics data')
			}}
			className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:pointer-events-none"
			title="Refresh BattleMetrics data"
		>
			<Icons.RefreshCw className={`h-3 w-3 ${refresh.isPending ? 'animate-spin' : ''}`} />
		</button>
	)
}

// active kick-timeout badge + cancel; rendered regardless of connection status since timeouts outlive the session
function PlayerTimeoutStatus({ playerId }: { playerId: string }) {
	const timeout = TimeoutsClient.useActiveTimeouts().find(t => t.playerId === playerId && !t.cancelled)
	const canCancel = TimeoutsClient.useMaxTimeout() !== undefined
	const cancelMutation = TimeoutsClient.useCancelTimeoutMutation()
	if (!timeout) return null
	return (
		<div className="flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1">
			<Icons.UserX className="h-3.5 w-3.5 text-red-500 shrink-0" />
			<span className="min-w-0 truncate">
				Timed out until {dateFns.format(timeout.expiresAt, 'PPp')}
				{timeout.reasonLabel ? ` (${timeout.reasonLabel})` : ''}
			</span>
			{canCancel && (
				<Button
					size="sm"
					variant="ghost"
					className="h-6 px-2 ml-auto shrink-0"
					title="Cancel this timeout"
					onClick={async () => {
						const res = await cancelMutation.mutateAsync({ timeoutId: timeout.id })
						if (res.code !== 'ok') toast.error('Cancel failed', { description: 'msg' in res && res.msg ? res.msg : res.code })
						else toast('Timeout cancelled')
					}}
				>
					Cancel
				</Button>
			)}
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

// events span many matches over potentially days, so rather than a raw timeline we punctuate it: a full
// date+time header before the first event, a date line whenever we cross a day boundary, and a "picked up N later"
// marker for any gap larger than this threshold within the same day.
const TIME_JUMP_THRESHOLD_MS = 15 * 60 * 1000

function playerEventsInfiniteOptions(serverId: string, playerId: string) {
	return RPC.orpc.matchHistory.getPlayerEvents.infiniteOptions({
		input: (cursor: number | undefined) => ({ serverId, playerId, cursor }),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (lastPage) => RPC.selectLoaded(lastPage)?.nextCursor,
	})
}

function formatDateLabel(time: number): string {
	if (dateFns.isToday(time)) return 'Today'
	if (dateFns.isYesterday(time)) return 'Yesterday'
	return dateFns.format(time, 'EEEE, MMMM d')
}

function formatGap(ms: number): string {
	const mins = Math.round(ms / 60_000)
	if (mins < 60) return `${mins}m`
	const hours = Math.floor(mins / 60)
	if (hours < 24) {
		const remMins = mins % 60
		return remMins ? `${hours}h ${remMins}m` : `${hours}h`
	}
	const days = Math.floor(hours / 24)
	const remHours = hours % 24
	return remHours ? `${days}d ${remHours}h` : `${days}d`
}

function EventSeparator({ time, prevTime }: { time: number; prevTime: number | null }) {
	if (prevTime === null) {
		return (
			<div className="flex flex-col items-center py-1 text-[10px] text-muted-foreground font-medium leading-tight">
				<span>{dateFns.format(time, 'EEEE, MMMM d, yyyy')}</span>
				<span className="font-mono">{dateFns.format(time, 'h:mm:ss a')}</span>
			</div>
		)
	}
	if (!dateFns.isSameDay(time, prevTime)) {
		return (
			<div className="flex items-center gap-2 px-2 py-1 text-[10px] text-muted-foreground font-medium">
				<div className="flex-1 h-px bg-border/50" />
				<span>{formatDateLabel(time)}</span>
				<div className="flex-1 h-px bg-border/50" />
			</div>
		)
	}
	if (time - prevTime > TIME_JUMP_THRESHOLD_MS) {
		return (
			<div className="flex items-center justify-center gap-1 px-2 py-0.5 text-[10px] text-muted-foreground italic">
				<Icons.ChevronsDown className="h-3 w-3 shrink-0" />
				<span>{formatGap(time - prevTime)} later, resuming {dateFns.format(time, 'h:mm a')}</span>
			</div>
		)
	}
	return null
}

interface PlayerFlagsListProps {
	flags: BM.PlayerFlag[]
}

function PlayerFlagsList({ flags }: PlayerFlagsListProps) {
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
					<PopoverContent className="w-auto max-w-md p-2">
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
