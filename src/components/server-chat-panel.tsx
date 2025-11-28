import { EventTime } from '@/components/event-time'
import { PlayerDisplay } from '@/components/player-display'
import ServerPlayerList from '@/components/server-state-panel'
import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import type * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import ShortLayerName from './short-layer-name'

const CHANNEL_STYLES = {
	ChatAll: { color: 'white', gradientColor: 'rgba(255, 255, 255, 0.1)' },
	ChatTeam: { color: 'rgb(59, 130, 246)', gradientColor: 'rgba(59, 130, 246, 0.1)' },
	ChatSquad: { color: 'rgb(34, 197, 94)', gradientColor: 'rgba(34, 197, 94, 0.1)' },
	ChatAdmin: { color: 'rgb(147, 197, 253)', gradientColor: 'rgba(147, 197, 253, 0.1)' },
} as const

function ChatMessageEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'CHAT_MESSAGE' }> }) {
	// Get team-specific color for team chats
	const getChannelStyle = () => {
		const baseStyle = CHANNEL_STYLES[event.channel.type]

		if (event.channel.type === 'ChatTeam') {
			const teamId = event.channel.teamId
			const teamColor = DH.getTeamColor(teamId, event.matchId, false)
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

	const channelStyle = getChannelStyle()

	const channelLabel = (() => {
		switch (event.channel.type) {
			case 'ChatAll':
				return 'all'
			case 'ChatTeam':
				return `T${event.channel.teamId} chat`
			case 'ChatSquad':
				return null // Will be rendered as JSX
			case 'ChatAdmin':
				return 'admin'
		}
	})()

	return (
		<div
			style={{
				display: 'flex',
				gap: '0.5rem',
				paddingTop: '0.25rem',
				paddingBottom: '0.25rem',
				fontSize: '0.75rem',
				width: '100%',
				minWidth: 0,
				borderRight: `2px solid ${channelStyle.color}`,
				backgroundImage: `linear-gradient(to left, transparent, ${channelStyle.gradientColor})`,
			}}
		>
			<EventTime time={event.time} />
			<div
				style={{ flexGrow: 1, minWidth: 0 }}
			>
				{event.channel.type === 'ChatSquad'
					? (
						<span style={{ color: channelStyle.color }}>
							(<SquadDisplay
								squad={{ squadId: event.channel.squadId, squadName: '', teamId: event.channel.teamId }}
								matchId={event.matchId}
								showName={false}
								showTeam={true}
							/>)
						</span>
					)
					: (
						<span
							style={{ color: channelStyle.color }}
							title={channelLabel ? `this message was sent in ${channelLabel} chat` : undefined}
						>
							({channelLabel})
						</span>
					)}{' '}
				<PlayerDisplay player={event.player} matchId={event.matchId} showTeam={['ChatAll', 'ChatAdmin'].includes(event.channel.type)} />
				: <span style={{ wordBreak: 'break-word' }}>{event.message}</span>
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
			<span className="text-xs flex items-center gap-1">
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
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Ban className="h-4 w-4 text-red-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> was banned. reason: "{event.interval}"
			</span>
		</div>
	)
}

function PlayerWarnedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WARNED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.AlertTriangle className="h-4 w-4 text-yellow-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> was warned: "{event.reason}"
			</span>
		</div>
	)
}

function NewGameEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'NEW_GAME' }> }) {
	const match = MatchHistoryClient.useRecentMatches().find(m => m.historyEntryId === event.matchId)
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Play className="h-4 w-4 text-green-500" />
			<span className="text-xs flex flex-col text-nowrap">
				<span>
					New game started
				</span>
				{match && <ShortLayerName layerId={match.layerId} teamParity={match.historyEntryId % 2} className="text-xs" />}
			</span>
		</div>
	)
}

function RoundEndedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'ROUND_ENDED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Flag className="h-4 w-4 text-blue-500" />
			<span className="text-xs">Round ended</span>
		</div>
	)
}

function AdminBroadcastEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'ADMIN_BROADCAST' }> }) {
	const fromDisplay = (() => {
		if (event.player) return <PlayerDisplay player={event.player} matchId={event.matchId} />
		if (event.from === 'RCON') {
			return <span className="text-yellow-400">RCON</span>
		}
		if (event.from === 'unknown') {
			return <span className="text-yellow-400/60">unknown</span>
		}
	})()

	return (
		<div className="flex gap-2 py-1 text-xs w-full min-w-0 border-r-2 bg-gradient-to-l to-transparent border-r-yellow-500 from-yellow-500/10">
			<EventTime time={event.time} />
			<div className="flex flex-wrap flex-grow items-start gap-x-2 min-w-0">
				<span className="text-yellow-500" title="admin broadcast message">
					(broadcast)
				</span>
				{fromDisplay}:
				<span className="break-words min-w-0 flex-shrink-0 whitespace-pre-wrap">{event.message}</span>
			</div>
		</div>
	)
}

function ResetEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'RESET' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.RotateCcw className="h-4 w-4 text-cyan-500" />
			<span className="text-xs">State reset</span>
		</div>
	)
}

function PlayerDetailsChangedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_DETAILS_CHANGED' }> }) {
	return null
}

function PlayerChangedTeamEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_CHANGED_TEAM' }> }) {
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
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.LogOut className="h-4 w-4 text-orange-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} /> left{' '}
				<SquadDisplay
					squad={{ squadId: event.squadId, squadName: '', teamId: event.teamId }}
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
					squad={{ squadId: event.squadId, squadName: '', teamId: event.teamId }}
					matchId={event.matchId}
					showName={false}
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
		case 'ADMIN_BROADCAST':
			return <AdminBroadcastEvent event={event} />
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
		default:
			assertNever(event)
	}
}

function ServerChatEvents() {
	const eventBuffer = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.eventBuffer)
	const bottomRef = React.useRef<HTMLDivElement>(null)
	const scrollAreaRef = React.useRef<HTMLDivElement>(null)
	const prevEventCount = React.useRef(0)
	const [showScrollButton, setShowScrollButton] = React.useState(false)
	const [newMessageCount, setNewMessageCount] = React.useState(0)

	const scrollToBottom = () => {
		bottomRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
		setNewMessageCount(0)
	}

	const checkIfAtBottom = () => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return false

		const threshold = 50 // pixels from bottom to consider "at bottom"
		const isAtBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < threshold
		return isAtBottom
	}

	// Auto-scroll when new events arrive if already at bottom
	React.useEffect(() => {
		if (eventBuffer.length > prevEventCount.current) {
			const newCount = eventBuffer.length - prevEventCount.current
			prevEventCount.current = eventBuffer.length
			if (checkIfAtBottom() && prevEventCount.current !== 0) {
				setTimeout(() => scrollToBottom(), 0)
			} else {
				setNewMessageCount(prev => prev + newCount)
			}
		}
	}, [eventBuffer])

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
		<ScrollArea className="h-[600px]" ref={scrollAreaRef}>
			<div className="flex flex-col gap-0.5 pr-4 w-full max-w-[600px] relative">
				{eventBuffer.length === 0
					? (
						<div className="text-muted-foreground text-sm text-center py-8">
							No events yet
						</div>
					)
					: (
						eventBuffer.map((event, idx) => <EventItem key={`${event.type}-${event.time.getTime()}-${idx}`} event={event} />)
					)}
				<div ref={bottomRef} />
				{showScrollButton && (
					<Button
						onClick={() => scrollToBottom()}
						variant="secondary"
						className="sticky bottom-0 left-0 right-0 h-8 shadow-lg flex items-center justify-center gap-2 z-10"
						title="Scroll to bottom"
					>
						<Icons.ChevronDown className="h-4 w-4" />
						<span className="text-xs">
							{newMessageCount > 0 ? `${newMessageCount} new event${newMessageCount === 1 ? '' : 's'}` : 'Scroll to bottom'}
						</span>
					</Button>
				)}
			</div>
		</ScrollArea>
	)
}

export default function ServerChatPanel() {
	const [isStatePanelOpen, setIsStatePanelOpen] = React.useState(true)

	return (
		<Card className="flex flex-col h-full">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Icons.Server className="h-5 w-5" />
					Server Activity
				</CardTitle>
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden">
				<div className="flex gap-4 h-[600px]">
					<div className="flex-1 overflow-hidden relative">
						<ServerChatEvents />
					</div>
					{isStatePanelOpen && (
						<div className="w-[240px] flex-shrink-0">
							<ServerPlayerList onClose={() => setIsStatePanelOpen(false)} />
						</div>
					)}
					{!isStatePanelOpen && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsStatePanelOpen(true)}
							className="h-8 px-2 flex-shrink-0"
							title="Show server state"
						>
							<Icons.ChevronLeft className="h-4 w-4" />
						</Button>
					)}
				</div>
			</CardContent>
		</Card>
	)
}
