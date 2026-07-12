import { EventTime } from '@/components/event-time'
import MapLayerDisplay from '@/components/map-layer-display'
import { PlayerDisplay } from '@/components/player-display'
import ShortLayerName from '@/components/short-layer-name'
import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import { formatHumanTime } from '@/lib/zod'
import * as ZusUtils from '@/lib/zustand'
import * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as USR from '@/models/users.models'

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

// warns render like chat messages, keyed by who was targeted. `admins` mirrors ChatAdmin (just a different channel
// name); `single`/`selection` inherit WarnChatBox's warm warn accent, split into two tones so a warn aimed at one
// player reads distinctly from a bulk warn against a whole selection.
const WARN_CHANNEL_STYLES = {
	admins: CHANNEL_STYLES.ChatAdmin,
	single: { color: 'rgb(251, 146, 60)', gradientColor: 'rgba(251, 146, 60, 0.1)' }, // orange-400, WarnChatBox targeted-warn accent
	selection: { color: 'rgb(245, 158, 11)', gradientColor: 'rgba(245, 158, 11, 0.1)' }, // amber-500, a bulk/group warn
} as const

// Shared layout for a feed entry: a non-shrinking time + icon gutter, then a text column that wraps.
// The text column has to stay a block rather than a flex row -- a flex row can't break between its
// items, which is what pinned entries to a single line and forced the feed to scroll horizontally.
// Inline atoms (player/squad/team/layer displays) keep themselves intact via their own nowrap, so
// lines break between them rather than through them.
//
// wrap-anywhere rather than wrap-break-word: radix sizes the scroll viewport's content as a table,
// so the feed's width follows its max-content width. Only `anywhere` shrinks an element's min-content
// contribution, so it's what stops one long username or unbroken message from widening the whole feed.
function EventLine(
	{ time, icon, className, style, children }: {
		time: number
		icon?: React.ReactNode
		className?: string
		style?: React.CSSProperties
		children: React.ReactNode
	},
) {
	return (
		<div className={cn('flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline', className)} style={style}>
			<EventTime time={time} variant="small" />
			{icon}
			<div className="grow min-w-0 wrap-anywhere">{children}</div>
		</div>
	)
}

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
			<div className="grow min-w-0 wrap-anywhere">
				{channelLabel}
				{fromDisplay}: {event.message}
			</div>
		</div>
	)
}

function PlayerConnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_CONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.UserPlus className="h-4 w-4 text-green-500 shrink-0" />}>
			<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> connected
			{event.player.teamId && (
				<>
					, joining <MatchTeamDisplay stores={stores} teamId={event.player.teamId} matchId={event.matchId} />
				</>
			)}
		</EventLine>
	)
}

function PlayerDisconnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_DISCONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.UserMinus className="h-4 w-4 text-red-500 shrink-0" />}>
			<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> disconnected
		</EventLine>
	)
}

function PossessedAdminCameraEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'POSSESSED_ADMIN_CAMERA' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.Camera className="h-4 w-4 text-purple-500 shrink-0" />}>
			<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> entered admin camera
		</EventLine>
	)
}

function UnpossessedAdminCameraEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'UNPOSSESSED_ADMIN_CAMERA' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.CameraOff className="h-4 w-4 text-purple-500 shrink-0" />}>
			<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> exited admin camera
		</EventLine>
	)
}

function PlayerKickedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_KICKED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.UserX className="h-4 w-4 text-orange-500 shrink-0" />}>
			<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> was kicked
			{event.reason && <span className="text-muted-foreground/70">{' '}- {event.reason}</span>}
		</EventLine>
	)
}

function SquadCreatedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_CREATED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.Users className="h-4 w-4 text-blue-500 shrink-0" />}>
			<PlayerDisplay player={event.creator} matchId={event.matchId} stores={stores} /> created{' '}
			<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={false} stores={stores} /> on{' '}
			<MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={event.squad.teamId} />
			{event.squad.locked
				? <Icons.Lock className="h-3 w-3 text-red-600 inline-block ml-1" />
				: null}
		</EventLine>
	)
}

function PlayerBannedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_BANNED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.Ban className="h-4 w-4 text-red-500 shrink-0" />}>
			<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> was banned reason: "{event.interval}"
		</EventLine>
	)
}

function PlayerWarnedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WARNED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />}>
			<PlayerDisplay showTeam player={event.player} matchId={event.matchId} stores={stores} /> was warned: "{event.reason}"
		</EventLine>
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
	const reason = <>: "{event.reason}"</>

	if (count <= 4) {
		return (
			<EventLine time={event.time} icon={icon}>
				{event.warns.map((warn, i) => (
					// index disambiguates: the same player can appear more than once in an aggregated warn entry
					// oxlint-disable-next-line react/no-array-index-key
					<span key={`${warn.player.ids.eos}-${i}`}>
						{i > 0 ? ', ' : ''}
						<PlayerDisplay showTeam player={warn.player} matchId={matchId} stores={stores} />
					</span>
				))} were warned{reason}
			</EventLine>
		)
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">
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

function joinNames(names: string[]) {
	if (names.length <= 1) return names[0] ?? ''
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// display names for the SLM users an event attributes work to. Users already in the parts store (or the viewer
// themselves) need no fetch; the rest are fetched in one batch.
function useUserLabels(userIds: USR.UserId[]) {
	const loggedInUser = UsersClient.useLoggedInUser()
	const unresolved = userIds.filter(id => !PartsSys.findUser(id) && id !== loggedInUser?.discordId)
	const res = UsersClient.useUsers(unresolved, { enabled: unresolved.length > 0 })
	const fetched = new Map((res.data?.code === 'ok' ? res.data.users : []).map(u => [u.discordId, u.displayName]))
	return (userId: USR.UserId) => {
		if (userId === loggedInUser?.discordId) return loggedInUser.displayName
		return PartsSys.findUser(userId)?.displayName ?? fetched.get(userId) ?? 'An admin'
	}
}

function QueueChangeLayers({ layerIds }: { layerIds: L.LayerId[] }) {
	const shown = layerIds.slice(0, 3)
	return (
		<span className="inline-flex items-baseline gap-1 flex-wrap">
			{shown.map((layerId, i) => (
				<span key={layerId} className="inline-flex items-baseline">
					<ShortLayerName layerId={layerId} />
					{i < shown.length - 1 ? ',' : ''}
				</span>
			))}
			{layerIds.length > shown.length && <span>and {layerIds.length - shown.length} more</span>}
		</span>
	)
}

function QueueChangeLine({ change, labelFor }: { change: AppEvents.QueueChange; labelFor: (userId: USR.UserId) => string }) {
	const who = change.actor.type === 'slm-user' ? labelFor(change.actor.userId) : change.actor.type === 'system' ? 'SLM' : 'An in-game admin'
	const layers = <QueueChangeLayers layerIds={change.layerIds} />
	const vote = change.isVote ? `a vote (${change.layerIds.length} ${change.layerIds.length === 1 ? 'choice' : 'choices'}): ` : null

	const [marker, markerClass, body] = ((): [string, string, React.ReactNode] => {
		switch (change.kind) {
			case 'added':
				return ['+', 'text-added', <>{who} added {vote}{layers}</>]
			case 'removed':
				return ['−', 'text-destructive', <>{who} removed {vote}{layers}</>]
			case 'edited':
				return [
					'~',
					'text-amber-500',
					(
						<>
							{who} changed <QueueChangeLayers layerIds={change.prevLayerIds} /> to {layers}
						</>
					),
				]
			case 'moved':
				return ['↕', 'text-indigo-400', <>{who} moved {layers} from #{change.fromIndex + 1} to #{change.toIndex + 1}</>]
			default:
				assertNever(change)
		}
	})()

	return (
		<div className="flex gap-2 items-baseline text-xs text-muted-foreground">
			<span className={cn('font-mono shrink-0', markerClass)}>{marker}</span>
			<span className="grow min-w-0 wrap-anywhere">{body}</span>
		</div>
	)
}

// a save of the layer queue. The summary names who saved and the net effect; expanding attributes each surviving
// change to the user who made it, which is the part a shared queue actually needs (several admins edit at once).
function QueueUpdatedEvent(
	{ event, appEvent, actorLabel, stores }: {
		event: Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>
		appEvent: AppEvents.QueueUpdated
		actorLabel: string
		stores: SquadServerFrame.KeyProp
	},
) {
	const changes = AppEvents.summarizeQueueChanges(appEvent)
	const contributors = changes.flatMap(c => c.actor.type === 'slm-user' ? [c.actor.userId] : [])
	const labelFor = useUserLabels([...new Set([...contributors, ...(appEvent.save?.overrodeEditors ?? [])])])
	const matchId = event.matchId

	const counts = {
		added: changes.filter(c => c.kind === 'added').length,
		removed: changes.filter(c => c.kind === 'removed').length,
		edited: changes.filter(c => c.kind === 'edited').length,
		moved: changes.filter(c => c.kind === 'moved').length,
	}
	const parts = [
		counts.added > 0 ? `+${counts.added}` : null,
		counts.removed > 0 ? `−${counts.removed}` : null,
		counts.edited > 0 ? `${counts.edited} changed` : null,
		counts.moved > 0 ? 'reordered' : null,
	].filter(Boolean)

	const overrode = appEvent.save?.overrodeEditors ?? []
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
		: (
			<>
				{actorLabel} {appEvent.save?.force ? 'force-saved' : 'saved'} the queue
				{overrode.length > 0 && `, overriding ${joinNames(overrode.map(labelFor))}`}
			</>
		)

	const nextBefore = LL.getNextLayerId(appEvent.prevList)
	const nextAfter = LL.getNextLayerId(appEvent.list)
	const summary = (
		<>
			{headline}
			{parts.length > 0 ? ` (${parts.join(', ')})` : ''}
			{nextAfter !== null && nextAfter !== nextBefore && (
				<span className="inline-flex items-baseline gap-1">
					, next layer {appEvent.trigger === 'external-layer-change' ? 'now' : 'set to'} <ShortLayerName layerId={nextAfter} />
				</span>
			)}
		</>
	)
	const icon = <Icons.ListOrdered className="h-4 w-4 text-indigo-500 shrink-0" />

	if (changes.length === 0) {
		return <EventLine time={event.time} icon={icon}>{summary}</EventLine>
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">{summary}</span>
			</summary>
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{changes.map(change => <QueueChangeLine key={`${change.kind}:${change.itemId}`} change={change} labelFor={labelFor} />)}
			</div>
		</details>
	)
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
					<span className="grow min-w-0 wrap-anywhere">
						{actorLabel} disbanded {appEvent.squadName} (Team{' '}
						{appEvent.teamId}){appEvent.reason?.label ? ` for ${appEvent.reason.label}` : ''}
						{n > 0 ? `, ${n} ${n === 1 ? 'player' : 'players'}` : ''}
					</span>
				</summary>
				{targetList}
			</details>
		)
	}

	// pure-audit / single-line entries with no target-count summary
	if (appEvent.type === 'SQUAD_RENAMED') {
		return (
			<EventLine time={event.time} icon={<Icons.PencilLine className="h-4 w-4 text-cyan-500 shrink-0" />}>
				{actorLabel} renamed {appEvent.squadName} (Team {appEvent.teamId})
			</EventLine>
		)
	}
	if (appEvent.type === 'COMMANDER_DEMOTED') {
		const target = event.targetPlayers[0]
		return (
			<EventLine time={event.time} icon={<Icons.ShieldOff className="h-4 w-4 text-orange-500 shrink-0" />}>
				{actorLabel} demoted {target && matchId !== null
					? <PlayerDisplay showTeam player={target} matchId={matchId} stores={stores} />
					: 'the commander'}
				{appEvent.reason?.label ? ` for ${appEvent.reason.label}` : ''}
			</EventLine>
		)
	}
	if (appEvent.type === 'FOG_OF_WAR_TOGGLED') {
		return (
			<EventLine time={event.time} icon={<Icons.CloudFog className="h-4 w-4 text-slate-400 shrink-0" />}>
				{actorLabel} turned fog of war {appEvent.enabled ? 'on' : 'off'}
			</EventLine>
		)
	}
	// audit-only today (matchId is null so it never enters the feed), but the branch keeps the union narrowing sound
	if (appEvent.type === 'BROADCAST_SENT') {
		return (
			<EventLine time={event.time} icon={<Icons.Megaphone className="h-4 w-4 text-amber-500 shrink-0" />}>
				{actorLabel} broadcast "{appEvent.message}"
			</EventLine>
		)
	}
	if (appEvent.type === 'PLAYER_TIMED_OUT') {
		const target = event.targetPlayers[0]
		return (
			<EventLine time={event.time} icon={<Icons.UserX className="h-4 w-4 text-red-500 shrink-0" />}>
				{actorLabel} kicked {target && matchId !== null
					? <PlayerDisplay showTeam player={target} matchId={matchId} stores={stores} />
					: 'a player'} with a {formatHumanTime(appEvent.durationMs)} timeout
				{appEvent.reason?.label ? ` for ${appEvent.reason.label}` : ''}
			</EventLine>
		)
	}
	if (appEvent.type === 'TIMEOUT_CANCELLED') {
		const target = event.targetPlayers[0]
		return (
			<EventLine time={event.time} icon={<Icons.UserCheck className="h-4 w-4 text-green-500 shrink-0" />}>
				{actorLabel} cancelled {target && matchId !== null
					? <PlayerDisplay showTeam player={target} matchId={matchId} stores={stores} />
					: 'a player'}'s timeout
			</EventLine>
		)
	}
	if (appEvent.type === 'MATCH_ENDED') {
		return (
			<EventLine time={event.time} icon={<Icons.Flag className="h-4 w-4 text-red-500 shrink-0" />}>
				{actorLabel} ended the match
			</EventLine>
		)
	}
	if (appEvent.type === 'VOTE_STARTED') {
		return (
			<EventLine time={event.time} icon={<Icons.Vote className="h-4 w-4 text-blue-500 shrink-0" />}>
				{actorLabel} started a vote ({appEvent.choiceCount} {appEvent.choiceCount === 1 ? 'option' : 'options'})
			</EventLine>
		)
	}
	if (appEvent.type === 'VOTE_ENDED') {
		return (
			<EventLine time={event.time} icon={<Icons.ListChecks className="h-4 w-4 text-green-500 shrink-0" />}>
				{appEvent.reason === 'ended-early' ? `${actorLabel} ended the vote early` : 'The vote ended'}
				{appEvent.winnerLayerId
					? (
						<>
							: <ShortLayerName layerId={appEvent.winnerLayerId} /> won
						</>
					)
					: ' (no winner)'}
			</EventLine>
		)
	}
	if (appEvent.type === 'VOTE_ABORTED') {
		return (
			<EventLine time={event.time} icon={<Icons.Ban className="h-4 w-4 text-red-500 shrink-0" />}>
				{actorLabel} aborted the vote
			</EventLine>
		)
	}
	if (appEvent.type === 'QUEUE_UPDATED') {
		return <QueueUpdatedEvent event={event} appEvent={appEvent} actorLabel={actorLabel} stores={stores} />
	}
	if (appEvent.type === 'MAP_SET') {
		// only override sets reach the feed; queue-driven MAP_SETs fold into their QUEUE_UPDATED (audit-only)
		if (appEvent.reason === 'queue-updated') {
			return (
				<EventLine time={event.time} icon={<Icons.RefreshCw className="h-4 w-4 text-amber-500 shrink-0" />}>
					Next layer set to <ShortLayerName layerId={appEvent.layerId} />
				</EventLine>
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
			<EventLine time={event.time} icon={<Icons.RefreshCw className="h-4 w-4 text-amber-500 shrink-0" />}>
				SLM overrode a layer set by {who}, next layer set to <ShortLayerName layerId={appEvent.layerId} />
			</EventLine>
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
			<EventLine time={event.time} icon={<Icons.ScrollText className="h-4 w-4 text-slate-400 shrink-0" />}>
				{actorLabel} {AppEvents.describeAppEvent(appEvent)}
			</EventLine>
		)
	}

	// warns render message-style (colored channel + border + gradient) like a chat message, with the channel
	// naming who was warned rather than a chat scope
	if (appEvent.type === 'PLAYER_WARNED') {
		const warnCount = appEvent.targets.length
		const summary = event.warnSummary
		const single = summary.type === 'players' && warnCount === 1 && matchId !== null && event.targetPlayers.length === 1
		const styleKey = summary.type === 'all-admins' ? 'admins' : single ? 'single' : 'selection'
		const style = WARN_CHANNEL_STYLES[styleKey]

		const channel: React.ReactNode = single
			? (
				<span
					className="inline-flex items-baseline gap-1 flex-nowrap whitespace-nowrap"
					style={{ color: style.color }}
				>
					(warning <PlayerDisplay showTeam player={event.targetPlayers[0]} matchId={matchId!} stores={stores} />)
				</span>
			)
			: (
				<span style={{ color: style.color }} title="the players this warning was sent to">
					({(() => {
						if (summary.type === 'all-admins') return 'warning admins'
						const descriptor = warnSummaryDescriptor(summary)
						if (!descriptor) return `warning ${warnCount} ${warnCount === 1 ? 'player' : 'players'}`
						return warnCount > 1 ? `warning ${descriptor} (${warnCount} players)` : `warning ${descriptor}`
					})()})
				</span>
			)

		const header = (
			<>
				<EventTime time={event.time} />
				<div className="grow min-w-0 wrap-anywhere">
					{channel} {actorLabel}: "{appEvent.message}"
				</div>
			</>
		)

		const containerStyle = {
			borderRightColor: style.color,
			backgroundImage: `linear-gradient(to left, ${style.gradientColor}, transparent)`,
		}
		// a single/named-target warn is a flat line; a bulk warn keeps an expandable list of everyone warned
		if (single || !targetList) {
			return (
				<div
					className="flex gap-2 py-1 text-xs w-full min-w-0 border-r-2 bg-linear-to-l to-transparent items-baseline"
					style={containerStyle}
				>
					{header}
				</div>
			)
		}
		return (
			<details className="py-1 text-xs w-full min-w-0 border-r-2 bg-linear-to-l to-transparent" style={containerStyle}>
				<summary className="flex gap-2 items-baseline cursor-pointer">
					{header}
				</summary>
				{targetList}
			</details>
		)
	}

	// PLAYER_REMOVED_FROM_SQUAD / TEAM_CHANGE_FORCED / PLAYER_KILLED: "{actor} {verb} {targets}{suffix}"
	const count = appEvent.targets.length
	const plural = count === 1 ? 'player' : 'players'
	let verb: string
	let icon: React.ReactNode
	let suffix: React.ReactNode
	if (appEvent.type === 'PLAYER_REMOVED_FROM_SQUAD') {
		verb = 'removed'
		icon = <Icons.UserMinus className="h-4 w-4 text-orange-500 shrink-0" />
		suffix = appEvent.reason?.label ? ` from their squad for ${appEvent.reason.label}` : ' from their squad'
	} else if (appEvent.type === 'PLAYER_KILLED') {
		verb = 'killed'
		icon = <Icons.Skull className="h-4 w-4 text-red-500 shrink-0" />
		suffix = appEvent.reason
			? (
				<>
					: "{appEvent.reason}"
				</>
			)
			: null
	} else {
		verb = 'switched'
		icon = <Icons.ArrowLeftRight className="h-4 w-4 text-blue-500 shrink-0" />
		suffix = ' to the other team'
	}

	// few enough targets: name them inline instead of grouping/collapsing (but still show the count)
	if (count <= 4 && matchId !== null && event.targetPlayers.length === count) {
		return (
			<EventLine time={event.time} icon={icon}>
				{actorLabel} {verb} {event.targetPlayers.map((player, i) => (
					<span key={player.ids.eos}>
						{i > 0 ? ', ' : ''}
						<PlayerDisplay showTeam player={player} matchId={matchId} stores={stores} />
					</span>
				))}
				{count > 1 ? <>{' '}({count} {plural})</> : ''}
				{suffix}
			</EventLine>
		)
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">
					{actorLabel} {verb} {count === 1 ? 'a player' : `${count} ${plural}`}
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
			<EventLine time={event.time} icon={<Icons.Play className="h-4 w-4 text-green-500 shrink-0" />} className="py-0.5">
				{label} ({visibleMatchIndex === 0 ? 'Current Match' : visibleMatchIndex}):{' '}
				{match && <ShortLayerName layerId={match.layerId} teamParity={match.ordinal % 2} className="text-xs" />}
			</EventLine>
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
		<EventLine time={event.time} icon={<Icons.Flag className="h-4 w-4 text-blue-500 shrink-0" />}>
			Round ended (<MapLayerDisplay layer={L.toLayer(match.layerId).Layer} className="text-xs font-semibold" />){' '}
			{winnerId === null && <span className="text-yellow-400">Draw</span>}
			{winnerId !== null && (
				<>
					<MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={winnerId} /> won{' '}
					<span className="font-semibold">{winnerTickets} to {loserTickets}</span> against{' '}
					<MatchTeamDisplay stores={stores} matchId={event.matchId} teamId={loserId} />
				</>
			)}
			{actionElt && <>{' '}{actionElt}</>}
		</EventLine>
	)
}

function PlayerChangedTeamEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_CHANGED_TEAM' }>; stores: SquadServerFrame.KeyProp },
) {
	// don't render unassigned, and if the player was previously unassigned that means we're swapping teams after the match, so no need to render
	if (event.newTeamId === null || event.prevTeamId === null) return
	return (
		<EventLine time={event.time} icon={<Icons.Repeat className="h-4 w-4 text-purple-400 shrink-0" />}>
			<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> changed to{' '}
			<MatchTeamDisplay stores={stores} teamId={event.player.teamId!} matchId={event.matchId} />
		</EventLine>
	)
}

function PlayerLeftSquadEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_LEFT_SQUAD' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.LogOut className="h-4 w-4 text-orange-400 shrink-0" />}>
			<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> left{' '}
			<SquadDisplay
				squad={event.squad}
				matchId={event.matchId}
				showName={false}
				showTeam={true}
				stores={stores}
			/>
			{event.wasLeader ? ' (was leader)' : ''}
		</EventLine>
	)
}

function SquadDisbandedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_DISBANDED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.UsersRound className="h-4 w-4 text-red-400 shrink-0" />}>
			<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={true} stores={stores} /> was disbanded
		</EventLine>
	)
}

function SquadDetailsChangedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_DETAILS_CHANGED' }>; stores: SquadServerFrame.KeyProp },
) {
	const locked = event.details.locked
	const prevLocked = event.prevDetails.locked
	if (locked === prevLocked || locked === undefined) return null
	return (
		<EventLine
			time={event.time}
			icon={locked
				? <Icons.Lock className="h-4 w-4 text-yellow-500 shrink-0" />
				: <Icons.LockOpen className="h-4 w-4 text-green-500 shrink-0" />}
		>
			<SquadDisplay squad={event.squad} matchId={event.matchId} showName={true} showTeam={true} stores={stores} />{' '}
			{locked ? 'locked' : 'unlocked'}
		</EventLine>
	)
}

function SquadRenamedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'SQUAD_RENAMED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.Pencil className="h-4 w-4 text-cyan-400 shrink-0" />}>
			<SquadDisplay
				squad={{ ...event.squad, squadName: event.oldSquadName }}
				matchId={event.matchId}
				showName={true}
				showTeam={true}
				stores={stores}
			/>{' '}
			renamed to <span className="font-medium text-foreground">"{event.newSquadName}"</span>
		</EventLine>
	)
}

function PlayerJoinedSquadEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_JOINED_SQUAD' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.LogIn className="h-4 w-4 text-green-400 shrink-0" />}>
			<PlayerDisplay player={event.player} matchId={event.matchId} stores={stores} /> joined{' '}
			<SquadDisplay
				squad={event.squad}
				matchId={event.matchId}
				showTeam={true}
				stores={stores}
			/>
		</EventLine>
	)
}

function PlayerPromotedToLeaderEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_PROMOTED_TO_LEADER' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.Crown className="h-4 w-4 text-yellow-400 shrink-0" />}>
			<PlayerDisplay showTeam={true} showSquad={true} player={event.player} matchId={event.matchId} stores={stores} />{' '}
			promoted to squad leader
		</EventLine>
	)
}

function PlayerWoundedOrDiedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WOUNDED' | 'PLAYER_DIED' }>; stores: SquadServerFrame.KeyProp },
) {
	const getIcon = () => {
		if (event.type === 'PLAYER_DIED') {
			switch (event.variant) {
				case 'suicide':
					return <Icons.Skull className="h-4 w-4 text-orange-400 shrink-0" />
				case 'teamkill':
					return <Icons.Skull className="h-4 w-4 text-red-500 shrink-0" />
				case 'normal':
					return <Icons.Skull className="h-4 w-4 text-foreground shrink-0" />
			}
		}

		switch (event.variant) {
			case 'suicide':
				return <Icons.HeartPulse className="h-4 w-4 text-orange-400 shrink-0" />
			case 'teamkill':
				return <Icons.HeartPulse className="h-4 w-4 text-red-500 shrink-0" />
			case 'normal':
				return null
		}
	}

	const weaponSuffix = event.weapon && <span className="text-muted-foreground/70">{' '}with {event.weapon}</span>

	const getMessage = () => {
		switch (event.variant) {
			case 'suicide':
				return (
					<>
						<PlayerDisplay showTeam showSquad={true} player={event.victim} matchId={event.matchId} stores={stores} />{' '}
						{event.type === 'PLAYER_WOUNDED' ? 'wounded themselves' : 'killed themselves'}
						{weaponSuffix}
					</>
				)
			case 'teamkill':
				return (
					<>
						<PlayerDisplay showTeam showSquad={true} player={event.victim} matchId={event.matchId} stores={stores} /> teamkilled by{' '}
						<PlayerDisplay showTeam showSquad={true} player={event.attacker} matchId={event.matchId} stores={stores} />
						{weaponSuffix}
					</>
				)
			case 'normal':
				return (
					<>
						<PlayerDisplay showTeam player={event.victim} matchId={event.matchId} stores={stores} />{' '}
						{event.type === 'PLAYER_WOUNDED' ? 'wounded by' : 'killed by'}{' '}
						<PlayerDisplay showTeam={true} player={event.attacker} matchId={event.matchId} stores={stores} />
						{weaponSuffix}
					</>
				)
		}
	}

	return <EventLine time={event.time} icon={getIcon()}>{getMessage()}</EventLine>
}

