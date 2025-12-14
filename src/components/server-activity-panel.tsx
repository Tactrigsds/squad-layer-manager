import EventFilterSelect from '@/components/event-filter-select'
import { EventTime } from '@/components/event-time'
import { PlayerDisplay } from '@/components/player-display'
import ServerPlayerList from '@/components/server-player-list.tsx'
import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useInfiniteQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
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
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} /> disconnected
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
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} /> entered admin camera
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
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} /> exited admin camera
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
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} /> was kicked
				{event.reason && <span className="text-muted-foreground/70">- {event.reason}</span>}
			</span>
		</div>
	)
}

function SquadCreatedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_CREATED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Users className="h-4 w-4 text-blue-500" />
			<span className="text-xs flex items-center gap-1 whitespace-nowrap">
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
					<PlayerDisplay showTeam player={event.player} matchId={event.matchId} /> was warned
				</span>
				: "<span className="break-words">{event.reason}</span>"
			</div>
		</div>
	)
}

function PlayerWarnedDedupedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WARNED_DEDUPED' }> }) {
	const playerCount = event.players.length
	const totalWarnings = event.players.reduce((sum, p) => sum + p.times, 0)

	// Single player warned multiple times
	if (playerCount === 1) {
		const player = event.players[0]
		return (
			<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
				<EventTime time={event.time} variant="small" />
				<Icons.AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
				<div className="flex-grow min-w-0">
					<span className="inline-block whitespace-nowrap">
						<PlayerDisplay showTeam player={player} matchId={event.matchId} /> was warned {player.times}x
					</span>
					: "<span className="break-words">{event.reason}</span>"
				</div>
			</div>
		)
	}

	// Multiple players warned
	return (
		<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
			<EventTime time={event.time} variant="small" />
			<Icons.AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
			<div className="flex-grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="underline decoration-dotted cursor-help">
								{totalWarnings}x
							</span>
						</TooltipTrigger>
						<TooltipContent>
							<div className="flex flex-col gap-1">
								{event.players.map((player) => (
									<div key={SM.PlayerIds.resolvePlayerId(player.ids)} className="flex items-center gap-1">
										<PlayerDisplay showTeam player={player} matchId={event.matchId} />
										{player.times > 1 && <span className="text-muted-foreground">({player.times}x)</span>}
									</div>
								))}
							</div>
						</TooltipContent>
					</Tooltip>{' '}
					players were warned
				</span>
				: "<span className="break-words">{event.reason}</span>"
			</div>
		</div>
	)
}

function NewGameEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'NEW_GAME' }> }) {
	const match = MatchHistoryClient.useRecentMatches().find(m => m.historyEntryId === event.matchId)
	const currentMatch = MatchHistoryClient.useCurrentMatch()

	if (!match || !currentMatch) return
	const visibleMatchIndex = match.ordinal - currentMatch.ordinal

	let label: string
	switch (event.source) {
		case 'new-game-detected':
			label = 'New game started'
			break
		case 'slm-started':
			label = 'New game detected on Application Start'
			break
		case 'rcon-reconnected':
			label = 'New game detected on RCON Reconnect'
			break
		default:
			assertNever(event.source)
	}

	return (
		<div className="border-t border-green-500 pt-0.5 mt-1 w-full">
			<div className="flex gap-2 py-0.5 text-muted-foreground items-center w-full">
				<EventTime time={event.time} variant="small" />
				<Icons.Play className="h-4 w-4 text-green-500 flex-shrink-0" />
				<span className="text-xs inline-flex flex-wrap items-center gap-1 flex-grow whitespace-nowrap">
					<span>{label} ({visibleMatchIndex === 0 ? 'Current Match' : visibleMatchIndex}):</span>
					{match && <ShortLayerName layerId={match.layerId} teamParity={match.ordinal % 2} className="text-xs" />}
				</span>
			</div>
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

function PlayerLeftSquadDedupedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_LEFT_SQUAD_DEDUPED' }> }) {
	// server is rolling
	if (event.squad.teamId === null) return null

	const playerCount = event.players.length

	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.LogOut className="h-4 w-4 text-orange-400" />
			<span className="text-xs flex items-center gap-1">
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="underline decoration-dotted cursor-help">
							{playerCount}x
						</span>
					</TooltipTrigger>
					<TooltipContent>
						<div className="flex flex-col gap-1">
							{event.players.map((player, idx) => (
								<div key={SM.PlayerIds.resolvePlayerId(player.ids)} className="flex items-center gap-1">
									<PlayerDisplay player={player} matchId={event.matchId} />
									{player.wasLeader && <span className="text-muted-foreground">(was leader)</span>}
								</div>
							))}
						</div>
					</TooltipContent>
				</Tooltip>{' '}
				players left{' '}
				<SquadDisplay
					squad={event.squad}
					matchId={event.matchId}
					showName={false}
					showTeam={true}
				/>
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
				<PlayerDisplay showTeam={true} showSquad={true} player={event.player} matchId={event.matchId} /> promoted to squad leader
			</span>
		</div>
	)
}

function PlayerWoundedOrDiedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WOUNDED' | 'PLAYER_DIED' }> }) {
	const getIcon = () => {
		if (event.type === 'PLAYER_DIED') {
			switch (event.variant) {
				case 'suicide':
					return <Icons.Skull className="h-4 w-4 text-orange-400" />
				case 'teamkill':
					return <Icons.Skull className="h-4 w-4 text-red-500" />
				case 'normal':
					return <Icons.Skull className="h-4 w-4 text-foreground" />
			}
		}

		switch (event.variant) {
			case 'suicide':
				return <Icons.HeartPulse className="h-4 w-4 text-orange-400" />
			case 'teamkill':
				return <Icons.HeartPulse className="h-4 w-4 text-red-500" />
			case 'normal':
				return null
		}
	}

	const getMessage = () => {
		switch (event.variant) {
			case 'suicide':
				return (
					<>
						<PlayerDisplay showTeam showSquad={true} player={event.victim} matchId={event.matchId} />{' '}
						{event.type === 'PLAYER_WOUNDED' ? 'wounded themselves' : 'killed themselves'}
						{event.weapon && <span className="text-muted-foreground/70">with {event.weapon}</span>}
					</>
				)
			case 'teamkill':
				return (
					<>
						<PlayerDisplay showTeam showSquad={true} player={event.victim} matchId={event.matchId} /> teamkilled by{' '}
						<PlayerDisplay showTeam showSquad={true} player={event.attacker} matchId={event.matchId} />
						{event.weapon && <span className="text-muted-foreground/70">with {event.weapon}</span>}
					</>
				)
			case 'normal':
				return (
					<>
						<PlayerDisplay showTeam player={event.victim} matchId={event.matchId} />{' '}
						{event.type === 'PLAYER_WOUNDED' ? 'wounded by' : 'killed by'}
						<PlayerDisplay showTeam={true} player={event.attacker} matchId={event.matchId} />
						{event.weapon && <span className="text-muted-foreground/70">with {event.weapon}</span>}
					</>
				)
		}
	}

	return (
		<div className="flex gap-2 py-1 text-muted-foreground whitespace-nowrap">
			<EventTime time={event.time} variant="small" />
			{getIcon()}
			<span className="text-xs flex items-center gap-1">{getMessage()}</span>
		</div>
	)
}

function MapSetEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'MAP_SET' }> }) {
	return (
		<div className="flex gap-2 py-0.5 text-muted-foreground items-center">
			<EventTime time={event.time} variant="small" />
			<Icons.Map className="h-4 w-4 text-blue-400" />
			<span className="text-xs inline-flex items-center gap-1 flex-grow whitespace-nowrap">
				Next layer set to <ShortLayerName layerId={event.layerId} teamParity={0} className="text-xs" />
			</span>
		</div>
	)
}

function RconConnectedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'RCON_CONNECTED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Plug className="h-4 w-4 text-green-500" />
			<span className="text-xs">
				{event.reconnected ? 'RCON reconnected' : 'Application started, RCON connection established'}
			</span>
		</div>
	)
}

function RconDisconnectedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'RCON_DISCONNECTED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Unplug className="h-4 w-4 text-red-500" />
			<span className="text-xs">
				RCON disconnected
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
		case 'PLAYER_WARNED_DEDUPED':
			return <PlayerWarnedDedupedEvent event={event} />
		case 'NEW_GAME':
			return <NewGameEvent event={event} />
		case 'RESET':
			return null
		case 'ROUND_ENDED':
			return <RoundEndedEvent event={event} />
		case 'PLAYER_DETAILS_CHANGED':
		case 'SQUAD_DETAILS_CHANGED':
			return null
		case 'PLAYER_CHANGED_TEAM':
			return <PlayerChangedTeamEvent event={event} />
		case 'PLAYER_LEFT_SQUAD':
			return <PlayerLeftSquadEvent event={event} />
		case 'PLAYER_LEFT_SQUAD_DEDUPED':
			return <PlayerLeftSquadDedupedEvent event={event} />
		case 'SQUAD_DISBANDED':
			return <SquadDisbandedEvent event={event} />
		case 'PLAYER_JOINED_SQUAD':
			return <PlayerJoinedSquadEvent event={event} />
		case 'PLAYER_PROMOTED_TO_LEADER':
			return <PlayerPromotedToLeaderEvent event={event} />
		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED':
			return <PlayerWoundedOrDiedEvent event={event} />
		case 'MAP_SET':
			return <MapSetEvent event={event} />
		case 'RCON_CONNECTED':
			return <RconConnectedEvent event={event} />
		case 'RCON_DISCONNECTED':
			return <RconDisconnectedEvent event={event} />
		case 'NOOP':
			return null
		default:
			assertNever(event)
	}
}

