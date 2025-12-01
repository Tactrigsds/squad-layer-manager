import EventFilterSelect from '@/components/event-filter-select'
import { EventTime } from '@/components/event-time'
import { PlayerDisplay } from '@/components/player-display'
import ServerPlayerList from '@/components/server-player-list.tsx'
import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import MapLayerDisplay from './map-layer-display.tsx'
import { ServerUnreachable } from './server-offline-display.tsx'
import ShortLayerName from './short-layer-name.tsx'

const CHANNEL_STYLES = {
	ChatAll: { color: 'white', gradientColor: 'rgba(255, 255, 255, 0.1)' },
	ChatTeam: { color: 'rgb(59, 130, 246)', gradientColor: 'rgba(59, 130, 246, 0.1)' },
	ChatSquad: { color: 'rgb(34, 197, 94)', gradientColor: 'rgba(34, 197, 94, 0.1)' },
	ChatAdmin: { color: 'rgb(147, 197, 253)', gradientColor: 'rgba(147, 197, 253, 0.1)' },
	Broadcast: { color: 'rgb(234, 179, 8)', gradientColor: 'rgba(234, 179, 8, 0.1)' }, // yellow-500
} as const

function ChatMessageEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'CHAT_MESSAGE' | 'ADMIN_BROADCAST' }> }) {
	const match = MatchHistoryClient.useRecentMatches().find(m => m.historyEntryId === event.matchId)
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, s => s.displayTeamsNormalized)

	// Get team-specific color for team chats
	const getChannelStyle = () => {
		// Admin broadcast gets yellow styling
		if (event.type === 'ADMIN_BROADCAST') {
			return CHANNEL_STYLES.Broadcast
		}

		const baseStyle = CHANNEL_STYLES[event.channel.type]

		if (event.channel.type === 'ChatTeam' && match) {
			const teamId = event.channel.teamId
			const teamColor = DH.getTeamColor(teamId, match.ordinal, displayTeamsNormalized)
			// Convert hex color to rgba for gradient
			const hexToRgba = (hex: string, alpha: number) => {
				const r = parseInt(hex.slice(1, 3), 16)
				const g = parseInt(hex.slice(3, 5), 16)
				const b = parseInt(hex.slice(5, 7), 16)
				return `rgba(${r}, ${g}, ${b}, ${alpha})`
			}
			return {
				color: teamColor,
				gradientColor: hexToRgba(teamColor, 0.1),
			}
		}

		return baseStyle
	}

	if (event.type === 'CHAT_MESSAGE' && event.player.teamId === null) return null
	const channelStyle = getChannelStyle()

	const channelLabel = (() => {
		if (event.type === 'ADMIN_BROADCAST') {
			return (
				<span
					style={{ color: channelStyle.color }}
					title="admin broadcast message"
				>
					(broadcast)
				</span>
			)
		}

		switch (event.channel.type) {
			case 'ChatAll':
				return (
					<span
						style={{ color: channelStyle.color }}
						title="this message was sent in all chat"
					>
						(all)
					</span>
				)
			case 'ChatTeam':
				return (
					<span className="inline-flex gap-0">
						(
						<span
							style={{ color: channelStyle.color }}
							className="flex items-baseline flex-nowrap whitespace-nowrap gap-1"
						>
							<MatchTeamDisplay matchId={event.matchId} teamId={event.player.teamId!} />
						</span>
						)
					</span>
				)
			case 'ChatSquad':
				return (
					<span className="inline-flex gap-0">
						(<span
							className="flex items-baseline flex-nowrap whitespace-nowrap gap-1"
							style={{ color: channelStyle.color }}
						>
							<SquadDisplay
								squad={{ squadId: event.channel.squadId, squadName: '', teamId: event.channel.teamId }}
								matchId={event.matchId}
								showName={false}
								showTeam={false}
							/>
							<MatchTeamDisplay matchId={event.matchId} teamId={event.player.teamId!} />
						</span>)
					</span>
				)
			case 'ChatAdmin':
				return (
					<span
						style={{ color: channelStyle.color }}
						title="this message was sent in admin chat"
					>
						(admin)
					</span>
				)
		}
	})()

	const fromDisplay = (() => {
		if (event.type === 'ADMIN_BROADCAST') {
			if (event.player) return <PlayerDisplay player={event.player} matchId={event.matchId} />
			if (event.from === 'RCON') {
				return <span className="text-red-400">RCON</span>
			}
			if (event.from === 'unknown') {
				return <span className="text-yellow-400/60">unknown</span>
			}
			return null
		}
		return (
			<PlayerDisplay
				player={event.player}
				matchId={event.matchId}
				showTeam={event.type === 'CHAT_MESSAGE' && ['ChatAdmin', 'ChatAll'].includes(event.channel.type)}
			/>
		)
	})()

	return (
		<div
			className="flex gap-2 py-1 text-xs w-full min-w-0 border-r-2 bg-gradient-to-l to-transparent items-baseline"
			style={{
				borderRightColor: channelStyle.color,
				backgroundImage: `linear-gradient(to left, ${channelStyle.gradientColor}, transparent)`,
			}}
		>
			<EventTime time={event.time} />
			<div className="flex-grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					{channelLabel}
					{fromDisplay}
				</span>
				: <span className="break-words">{event.message}</span>
			</div>
		</div>
	)
}
function PlayerConnectedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_CONNECTED' }> }) {
	return (
		<div className="flex items-start gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UserPlus className="h-4 w-4 text-green-500" />
			<span className="text-xs flex items-center gap-1 ">
				<span>
					<PlayerDisplay player={event.player} matchId={event.matchId} /> connected,
				</span>
				{event.player.teamId && (
					<>
						joining <MatchTeamDisplay teamId={event.player.teamId} matchId={event.matchId} />
					</>
				)}
			</span>
		</div>
	)
}

function PlayerDisconnectedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_DISCONNECTED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UserMinus className="h-4 w-4 text-red-500" />
			<span className="text-xs flex items-center gap-1 whitespace-nowrap">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> disconnected
			</span>
		</div>
	)
}

function PossessedAdminCameraEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'POSSESSED_ADMIN_CAMERA' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Camera className="h-4 w-4 text-purple-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> entered admin camera
			</span>
		</div>
	)
}

function UnpossessedAdminCameraEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'UNPOSSESSED_ADMIN_CAMERA' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.CameraOff className="h-4 w-4 text-purple-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> exited admin camera
			</span>
		</div>
	)
}

function PlayerKickedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_KICKED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UserX className="h-4 w-4 text-orange-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> was kicked
			</span>
		</div>
	)
}

function SquadCreatedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_CREATED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Users className="h-4 w-4 text-blue-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.creator} matchId={event.matchId} /> created{' '}
				<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={false} /> on{' '}
				<MatchTeamDisplay matchId={event.matchId} teamId={event.squad.teamId} />
			</span>
		</div>
	)
}

function PlayerBannedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_BANNED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
			<EventTime time={event.time} variant="small" />
			<Icons.Ban className="h-4 w-4 text-red-500 flex-shrink-0" />
			<div className="flex-grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					<PlayerDisplay player={event.player} matchId={event.matchId} /> was banned
				</span>
				reason: "<span className="break-words">{event.interval}</span>"
			</div>
		</div>
	)
}

function PlayerWarnedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WARNED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
			<EventTime time={event.time} variant="small" />
			<Icons.AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
			<div className="flex-grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					<PlayerDisplay player={event.player} matchId={event.matchId} /> was warned
				</span>
				: "<span className="break-words">{event.reason}</span>"
			</div>
		</div>
	)
}

function NewGameEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'NEW_GAME' }> }) {
	const match = MatchHistoryClient.useRecentMatches().find(m => m.historyEntryId === event.matchId)
	return (
		<div className="flex gap-2 py-1 text-muted-foreground items-center">
			<EventTime time={event.time} variant="small" />
			<Icons.Play className="h-4 w-4 text-green-500" />
			<span className="text-xs inline-flex flex-wrap items-center gap-1">
				<span>New game started:</span>
				{match && <ShortLayerName layerId={match.layerId} teamParity={match.ordinal % 2} className="text-xs" />}
			</span>
		</div>
	)
}

function RoundEndedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'ROUND_ENDED' }> }) {
	const match = MatchHistoryClient.useRecentMatches().find(m => m.historyEntryId === event.matchId)
	if (match?.status !== 'post-game') return null
	const winnerTickets = match.outcome.type === 'team1'
		? match.outcome.team1Tickets
		: match?.outcome.type === 'team2'
		? match.outcome.team2Tickets
		: 0
	const loserTickets = match?.outcome.type === 'team1'
		? match.outcome.team2Tickets
		: match?.outcome.type === 'team2'
		? match.outcome.team1Tickets
		: 0
	const winnerId = match?.outcome.type === 'team1' ? 1 : match?.outcome.type === 'team2' ? 2 : null
	const loserId = winnerId === 1 ? 2 : 1

	return (
		<div className="flex gap-2 py-1 text-muted-foreground items-center">
			<EventTime time={event.time} variant="small" />
			<Icons.Flag className="h-4 w-4 text-blue-500" />
			<span className="text-xs inline-flex flex-wrap items-center gap-1">
				<span>Round ended</span>
				<span>
					(<MapLayerDisplay layer={L.toLayer(match.layerId).Layer} className="text-xs font-semibold" />)
				</span>
				{winnerId === null && <span className="text-yellow-400">Draw</span>}
				{winnerId !== null && (
					<>
						<MatchTeamDisplay matchId={event.matchId} teamId={winnerId} /> won
						<span className="font-semibold">{winnerTickets} to {loserTickets}</span>
						against <MatchTeamDisplay matchId={event.matchId} teamId={loserId} />
					</>
				)}
			</span>
		</div>
	)
}

function ResetEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'RESET' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.RotateCcw className="h-4 w-4 text-cyan-500" />
			<span className="text-xs">{event.reason === 'slm-started' ? 'Application start' : 'RCON Reconnected'}</span>
		</div>
	)
}

function PlayerDetailsChangedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_DETAILS_CHANGED' }> }) {
	return null
}

function PlayerChangedTeamEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_CHANGED_TEAM' }> }) {
	// don't render unassigned, and if the player was previously unassigned that means we're swapping teams after the match, so no need to render
	if (event.newTeamId === null || event.prevTeamId === null) return
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Repeat className="h-4 w-4 text-purple-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> changed to{' '}
				<MatchTeamDisplay teamId={event.player.teamId!} matchId={event.matchId} />
			</span>
		</div>
	)
}

function PlayerLeftSquadEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_LEFT_SQUAD' }> }) {
	// server is rolling
	if (event.teamId === null) return null
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.LogOut className="h-4 w-4 text-orange-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> left{' '}
				<SquadDisplay
					squad={event.squad}
					matchId={event.matchId}
					showName={false}
					showTeam={true}
				/>{' '}
				{event.wasLeader ? '(was leader)' : ''}
			</span>
		</div>
	)
}

function SquadDisbandedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_DISBANDED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UsersRound className="h-4 w-4 text-red-400" />
			<span className="text-xs flex items-center gap-1">
				<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={true} /> was disbanded
			</span>
		</div>
	)
}

function PlayerJoinedSquadEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_JOINED_SQUAD' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.LogIn className="h-4 w-4 text-green-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> joined{' '}
				<SquadDisplay
					squad={event.squad}
					matchId={event.matchId}
					showTeam={true}
				/>
			</span>
		</div>
	)
}

function PlayerPromotedToLeaderEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_PROMOTED_TO_LEADER' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Crown className="h-4 w-4 text-yellow-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> promoted to squad leader
			</span>
		</div>
	)
}
function EventItem({ event }: { event: CHAT.EventEnriched }) {
	switch (event.type) {
		case 'CHAT_MESSAGE':
		case 'ADMIN_BROADCAST':
			return <ChatMessageEvent event={event} />
		case 'PLAYER_CONNECTED':
			return <PlayerConnectedEvent event={event} />
		case 'PLAYER_DISCONNECTED':
			return <PlayerDisconnectedEvent event={event} />
		case 'POSSESSED_ADMIN_CAMERA':
			return <PossessedAdminCameraEvent event={event} />
		case 'UNPOSSESSED_ADMIN_CAMERA':
			return <UnpossessedAdminCameraEvent event={event} />
		case 'PLAYER_KICKED':
			return <PlayerKickedEvent event={event} />
		case 'SQUAD_CREATED':
			return <SquadCreatedEvent event={event} />
		case 'PLAYER_BANNED':
			return <PlayerBannedEvent event={event} />
		case 'PLAYER_WARNED':
			return <PlayerWarnedEvent event={event} />
		case 'NEW_GAME':
			return <NewGameEvent event={event} />
		case 'ROUND_ENDED':
			return <RoundEndedEvent event={event} />
		case 'RESET':
			return <ResetEvent event={event} />
		case 'PLAYER_DETAILS_CHANGED':
			return <PlayerDetailsChangedEvent event={event} />
		case 'PLAYER_CHANGED_TEAM':
			return <PlayerChangedTeamEvent event={event} />
		case 'PLAYER_LEFT_SQUAD':
			return <PlayerLeftSquadEvent event={event} />
		case 'SQUAD_DISBANDED':
			return <SquadDisbandedEvent event={event} />
		case 'PLAYER_JOINED_SQUAD':
			return <PlayerJoinedSquadEvent event={event} />
		case 'PLAYER_PROMOTED_TO_LEADER':
			return <PlayerPromotedToLeaderEvent event={event} />
		case 'NOOP':
			return null
		default:
			assertNever(event)
	}
}

