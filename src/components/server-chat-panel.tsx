import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as CM from '@/models/chat.models'
import * as SM from '@/models/squad.models'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'

function formatTime(date: Date): string {
	return dateFns.format(date, 'HH:mm:ss')
}

function formatPlayer(player: SM.Player): string {
	return player.ids.username
}

function ChatMessageEvent({ event }: { event: CM.Event & { type: 'CHAT_MESSAGE' } }) {
	const channelColor = (() => {
		switch (event.channel.type) {
			case 'ChatAll':
				return 'bg-blue-500'
			case 'ChatTeam':
				return 'bg-green-500'
			case 'ChatSquad':
				return 'bg-yellow-500'
			case 'ChatAdmin':
				return 'bg-red-500'
		}
	})()

	const channelLabel = (() => {
		switch (event.channel.type) {
			case 'ChatAll':
				return 'ALL'
			case 'ChatTeam':
				return `TEAM ${event.channel.teamId}`
			case 'ChatSquad':
				return `SQUAD ${event.channel.squadId}`
			case 'ChatAdmin':
				return 'ADMIN'
		}
	})()

	return (
		<div className="flex gap-2 py-1">
			<span className="text-muted-foreground text-xs">{formatTime(event.time)}</span>
			<Badge className={`${channelColor} text-xs px-1`} variant="default">
				{channelLabel}
			</Badge>
			<span className="font-semibold">{formatPlayer(event.player)}:</span>
			<span>{event.message}</span>
		</div>
	)
}

function PlayerConnectedEvent({ event }: { event: CM.Event & { type: 'PLAYER_CONNECTED' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.UserPlus className="h-4 w-4 text-green-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.player)}</span> connected
			</span>
		</div>
	)
}

function PlayerDisconnectedEvent({ event }: { event: CM.Event & { type: 'PLAYER_DISCONNECTED' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.UserMinus className="h-4 w-4 text-red-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.player)}</span> disconnected
			</span>
		</div>
	)
}

function PossessedAdminCameraEvent({ event }: { event: CM.Event & { type: 'POSSESSED_ADMIN_CAMERA' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.Camera className="h-4 w-4 text-purple-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.player)}</span> entered admin camera
			</span>
		</div>
	)
}

function UnpossessedAdminCameraEvent({ event }: { event: CM.Event & { type: 'UNPOSSESSED_ADMIN_CAMERA' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.CameraOff className="h-4 w-4 text-purple-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.player)}</span> exited admin camera
			</span>
		</div>
	)
}

function PlayerKickedEvent({ event }: { event: CM.Event & { type: 'PLAYER_KICKED' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.UserX className="h-4 w-4 text-orange-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.player)}</span> was kicked
			</span>
		</div>
	)
}

function SquadCreatedEvent({ event }: { event: CM.Event & { type: 'SQUAD_CREATED' } }) {
	const teamName = event.squad.teamId ? `Team ${event.squad.teamId}` : 'Unknown Team'
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.Users className="h-4 w-4 text-blue-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.creator)}</span> created squad{' '}
				<span className="font-semibold">"{event.squad.squadName}"</span> on {teamName}
			</span>
		</div>
	)
}

function PlayerBannedEvent({ event }: { event: CM.Event & { type: 'PLAYER_BANNED' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.Ban className="h-4 w-4 text-red-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.player)}</span> was banned for {event.interval}
			</span>
		</div>
	)
}

function PlayerWarnedEvent({ event }: { event: CM.Event & { type: 'PLAYER_WARNED' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.AlertTriangle className="h-4 w-4 text-yellow-500" />
			<span className="text-sm">
				<span className="font-semibold">{formatPlayer(event.player)}</span> was warned: "{event.reason}"
			</span>
		</div>
	)
}

function NewGameEvent({ event }: { event: CM.Event & { type: 'NEW_GAME' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.Play className="h-4 w-4 text-green-500" />
			<span className="text-sm">New game started</span>
		</div>
	)
}

function RoundEndedEvent({ event }: { event: CM.Event & { type: 'ROUND_ENDED' } }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<span className="text-xs">{formatTime(event.time)}</span>
			<Icons.Flag className="h-4 w-4 text-blue-500" />
			<span className="text-sm">Round ended</span>
		</div>
	)
}

function EventItem({ event }: { event: CM.Event }) {
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
		default:
			return null
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
		<Card className="flex flex-col h-full">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Icons.MessageSquare className="h-5 w-5" />
					Server Events
				</CardTitle>
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden">
				<ScrollArea className="h-[600px]" ref={scrollRef}>
					<div className="flex flex-col gap-0.5 pr-4">
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