function ServerChatEvents(props: { className?: string; onToggleStatePanel?: () => void; isStatePanelOpen?: boolean }) {
	const synced = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.synced)
	const connectionError = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.connectionError)
	const currentMatch = MatchHistoryClient.useCurrentMatch()
	const bottomRef = React.useRef<HTMLDivElement>(null)
	const scrollAreaRef = React.useRef<HTMLDivElement>(null)
	// are we following the latest events by autoscrolling down
	const tailing = React.useRef(true)
	const eventsContainerRef = React.useRef<HTMLDivElement>(null)
	const [showScrollButton, setShowScrollButton] = React.useState(false)
	const [newMessageCount, setNewMessageCount] = React.useState(0)
	const prevState = React.useRef<
		{ eventGeneration: number; filteredEvents: CHAT.EventEnriched[]; eventFilterState: CHAT.EventFilterState; matchId: number } | null
	>(null)
	const filteredEvents = Zus.useStore(
		SquadServerClient.ChatStore,
		React.useCallback(s => {
			if (!s.chatState.synced || currentMatch?.historyEntryId === undefined) return null
			// we have all of this ceremony to prevent having to reallocate the event buffer array every time it's modified. maybe a bit excessive :shrug:
			if (
				currentMatch?.historyEntryId === prevState.current?.matchId
				&& s.eventGeneration === prevState.current?.eventGeneration
				&& s.eventFilterState === prevState.current.eventFilterState
			) {
				return prevState.current?.filteredEvents
			}

			const eventFilterState = s.eventFilterState
			const eventBuffer = s.chatState.eventBuffer
			const filtered: CHAT.EventEnriched[] = []
			for (const event of eventBuffer) {
				if (event.matchId !== currentMatch?.historyEntryId) continue
				if (!CHAT.isEventFiltered(event, eventFilterState)) {
					filtered.push(event)
				}
			}
			prevState.current = {
				eventGeneration: s.eventGeneration,
				filteredEvents: filtered,
				eventFilterState: s.eventFilterState,
				matchId: currentMatch?.historyEntryId,
			}
			return filtered
		}, [currentMatch?.historyEntryId]),
	)

	const scrollToBottom = () => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (scrollElement) {
			scrollElement.scrollTop = scrollElement.scrollHeight
		}
		tailing.current = true
		setNewMessageCount(0)
	}

	const checkIfAtBottom = () => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return false

		const threshold = 10 // pixels from bottom to consider "at bottom"
		const { scrollHeight, scrollTop, clientHeight } = scrollElement
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight

		const isAtBottom = distanceFromBottom < threshold
		return isAtBottom
	}

	// Scroll to bottom on initial render and when new events arrive if already tailing
	// Scroll to bottom when scroll area content changes (via ResizeObserver)
	// Scroll to bottom when window becomes visible again if already tailing
	React.useEffect(() => {
		const scrollElement = eventsContainerRef.current
		if (!scrollElement) return

		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				if (tailing.current && !checkIfAtBottom()) {
					scrollToBottom()
				}
			})
		})

		const sub = Rx.fromEvent(document, 'visibilitychange').subscribe(() => {
			if (document.hidden || !tailing.current) return
			scrollToBottom()
		})

		requestAnimationFrame(() => {
			scrollToBottom()
		})

		resizeObserver.observe(scrollElement)

		return () => {
			resizeObserver.disconnect()
			sub.unsubscribe()
		}
	}, [])

	React.useEffect(() => {
		if (synced) {
			requestAnimationFrame(() => {
				scrollToBottom()
			})
		}
	}, [synced])

	// Listen to scroll events to show/hide button
	React.useEffect(() => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return

		const handleScroll = () => {
			const atBottom = checkIfAtBottom()
			setShowScrollButton(!atBottom)
			if (atBottom) {
				setNewMessageCount(0)
				tailing.current = true
			} else {
				tailing.current = false
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
					<PreviousMatchEvents />
					{filteredEvents && filteredEvents.length === 0 && (
						<div className="text-muted-foreground text-sm text-center py-8">
							No events yet for current match
						</div>
					)}
					{filteredEvents && filteredEvents.map((event) => <EventItem key={event.id} event={event} />)}
					{connectionError && (
						<div className="flex gap-2 py-1 text-destructive">
							{connectionError.code === 'CONNECTION_LOST'
								? <Icons.Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
								: <Icons.WifiOff className="h-4 w-4 flex-shrink-0" />}
							<span className="text-xs">
								{connectionError.code === 'CONNECTION_LOST'
									? 'Connection lost - attempting to reconnect...'
									: 'Reconnection failed - unable to reconnect to the server. Please refresh the page.'}
							</span>
						</div>
					)}
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

function PreviousMatchEvents() {
	const currentMatch = MatchHistoryClient.useCurrentMatch()
	const recentMatches = MatchHistoryClient.useRecentMatches()
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.eventFilterState)

	const containerRef = React.useRef<HTMLDivElement>(null)
	const prevScrollHeightRef = React.useRef<number>(0)
	const [revealedPageCount, setRevealedPageCount] = React.useState(0)
	const revealedPageMatches: MH.MatchDetails[] = []
	for (let i = 0; i < revealedPageCount; i++) {
		if (!currentMatch) break
		const currentMatchIndex = recentMatches.length - 1
		revealedPageMatches.push(recentMatches[currentMatchIndex - i - 1])
	}

	type Page = {
		events: CHAT.EventEnriched[]
		previousOrdinal?: number
	}

	const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isError } = useInfiniteQuery({
		// we start at the current match but we don't actually load any events for it
		initialPageParam: currentMatch?.ordinal !== undefined ? currentMatch.ordinal - 1 : 0,
		enabled: !!currentMatch,
		// when the current match changes we want to unload these
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), currentMatch?.ordinal],
		staleTime: Infinity,
		queryFn: async ({ pageParam }): Promise<Page> => {
			try {
				if (pageParam === currentMatch!.ordinal) return { events: [], previousOrdinal: pageParam - 1 }
				const res = await RPC.orpc.matchHistory.getMatchEvents.call(pageParam)
				if (!res?.events) return { events: [] as CHAT.EventEnriched[], previousOrdinal: res?.previousOrdinal }

				const chatState = CHAT.getInitialChatState()
				for (const event of res.events) {
					CHAT.handleEvent(chatState, event)
				}

				return { events: chatState.eventBuffer, previousOrdinal: res.previousOrdinal }
			} catch (err) {
				console.error('Failed to fetch match events for ordinal', pageParam, err)
				throw err
			}
		},
		getNextPageParam: (lastPage: Page) => lastPage?.previousOrdinal,
		maxPages: MH.MAX_RECENT_MATCHES - 1,
	})

	const totalPages = data?.pages.length ?? 0

	const prevCurrentMatchId = React.useRef(-1)
	// reset  pages when a new game starts
	React.useEffect(() => {
		if (!currentMatch?.historyEntryId) return
		if (prevCurrentMatchId.current === currentMatch.historyEntryId) return
		prevCurrentMatchId.current = currentMatch.historyEntryId
		setRevealedPageCount(0)
	}, [currentMatch?.historyEntryId])

	// Maintain scroll position when loading previous matches
	React.useEffect(() => {
		if (!containerRef.current) return
		const scrollElement = containerRef.current.closest('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return

		const currentScrollHeight = scrollElement.scrollHeight
		const prevScrollHeight = prevScrollHeightRef.current

		if (prevScrollHeight > 0 && currentScrollHeight > prevScrollHeight) {
			// Content was added above, adjust scroll position
			const heightDifference = currentScrollHeight - prevScrollHeight
			scrollElement.scrollTop += heightDifference
		}

		prevScrollHeightRef.current = currentScrollHeight
	}, [revealedPageCount])

	let loadElt: React.ReactNode = null

	if (revealedPageCount < totalPages) {
		loadElt = (
			<Button
				onClick={() => {
					setRevealedPageCount(prev => prev + 1)
					void fetchNextPage()
				}}
				variant="secondary"
				disabled={isFetchingNextPage}
				className="w-full h-8 shadow-lg flex items-center justify-center gap-2 bg-opacity-20! rounded-none backdrop-blur-sm"
			>
				<Icons.ChevronUp className="h-4 w-4" />
				<span className="text-xs">Show Previous Match</span>
			</Button>
		)
	} else if (revealedPageCount >= totalPages && isError) {
		loadElt = (
			<Button
				onClick={() => fetchNextPage()}
				variant="destructive"
				className="w-full h-8 shadow-lg flex items-center justify-center gap-2 bg-opacity-20! rounded-none backdrop-blur-sm"
			>
				<Icons.AlertCircle className="h-4 w-4" />
				<span className="text-xs">Failed to load - Click to retry</span>
			</Button>
		)
	} else if (revealedPageCount >= totalPages && isFetchingNextPage) {
		loadElt = (
			<Button
				variant="secondary"
				disabled={isFetchingNextPage}
				className="w-full h-8 shadow-lg flex items-center justify-center gap-2 bg-opacity-20! rounded-none backdrop-blur-sm"
			>
				<Icons.Loader2 className="h-4 w-4 animate-spin" />
				<span className="text-xs">Loading...</span>
			</Button>
		)
	} else if (revealedPageCount >= totalPages && !hasNextPage) {
		loadElt = (
			<div className="text-muted-foreground text-xs text-center py-2">
				No previous matches available for {totalPages === MH.MAX_RECENT_MATCHES - 1 ? ' (max already loaded)' : ''}
			</div>
		)
	} else {
		loadElt = <span data-whelp="idk"></span>
	}

	return (
		<div ref={containerRef}>
			{loadElt}
			{data?.pages.slice(0, revealedPageCount).map((page, pageIndex) => {
				const match = revealedPageMatches[pageIndex]
				const filteredEvents = page?.events?.filter(event => !CHAT.isEventFiltered(event, eventFilterState))

				return (
					<div key={page.events[0]?.id ?? `empty-${page.previousOrdinal}`}>
						{filteredEvents && filteredEvents.length === 0 && match && (
							<div className="text-muted-foreground text-xs py-2">
								No events for {DH.displayLayer(match.layerId)}
							</div>
						)}
						{filteredEvents?.map((event) => <EventItem key={event.id} event={event} />)}
					</div>
				)
			}).reverse()}
		</div>
	)
}

