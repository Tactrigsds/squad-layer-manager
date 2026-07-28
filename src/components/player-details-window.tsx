import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'

import { PlayerFlagsButton } from '@/components/bm-flag-workflows'
import { DiscordMemberSelect } from '@/components/discord-picker'
import EventFilterSelect from '@/components/event-filter-select'
import { PlayerMenuItems } from '@/components/player-context-menu-options'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as ChatPrt from '@/frame-partials/chat.partial'
import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as BM_Msgs from '@/messages/battlemetrics.messages'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as USR_Msgs from '@/messages/users.messages'
import * as BM from '@/models/battlemetrics.models'
import * as CHAT from '@/models/chat.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import { useOrgFlags, usePlayerGroupColor, useRefreshPlayerBmData } from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as RbacClient from '@/systems/rbac.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as UsersClient from '@/systems/users.client'

import { CopyIdButton } from './copy-id-button'
import type { PlayerDetailsWindowProps } from './player-details-window.helpers'
import { ServerEvent } from './server-event'
import {
	DraggableWindowClose,
	DraggableWindowDragBar,
	DraggableWindowPinToggle,
	DraggableWindowTitle,
	useDraggableWindow,
} from './ui/draggable-window'
import { Separator } from './ui/separator'
import { Spinner } from './ui/spinner'
import WarnChatBox from './warn-chat-box'

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
			RPC.queryClient.fetchQuery(
				RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId: props.playerId }, staleTime: Infinity }),
			),
		])
	},
})