function MapSetEvent({ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'MAP_SET' }>; stores: SquadServerFrame.KeyProp }) {
	return (
		<EventLine time={event.time} icon={<Icons.Map className="h-4 w-4 text-blue-400 shrink-0" />} className="py-0.5">
			Next layer set to <ShortLayerName layerId={event.layerId} teamParity={0} className="text-xs" />
		</EventLine>
	)
}

function RconConnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'RCON_CONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.Plug className="h-4 w-4 text-green-500 shrink-0" />}>
			{event.reconnected ? 'RCON reconnected' : 'Application started, RCON connection established'}
		</EventLine>
	)
}

function RconDisconnectedEvent(
	{ event, stores }: { event: Extract<CHAT.EventEnriched, { type: 'RCON_DISCONNECTED' }>; stores: SquadServerFrame.KeyProp },
) {
	return (
		<EventLine time={event.time} icon={<Icons.Unplug className="h-4 w-4 text-red-500 shrink-0" />}>
			RCON disconnected
		</EventLine>
	)
}

export function ServerEvent({ event, stores }: { event: CHAT.EventEnriched; stores: SquadServerFrame.KeyProp }) {
	switch (event.type) {
		case 'CHAT_MESSAGE':
		case 'ADMIN_BROADCAST':
			return <ChatMessageEvent event={event} stores={stores} />
		case 'PLAYER_CONNECTED':
			return <PlayerConnectedEvent event={event} stores={stores} />
		case 'PLAYER_RECONCILED':
			// roster backfill from the teams poll -- not surfaced to the user
			return null
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