function ServerChatEvents(props: { className?: string; onToggleStatePanel?: () => void; isStatePanelOpen?: boolean }) {
	const eventBuffer = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.synced ? s.chatState.eventBuffer : null)
	const synced = eventBuffer !== null
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.eventFilterState)
	const bottomRef = React.useRef<HTMLDivElement>(null)
	const scrollAreaRef = React.useRef<HTMLDivElement>(null)
	const hasScrolledInitially = React.useRef(false)
	const eventsContainerRef = React.useRef<HTMLDivElement>(null)
	const [showScrollButton, setShowScrollButton] = React.useState(false)
	const [newMessageCount, setNewMessageCount] = React.useState(0)

	// Filter events based on the selected filter
	const filteredEvents = React.useMemo(() => {
		if (!synced) {
			return null
		}

		if (eventFilterState === 'ALL') {
			return eventBuffer
		}

		if (eventFilterState === 'CHAT') {
			// Show only chat messages and broadcasts
			return eventBuffer.filter(event => event.type === 'CHAT_MESSAGE' || event.type === 'ADMIN_BROADCAST')
		}

		if (eventFilterState === 'ADMIN') {
			// Show only admin chat messages and broadcasts
			return eventBuffer.filter(event => {
				if (event.type === 'ADMIN_BROADCAST' && event.from !== 'RCON') return true
				if (event.type === 'CHAT_MESSAGE' && event.channel.type === 'ChatAdmin') return true
				return false
			})
		}

		return eventBuffer
	}, [eventBuffer, eventFilterState, synced])

	const scrollToBottom = () => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (scrollElement) {
			scrollElement.scrollTop = scrollElement.scrollHeight
		}
		setNewMessageCount(0)
	}

	const checkIfAtBottom = () => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return false

		const threshold = 50 // pixels from bottom to consider "at bottom"
		const { scrollHeight, scrollTop, clientHeight } = scrollElement
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight

		const isAtBottom = distanceFromBottom < threshold
		return isAtBottom
	}

	// Scroll to bottom on initial render and when new events arrive if already at bottom
	// Scroll to bottom when scroll area content changes (via ResizeObserver)
	React.useEffect(() => {
		const scrollElement = eventsContainerRef.current
		if (!scrollElement) return

		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				if (hasScrolledInitially.current || checkIfAtBottom()) {
					hasScrolledInitially.current = true
					// Use requestAnimationFrame to ensure DOM has updated
					scrollToBottom()
				}
			})
		})
		requestAnimationFrame(() => {
			scrollToBottom()
		})

		resizeObserver.observe(scrollElement)

		return () => resizeObserver.disconnect()
	}, [])

	// Listen to scroll events to show/hide button
	React.useEffect(() => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return

		const handleScroll = () => {
			const atBottom = checkIfAtBottom()
			setShowScrollButton(!atBottom)
			if (atBottom) {
				setNewMessageCount(0)
			}
		}

		scrollElement.addEventListener('scroll', handleScroll)
		handleScroll() // Initial check

		return () => scrollElement.removeEventListener('scroll', handleScroll)
	}, [])

	return (
		<div className="h-full w-full relative">
			{!synced && (
				<div className="absolute inset-0 z-30 bg-background/80 backdrop-blur-sm flex items-center justify-center">
					<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}
			{props.onToggleStatePanel && (
				<Button
					variant="ghost"
					size="sm"
					onClick={props.onToggleStatePanel}
					className="h-8 w-6 p-0 absolute top-0 right-0 z-20"
					title={`${props.isStatePanelOpen ? 'Hide' : 'Show'} player list`}
				>
					{props.isStatePanelOpen ? <Icons.ChevronRight className="h-3 w-3" /> : <Icons.ChevronLeft className="h-3 w-3" />}
				</Button>
			)}
			<ScrollArea className={props.className} ref={scrollAreaRef}>
				{/* it's important that the only things which can significantly resize the scrollarea are in this container, otherwise the autoscroll will break */}
				<div ref={eventsContainerRef} className="flex flex-col gap-0.5 pr-4 min-h-0 w-full">
					{filteredEvents && filteredEvents.length === 0 && (
						<div className="text-muted-foreground text-sm text-center py-8">
							No events yet
						</div>
					)}
					{filteredEvents
						&& filteredEvents.map((event, idx) => <EventItem key={`${event.type}-${event.time}-${idx}`} event={event} />)}
				</div>
				<div ref={bottomRef} />
				{showScrollButton && (
					<Button
						onClick={() => scrollToBottom()}
						variant="secondary"
						className="absolute bottom-0 left-0 right-0 w-full h-8 shadow-lg flex items-center justify-center gap-2 z-10 bg-opacity-20! rounded-none backdrop-blur-sm"
						title="Scroll to bottom"
					>
						<Icons.ChevronDown className="h-4 w-4" />
						<span className="text-xs">
							{newMessageCount > 0 ? `${newMessageCount} new event${newMessageCount === 1 ? '' : 's'}` : 'Scroll to bottom'}
						</span>
					</Button>
				)}
			</ScrollArea>
		</div>
	)
}

function ServerCounts() {
	const serverInfoStatusRes = SquadServerClient.useServerInfoRes()

	if (serverInfoStatusRes.code !== 'ok') return <ServerUnreachable statusRes={serverInfoStatusRes} />

	const serverInfo = serverInfoStatusRes.data

	return (
		<div className="inline-flex text-muted-foreground space-x-2 items-baseline text-sm">
			{serverInfo.playerCount} / {serverInfo.maxPlayerCount} online, {serverInfo.queueLength} / {serverInfo.maxQueueLength} in queue
		</div>
	)
}

const AUTO_CLOSE_WIDTH_THRESHOLD = 1350 // pixels
const AUTO_OPEN_WIDTH_THRESHOLD = AUTO_CLOSE_WIDTH_THRESHOLD * 1.2 // 20% above threshold (1620 pixels)

