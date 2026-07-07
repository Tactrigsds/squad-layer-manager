import { EventTime } from '@/components/event-time'
import MapLayerDisplay from '@/components/map-layer-display'
import { PlayerDisplay } from '@/components/player-display'
import ShortLayerName from '@/components/short-layer-name'
import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'

import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as PartsSys from '@/systems/parts.client'
import * as UsersClient from '@/systems/users.client'
import * as Icons from 'lucide-react'

const CHANNEL_STYLES = {
	ChatAll: { color: 'white', gradientColor: 'rgba(255, 255, 255, 0.1)' },
	ChatTeam: { color: 'rgb(59, 130, 246)', gradientColor: 'rgba(59, 130, 246, 0.1)' },
	ChatSquad: { color: 'rgb(34, 197, 94)', gradientColor: 'rgba(34, 197, 94, 0.1)' },
	ChatAdmin: { color: 'rgb(147, 197, 253)', gradientColor: 'rgba(147, 197, 253, 0.1)' },
	Broadcast: { color: 'rgb(234, 179, 8)', gradientColor: 'rgba(234, 179, 8, 0.1)' }, // yellow-500
} as const

function ChatMessageEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'CHAT_MESSAGE' | 'ADMIN_BROADCAST' }>; stores: SquadServerFrame.KeyProp },
) {
	const match = MatchHistoryClient.useRecentMatches(stores.squadServer.serverId).find(m => m.historyEntryId === event.matchId)
	const displayTeamsNormalized = ZusUtils.useStore(GlobalSettingsStore, s => s.displayTeamsNormalized)

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
							<MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={event.player.teamId!} />
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
								squad={{ squadId: event.channel.squadId, squadName: '', teamId: event.channel.teamId, uniqueId: event.channel.uniqueId }}
								matchId={event.matchId}
								showName={false}
								showTeam={false}
								stores={stores}
							/>
							<MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={event.player.teamId!} />
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
			if (event.player) return <PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} />
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
				stores={stores}
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

function PlayerConnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_CONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex items-start gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UserPlus className="h-4 w-4 text-green-500" />
			<span className="text-xs flex items-center gap-1 ">
				<span>
					<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> connected,
				</span>
				{event.player.teamId && (
					<>
						joining <MatchTeamDisplay stores={stores} teamId={event.player.teamId} matchId={event.matchId} />
					</>
				)}
			</span>
		</div>
	)
}

function PlayerDisconnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_DISCONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UserMinus className="h-4 w-4 text-red-500" />
			<span className="text-xs flex items-center gap-1 whitespace-nowrap">
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> disconnected
			</span>
		</div>
	)
}

function PossessedAdminCameraEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'POSSESSED_ADMIN_CAMERA' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Camera className="h-4 w-4 text-purple-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> entered admin camera
			</span>
		</div>
	)
}

function UnpossessedAdminCameraEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'UNPOSSESSED_ADMIN_CAMERA' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.CameraOff className="h-4 w-4 text-purple-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> exited admin camera
			</span>
		</div>
	)
}

function PlayerKickedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_KICKED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UserX className="h-4 w-4 text-orange-500" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> was kicked
				{event.reason && <span className="text-muted-foreground/70">- {event.reason}</span>}
			</span>
		</div>
	)
}

function SquadCreatedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_CREATED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Users className="h-4 w-4 text-blue-500" />
			<span className="text-xs flex items-center gap-1 whitespace-nowrap">
				<PlayerDisplay player={event.creator} matchId={event.matchId} stores={stores} /> created{' '}
				<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={false} stores={stores} /> on{' '}
				<MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={event.squad.teamId} />
				{event.squad.locked
					? <Icons.Lock className="h-3 w-3 text-red-600" />
					: null}
			</span>
		</div>
	)
}

function PlayerBannedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_BANNED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
			<EventTime time={event.time} variant="small" />
			<Icons.Ban className="h-4 w-4 text-red-500 shrink-0" />
			<div className="grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> was banned
				</span>
				reason: "<span className="words">{event.interval}</span>"
			</div>
		</div>
	)
}

function PlayerWarnedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WARNED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
			<EventTime time={event.time} variant="small" />
			<Icons.AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
			<div className="grow min-w-0">
				<span className="inline-block whitespace-nowrap">
					<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> was warned
				</span>
				: "<span className="wrap-break-word">{event.reason}</span>"
			</div>
		</div>
	)
}

// several standalone warns sharing the same text + source, collapsed into one entry. Few targets are named inline;
// larger groups use an expandable <details> listing everyone warned.
function WarnsAggregatedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'WARNS_AGGREGATED' }>; stores: SquadServerFrame.KeyProp },
) {
	const count = event.warns.length
	const plural = count === 1 ? 'player' : 'players'
	const matchId = event.matchId
	const icon = <Icons.AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
	const reason = (
		<>
			: "<span className="wrap-break-word">{event.reason}</span>"
		</>
	)

	if (count <= 4) {
		return (
			<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
				<EventTime time={event.time} variant="small" />
				{icon}
				<div className="grow min-w-0">
					{event.warns.map((warn, i) => (
						// index disambiguates: the same player can appear more than once in an aggregated warn entry
						// oxlint-disable-next-line react/no-array-index-key
						<span key={`${warn.player.ids.eos}-${i}`}>
							{i > 0 ? ', ' : ''}
							<PlayerDisplay showTeam player={warn.player} matchId={matchId} stores={stores} />
						</span>
					))} were warned{reason}
				</div>
			</div>
		)
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-break-word">
					{count} {plural} were warned{reason}
				</span>
			</summary>
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{event.warns.map((warn, i) => (
					// index disambiguates: the same player can appear more than once in an aggregated warn entry
					// oxlint-disable-next-line react/no-array-index-key
					<PlayerDisplay key={`${warn.player.ids.eos}-${i}`} showTeam player={warn.player} matchId={matchId} stores={stores} />
				))}
			</div>
		</details>
	)
}

// a single-line app-event feed entry (time + icon + text)
function AppEventLine({ time, icon, children }: { time: number; icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
			<EventTime time={time} variant="small" />
			{icon}
			<div className="grow min-w-0">{children}</div>
		</div>
	)
}

// concise text for a warn's target grouping; null means "no grouping -- just show the count"
function warnSummaryDescriptor(summary: CHAT.WarnSummary): string | null {
	switch (summary.type) {
		case 'everyone':
			return 'the entire server'
		case 'all-admins':
			return 'all admins'
		case 'teams':
			return summary.teamIds.length === 2 ? 'both teams' : `everyone on Team ${summary.teamIds[0]}`
		case 'squads': {
			const names = summary.squads.map(s => s.squadName).join(', ')
			if (summary.otherPlayerCount > 0) {
				return `${names} and ${summary.otherPlayerCount} other ${summary.otherPlayerCount === 1 ? 'player' : 'players'}`
			}
			return names
		}
		case 'players':
			return null
	}
}

