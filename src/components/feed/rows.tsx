// static-render calls these components directly, so the react compiler must not inject its memo-cache hook
'use no memo'

// Every activity feed row that isn't an app event, as inert jsx. App events are the exception and stay in
// live react (see server-event.tsx): they are a fraction of a percent of the feed, and they query, expand and
// attribute in ways an inert template cannot.
//
// Nothing here may use hooks or handlers: the same component renders to strings on the server (history
// results) and on the client (the activity feed inserts the strings; see render.ts), and interactivity is
// all attributes the delegated handlers read.

import React from 'react'

import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as I18n from '@/messages/i18n'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'

import { AppEventRow } from './app-event-rows'
import * as Atoms from './atoms'
import { Icon } from './icons'
import type * as RC from './render-context'

const tr = I18n.ambient

const CHANNEL_STYLES = {
	ChatAll: { color: '#eeeeee', gradientColor: 'rgba(255, 255, 255, 0.08)' },
	ChatTeam: { color: '#5b8def', gradientColor: 'rgba(91, 141, 239, 0.12)' },
	ChatSquad: { color: '#5fb76a', gradientColor: 'rgba(95, 183, 106, 0.12)' },
	ChatAdmin: { color: '#e6b422', gradientColor: 'rgba(230, 180, 34, 0.14)' },
	Broadcast: { color: '#e8c24a', gradientColor: 'rgba(232, 194, 74, 0.12)' },
} as const

const MESSAGE_ROW_CLASS =
	'flex gap-1.5 py-[3px] pr-1.5 text-xs text-text w-full min-w-0 border-r-2 bg-linear-to-l to-transparent items-baseline'

function messageRowStyle(style: { color: string; gradientColor: string }): React.CSSProperties {
	return { borderRightColor: style.color, backgroundImage: `linear-gradient(to left, ${style.gradientColor}, transparent)` }
}

function ChatMessage(props: { ctx: RC.RenderCtx; event: Extract<CHAT.EventEnriched, { type: 'CHAT_MESSAGE' | 'ADMIN_BROADCAST' }> }) {
	const { ctx, event } = props
	// the live feed suppresses chat from a player not yet on a team (a transient pre-roster state); a results
	// context has to show every event its query matched, teamless or not
	if (event.type === 'CHAT_MESSAGE' && event.player.teamId === null && !ctx.showTeamlessChat) return null
	const match = ctx.matchById(event.matchId)

	const channelStyle = (() => {
		if (event.type === 'ADMIN_BROADCAST') return CHANNEL_STYLES.Broadcast
		const base = CHANNEL_STYLES[event.channel.type]
		if (event.channel.type !== 'ChatTeam' || !match) return base
		const teamColor = DH.getTeamColor(event.channel.teamId, match.ordinal, ctx.displayTeamsNormalized)
		const r = parseInt(teamColor.slice(1, 3), 16)
		const g = parseInt(teamColor.slice(3, 5), 16)
		const b = parseInt(teamColor.slice(5, 7), 16)
		return { color: teamColor, gradientColor: `rgba(${r}, ${g}, ${b}, 0.1)` }
	})()

	const channelLabel = ((): React.ReactNode => {
		if (event.type === 'ADMIN_BROADCAST') {
			return (
				<span style={{ color: channelStyle.color }} title={tr.text(CHAT_Msgs.chatChannelBroadcastHint())}>
					{tr.text(CHAT_Msgs.chatChannelBroadcast())}
				</span>
			)
		}
		switch (event.channel.type) {
			case 'ChatAll':
				return (
					<span style={{ color: channelStyle.color }} title={tr.text(CHAT_Msgs.chatChannelAllHint())}>
						{tr.text(CHAT_Msgs.chatChannelAll())}
					</span>
				)
			case 'ChatTeam':
				return (
					<span className="inline-flex gap-0">
						(
						<span style={{ color: channelStyle.color }} className="flex items-baseline flex-nowrap whitespace-nowrap gap-1">
							<Atoms.MatchTeamDisplay ctx={ctx} matchId={event.matchId} teamId={event.channel.teamId} />
						</span>
						)
					</span>
				)
			case 'ChatSquad':
				return (
					<span className="inline-flex gap-0">
						(
						<span className="flex items-baseline flex-nowrap whitespace-nowrap gap-1" style={{ color: channelStyle.color }}>
							<Atoms.SquadDisplay
								ctx={ctx}
								squad={{
									squadId: event.channel.squadId,
									squadName: '',
									teamId: event.channel.teamId,
									uniqueId: event.channel.uniqueId,
								}}
								matchId={event.matchId!}
								showName={false}
								showTeam={false}
							/>
							<Atoms.MatchTeamDisplay ctx={ctx} matchId={event.matchId} teamId={event.channel.teamId} />
						</span>
						)
					</span>
				)
			case 'ChatAdmin':
				return (
					<span style={{ color: channelStyle.color }} title={tr.text(CHAT_Msgs.chatChannelAdminHint())}>
						{tr.text(CHAT_Msgs.chatChannelAdmin())}
					</span>
				)
			default:
				return assertNever(event.channel)
		}
	})()

	const fromDisplay = ((): React.ReactNode => {
		if (event.type === 'ADMIN_BROADCAST') {
			if (event.player) return <Atoms.PlayerDisplay ctx={ctx} player={event.player} matchId={event.matchId} />
			if (event.from === 'RCON') return <span className="text-[#ef7c7a]">{tr.text(CHAT_Msgs.broadcastFromRcon())}</span>
			if (event.from === 'unknown') return <span className="text-warn/60">{tr.text(CHAT_Msgs.broadcastFromUnknown())}</span>
			return null
		}
		return (
			<Atoms.PlayerDisplay
				ctx={ctx}
				player={event.player}
				matchId={event.matchId}
				showTeam={['ChatAdmin', 'ChatAll'].includes(event.channel.type)}
			/>
		)
	})()

	return (
		<div className={MESSAGE_ROW_CLASS} style={messageRowStyle(channelStyle)}>
			<Atoms.EventTime time={event.time} />
			<div className="grow min-w-0 wrap-anywhere">
				{channelLabel}
				{fromDisplay}
				{': '}
				{event.message}
			</div>
		</div>
	)
}

