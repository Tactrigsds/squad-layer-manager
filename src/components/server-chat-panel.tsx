import { EventTime } from '@/components/event-time'
import { PlayerDisplay } from '@/components/player-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
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
	ChatAll: { border: 'border-r-white', text: 'text-white', gradient: 'from-white/10' },
	ChatTeam: { border: 'border-r-blue-500', text: 'text-blue-500', gradient: 'from-blue-500/10' },
	ChatSquad: { border: 'border-r-green-500', text: 'text-green-500', gradient: 'from-green-500/10' },
	ChatAdmin: { border: 'border-r-blue-300', text: 'text-blue-300', gradient: 'from-blue-300/10' },
} as const

function ChatMessageEvent({ event }: { event: Extract<CHAT.Event, { type: 'CHAT_MESSAGE' }> }) {
	const channelStyle = CHANNEL_STYLES[event.channel.type]

	const channelLabel = (() => {
		switch (event.channel.type) {
			case 'ChatAll':
				return 'all'
			case 'ChatTeam':
				return `T${event.channel.teamId} chat`
			case 'ChatSquad':
				return `squad ${event.channel.teamId}-${event.channel.squadId}`
			case 'ChatAdmin':
				return 'admin'
		}
	})()

	return (
		<div
			className={`flex gap-2 py-1 text-xs w-full min-w-0 border-r-2 bg-gradient-to-l to-transparent ${channelStyle.border} ${channelStyle.gradient}`}
		>
			<EventTime time={event.time} />
			<div className="flex flex-wrap flex-grow items-start gap-x-2 min-w-0">
				<span className={channelStyle.text} title={`this message was sent in ${channelLabel} chat`}>
					({channelLabel})
				</span>
				<PlayerDisplay player={event.player} matchId={event.matchId} showTeam />:
				<span className="break-words min-w-0 flex-shrink-0">{event.message}</span>
			</div>
		</div>
	)
}

function PlayerConnectedEvent({ event }: { event: Extract<CHAT.Event, { type: 'PLAYER_CONNECTED' }> }) {
	return (
		<div className="flex items-start gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UserPlus className="h-4 w-4 text-green-500" />
			<span className="text-xs flex items-center gap-1 ">
				<span>
					<PlayerDisplay player={event.player} matchId={event.matchId} /> connected,
				</span>
				{event.player.teamID && (
					<>
						joining <MatchTeamDisplay teamId={event.player.teamID} matchId={event.matchId} />
					</>
				)}
			</span>
		</div>
	)
}

function PlayerDisconnectedEvent({ event }: { event: Extract<CHAT.Event, { type: 'PLAYER_DISCONNECTED' }> }) {
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

function PossessedAdminCameraEvent({ event }: { event: Extract<CHAT.Event, { type: 'POSSESSED_ADMIN_CAMERA' }> }) {
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

function UnpossessedAdminCameraEvent({ event }: { event: Extract<CHAT.Event, { type: 'UNPOSSESSED_ADMIN_CAMERA' }> }) {
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

function PlayerKickedEvent({ event }: { event: Extract<CHAT.Event, { type: 'PLAYER_KICKED' }> }) {
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

function SquadCreatedEvent({ event }: { event: Extract<CHAT.Event, { type: 'SQUAD_CREATED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Users className="h-4 w-4 text-blue-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.creator} matchId={event.matchId} /> created
				<span className="font-semibold">"{event.squad.squadName}"</span> on{' '}
				<MatchTeamDisplay matchId={event.matchId} teamId={event.squad.teamId} />
			</span>
		</div>
	)
}

function PlayerBannedEvent({ event }: { event: Extract<CHAT.Event, { type: 'PLAYER_BANNED' }> }) {
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

function PlayerWarnedEvent({ event }: { event: Extract<CHAT.Event, { type: 'PLAYER_WARNED' }> }) {
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

function NewGameEvent({ event }: { event: Extract<CHAT.Event, { type: 'NEW_GAME' }> }) {
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

function RoundEndedEvent({ event }: { event: Extract<CHAT.Event, { type: 'ROUND_ENDED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Flag className="h-4 w-4 text-blue-500" />
			<span className="text-xs">Round ended</span>
		</div>
	)
}

function AdminBroadcastEvent({ event }: { event: Extract<CHAT.Event, { type: 'ADMIN_BROADCAST' }> }) {
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

function EventItem({ event }: { event: CHAT.Event }) {
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
		default:
			assertNever(event)
	}
}

export default function ServerChatPanel() {
	const eventBuffer = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.eventBuffer)
	const scrollRef = React.useRef<HTMLDivElement>(null)
	const prevEventCount = React.useRef(0)

	React.useEffect(() => {
		if (eventBuffer.length > prevEventCount.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight
		}
		prevEventCount.current = eventBuffer.length
	}, [eventBuffer.length])

	return (
		<Card className="flex flex-col h-full min-w-[500px]">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Icons.MessageSquare className="h-5 w-5" />
					Server Events
				</CardTitle>
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden">
				<ScrollArea className="h-[600px]" ref={scrollRef}>
					<div className="flex flex-col gap-0.5 pr-4 w-full max-w-[500px]">
						{eventBuffer.length === 0
							? (
								<div className="text-muted-foreground text-sm text-center py-8">
									No events yet
								</div>
							)
							: (
								eventBuffer.map((event, idx) => <EventItem key={`${event.type}-${event.time.getTime()}-${idx}`} event={event} />)
							)}
					</div>
				</ScrollArea>
			</CardContent>
		</Card>
	)
}