// an app (audit) event, e.g. a warnAll that aggregates its individual PLAYER_WARNED server events into one
// expandable entry. Uses a native <details> so no local state is needed.
function AppEventEntry(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>; stores: SquadServerFrame.KeyProp },
) {
	const appEvent = event.appEvent
	// resolve the acting user's display name (hooks must run before any early return)
	const actorUserId = appEvent.actor.type === 'slm-user' ? appEvent.actor.userId : undefined
	const loggedInUser = UsersClient.useLoggedInUser()
	const userPartial = actorUserId ? PartsSys.findUser(actorUserId) : undefined
	const isMe = !!actorUserId && actorUserId === loggedInUser?.discordId
	const userRes = UsersClient.useUser(actorUserId, { enabled: !!actorUserId && !userPartial && !isMe })
	const actorUser = (userRes.data?.code === 'ok' ? userRes.data.user : undefined) ?? userPartial ?? (isMe ? loggedInUser : undefined)

	const actorLabel = appEvent.actor.type === 'slm-user'
		? (actorUser?.displayName ?? 'An admin')
		: appEvent.actor.type === 'system'
		? 'SLM'
		: 'A player'
	const matchId = event.matchId

	// expandable list of the players involved (targets, or a disbanded squad's members)
	const targetList = matchId !== null && event.targetPlayers.length > 0
		? (
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{event.targetPlayers.map((player) => (
					<PlayerDisplay key={player.ids.eos} showTeam player={player} matchId={matchId} stores={stores} />
				))}
			</div>
		)
		: null

	if (appEvent.type === 'SQUAD_DISBANDED') {
		const n = appEvent.members.length
		return (
			<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
				<summary className="flex gap-2 items-baseline cursor-pointer">
					<EventTime time={event.time} variant="small" />
					<Icons.Users className="h-4 w-4 text-red-500 shrink-0" />
					<span className="grow min-w-0 wrap-break-word">
						{actorLabel} disbanded {appEvent.squadName} (Team {appEvent.teamId}){n > 0 ? `, ${n} ${n === 1 ? 'player' : 'players'}` : ''}
					</span>
				</summary>
				{targetList}
			</details>
		)
	}

	// pure-audit / single-line entries with no target-count summary
	if (appEvent.type === 'SQUAD_RENAMED') {
		return (
			<AppEventLine time={event.time} icon={<Icons.PencilLine className="h-4 w-4 text-cyan-500 shrink-0" />}>
				{actorLabel} renamed {appEvent.squadName} (Team {appEvent.teamId})
			</AppEventLine>
		)
	}
	if (appEvent.type === 'COMMANDER_DEMOTED') {
		const target = event.targetPlayers[0]
		return (
			<AppEventLine time={event.time} icon={<Icons.ShieldOff className="h-4 w-4 text-orange-500 shrink-0" />}>
				{actorLabel} demoted {target && matchId !== null
					? <PlayerDisplay showTeam player={target} matchId={matchId} stores={stores} />
					: 'the commander'}
			</AppEventLine>
		)
	}
	if (appEvent.type === 'FOG_OF_WAR_TOGGLED') {
		return (
			<AppEventLine time={event.time} icon={<Icons.CloudFog className="h-4 w-4 text-slate-400 shrink-0" />}>
				{actorLabel} turned fog of war {appEvent.enabled ? 'on' : 'off'}
			</AppEventLine>
		)
	}
	if (appEvent.type === 'MATCH_ENDED') {
		return (
			<AppEventLine time={event.time} icon={<Icons.Flag className="h-4 w-4 text-red-500 shrink-0" />}>
				{actorLabel} ended the match
			</AppEventLine>
		)
	}
	if (appEvent.type === 'VOTE_STARTED') {
		return (
			<AppEventLine time={event.time} icon={<Icons.Vote className="h-4 w-4 text-blue-500 shrink-0" />}>
				{actorLabel} started a vote ({appEvent.choiceCount} {appEvent.choiceCount === 1 ? 'option' : 'options'})
			</AppEventLine>
		)
	}
	if (appEvent.type === 'VOTE_ENDED') {
		return (
			<AppEventLine time={event.time} icon={<Icons.ListChecks className="h-4 w-4 text-green-500 shrink-0" />}>
				{appEvent.reason === 'ended-early' ? `${actorLabel} ended the vote early` : 'The vote ended'}
				{appEvent.winnerLayerId
					? (
						<>
							: <ShortLayerName layerId={appEvent.winnerLayerId} /> won
						</>
					)
					: ' (no winner)'}
			</AppEventLine>
		)
	}
	if (appEvent.type === 'VOTE_ABORTED') {
		return (
			<AppEventLine time={event.time} icon={<Icons.Ban className="h-4 w-4 text-red-500 shrink-0" />}>
				{actorLabel} aborted the vote
			</AppEventLine>
		)
	}
	if (appEvent.type === 'QUEUE_UPDATED') {
		// net change to the saved queue -- the "relevant" default view; the full op log is available for the audit page
		const layerOf = (item: { itemId: string }) => ('layerId' in item ? (item as { layerId: string }).layerId : 'vote')
		const prev = new Map<string, string>()
		for (const { item } of LL.iterItems(appEvent.prevList)) prev.set(item.itemId, layerOf(item))
		const next = new Map<string, string>()
		for (const { item } of LL.iterItems(appEvent.list)) next.set(item.itemId, layerOf(item))
		let added = 0
		let changed = 0
		for (const [id, layerId] of next) {
			if (!prev.has(id)) added++
			else if (prev.get(id) !== layerId) changed++
		}
		let removed = 0
		for (const id of prev.keys()) if (!next.has(id)) removed++
		const commonPrev = [...prev.keys()].filter(id => next.has(id))
		const commonNext = [...next.keys()].filter(id => prev.has(id))
		const reordered = commonPrev.length === commonNext.length && commonPrev.some((id, i) => id !== commonNext[i])
		const parts = [
			added > 0 ? `+${added}` : null,
			removed > 0 ? `−${removed}` : null,
			changed > 0 ? `${changed} changed` : null,
			reordered ? 'reordered' : null,
		].filter(Boolean)
		const nextBefore = LL.getNextLayerId(appEvent.prevList)
		const nextAfter = LL.getNextLayerId(appEvent.list)
		const headline: React.ReactNode = appEvent.trigger === 'roll'
			? 'Queue advanced on map change'
			: appEvent.trigger === 'external-layer-change'
			? (
				<>
					Queue synced to an external layer change by {appEvent.actor.type === 'ingame-user' && event.actorPlayer && matchId !== null
						? <PlayerDisplay showTeam player={event.actorPlayer} matchId={matchId} stores={stores} />
						: appEvent.actor.type === 'ingame-user'
						? 'an in-game admin'
						: 'another RCON tool'}
				</>
			)
			: `${actorLabel} updated the queue`
		return (
			<AppEventLine time={event.time} icon={<Icons.ListOrdered className="h-4 w-4 text-indigo-500 shrink-0" />}>
				{headline}
				{parts.length > 0 ? ` (${parts.join(', ')})` : ''}
				{nextAfter !== null && nextAfter !== nextBefore && (
					<span className="inline-flex items-baseline gap-1">
						, next layer {appEvent.trigger === 'external-layer-change' ? 'now' : 'set to'} <ShortLayerName layerId={nextAfter} />
					</span>
				)}
			</AppEventLine>
		)
	}
	if (appEvent.type === 'MAP_SET') {
		// only override sets reach the feed; queue-driven MAP_SETs fold into their QUEUE_UPDATED (audit-only)
		if (appEvent.reason === 'queue-updated') {
			return (
				<AppEventLine time={event.time} icon={<Icons.RefreshCw className="h-4 w-4 text-amber-500 shrink-0" />}>
					Next layer set to <ShortLayerName layerId={appEvent.layerId} />
				</AppEventLine>
			)
		}
		// the overridden player (if any) is resolved into targetPlayers via involvedPlayerIds
		const overrodePlayer = event.targetPlayers[0]
		const who = appEvent.overrode?.type === 'player' && overrodePlayer && matchId !== null
			? <PlayerDisplay showTeam player={overrodePlayer} matchId={matchId} stores={stores} />
			: appEvent.overrode?.type === 'player'
			? 'an in-game admin'
			: 'another RCON tool'
		return (
			<AppEventLine time={event.time} icon={<Icons.RefreshCw className="h-4 w-4 text-amber-500 shrink-0" />}>
				SLM overrode a layer set by {who}, next layer set to <ShortLayerName layerId={appEvent.layerId} />
			</AppEventLine>
		)
	}
	if (
		appEvent.type === 'SETTINGS_UPDATED' || appEvent.type === 'SERVER_REGISTRY_CHANGED'
		|| appEvent.type === 'FILTER_CHANGED' || appEvent.type === 'FILTER_CONTRIBUTOR_CHANGED'
		|| appEvent.type === 'USER_ACCOUNT_CHANGED' || appEvent.type === 'PLAYER_FLAGS_UPDATED'
		|| appEvent.type === 'APP_STARTED' || appEvent.type === 'APP_RESTARTED'
	) {
		// global/audit-only types -- they never reach a server activity feed (matchId null), but the union needs a
		// branch. rendered generically via describeAppEvent (the audit log is where these actually show up).
		return (
			<AppEventLine time={event.time} icon={<Icons.ScrollText className="h-4 w-4 text-slate-400 shrink-0" />}>
				{actorLabel} {AppEvents.describeAppEvent(appEvent)}
			</AppEventLine>
		)
	}

	// PLAYER_WARNED / PLAYER_REMOVED_FROM_SQUAD / TEAM_CHANGE_FORCED: "{actor} {verb} {targets}{suffix}"
	const count = appEvent.targets.length
	const plural = count === 1 ? 'player' : 'players'
	let verb: string
	let icon: React.ReactNode
	let suffix: React.ReactNode
	let descriptor: string | null
	if (appEvent.type === 'PLAYER_WARNED') {
		verb = 'warned'
		icon = <Icons.AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
		suffix = (
			<>
				: "<span className="wrap-break-word">{appEvent.message}</span>"
			</>
		)
		descriptor = warnSummaryDescriptor(event.warnSummary)
	} else if (appEvent.type === 'PLAYER_REMOVED_FROM_SQUAD') {
		verb = 'removed'
		icon = <Icons.UserMinus className="h-4 w-4 text-orange-500 shrink-0" />
		suffix = ' from their squad'
		descriptor = null
	} else {
		verb = 'switched'
		icon = <Icons.ArrowLeftRight className="h-4 w-4 text-blue-500 shrink-0" />
		suffix = ' to the other team'
		descriptor = null
	}

	// few enough targets: name them inline instead of grouping/collapsing (but still show the count)
	if (count <= 4 && matchId !== null && event.targetPlayers.length === count) {
		return (
			<div className="flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline">
				<EventTime time={event.time} variant="small" />
				{icon}
				<div className="grow min-w-0">
					{actorLabel} {verb} {event.targetPlayers.map((player, i) => (
						<span key={player.ids.eos}>
							{i > 0 ? ', ' : ''}
							<PlayerDisplay showTeam player={player} matchId={matchId} stores={stores} />
						</span>
					))}
					{count > 1 ? <>{' '}({count} {plural})</> : ''}
					{suffix}
				</div>
			</div>
		)
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-break-word">
					{actorLabel} {verb} {descriptor
						? (count > 1 ? `${descriptor} (${count} ${plural})` : descriptor)
						: (count === 1 ? 'a player' : `${count} ${plural}`)}
					{suffix}
				</span>
			</summary>
			{targetList}
		</details>
	)
}