// several standalone warns sharing the same text + source, collapsed into one entry. Few targets are named inline;
// larger groups use an expandable <details> listing everyone warned.
function WarnsAggregated(props: { ctx: RC.RenderCtx; event: Extract<CHAT.EventEnriched, { type: 'WARNS_AGGREGATED' }> }) {
	const { ctx, event } = props
	const count = event.warns.length
	const iconElt = <Icon name="AlertTriangle" className="h-4 w-4 text-warn shrink-0" />

	if (count <= 4) {
		const warnees = event.warns.map((warn, i) => (
			// eslint-disable-next-line react/no-array-index-key
			<span key={i}>
				{i > 0 ? ', ' : null}
				<Atoms.PlayerDisplay ctx={ctx} showTeam player={warn.player} matchId={event.matchId} />
			</span>
		))
		return (
			<Atoms.EventLine time={event.time} icon={iconElt}>
				{tr.richText(CHAT_Msgs.playersWarned(warnees, event.reason))}
			</Atoms.EventLine>
		)
	}

	return (
		<Details time={event.time} icon={iconElt} summary={tr.richText(CHAT_Msgs.playerCountWarned(count, event.reason))}>
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{event.warns.map((warn, i) => (
					// eslint-disable-next-line react/no-array-index-key
					<Atoms.PlayerDisplay key={i} ctx={ctx} showTeam player={warn.player} matchId={event.matchId} />
				))}
			</div>
		</Details>
	)
}

// an expandable entry. Native <details>, so no state has to live anywhere for it.
function Details(props: { time: number; icon: React.ReactNode; summary: React.ReactNode; children: React.ReactNode }) {
	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<Atoms.EventTime time={props.time} />
				{props.icon}
				<span className="grow min-w-0 wrap-anywhere">{props.summary}</span>
			</summary>
			{props.children}
		</details>
	)
}