function PlayerDetailsWindow({ playerId, stores }: PlayerDetailsWindowProps) {
	const squadServerFrameKey = stores.squadServer
	const serverId = squadServerFrameKey.serverId
	const { data } = useQuery(
		RPC.orpc.matchHistory.getPlayerDetails.queryOptions({
			input: { serverId, playerId },
			select: (res) => RPC.selectLoaded(res),
		}),
	)
	// the window opens on the current match alone, which the chat feed already holds; earlier matches are fetched only
	// once asked for, a page (several matches) at a time
	const [historyRequested, setHistoryRequested] = React.useState(false)
	const eventsQuery = useInfiniteQuery({ ...playerEventsInfiniteOptions(serverId, playerId), enabled: historyRequested })
	const preloadHistory = () => {
		void RPC.queryClient.prefetchInfiniteQuery(playerEventsInfiniteOptions(serverId, playerId))
	}
	const { data: bmData } = useQuery(RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId }, staleTime: Infinity }))
	const orgFlags = useOrgFlags()
	const flags = bmData && orgFlags ? BM.resolveFlags(bmData.flagIds, orgFlags) : undefined
	const profile = bmData ? (({ flagIds: _, ...rest }) => rest)(bmData) : null
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const currentMatchEvents = Zus.useStore(
		squadServerFrameKey,
		Zus.useShallow((s) =>
			currentMatch
				? ChatPrt.Sel.chatEvents(s).filter(
						(e) => e.matchId === currentMatch.historyEntryId && (e.type === 'NEW_GAME' || CHAT.hasAssocPlayer(e, playerId)),
					)
				: [],
		),
	)

	// pages arrive most-recent-match first; reverse to interleave chronologically ahead of the live current-match events.
	// gated on the request rather than on the data, so hovering the button warms the cache without the feed jumping.
	const historicalEvents = (historyRequested ? (eventsQuery.data?.pages ?? []) : [])
		.slice()
		.reverse()
		.flatMap((p) => RPC.selectLoaded(p)?.events ?? [])
	const allEvents = [...historicalEvents, ...currentMatchEvents]
	// while the player is connected we render their full details; once they aren't, only what a RecentPlayer carries
	// (their ids, and that they're an admin) is still true of them, so team/squad/role drop off rather than going stale.
	const livePlayer = Zus.useStore(squadServerFrameKey, (s) => ChatPrt.Sel.player(playerId)(s) ?? null)
	const recentPlayer = Zus.useStore(squadServerFrameKey, (s) => ChatPrt.Sel.recentPlayer(playerId)(s) ?? null)
	const ids = livePlayer?.ids ?? recentPlayer?.ids
	const groupColor = usePlayerGroupColor(playerId, livePlayer ?? recentPlayer ?? undefined)

	const connectionStatus = data?.connectionStatus ?? null
	const elapsed = useElapsed(connectionStatus?.status === 'online' ? connectionStatus.connectedSince : null)
	const isOnline = !!livePlayer
	const [filterState, setFilterState] = React.useState<CHAT.SecondaryFilterState>('DEFAULT')
	const filteredEvents = allEvents.filter((e) => CHAT.isRenderableInFeed(e) && CHAT.showEventInFeed(e, filterState))
	const { scrollAreaRef, contentRef, showScrollButton, isAtTop, scrollToBottom, anchorForPrepend } = useTailingScroll()
	const { setIsPinned } = useDraggableWindow()
	const aboveChatZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle style={groupColor ? { color: groupColor } : undefined}>
					{ids?.username ?? SM_Msgs.playerDetailsTitle().text()}
					{livePlayer && (livePlayer.teamId !== null || livePlayer.squadId !== null) && (
						<span className="text-muted-foreground font-normal ml-1">
							(
							{livePlayer.teamId !== null && currentMatch ? (
								<>
									<MatchTeamDisplay matchId={currentMatch.historyEntryId} teamId={livePlayer.teamId} stores={stores} />
									{livePlayer.squadId !== null && ', '}
								</>
							) : null}
							{livePlayer.squadId !== null && SM_Msgs.squadWithId(livePlayer.squadId).text()})
						</span>
					)}
				</DraggableWindowTitle>
				{connectionStatus &&
					(connectionStatus.status === 'online' ? (
						<span className="h-2 w-2 rounded-full bg-green-500 shrink-0" title={SM_Msgs.onlineFor(elapsed).text()} />
					) : (
						<span
							className="h-2 w-2 rounded-full bg-muted-foreground shrink-0"
							title={
								connectionStatus.lastSeen
									? SM_Msgs.lastSeen(dateFns.formatDistanceToNow(connectionStatus.lastSeen, { addSuffix: true })).text()
									: SM_Msgs.offline().text()
							}
						/>
					))}
				{flags && flags.length > 0 && <PlayerFlagsList flags={flags} />}
				<PlayerBmRefreshButton playerId={playerId} />
				<PlayerFlagsButton playerId={playerId} />
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
							title={SM_Msgs.playerActions().text()}
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
					<CopyIdButton kind="eos" id={playerId} />
					{(ids?.steam ?? profile?.playerIds.steam) && <CopyIdButton kind="steam" id={(ids?.steam ?? profile?.playerIds.steam)!} />}
					{ids?.epic && <CopyIdButton kind="epic" id={ids.epic} />}
				</div>
				<div className="flex items-center gap-2 text-muted-foreground">
					{(ids?.steam ?? profile?.playerIds.steam) ? (
						<>
							<ExtLink href={`https://steamcommunity.com/profiles/${ids?.steam ?? profile?.playerIds.steam}`}>
								{SM_Msgs.linkNames.steam}
							</ExtLink>
							<ExtLink href={`https://communitybanlist.com/search/${ids?.steam ?? profile?.playerIds.steam}`}>
								{SM_Msgs.linkNames.cbl}
							</ExtLink>
							<ExtLink href={`https://mysquadstats.com/search/${ids?.steam ?? profile?.playerIds.steam}#vanillaStats`}>
								{SM_Msgs.linkNames.mySquadStats}
							</ExtLink>
						</>
					) : (
						<span className="italic">{SM_Msgs.noSteamId().text()}</span>
					)}
					<ExtLink
						href={
							profile
								? profile.profileUrl
								: `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${playerId}&filter%5Bservers%5D=false&filter%5BplayerFlags%5D=&sort=score&showServers=true&method=quick`
						}
					>
						{SM_Msgs.linkNames.battlemetrics}
					</ExtLink>
					{!!profile?.hoursPlayed && (
						<span title={BM_Msgs.hoursPlayedHint().text()}>{BM_Msgs.hoursPlayed(profile.hoursPlayed).text()}</span>
					)}
				</div>
				<PlayerDiscordLink steamId={ids?.steam ?? profile?.playerIds.steam} />
			</div>
			<Separator />
			<div className="px-3 py-0.5 flex-1 min-h-0 flex flex-col">
				<div className="inline-flex items-baseline gap-1 justify-between w-full">
					<h3 className="inline">{CHAT_Msgs.activityTitle().text()}</h3>
					<EventFilterSelect
						variant="ghost"
						value={filterState}
						onOpenChange={(open) => {
							// hack to get around close on click-out behaviour. TODO find better pattern
							if (open) setIsPinned(true)
						}}
						onValueChange={(v) => {
							setFilterState(v)
							setIsPinned(true)
						}}
					/>
				</div>
				<div className="relative flex-1 min-h-0">
					<ScrollArea ref={scrollAreaRef} className="h-full">
						<div ref={contentRef} className="flex flex-col gap-0.5 min-h-0 w-full max-w-175">
							{eventsQuery.isFetching && filteredEvents.length === 0 && (
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
					{(!historyRequested || eventsQuery.hasNextPage) && isAtTop && (
						<Button
							onMouseEnter={preloadHistory}
							onFocus={preloadHistory}
							onClick={() => {
								anchorForPrepend()
								if (!historyRequested) setHistoryRequested(true)
								else void eventsQuery.fetchNextPage()
							}}
							disabled={eventsQuery.isFetching}
							variant="secondary"
							style={{ zIndex: aboveChatZIndex }}
							className="absolute top-0 left-0 right-0 w-full h-6 shadow-lg flex items-center justify-center bg-opacity-20! rounded-none backdrop-blur-sm"
							title={CHAT_Msgs.loadOlderEvents().text()}
						>
							{eventsQuery.isFetching ? <Spinner className="h-3 w-3" /> : <Icons.ChevronUp className="h-3 w-3" />}
							<span className="text-xs">{CHAT_Msgs.loadOlderEvents().text()}</span>
						</Button>
					)}
					{historyRequested && !eventsQuery.hasNextPage && !eventsQuery.isFetching && isAtTop && (
						<div
							style={{ zIndex: aboveChatZIndex }}
							className="absolute top-0 left-0 right-0 w-full h-6 flex items-center justify-center text-xs text-muted-foreground backdrop-blur-sm"
						>
							{CHAT_Msgs.noMoreEvents().text()}
						</div>
					)}
					{showScrollButton && (
						<Button
							onClick={() => scrollToBottom()}
							variant="secondary"
							style={{ zIndex: aboveChatZIndex }}
							className="absolute bottom-0 left-0 right-0 w-full h-6 shadow-lg flex items-center justify-center bg-opacity-20! rounded-none backdrop-blur-sm"
							title={CHAT_Msgs.scrollToBottom().text()}
						>
							<Icons.ChevronDown className="h-3 w-3" />
							<span className="text-xs">{CHAT_Msgs.scrollToBottom().text()}</span>
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
						placeholder={SM_Msgs.warnPlayerPlaceholder(ids?.username ?? SM_Msgs.unnamedPlayer().text()).text()}
						stores={stores}
					/>
				</div>
			)}
		</div>
	)
}