export default function ServerActivityPanel() {
	const [isStatePanelOpen, setIsStatePanelOpen] = React.useState(window.innerWidth >= AUTO_CLOSE_WIDTH_THRESHOLD)
	const cardRef = React.useRef<HTMLDivElement>(null)
	const [maxHeight, setMaxHeight] = React.useState<number | null>(null)
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.eventFilterState)
	const setEventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.setEventFilterState)
	const synced = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.synced)

	// Track viewport width state for auto-closing/opening the panel
	const hasBeenAboveThresholdRef = React.useRef(window.innerWidth >= AUTO_CLOSE_WIDTH_THRESHOLD)
	const userManuallyClosed = React.useRef(false)

	React.useEffect(() => {
		const calculateMaxHeight = () => {
			if (!cardRef.current) return

			const rect = cardRef.current.getBoundingClientRect()
			const viewportHeight = window.innerHeight
			const topOffset = rect.top
			const bottomPadding = 16 // Some breathing room at the bottom

			const availableHeight = viewportHeight - topOffset - bottomPadding
			setMaxHeight(availableHeight)
		}

		const handleResize = () => {
			calculateMaxHeight()

			const currentWidth = window.innerWidth
			const isAboveThreshold = currentWidth >= AUTO_CLOSE_WIDTH_THRESHOLD
			const isAboveAutoOpenThreshold = currentWidth >= AUTO_OPEN_WIDTH_THRESHOLD

			// Auto-open if we're 20% above the threshold, panel is closed, and user hasn't manually closed it
			if (isAboveAutoOpenThreshold && !isStatePanelOpen && !userManuallyClosed.current) {
				setIsStatePanelOpen(true)
				hasBeenAboveThresholdRef.current = true
				return
			}

			// If we've crossed above the threshold, mark it
			if (isAboveThreshold) {
				hasBeenAboveThresholdRef.current = true
			}

			// Only auto-close if:
			// 1. We're below the threshold
			// 2. We've been above the threshold at some point (this prevents auto-close if user manually opened while below)
			// 3. The panel is currently open
			if (!isAboveThreshold && hasBeenAboveThresholdRef.current && isStatePanelOpen) {
				setIsStatePanelOpen(false)
				// Reset the flag so if user manually opens, we won't auto-close again until they resize above threshold
				hasBeenAboveThresholdRef.current = false
				// Reset manual close flag when we auto-close
				userManuallyClosed.current = false
			}
		}

		// Calculate on mount and window resize
		calculateMaxHeight()
		handleResize()
		window.addEventListener('resize', handleResize)

		return () => window.removeEventListener('resize', handleResize)
	}, [isStatePanelOpen])

	return (
		<Card
			ref={cardRef}
			className="flex flex-col"
			style={{ height: maxHeight ? `${maxHeight}px` : 'auto' }}
		>
			<CardHeader className="flex flex-row justify-between flex-shrink-0 items-center pb-3">
				<div className="flex items-center gap-4">
					<CardTitle className="flex items-center gap-2">
						<Icons.Server className="h-5 w-5" />
						Server Activity
					</CardTitle>
					<EventFilterSelect value={eventFilterState} onValueChange={setEventFilterState} />
				</div>
				<ServerCounts />
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden w-full min-h-[10em]">
				<div className="flex gap-0.5 h-full">
					<ServerChatEvents
						className="flex-1 min-w-[350px] max-w-[750px] h-full"
						onToggleStatePanel={() => {
							const newState = !isStatePanelOpen
							setIsStatePanelOpen(newState)
							// Track if user manually closed the panel while above auto-open threshold
							if (!newState && window.innerWidth >= AUTO_OPEN_WIDTH_THRESHOLD) {
								userManuallyClosed.current = true
							} else if (newState) {
								// User manually opened it, reset the flag
								userManuallyClosed.current = false
							}
						}}
						isStatePanelOpen={isStatePanelOpen}
					/>
					{isStatePanelOpen && synced && (
						<div className="w-[240px] flex-shrink-0">
							<ServerPlayerList />
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	)
}