function NewGame(props: { ctx: RC.RenderCtx; event: Extract<CHAT.EventEnriched, { type: 'NEW_GAME' }> }) {
	const { ctx, event } = props
	const match = ctx.matchById(event.matchId)
	if (!match || !ctx.currentMatch) return null
	const visibleMatchIndex = match.ordinal - ctx.currentMatch.ordinal

	let label: string
	switch (event.source) {
		case 'new-game-detected':
		case 'server-roll':
			label = tr.text(CHAT_Msgs.newGameStarted())
			break
		case 'slm-started':
			label = tr.text(CHAT_Msgs.newGameOnAppStart())
			break
		case 'rcon-reconnected':
			label = tr.text(CHAT_Msgs.newGameOnRconReconnect())
			break
		default:
			assertNever(event.source)
	}

	return (
		<div className="border-t border-green-500 pt-0.5 mt-1 w-full">
			<Atoms.EventLine time={event.time} icon={<Icon name="Play" className="h-4 w-4 text-ok shrink-0" />} className="py-0.5">
				{tr.richText(
					CHAT_Msgs.newGameLine(
						label,
						visibleMatchIndex === 0 ? tr.text(CHAT_Msgs.currentMatch()) : visibleMatchIndex,
						<Atoms.ShortLayerName
							normalized={ctx.displayTeamsNormalized}
							layerId={match.layerId}
							teamParity={match.ordinal % 2}
							className="text-xs"
						/>,
					),
				)}
			</Atoms.EventLine>
		</div>
	)
}

function RoundEnded(props: { ctx: RC.RenderCtx; event: Extract<CHAT.EventEnriched, { type: 'ROUND_ENDED' }> }) {
	const { ctx, event } = props
	const match = ctx.matchById(event.matchId)
	if (match?.status !== 'post-game') return null
	const winnerTickets =
		match.outcome.type === 'team1' ? match.outcome.team1Tickets : match.outcome.type === 'team2' ? match.outcome.team2Tickets : 0
	const loserTickets =
		match.outcome.type === 'team1' ? match.outcome.team2Tickets : match.outcome.type === 'team2' ? match.outcome.team1Tickets : 0
	const winnerId = match.outcome.type === 'team1' ? 1 : match.outcome.type === 'team2' ? 2 : null
	const loserId = winnerId === 1 ? 2 : 1

	let actionElt: React.ReactNode = null
	if (event.action) {
		const source = event.action.source
		let sourceName: React.ReactNode
		if (source.type === 'player') {
			sourceName = (
				<span>
					{tr.richText(
						CHAT_Msgs.roundEndBy(
							event.actorPlayer ? (
								<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.actorPlayer} matchId={event.matchId} />
							) : (
								<b>{source.playerIds.username}</b>
							),
						),
					)}
				</span>
			)
		} else if (source.type === 'rcon') {
			sourceName = <span>{tr.richText(CHAT_Msgs.roundEndVia(<b>{tr.text(CHAT_Msgs.rconTool())}</b>))}</span>
		} else {
			// an SLM action: the app event it links to is its own entry in the feed and names the admin
			sourceName = <span>{tr.richText(CHAT_Msgs.roundEndVia(<b>{tr.text(CHAT_Msgs.slmTool())}</b>))}</span>
		}
		const nextLayerText =
			event.action.type === 'AdminChangeLayer' ? (
				<span>
					{tr.richText(
						CHAT_Msgs.roundEndSwitchingTo(
							<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={event.action.layerId} />,
						),
					)}
				</span>
			) : null
		actionElt = (
			<span className="text-xs font-semibold">
				{tr.richText(CHAT_Msgs.roundEndAction(event.action.type, sourceName, nextLayerText))}
			</span>
		)
	}

	const layerElt = () => <Atoms.MapLayerDisplay layer={L.toLayer(match.layerId).Layer!} className="text-xs font-semibold" />
	return (
		<Atoms.EventLine
			time={event.time}
			icon={<Icon name="Flag" className="h-4 w-4 text-info shrink-0" />}
			className="[&_strong]:font-semibold"
		>
			{winnerId === null
				? tr.richText(CHAT_Msgs.roundEndedDraw(layerElt(), <span className="text-warn">{tr.text(CHAT_Msgs.draw())}</span>))
				: tr.richText(
						CHAT_Msgs.roundEndedWinner(
							layerElt(),
							<Atoms.MatchTeamDisplay ctx={ctx} matchId={event.matchId} teamId={winnerId} />,
							winnerTickets,
							loserTickets,
							<Atoms.MatchTeamDisplay ctx={ctx} matchId={event.matchId} teamId={loserId} />,
						),
					)}
			{actionElt && <> {actionElt}</>}
		</Atoms.EventLine>
	)
}