// The discord account this player's steam account is linked to, and the controls to change it. Rendered only for
// holders of users:manage-steam-links: the link decides what both identities are entitled to, and it puts a discord
// name to somebody who has not chosen to show one here.
//
// The picker searches the home guild alone, so an account outside it cannot be linked -- one SLM cannot resolve
// carries no name to show and no roles for a grouping rule to read.
function PlayerDiscordLink({ steamId }: { steamId: string | undefined }) {
	const denied = RbacClient.usePermsCheck(RBAC.perm('users:manage-steam-links'))
	const discordEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.discordEnabled)
	const linkQuery = UsersClient.useSteamAccountLink(denied ? undefined : steamId)
	const assign = UsersClient.useAssignSteamLinkMutation()
	const remove = UsersClient.useRemoveSteamLinkMutation()
	const [picked, setPicked] = React.useState('')

	// a link points at a home-guild member, which is nobody without the guild to resolve them from
	if (denied || !steamId || !discordEnabled) return null
	const link = linkQuery.data?.code === 'ok' ? linkQuery.data.link : null
	const pending = assign.isPending || remove.isPending

	async function onAssign(discordId: string) {
		setPicked(discordId)
		if (!discordId || !steamId) return
		const res = await assign.mutateAsync({ steamId, discordId })
		if (res.code === 'ok') {
			toast(...USR_Msgs.steamLinkAssigned(discordId).toast())
			setPicked('')
		} else if (res.code === 'err:not-a-guild-member') {
			toast.error(...USR_Msgs.steamLinkNotAGuildMember(discordId).toast())
		} else if (res.code === 'err:steam-already-linked') {
			toast.error(...USR_Msgs.steamIdAlreadyLinked(steamId).toast())
		} else {
			toast.error(...USR_Msgs.steamLinkFailed().toast())
		}
	}

	async function onRemove() {
		if (!steamId) return
		const res = await remove.mutateAsync({ steamId })
		if (res.code === 'ok') toast(...USR_Msgs.steamLinkRemoved().toast())
		else toast.error(...USR_Msgs.steamLinkFailed().toast())
	}

	return (
		<div className="flex items-center gap-2">
			<span className="text-muted-foreground shrink-0">{USR_Msgs.discordLabel().text()}</span>
			{link ? (
				<>
					<span className="truncate" title={link.discordId}>
						{link.discordUsername}
					</span>
					<span className="text-muted-foreground shrink-0">
						{link.origin === 'assigned' ? USR_Msgs.linkedBy(link.linkedBy?.displayName).text() : USR_Msgs.selfLinked().text()}
					</span>
					<Button type="button" size="sm" variant="ghost" className="h-6 px-1 text-destructive" disabled={pending} onClick={onRemove}>
						{USR_Msgs.unlink().text()}
					</Button>
				</>
			) : (
				<div className="min-w-0 flex-1">
					<DiscordMemberSelect value={picked} onChange={onAssign} disabled={pending} />
				</div>
			)}
		</div>
	)
}

