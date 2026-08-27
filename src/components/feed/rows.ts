// Every activity feed row that isn't an app event, built as dom.
//
// A past match is ~600 rows and ~10,000 nodes arriving in one update, which is what this exists for. App events are
// the exception and stay in react (see server-event.tsx): they are a fraction of a percent of the feed, and they
// query, expand and attribute in ways that would need most of a component model rebuilt to support.

import * as DH from '@/lib/display-helpers'
import * as Dom from '@/lib/dom'
import { assertNever } from '@/lib/type-guards'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as I18nDom from '@/messages/i18n-dom'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'
import { tr } from '@/systems/messages.client'

import * as Atoms from './atoms'
import { icon } from './icons'
import type * as RC from './render-context'

const trDom = I18nDom.ambient

const CHANNEL_STYLES = {
	ChatAll: { color: 'white', gradientColor: 'rgba(255, 255, 255, 0.1)' },
	ChatTeam: { color: 'rgb(59, 130, 246)', gradientColor: 'rgba(59, 130, 246, 0.1)' },
	ChatSquad: { color: 'rgb(34, 197, 94)', gradientColor: 'rgba(34, 197, 94, 0.1)' },
	ChatAdmin: { color: 'hsl(var(--admin))', gradientColor: 'hsl(var(--admin) / 0.1)' },
	Broadcast: { color: 'rgb(234, 179, 8)', gradientColor: 'rgba(234, 179, 8, 0.1)' }, // yellow-500
} as const

const MESSAGE_ROW_CLASS = 'flex gap-2 py-1 text-xs w-full min-w-0 border-r-2 bg-linear-to-l to-transparent items-baseline'

function messageRowStyle(style: { color: string; gradientColor: string }) {
	return `border-right-color:${style.color};background-image:linear-gradient(to left, ${style.gradientColor}, transparent)`
}

function chatMessage(ctx: RC.RenderCtx, event: Extract<CHAT.EventEnriched, { type: 'CHAT_MESSAGE' | 'ADMIN_BROADCAST' }>) {
	if (event.type === 'CHAT_MESSAGE' && event.player.teamId === null) return null
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

	const channelLabel = ((): Node | string => {
		if (event.type === 'ADMIN_BROADCAST') {
			return Dom.el(
				'span',
				{ style: `color:${channelStyle.color}`, title: tr.text(CHAT_Msgs.chatChannelBroadcastHint()) },
				tr.text(CHAT_Msgs.chatChannelBroadcast()),
			)
		}
		switch (event.channel.type) {
			case 'ChatAll':
				return Dom.el(
					'span',
					{ style: `color:${channelStyle.color}`, title: tr.text(CHAT_Msgs.chatChannelAllHint()) },
					tr.text(CHAT_Msgs.chatChannelAll()),
				)
			case 'ChatTeam':
				return Dom.el(
					'span',
					{ class: 'inline-flex gap-0' },
					'(',
					Dom.el(
						'span',
						{ style: `color:${channelStyle.color}`, class: 'flex items-baseline flex-nowrap whitespace-nowrap gap-1' },
						Atoms.matchTeamDisplay(ctx, { matchId: event.matchId, teamId: event.player.teamId! }),
					),
					')',
				)
			case 'ChatSquad':
				return Dom.el(
					'span',
					{ class: 'inline-flex gap-0' },
					'(',
					Dom.el(
						'span',
						{ class: 'flex items-baseline flex-nowrap whitespace-nowrap gap-1', style: `color:${channelStyle.color}` },
						Atoms.squadDisplay(ctx, {
							squad: {
								squadId: event.channel.squadId,
								squadName: '',
								teamId: event.channel.teamId,
								uniqueId: event.channel.uniqueId,
							},
							matchId: event.matchId!,
							showName: false,
							showTeam: false,
						}),
						Atoms.matchTeamDisplay(ctx, { matchId: event.matchId, teamId: event.player.teamId! }),
					),
					')',
				)
			case 'ChatAdmin':
				return Dom.el(
					'span',
					{ style: `color:${channelStyle.color}`, title: tr.text(CHAT_Msgs.chatChannelAdminHint()) },
					tr.text(CHAT_Msgs.chatChannelAdmin()),
				)
			default:
				return assertNever(event.channel)
		}
	})()

	const fromDisplay = ((): Node | string | null => {
		if (event.type === 'ADMIN_BROADCAST') {
			if (event.player) return Atoms.playerDisplay(ctx, { player: event.player, matchId: event.matchId })
			if (event.from === 'RCON') return Dom.el('span', { class: 'text-red-400' }, tr.text(CHAT_Msgs.broadcastFromRcon()))
			if (event.from === 'unknown') return Dom.el('span', { class: 'text-yellow-400/60' }, tr.text(CHAT_Msgs.broadcastFromUnknown()))
			return null
		}
		return Atoms.playerDisplay(ctx, {
			player: event.player,
			matchId: event.matchId,
			showTeam: ['ChatAdmin', 'ChatAll'].includes(event.channel.type),
		})
	})()

	return Dom.el(
		'div',
		{ class: MESSAGE_ROW_CLASS, style: messageRowStyle(channelStyle) },
		Atoms.eventTime(event.time),
		Dom.el('div', { class: 'grow min-w-0 wrap-anywhere' }, channelLabel, fromDisplay, ': ', event.message),
	)
}