function WoundedOrDied(props: { ctx: RC.RenderCtx; event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WOUNDED' | 'PLAYER_DIED' }> }) {
	const { ctx, event } = props
	const iconElt = (() => {
		if (event.type === 'PLAYER_DIED') {
			switch (event.variant) {
				case 'suicide':
					return <Icon name="Skull" className="h-4 w-4 text-warn shrink-0" />
				case 'teamkill':
					return <Icon name="Skull" className="h-4 w-4 text-danger shrink-0" />
				case 'normal':
					return <Icon name="Skull" className="h-4 w-4 text-foreground shrink-0" />
			}
		}
		switch (event.variant) {
			case 'suicide':
				return <Icon name="HeartPulse" className="h-4 w-4 text-warn shrink-0" />
			case 'teamkill':
				return <Icon name="HeartPulse" className="h-4 w-4 text-danger shrink-0" />
			case 'normal':
				return null
		}
	})()

	const weaponSuffix = event.weapon ? (
		<span className="text-muted-foreground/70">{tr.text(CHAT_Msgs.withWeapon(event.weapon))}</span>
	) : undefined

	const message = (() => {
		switch (event.variant) {
			case 'suicide':
				return tr.richText(
					CHAT_Msgs.playerSuicide(
						<Atoms.PlayerDisplay ctx={ctx} showTeam showSquad player={event.victim} matchId={event.matchId} />,
						event.type === 'PLAYER_WOUNDED',
						weaponSuffix,
					),
				)
			case 'teamkill':
				return tr.richText(
					CHAT_Msgs.playerTeamkilled(
						<Atoms.PlayerDisplay ctx={ctx} showTeam showSquad player={event.victim} matchId={event.matchId} />,
						<Atoms.PlayerDisplay ctx={ctx} showTeam showSquad player={event.attacker} matchId={event.matchId} />,
						weaponSuffix,
					),
				)
			case 'normal':
				return tr.richText(
					CHAT_Msgs.playerDowned(
						<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.victim} matchId={event.matchId} />,
						event.type === 'PLAYER_WOUNDED',
						<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.attacker} matchId={event.matchId} />,
						weaponSuffix,
					),
				)
			default:
				return assertNever(event.variant)
		}
	})()

	return (
		<Atoms.EventLine time={event.time} icon={iconElt}>
			{message}
		</Atoms.EventLine>
	)
}

// A layer set on the server. The SLM-originated ones normally collapse into the app event that caused them (see
// handleEvent), so what reaches here is somebody else's set -- or, on connect, no set at all: `observed` is the
// layer the server already had, which reads as an anonymous set unless it says so.
function MapSet(props: { ctx: RC.RenderCtx; event: Extract<CHAT.EventEnriched, { type: 'MAP_SET' }> }) {
	const { ctx, event } = props
	const layer = () => (
		<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={event.layerId} teamParity={0} className="text-xs" />
	)
	const iconElt = <Icon name="Map" className="h-4 w-4 text-info shrink-0" />
	if (event.source?.type === 'observed') {
		return (
			<Atoms.EventLine time={event.time} icon={iconElt} className="py-0.5">
				{tr.richText(CHAT_Msgs.observedNextLayer(layer()))}
			</Atoms.EventLine>
		)
	}
	const who: React.ReactNode =
		event.source?.type === 'player' && event.actorPlayer ? (
			<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.actorPlayer} matchId={event.matchId} />
		) : event.source?.type === 'player' ? (
			(event.source.playerIds.username ?? tr.text(CHAT_Msgs.ingameAdmin()))
		) : event.source?.type === 'rcon' ? (
			tr.text(CHAT_Msgs.anotherRconTool())
		) : null
	return (
		<Atoms.EventLine time={event.time} icon={iconElt} className="py-0.5">
			{who ? tr.richText(CHAT_Msgs.nextLayerSetBy(who, layer())) : tr.richText(CHAT_Msgs.nextLayerSet(layer()))}
		</Atoms.EventLine>
	)
}

/**
 * One feed row, or null when the event draws nothing.
 *
 * A results context asks for a placeholder instead of nothing (see RenderCtx.placeholderUndrawn): the live
 * feed leaves roster bookkeeping undrawn on purpose, but a query that matched such an event has to show it,
 * or the result count disagrees with what is on screen.
 */
export function Row({ ctx, event }: { ctx: RC.RenderCtx; event: CHAT.EventEnriched }): React.ReactNode {
	if (event.type === 'APP_EVENT') return <AppEventRow ctx={ctx} event={event} />
	const drawn = drawRow({ ctx, event })
	if (drawn !== null || !ctx.placeholderUndrawn) return drawn
	return <UndrawnRow event={event} />
}

