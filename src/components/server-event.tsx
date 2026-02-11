import { EventTime } from '@/components/event-time'
import MapLayerDisplay from '@/components/map-layer-display'
import { PlayerDisplay } from '@/components/player-display'
import ShortLayerName from '@/components/short-layer-name'
import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'

import { GlobalSettingsStore } from '@/systems/global-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as Icons from 'lucide-react'
import * as Zus from 'zustand'

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
			className="flex gap-2 py-1 text-xs w-full min-w-0 border-r-2 bg-linear-to-l to-transparent items-baseline"
			style={{
				borderRightColor: channelStyle.color,
				backgroundImage: `linear-gradient(to left, ${channelStyle.gradientColor}, transparent)`,
			}}
		>
			<EventTime time={event.time} />
			<div className="grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					{channelLabel}
					{fromDisplay}
				</span>
				: <span className="wrap-break-word">{event.message}</span>
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
			<Icons.Ban className="h-4 w-4 text-red-500 shrink-0" />
			<div className="grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					<PlayerDisplay player={event.player} matchId={event.matchId} /> was banned
				</span>
				reason: "<span className="words">{event.interval}</span>"
			</div>
		</div>
	)
}

function PlayerWarnedEvent({ event }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WARNED' }> }) {
	return (
		<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
			<EventTime time={event.time} variant="small" />
			<Icons.AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
			<div className="grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					<PlayerDisplay showTeam player={event.player} matchId={event.matchId} /> was warned
				</span>
				: "<span className="wrap-break-word">{event.reason}</span>"
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
				<Icons.Play className="h-4 w-4 text-green-500 shrink-0" />
				<span className="text-xs inline-flex flex-wrap items-center gap-1 grow whitespace-nowrap">
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
			<span className="text-xs inline-flex items-center gap-1 grow whitespace-nowrap">
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

export function ServerEvent({ event }: { event: CHAT.EventEnriched }) {
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