// on-demand bust of this player's cached BM data; the fresh flags/profile arrive over the watch stream
function PlayerBmRefreshButton({ playerId }: { playerId: string }) {
	const bmEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.battlemetricsEnabled)
	const refresh = useRefreshPlayerBmData()
	if (!bmEnabled) return null
	return (
		<button
			type="button"
			disabled={refresh.isPending}
			onClick={async () => {
				const res = await refresh.mutateAsync({ playerIds: [playerId] })
				if (res.failed.length > 0) toast.error(...BM_Msgs.refreshFailed().toast())
			}}
			className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:pointer-events-none"
			title={BM_Msgs.refreshHint().text()}
		>
			<Icons.RefreshCw className={`h-3 w-3 ${refresh.isPending ? 'animate-spin' : ''}`} />
		</button>
	)
}

// active kick-timeout badge + cancel; rendered regardless of connection status since timeouts outlive the session
function PlayerTimeoutStatus({ playerId }: { playerId: string }) {
	const timeout = TimeoutsClient.useActiveTimeouts().find((t) => t.playerId === playerId && !t.cancelled)
	const canCancel = TimeoutsClient.useCanCancelSomeTimeout()
	const cancelMutation = TimeoutsClient.useCancelTimeoutMutation()
	if (!timeout) return null
	return (
		<div className="flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1">
			<Icons.UserX className="h-3.5 w-3.5 text-red-500 shrink-0" />
			<span className="min-w-0 truncate">
				{SM_Msgs.timedOutUntil(dateFns.format(timeout.expiresAt, 'PPp'), timeout.reasonLabel ?? undefined).text()}
			</span>
			{canCancel && (
				<Button
					size="sm"
					variant="ghost"
					className="h-6 px-2 ml-auto shrink-0"
					title={SM_Msgs.cancelTimeoutHint().text()}
					onClick={async () => {
						const res = await cancelMutation.mutateAsync({ timeoutId: timeout.id })
						if (res.code !== 'ok') toast.error(...SM_Msgs.cancelTimeoutFailed('msg' in res && res.msg ? res.msg : res.code).toast())
						else toast(...SM_Msgs.timeoutCancelled().toast())
					}}
				>
					{SM_Msgs.cancelTimeout().text()}
				</Button>
			)}
		</div>
	)
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-blue-400 hover:underline">
			{children}
			<Icons.ExternalLink className="h-2.5 w-2.5" />
		</a>
	)
}

function useElapsed(since: number | null): string | null {
	const [, setTick] = React.useState(0)
	React.useEffect(() => {
		if (since === null) return
		const id = setInterval(() => setTick((t) => t + 1), 30_000)
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
				<span>{SM_Msgs.feedGap(formatGap(time - prevTime), dateFns.format(time, 'h:mm a')).text()}</span>
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

		for (let i = 0; i < children.length - 1; i++) {
			// -1 to exclude the ellipsis button
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
					{flag.icon && (
						<span className="material-symbols-outlined leading-none" style={{ fontSize: '12px' }}>
							{flag.icon}
						</span>
					)}
					{flag.name}
				</span>
			))}
			{hasOverflow && (
				<Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="inline-flex items-center gap-0.5 rounded px-1 py-0 text-[10px] font-medium leading-tight shrink-0 bg-muted hover:bg-muted/80 transition-colors"
							title={BM_Msgs.showAllFlags().text()}
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
									{flag.icon && (
										<span className="material-symbols-outlined leading-none" style={{ fontSize: '12px' }}>
											{flag.icon}
										</span>
									)}
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
						{flag.icon && (
							<span className="material-symbols-outlined leading-none" style={{ fontSize: '12px' }}>
								{flag.icon}
							</span>
						)}
						{flag.name}
					</span>
				))}
			</div>
		</div>
	)
}