// several standalone warns sharing the same text + source, collapsed into one entry. Few targets are named inline;
// larger groups use an expandable <details> listing everyone warned.
function warnsAggregated(ctx: RC.RenderCtx, event: Extract<CHAT.EventEnriched, { type: 'WARNS_AGGREGATED' }>) {
	const count = event.warns.length
	const iconElt = () => icon('AlertTriangle', 'h-4 w-4 text-yellow-500 shrink-0')

	if (count <= 4) {
		const warnees = event.warns.map((warn, i) =>
			Dom.el(
				'span',
				null,
				i > 0 ? ', ' : null,
				Atoms.playerDisplay(ctx, { showTeam: true, player: warn.player, matchId: event.matchId }),
			),
		)
		return Atoms.eventLine(event.time, iconElt(), trDom.richText(CHAT_Msgs.playersWarned(Dom.frag(warnees), event.reason)))
	}

	return details(
		event.time,
		iconElt(),
		trDom.richText(CHAT_Msgs.playerCountWarned(count, event.reason)),
		Dom.el(
			'div',
			{ class: 'pl-6 pt-1 flex flex-col gap-0.5' },
			event.warns.map((warn) => Atoms.playerDisplay(ctx, { showTeam: true, player: warn.player, matchId: event.matchId })),
		),
	)
}

// an expandable entry. Native <details>, so no state has to live anywhere for it.
function details(time: number, iconElt: Dom.Child, summary: Dom.Child, body: Dom.Child) {
	return Dom.el(
		'details',
		{ class: 'py-1 text-xs text-muted-foreground w-full min-w-0' },
		Dom.el(
			'summary',
			{ class: 'flex gap-2 items-baseline cursor-pointer' },
			Atoms.eventTime(time),
			iconElt,
			Dom.el('span', { class: 'grow min-w-0 wrap-anywhere' }, summary),
		),
		body,
	)
}

function newGame(ctx: RC.RenderCtx, event: Extract<CHAT.EventEnriched, { type: 'NEW_GAME' }>) {
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

	return Dom.el(
		'div',
		{ class: 'border-t border-green-500 pt-0.5 mt-1 w-full' },
		Atoms.eventLine(
			event.time,
			icon('Play', 'h-4 w-4 text-green-500 shrink-0'),
			trDom.richText(
				CHAT_Msgs.newGameLine(
					label,
					visibleMatchIndex === 0 ? tr.text(CHAT_Msgs.currentMatch()) : visibleMatchIndex,
					Atoms.shortLayerName({
						normalized: ctx.displayTeamsNormalized,
						layerId: match.layerId,
						teamParity: match.ordinal % 2,
						className: 'text-xs',
					}),
				),
			),
			{ className: 'py-0.5' },
		),
	)
}