// The event as its type and its payload, for the types the feed has no rendering for. A native disclosure, so
// it stays inert: no handler, and it works the same server-rendered, walked to dom, or in a react tree.
function UndrawnRow({ event }: { event: CHAT.EventEnriched }) {
	// a NOOP's placeholder names the event it stands for, and why it drew nothing
	const type = event.type === 'NOOP' ? `${event.originalEvent.type} \u00b7 ${event.cause}` : event.type
	return (
		<Atoms.EventLine time={event.time} icon={<Icon name="Dot" className="h-4 w-4 text-muted-foreground shrink-0" />}>
			<details className="min-w-0">
				<summary className="cursor-pointer font-mono text-2xs text-muted-foreground">{type}</summary>
				<pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-1 text-2xs wrap-anywhere">{JSON.stringify(event, null, 2)}</pre>
			</details>
		</Atoms.EventLine>
	)
}

// not a component: Row needs the result to decide whether to stand a placeholder in for it
function drawRow({ ctx, event }: { ctx: RC.RenderCtx; event: CHAT.EventEnriched }): React.ReactNode {
	switch (event.type) {
		case 'CHAT_MESSAGE':
		case 'ADMIN_BROADCAST':
			return <ChatMessage ctx={ctx} event={event} />
		case 'PLAYER_CONNECTED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="UserPlus" className="h-4 w-4 text-ok shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerConnected(
							<Atoms.PlayerDisplay ctx={ctx} player={event.player} matchId={event.matchId} />,
							event.player.teamId ? (
								<Atoms.MatchTeamDisplay ctx={ctx} teamId={event.player.teamId} matchId={event.matchId} />
							) : undefined,
						),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_DISCONNECTED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="UserMinus" className="h-4 w-4 text-danger shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerDisconnected(<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.player} matchId={event.matchId} />),
					)}
				</Atoms.EventLine>
			)
		case 'POSSESSED_ADMIN_CAMERA':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Camera" className="h-4 w-4 text-[#b58cff] shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.enteredAdminCamera(<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.player} matchId={event.matchId} />),
					)}
				</Atoms.EventLine>
			)
		case 'UNPOSSESSED_ADMIN_CAMERA':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="CameraOff" className="h-4 w-4 text-[#b58cff] shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.exitedAdminCamera(<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.player} matchId={event.matchId} />),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_KICKED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="UserX" className="h-4 w-4 text-warn shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerKicked(
							<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.player} matchId={event.matchId} />,
							event.reason ? <span className="text-muted-foreground/70">{event.reason}</span> : undefined,
						),
					)}
				</Atoms.EventLine>
			)
		case 'SQUAD_CREATED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Users" className="h-4 w-4 text-info shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.squadCreated(
							<Atoms.PlayerDisplay ctx={ctx} player={event.creator} matchId={event.matchId} />,
							<Atoms.SquadDisplay ctx={ctx} squad={event.squad} matchId={event.matchId} showName showTeam={false} />,
							<Atoms.MatchTeamDisplay ctx={ctx} matchId={event.matchId} teamId={event.squad.teamId} />,
						),
					)}
					{event.squad.locked ? <Icon name="Lock" className="h-3 w-3 text-danger inline-block ml-1" /> : null}
				</Atoms.EventLine>
			)
		case 'PLAYER_BANNED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Ban" className="h-4 w-4 text-danger shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerBanned(<Atoms.PlayerDisplay ctx={ctx} player={event.player} matchId={event.matchId} />, event.interval),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_WARNED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="AlertTriangle" className="h-4 w-4 text-warn shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerWarned(
							<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.player} matchId={event.matchId} />,
							event.reason,
						),
					)}
				</Atoms.EventLine>
			)
		case 'WARNS_AGGREGATED':
			return <WarnsAggregated ctx={ctx} event={event} />
		case 'NEW_GAME':
			return <NewGame ctx={ctx} event={event} />
		case 'ROUND_ENDED':
			return <RoundEnded ctx={ctx} event={event} />
		case 'SQUAD_DETAILS_CHANGED': {
			const locked = event.details.locked
			if (locked === event.prevDetails.locked || locked === undefined) return null
			return (
				<Atoms.EventLine
					time={event.time}
					icon={
						locked ? (
							<Icon name="Lock" className="h-4 w-4 text-warn shrink-0" />
						) : (
							<Icon name="LockOpen" className="h-4 w-4 text-ok shrink-0" />
						)
					}
				>
					{tr.richText(
						CHAT_Msgs.squadLockChanged(
							<Atoms.SquadDisplay ctx={ctx} squad={event.squad} matchId={event.matchId} showName showTeam />,
							locked,
						),
					)}
				</Atoms.EventLine>
			)
		}
		case 'SQUAD_RENAMED':
			return (
				<Atoms.EventLine
					time={event.time}
					icon={<Icon name="Pencil" className="h-4 w-4 text-info shrink-0" />}
					className="[&_strong]:font-medium [&_strong]:text-foreground"
				>
					{tr.richText(
						CHAT_Msgs.squadRenamed(
							<Atoms.SquadDisplay
								ctx={ctx}
								squad={{ ...event.squad, squadName: event.oldSquadName }}
								matchId={event.matchId}
								showName
								showTeam
							/>,
							event.newSquadName,
						),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_CHANGED_TEAM':
			// don't render unassigned, and a player who was previously unassigned is a post-match team swap
			if (event.newTeamId === null || event.prevTeamId === null) return null
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Repeat" className="h-4 w-4 text-[#b58cff] shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerChangedTeam(
							<Atoms.PlayerDisplay ctx={ctx} player={event.player} matchId={event.matchId} />,
							<Atoms.MatchTeamDisplay ctx={ctx} teamId={event.player.teamId!} matchId={event.matchId} />,
						),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_LEFT_SQUAD':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="LogOut" className="h-4 w-4 text-warn shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerLeftSquad(
							<Atoms.PlayerDisplay ctx={ctx} player={event.player} matchId={event.matchId} />,
							<Atoms.SquadDisplay ctx={ctx} squad={event.squad} matchId={event.matchId} showName={false} showTeam />,
							event.wasLeader,
						),
					)}
				</Atoms.EventLine>
			)
		case 'SQUAD_DISBANDED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="UsersRound" className="h-4 w-4 text-[#ef7c7a] shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.squadWasDisbanded(
							<Atoms.SquadDisplay ctx={ctx} squad={event.squad} matchId={event.matchId} showName showTeam />,
						),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_JOINED_SQUAD':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="LogIn" className="h-4 w-4 text-ok shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerJoinedSquad(
							<Atoms.PlayerDisplay ctx={ctx} player={event.player} matchId={event.matchId} />,
							<Atoms.SquadDisplay ctx={ctx} squad={event.squad} matchId={event.matchId} showTeam />,
						),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_PROMOTED_TO_LEADER':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Crown" className="h-4 w-4 text-warn shrink-0" />}>
					{tr.richText(
						CHAT_Msgs.playerPromotedToLeader(
							<Atoms.PlayerDisplay ctx={ctx} showTeam showSquad player={event.player} matchId={event.matchId} />,
						),
					)}
				</Atoms.EventLine>
			)
		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED':
			return <WoundedOrDied ctx={ctx} event={event} />
		case 'MAP_SET':
			return <MapSet ctx={ctx} event={event} />
		case 'INGAME_VOTE_STARTED':
			if (event.container !== 'Vote_NextLayer') return null
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Vote" className="h-4 w-4 text-warn shrink-0" />}>
					<span>{tr.text(CHAT_Msgs.ingameVoteStarted())}</span>
					{event.choices.length > 0 && (
						<span className="text-muted-foreground">{tr.text(CHAT_Msgs.ingameVoteChoices(event.choices))}</span>
					)}
				</Atoms.EventLine>
			)
		case 'RCON_CONNECTED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Plug" className="h-4 w-4 text-ok shrink-0" />}>
					{event.reconnected ? tr.text(CHAT_Msgs.rconReconnected()) : tr.text(CHAT_Msgs.rconFirstConnected())}
				</Atoms.EventLine>
			)
		case 'RCON_DISCONNECTED':
			return (
				<Atoms.EventLine time={event.time} icon={<Icon name="Unplug" className="h-4 w-4 text-danger shrink-0" />}>
					{tr.text(CHAT_Msgs.rconDisconnected())}
				</Atoms.EventLine>
			)
		// drawn by live react, or not drawn at all
		case 'APP_EVENT':
		case 'PLAYER_RECONCILED':
		case 'RESET':
		case 'PLAYER_DETAILS_CHANGED':
		case 'TEAMS_POLLED_UPDATE':
		case 'NOOP':
			return null
		default:
			return assertNever(event)
	}
}