function ServerCounts() {
	const serverInfoStatusRes = SquadServerClient.useServerInfoRes()
	const playerCount = SquadServerClient.usePlayerCount()

	if (serverInfoStatusRes.code !== 'ok') return <ServerUnreachable statusRes={serverInfoStatusRes} />

	const serverInfo = serverInfoStatusRes.data

	return (
		<div className="inline-flex text-muted-foreground space-x-2 items-baseline text-sm">
			{playerCount ?? '<unknown>'} / {serverInfo.maxPlayerCount} online, {serverInfo.queueLength} / {serverInfo.maxQueueLength} in queue
		</div>
	)
}

const AUTO_CLOSE_WIDTH_THRESHOLD = 1350 // pixels
const AUTO_OPEN_WIDTH_THRESHOLD = AUTO_CLOSE_WIDTH_THRESHOLD * 1.2 // 20% above threshold (1620 pixels)

export default function ServerActivityPanel() {
	const [isStatePanelOpen, setIsStatePanelOpen] = React.useState(window.innerWidth >= AUTO_CLOSE_WIDTH_THRESHOLD)
	const synced = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.synced)

	// Track viewport width state for auto-closing/opening the panel
	const hasBeenAboveThresholdRef = React.useRef(window.innerWidth >= AUTO_CLOSE_WIDTH_THRESHOLD)
	const userManuallyClosed = React.useRef(false)

	React.useEffect(() => {
		const handleResize = () => {
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

		const resize$ = Rx.fromEvent(window, 'resize').pipe(Rx.debounceTime(150))
		const sub = resize$.subscribe(handleResize)

		handleResize()

		return () => {
			sub.unsubscribe()
		}
	}, [isStatePanelOpen])

	return (
		<Card className="flex flex-col flex-1 min-h-0">
			<CardHeader className="flex flex-row justify-between flex-shrink-0 items-center pb-3">
				<div className="flex items-center gap-4">
					<CardTitle className="flex items-center gap-2">
						<Icons.Server className="h-5 w-5" />
						Server Activity
					</CardTitle>
					<EventFilterSelect />
				</div>
				<ServerCounts />
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden w-full min-h-0">
				<div className="flex gap-0.5 h-full">
					<ServerChatEvents
						className="flex-1 min-w-[350px] h-full"
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