function roundEnded(ctx: RC.RenderCtx, event: Extract<CHAT.EventEnriched, { type: 'ROUND_ENDED' }>) {
	const match = ctx.matchById(event.matchId)
	if (match?.status !== 'post-game') return null
	const winnerTickets =
		match.outcome.type === 'team1' ? match.outcome.team1Tickets : match.outcome.type === 'team2' ? match.outcome.team2Tickets : 0
	const loserTickets =
		match.outcome.type === 'team1' ? match.outcome.team2Tickets : match.outcome.type === 'team2' ? match.outcome.team1Tickets : 0
	const winnerId = match.outcome.type === 'team1' ? 1 : match.outcome.type === 'team2' ? 2 : null
	const loserId = winnerId === 1 ? 2 : 1

	let actionElt: Dom.Child = null
	if (event.action) {
		const source = event.action.source
		let sourceName: Node
		if (source.type === 'player') {
			sourceName = Dom.el(
				'span',
				null,
				trDom.richText(
					CHAT_Msgs.roundEndBy(
						event.actorPlayer
							? Atoms.playerDisplay(ctx, { showTeam: true, player: event.actorPlayer, matchId: event.matchId })
							: Dom.el('b', null, source.playerIds.username),
					),
				),
			)
		} else if (source.type === 'rcon') {
			sourceName = Dom.el('span', null, trDom.richText(CHAT_Msgs.roundEndVia(Dom.el('b', null, tr.text(CHAT_Msgs.rconTool())))))
		} else {
			// an SLM action: the app event it links to is its own entry in the feed and names the admin
			sourceName = Dom.el('span', null, trDom.richText(CHAT_Msgs.roundEndVia(Dom.el('b', null, tr.text(CHAT_Msgs.slmTool())))))
		}
		const nextLayerText =
			event.action.type === 'AdminChangeLayer'
				? Dom.el(
						'span',
						null,
						trDom.richText(
							CHAT_Msgs.roundEndSwitchingTo(
								Atoms.shortLayerName({ normalized: ctx.displayTeamsNormalized, layerId: event.action.layerId }),
							),
						),
					)
				: null
		actionElt = Dom.el(
			'span',
			{ class: 'text-xs font-semibold' },
			trDom.richText(CHAT_Msgs.roundEndAction(event.action.type, sourceName, nextLayerText)),
		)
	}

	const layerElt = () => Atoms.mapLayerDisplay(L.toLayer(match.layerId).Layer!, undefined, 'text-xs font-semibold')
	return Atoms.eventLine(
		event.time,
		icon('Flag', 'h-4 w-4 text-blue-500 shrink-0'),
		[
			winnerId === null
				? trDom.richText(CHAT_Msgs.roundEndedDraw(layerElt(), Dom.el('span', { class: 'text-yellow-400' }, tr.text(CHAT_Msgs.draw()))))
				: trDom.richText(
						CHAT_Msgs.roundEndedWinner(
							layerElt(),
							Atoms.matchTeamDisplay(ctx, { matchId: event.matchId, teamId: winnerId }),
							winnerTickets,
							loserTickets,
							Atoms.matchTeamDisplay(ctx, { matchId: event.matchId, teamId: loserId }),
						),
					),
			actionElt && [' ', actionElt],
		],
		{ className: '[&_strong]:font-semibold' },
	)
}