function NewGameEvent({ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'NEW_GAME' }>; stores: SquadServerFrame.KeyProp }) {
	const match = MatchHistoryClient.useRecentMatches(stores.squadServer.serverId).find(m => m.historyEntryId === event.matchId)
	const currentMatch = MatchHistoryClient.useCurrentMatch(stores.squadServer.serverId)

	if (!match || !currentMatch) return
	const visibleMatchIndex = match.ordinal - currentMatch.ordinal

	let label: string
	switch (event.source) {
		case 'new-game-detected':
		case 'server-roll':
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

function RoundEndedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'ROUND_ENDED' }>; stores: SquadServerFrame.KeyProp },
) {
	const match = MatchHistoryClient.useRecentMatches(stores.squadServer.serverId).find(m => m.historyEntryId === event.matchId)
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
	let actionElt: React.ReactNode = null
	if (event.action) {
		const source = event.action.source
		let sourceName: React.ReactNode
		if (source.type === 'player') {
			sourceName = (
				<span>
					by <b>{source.playerIds.username}</b>
				</span>
			)
		} else if (source.type === 'rcon') {
			sourceName = (
				<span>
					via <b>RCON</b>
				</span>
			)
		} else {
			// SLM-originated (application-event link or system fallback) -- MVP renders a generic label;
			// richer actor display arrives with the audit UI
			sourceName = (
				<span>
					via <b>SLM</b>
				</span>
			)
		}
		let nextLayerText: React.ReactNode = null
		if (event.action.type === 'AdminChangeLayer') {
			nextLayerText = (
				<span>
					, switching to <ShortLayerName layerId={event.action.layerId} />
				</span>
			)
		}
		actionElt = <span className="text-xs font-semibold">({event.action.type} {sourceName}{nextLayerText})</span>
	}

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
						<MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={winnerId} /> won
						<span className="font-semibold">{winnerTickets} to {loserTickets}</span>
						against <MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={loserId} />
					</>
				)}
				{actionElt}
			</span>
		</div>
	)
}

function PlayerChangedTeamEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_CHANGED_TEAM' }>; stores: SquadServerFrame.KeyProp },
) {
	// don't render unassigned, and if the player was previously unassigned that means we're swapping teams after the match, so no need to render
	if (event.newTeamId === null || event.prevTeamId === null) return
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Repeat className="h-4 w-4 text-purple-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> changed to{' '}
				<MatchTeamDisplay stores={stores} teamId={event.player.teamId!} matchId={event.matchId} />
			</span>
		</div>
	)
}

function PlayerLeftSquadEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_LEFT_SQUAD' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.LogOut className="h-4 w-4 text-orange-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> left{' '}
				<SquadDisplay
					squad={event.squad}
					matchId={event.matchId}
					showName={false}
					showTeam={true}
					stores={stores}
				/>{' '}
				{event.wasLeader ? '(was leader)' : ''}
			</span>
		</div>
	)
}

function SquadDisbandedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_DISBANDED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.UsersRound className="h-4 w-4 text-red-400" />
			<span className="text-xs flex items-center gap-1">
				<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={true} stores={stores} /> was disbanded
			</span>
		</div>
	)
}

function SquadDetailsChangedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_DETAILS_CHANGED' }>; stores: SquadServerFrame.KeyProp },
) {
	const locked = event.details.locked
	const prevLocked = event.prevDetails.locked
	if (locked === prevLocked || locked === undefined) return null
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			{locked ? <Icons.Lock className="h-4 w-4 text-yellow-500" /> : <Icons.LockOpen className="h-4 w-4 text-green-500" />}
			<span className="text-xs flex items-center gap-1">
				<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={true} stores={stores} />{' '}
				{locked ? 'locked' : 'unlocked'}
			</span>
		</div>
	)
}

function SquadRenamedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_RENAMED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Pencil className="h-4 w-4 text-cyan-400" />
			<span className="text-xs flex items-center gap-1">
				<SquadDisplay
					squad={{ ...event.squad, squadName: event.oldSquadName }}
					matchId={event.matchId}
					showName={true}
					showTeam={true}
					stores={stores}
				/>{' '}
				renamed to
				<span className="font-medium text-foreground">"{event.newSquadName}"</span>
			</span>
		</div>
	)
}

function PlayerJoinedSquadEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_JOINED_SQUAD' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.LogIn className="h-4 w-4 text-green-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> joined{' '}
				<SquadDisplay
					squad={event.squad}
					matchId={event.matchId}
					showTeam={true}
					stores={stores}
				/>
			</span>
		</div>
	)
}

function PlayerPromotedToLeaderEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_PROMOTED_TO_LEADER' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<div className="flex gap-2 py-1 text-muted-foreground">
			<EventTime time={event.time} variant="small" />
			<Icons.Crown className="h-4 w-4 text-yellow-400" />
			<span className="text-xs flex items-center gap-1">
				<PlayerDisplay showTeam={true} showSquad={true} player={event.player} matchId={event.matchId} stores={stores} />{' '}
				promoted to squad leader
			</span>
		</div>
	)
}

function PlayerWoundedOrDiedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WOUNDED' | 'PLAYER_DIED' }>; stores: SquadServerFrame.KeyProp },
) {
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
						<PlayerDisplay showTeam showSquad={true} player={event.victim} matchId={event.matchId} stores={stores} />{' '}
						{event.type === 'PLAYER_WOUNDED' ? 'wounded themselves' : 'killed themselves'}
						{event.weapon && <span className="text-muted-foreground/70">with {event.weapon}</span>}
					</>
				)
			case 'teamkill':
				return (
					<>
						<PlayerDisplay showTeam showSquad={true} player={event.victim} matchId={event.matchId} stores={stores} /> teamkilled by{' '}
						<PlayerDisplay showTeam showSquad={true} player={event.attacker} matchId={event.matchId} stores={stores} />
						{event.weapon && <span className="text-muted-foreground/70">with {event.weapon}</span>}
					</>
				)
			case 'normal':
				return (
					<>
						<PlayerDisplay showTeam player={event.victim} matchId={event.matchId} stores={stores} />{' '}
						{event.type === 'PLAYER_WOUNDED' ? 'wounded by' : 'killed by'}
						<PlayerDisplay showTeam={true} player={event.attacker} matchId={event.matchId} stores={stores} />
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

function MapSetEvent({ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'MAP_SET' }>; stores: SquadServerFrame.KeyProp }) {
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

function RconConnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'RCON_CONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
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

function RconDisconnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'RCON_DISCONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
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

export function ServerEvent({ event, stores }: { event: CHAT.EventEnriched; stores: SquadServerFrame.KeyProp }) {
	switch (event.type) {
		case 'CHAT_MESSAGE':
		case 'ADMIN_BROADCAST':
			return <ChatMessageEvent event={event} stores={stores} />
		case 'PLAYER_CONNECTED':
			return <PlayerConnectedEvent event={event} stores={stores} />
		case 'PLAYER_DISCONNECTED':
			return <PlayerDisconnectedEvent event={event} stores={stores} />
		case 'POSSESSED_ADMIN_CAMERA':
			return <PossessedAdminCameraEvent event={event} stores={stores} />
		case 'UNPOSSESSED_ADMIN_CAMERA':
			return <UnpossessedAdminCameraEvent event={event} stores={stores} />
		case 'PLAYER_KICKED':
			return <PlayerKickedEvent event={event} stores={stores} />
		case 'SQUAD_CREATED':
			return <SquadCreatedEvent event={event} stores={stores} />
		case 'PLAYER_BANNED':
			return <PlayerBannedEvent event={event} stores={stores} />
		case 'PLAYER_WARNED':
			return <PlayerWarnedEvent event={event} stores={stores} />
		case 'WARNS_AGGREGATED':
			return <WarnsAggregatedEvent event={event} stores={stores} />
		case 'APP_EVENT':
			return <AppEventEntry event={event} stores={stores} />
		case 'NEW_GAME':
			return <NewGameEvent event={event} stores={stores} />
		case 'RESET':
			return null
		case 'ROUND_ENDED':
			return <RoundEndedEvent event={event} stores={stores} />
		case 'PLAYER_DETAILS_CHANGED':
			return null
		case 'SQUAD_DETAILS_CHANGED':
			return <SquadDetailsChangedEvent event={event} stores={stores} />
		case 'SQUAD_RENAMED':
			return <SquadRenamedEvent event={event} stores={stores} />
		case 'PLAYER_CHANGED_TEAM':
			return <PlayerChangedTeamEvent event={event} stores={stores} />
		case 'PLAYER_LEFT_SQUAD':
			return <PlayerLeftSquadEvent event={event} stores={stores} />
		case 'SQUAD_DISBANDED':
			return <SquadDisbandedEvent event={event} stores={stores} />
		case 'PLAYER_JOINED_SQUAD':
			return <PlayerJoinedSquadEvent event={event} stores={stores} />
		case 'PLAYER_PROMOTED_TO_LEADER':
			return <PlayerPromotedToLeaderEvent event={event} stores={stores} />
		case 'TEAMS_POLLED_UPDATE':
			return null
		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED':
			return <PlayerWoundedOrDiedEvent event={event} stores={stores} />
		case 'MAP_SET':
			return <MapSetEvent event={event} stores={stores} />
		case 'RCON_CONNECTED':
			return <RconConnectedEvent event={event} stores={stores} />
		case 'RCON_DISCONNECTED':
			return <RconDisconnectedEvent event={event} stores={stores} />
		case 'NOOP':
			return null
		default:
			assertNever(event)
	}
}