function woundedOrDied(ctx: RC.RenderCtx, event: Extract<CHAT.EventEnriched, { type: 'PLAYER_WOUNDED' | 'PLAYER_DIED' }>) {
	const iconElt = (() => {
		if (event.type === 'PLAYER_DIED') {
			switch (event.variant) {
				case 'suicide':
					return icon('Skull', 'h-4 w-4 text-orange-400 shrink-0')
				case 'teamkill':
					return icon('Skull', 'h-4 w-4 text-red-500 shrink-0')
				case 'normal':
					return icon('Skull', 'h-4 w-4 text-foreground shrink-0')
			}
		}
		switch (event.variant) {
			case 'suicide':
				return icon('HeartPulse', 'h-4 w-4 text-orange-400 shrink-0')
			case 'teamkill':
				return icon('HeartPulse', 'h-4 w-4 text-red-500 shrink-0')
			case 'normal':
				return null
		}
	})()

	const weaponSuffix = event.weapon
		? Dom.el('span', { class: 'text-muted-foreground/70' }, tr.text(CHAT_Msgs.withWeapon(event.weapon)))
		: undefined

	const message = (() => {
		switch (event.variant) {
			case 'suicide':
				return trDom.richText(
					CHAT_Msgs.playerSuicide(
						Atoms.playerDisplay(ctx, { showTeam: true, showSquad: true, player: event.victim, matchId: event.matchId }),
						event.type === 'PLAYER_WOUNDED',
						weaponSuffix,
					),
				)
			case 'teamkill':
				return trDom.richText(
					CHAT_Msgs.playerTeamkilled(
						Atoms.playerDisplay(ctx, { showTeam: true, showSquad: true, player: event.victim, matchId: event.matchId }),
						Atoms.playerDisplay(ctx, { showTeam: true, showSquad: true, player: event.attacker, matchId: event.matchId }),
						weaponSuffix,
					),
				)
			case 'normal':
				return trDom.richText(
					CHAT_Msgs.playerDowned(
						Atoms.playerDisplay(ctx, { showTeam: true, player: event.victim, matchId: event.matchId }),
						event.type === 'PLAYER_WOUNDED',
						Atoms.playerDisplay(ctx, { showTeam: true, player: event.attacker, matchId: event.matchId }),
						weaponSuffix,
					),
				)
			default:
				return assertNever(event.variant)
		}
	})()

	return Atoms.eventLine(event.time, iconElt, message)
}

// A layer set on the server. The SLM-originated ones normally collapse into the app event that caused them (see
// handleEvent), so what reaches here is somebody else's set -- or, on connect, no set at all: `observed` is the
// layer the server already had, which reads as an anonymous set unless it says so.
function mapSet(ctx: RC.RenderCtx, event: Extract<CHAT.EventEnriched, { type: 'MAP_SET' }>) {
	const layer = () =>
		Atoms.shortLayerName({ normalized: ctx.displayTeamsNormalized, layerId: event.layerId, teamParity: 0, className: 'text-xs' })
	const iconElt = icon('Map', 'h-4 w-4 text-blue-400 shrink-0')
	if (event.source?.type === 'observed') {
		return Atoms.eventLine(event.time, iconElt, trDom.richText(CHAT_Msgs.observedNextLayer(layer())), { className: 'py-0.5' })
	}
	const who: Node | string | null =
		event.source?.type === 'player' && event.actorPlayer
			? Atoms.playerDisplay(ctx, { showTeam: true, player: event.actorPlayer, matchId: event.matchId })
			: event.source?.type === 'player'
				? (event.source.playerIds.username ?? tr.text(CHAT_Msgs.ingameAdmin()))
				: event.source?.type === 'rcon'
					? tr.text(CHAT_Msgs.anotherRconTool())
					: null
	return Atoms.eventLine(
		event.time,
		iconElt,
		who ? trDom.richText(CHAT_Msgs.nextLayerSetBy(who, layer())) : trDom.richText(CHAT_Msgs.nextLayerSet(layer())),
		{ className: 'py-0.5' },
	)
}

/** The dom for one feed row, or null when the event draws nothing. App events return null: react draws those. */
export function buildRow(ctx: RC.RenderCtx, event: CHAT.EventEnriched): Node | null {
	switch (event.type) {
		case 'CHAT_MESSAGE':
		case 'ADMIN_BROADCAST':
			return chatMessage(ctx, event)
		case 'PLAYER_CONNECTED':
			return Atoms.eventLine(
				event.time,
				icon('UserPlus', 'h-4 w-4 text-green-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerConnected(
						Atoms.playerDisplay(ctx, { player: event.player, matchId: event.matchId }),
						event.player.teamId ? Atoms.matchTeamDisplay(ctx, { teamId: event.player.teamId, matchId: event.matchId }) : undefined,
					),
				),
			)
		case 'PLAYER_DISCONNECTED':
			return Atoms.eventLine(
				event.time,
				icon('UserMinus', 'h-4 w-4 text-red-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerDisconnected(Atoms.playerDisplay(ctx, { showTeam: true, player: event.player, matchId: event.matchId })),
				),
			)
		case 'POSSESSED_ADMIN_CAMERA':
			return Atoms.eventLine(
				event.time,
				icon('Camera', 'h-4 w-4 text-purple-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.enteredAdminCamera(Atoms.playerDisplay(ctx, { showTeam: true, player: event.player, matchId: event.matchId })),
				),
			)
		case 'UNPOSSESSED_ADMIN_CAMERA':
			return Atoms.eventLine(
				event.time,
				icon('CameraOff', 'h-4 w-4 text-purple-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.exitedAdminCamera(Atoms.playerDisplay(ctx, { showTeam: true, player: event.player, matchId: event.matchId })),
				),
			)
		case 'PLAYER_KICKED':
			return Atoms.eventLine(
				event.time,
				icon('UserX', 'h-4 w-4 text-orange-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerKicked(
						Atoms.playerDisplay(ctx, { showTeam: true, player: event.player, matchId: event.matchId }),
						event.reason ? Dom.el('span', { class: 'text-muted-foreground/70' }, event.reason) : undefined,
					),
				),
			)
		case 'SQUAD_CREATED':
			return Atoms.eventLine(event.time, icon('Users', 'h-4 w-4 text-blue-500 shrink-0'), [
				trDom.richText(
					CHAT_Msgs.squadCreated(
						Atoms.playerDisplay(ctx, { player: event.creator, matchId: event.matchId }),
						Atoms.squadDisplay(ctx, { squad: event.squad, matchId: event.matchId, showName: true, showTeam: false }),
						Atoms.matchTeamDisplay(ctx, { matchId: event.matchId, teamId: event.squad.teamId }),
					),
				),
				event.squad.locked ? icon('Lock', 'h-3 w-3 text-red-600 inline-block ml-1') : null,
			])
		case 'PLAYER_BANNED':
			return Atoms.eventLine(
				event.time,
				icon('Ban', 'h-4 w-4 text-red-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerBanned(Atoms.playerDisplay(ctx, { player: event.player, matchId: event.matchId }), event.interval),
				),
			)
		case 'PLAYER_WARNED':
			return Atoms.eventLine(
				event.time,
				icon('AlertTriangle', 'h-4 w-4 text-yellow-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerWarned(
						Atoms.playerDisplay(ctx, { showTeam: true, player: event.player, matchId: event.matchId }),
						event.reason,
					),
				),
			)
		case 'WARNS_AGGREGATED':
			return warnsAggregated(ctx, event)
		case 'NEW_GAME':
			return newGame(ctx, event)
		case 'ROUND_ENDED':
			return roundEnded(ctx, event)
		case 'SQUAD_DETAILS_CHANGED': {
			const locked = event.details.locked
			if (locked === event.prevDetails.locked || locked === undefined) return null
			return Atoms.eventLine(
				event.time,
				locked ? icon('Lock', 'h-4 w-4 text-yellow-500 shrink-0') : icon('LockOpen', 'h-4 w-4 text-green-500 shrink-0'),
				trDom.richText(
					CHAT_Msgs.squadLockChanged(
						Atoms.squadDisplay(ctx, { squad: event.squad, matchId: event.matchId, showName: true, showTeam: true }),
						locked,
					),
				),
			)
		}
		case 'SQUAD_RENAMED':
			return Atoms.eventLine(
				event.time,
				icon('Pencil', 'h-4 w-4 text-cyan-400 shrink-0'),
				trDom.richText(
					CHAT_Msgs.squadRenamed(
						Atoms.squadDisplay(ctx, {
							squad: { ...event.squad, squadName: event.oldSquadName },
							matchId: event.matchId,
							showName: true,
							showTeam: true,
						}),
						event.newSquadName,
					),
				),
				{ className: '[&_strong]:font-medium [&_strong]:text-foreground' },
			)
		case 'PLAYER_CHANGED_TEAM':
			// don't render unassigned, and a player who was previously unassigned is a post-match team swap
			if (event.newTeamId === null || event.prevTeamId === null) return null
			return Atoms.eventLine(
				event.time,
				icon('Repeat', 'h-4 w-4 text-purple-400 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerChangedTeam(
						Atoms.playerDisplay(ctx, { player: event.player, matchId: event.matchId }),
						Atoms.matchTeamDisplay(ctx, { teamId: event.player.teamId!, matchId: event.matchId }),
					),
				),
			)
		case 'PLAYER_LEFT_SQUAD':
			return Atoms.eventLine(
				event.time,
				icon('LogOut', 'h-4 w-4 text-orange-400 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerLeftSquad(
						Atoms.playerDisplay(ctx, { player: event.player, matchId: event.matchId }),
						Atoms.squadDisplay(ctx, { squad: event.squad, matchId: event.matchId, showName: false, showTeam: true }),
						event.wasLeader,
					),
				),
			)
		case 'SQUAD_DISBANDED':
			return Atoms.eventLine(
				event.time,
				icon('UsersRound', 'h-4 w-4 text-red-400 shrink-0'),
				trDom.richText(
					CHAT_Msgs.squadWasDisbanded(
						Atoms.squadDisplay(ctx, { squad: event.squad, matchId: event.matchId, showName: true, showTeam: true }),
					),
				),
			)
		case 'PLAYER_JOINED_SQUAD':
			return Atoms.eventLine(
				event.time,
				icon('LogIn', 'h-4 w-4 text-green-400 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerJoinedSquad(
						Atoms.playerDisplay(ctx, { player: event.player, matchId: event.matchId }),
						Atoms.squadDisplay(ctx, { squad: event.squad, matchId: event.matchId, showTeam: true }),
					),
				),
			)
		case 'PLAYER_PROMOTED_TO_LEADER':
			return Atoms.eventLine(
				event.time,
				icon('Crown', 'h-4 w-4 text-yellow-400 shrink-0'),
				trDom.richText(
					CHAT_Msgs.playerPromotedToLeader(
						Atoms.playerDisplay(ctx, { showTeam: true, showSquad: true, player: event.player, matchId: event.matchId }),
					),
				),
			)
		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED':
			return woundedOrDied(ctx, event)
		case 'MAP_SET':
			return mapSet(ctx, event)
		case 'INGAME_VOTE_STARTED':
			if (event.container !== 'Vote_NextLayer') return null
			return Atoms.eventLine(event.time, icon('Vote', 'h-4 w-4 text-yellow-500 shrink-0'), [
				Dom.el('span', null, tr.text(CHAT_Msgs.ingameVoteStarted())),
				event.choices.length > 0 &&
					Dom.el('span', { class: 'text-muted-foreground' }, tr.text(CHAT_Msgs.ingameVoteChoices(event.choices))),
			])
		case 'RCON_CONNECTED':
			return Atoms.eventLine(
				event.time,
				icon('Plug', 'h-4 w-4 text-green-500 shrink-0'),
				event.reconnected ? tr.text(CHAT_Msgs.rconReconnected()) : tr.text(CHAT_Msgs.rconFirstConnected()),
			)
		case 'RCON_DISCONNECTED':
			return Atoms.eventLine(event.time, icon('Unplug', 'h-4 w-4 text-red-500 shrink-0'), tr.text(CHAT_Msgs.rconDisconnected()))
		// drawn by react, or not drawn at all
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
