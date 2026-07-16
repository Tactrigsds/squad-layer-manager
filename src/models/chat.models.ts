import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
import * as Arr from '@/lib/array'
import * as Gen from '@/lib/generator'
import { assertNever } from '@/lib/type-guards'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared'
import { applyEventTeamMutations } from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import { baseLogger } from '@/systems/logger.client'
import { z } from 'zod'

export type PlayerRef = string

export type Channel = SM.ChatChannelType

export type SyncedEvent = {
	// for the client this means that we're up-to-date with the server and we can start displaying the events
	type: 'SYNCED'
	time: number
	matchId: number
}

// tells client that we should reset the state
export type InitEvent = {
	type: 'INIT'
	time: number
	serverId: string
}

export type ConnectionErrorCode = 'CONNECTION_LOST' | 'RECONNECT_FAILED'
export type ConnectionErrorEvent = {
	type: 'CONNECTION_ERROR'
	code: ConnectionErrorCode
	time: number
}

export type ReconnectedEvent = {
	type: 'CHAT_RECONNECTED'
	resumedEventId: null | number
}

export type LifecycleEvent = SyncedEvent | ConnectionErrorEvent | ReconnectedEvent | InitEvent

export type PlayerStats = {
	kills: number
	wounds: number
	deaths: number
	teamkills: number
}

export type PlayerStatsMap = Record<SM.PlayerId, PlayerStats>

export type InterpolableState = {
	players: SM.Player[]
	squads: SM.UniqueSquad[]
	// per-match combat stats, keyed by player id. kept separate from players rather than stored on them
	playerStats: PlayerStatsMap
	// players currently in admin camera, tracked from POSSESSED/UNPOSSESSED_ADMIN_CAMERA. kept separate from players
	// since the roster is replaced wholesale by the teams poll, which knows nothing about admin camera
	adminCamPlayerIds: SM.PlayerId[]
}

export namespace InterpolableState {
	export function clone(state: InterpolableState): InterpolableState {
		return {
			players: state.players.map(p => ({ ...p, ids: { ...p.ids } })),
			squads: [...state.squads],
			playerStats: { ...state.playerStats },
			adminCamPlayerIds: [...state.adminCamPlayerIds],
		}
	}
}

// an app (audit) event wrapped for the feed. wrapped so its inner type (e.g. PLAYER_WARNED, which collides
// with the server event of the same name) doesn't clash with the SE.Event `type` discriminant.
export type AppFeedEvent = { type: 'APP_EVENT'; appEvent: AppEvents.AppEvent }

export type Event = SE.Event | AppFeedEvent

// a structured description of who a warn targeted, computed against the interpolated state so the UI can render a
// concise summary ("all admins", "everyone on Team 1", "Squad Alpha, Bravo and 3 other players") instead of a raw count
export type WarnSummary =
	| { type: 'everyone' }
	| { type: 'all-admins' }
	| { type: 'teams'; teamIds: SM.TeamId[] }
	| { type: 'squads'; squads: { uniqueId: number; squadName: string; teamId: SM.TeamId }[]; otherPlayerCount: number }
	| { type: 'players' } // no meaningful grouping; render an inline name list or a plain count

// a feed entry for an app event, enriched with resolved players and the collapsed server events attributed
// to it (e.g. the individual PLAYER_WARNED server events aggregated under one warnAll entry)
export type EnrichedAppEvent = {
	type: 'APP_EVENT'
	id: AppEvents.AppEventId
	time: number
	matchId: number | null
	appEvent: AppEvents.AppEvent
	// resolved from appEvent.targets against the interpolated state (best-effort)
	targetPlayers: SM.Player[]
	// resolved acting player when the actor is an in-game user (e.g. an external admin who changed the layer)
	actorPlayer?: SM.Player
	// structured grouping of the targets for the summary line (PLAYER_WARNED only; else 'players')
	warnSummary: WarnSummary
	// individual server events attributed to this app event, collapsed under it (e.g. the PLAYER_WARNED /
	// PLAYER_LEFT_SQUAD / PLAYER_CHANGED_TEAM events a bulk action fanned out into)
	collapsed: EventEnriched[]
	// unique (instance) ids of the squads this action targeted, resolved at event time from the target players' squads
	// (plus the squad a squad-typed action, e.g. disband/rename, names directly). Lets the squad feed attribute an
	// admin action to the exact squad instance rather than by flat player membership.
	targetSquadIds: number[]
}

// a chat message enriched with the resolved author and, when the author was in a squad at send time, that squad's
// unique (instance) id. Squad-channel messages are already tied to a squad via channel.uniqueId; this covers team/all
// chat so the squad feed can attribute it to the exact squad the author belonged to at that moment.
export type EnrichedChatMessage = SE.ChatMessage<SM.Player> & { authorSquadId?: number }

// a warn enriched with the resolved player and, when that player was in a squad at warn time, that squad's unique id.
export type EnrichedWarn = SE.PlayerWarned<SM.Player> & { targetSquadId?: number }

// event enriched with relevant data
export type EventEnriched =
	| EnrichedAppEvent
	| NoopEvent
	| SE.MapSet
	| SE.NewGame
	| SE.Reset
	| SE.RconConnected
	| SE.RconDisconnected
	| SE.RoundEnded
	| SE.PlayerConnected<SM.Player>
	| SE.PlayerReconciled<SM.Player>
	| (SE.PlayerDisconnected<SM.Player>)
	| (SE.PlayerDetailsChanged<SM.Player>)
	| (SE.SquadDetailsChanged & { squad: SM.UniqueSquad; prevDetails: SE.SquadDetailsChanged['details'] })
	| (SE.SquadRenamed & { squad: SM.UniqueSquad })
	| (SE.PlayerChangedTeam<SM.Player> & { prevTeamId: SM.TeamId | null })
	| (SE.PlayerJoinedSquad<SM.Player> & { squad: SM.UniqueSquad })
	| (SE.PlayerPromotedToLeader<SM.Player> & { squad: SM.UniqueSquad })
	| SE.TeamsPolledUpdate
	| (SE.SquadDisbanded & { squad: SM.UniqueSquad })
	| (SE.PlayerLeftSquad<SM.Player> & { wasLeader: boolean; squad: SM.UniqueSquad })
	| (SE.SquadCreated & { creator: SM.Player; squad: SM.UniqueSquad })
	| EnrichedWarn
	| SE.PlayerBanned<SM.Player>
	| SE.PlayerKicked<SM.Player>
	| SE.PossessedAdminCamera<SM.Player>
	| SE.UnpossessedAdminCamera<SM.Player>
	| EnrichedChatMessage
	| (SE.AdminBroadcast & { player?: SM.Player })
	| SE.PlayerDied<SM.Player>
	| SE.PlayerWounded<SM.Player>
	| AggregatedWarns

export type NoopEvent = {
	type: 'NOOP'
	reason: string
	id: number
	time: number
	matchId: number
	originalEvent: Event
}

// several standalone PLAYER_WARNED server events (i.e. ones NOT attributed to an app event, which are collapsed
// under their app-event entry instead) sharing the same warn text and acting source, merged into one feed entry.
// See mergeOrPushWarn: only warns arriving within WARN_AGGREGATION_WINDOW_MS of each other are grouped.
export type AggregatedWarns = {
	type: 'WARNS_AGGREGATED'
	// tracks the latest absorbed warn's id (server ids are monotonic) so the resume cursor stays sensible
	id: number
	// anchored to the first warn's time, keeping the entry in its original buffer position
	time: number
	matchId: number
	reason: string
	source: SE.PlayerWarned['source']
	// individual enriched warns, in arrival order (always length >= 2)
	warns: EnrichedWarn[]
}

export type ChatState = {
	eventBuffer: EventEnriched[]

	// the state of the chat as of the last event
	interpolatedState: InterpolableState

	connectionError: ConnectionErrorEvent | null

	synced: boolean
}

export function getInitialInterpolatedState(): InterpolableState {
	return {
		players: [],
		squads: [],
		playerStats: {},
		adminCamPlayerIds: [],
	}
}

export function getInitialChatState(): ChatState {
	return {
		interpolatedState: getInitialInterpolatedState(),
		eventBuffer: [],
		synced: false,
		connectionError: null,
	}
}

const chatLog: CS.Log = { ...CS.init(), log: baseLogger.child({ name: 'chat' }) }

export function handleEvent(
	state: ChatState,
	event: Event | LifecycleEvent,
	opts?: InterpolationOptions,
) {
	if (event.type === 'INIT') {
		Object.assign(state, getInitialChatState())
		return
	}
	if (event.type === 'SYNCED') {
		state.synced = true
		return
	}
	if (event.type === 'CONNECTION_ERROR') {
		state.connectionError = event
		return
	}
	if (event.type === 'CHAT_RECONNECTED') {
		state.connectionError = null
		const lastEvent = state.eventBuffer[state.eventBuffer.length - 1]
		if (!lastEvent || event.resumedEventId === lastEvent.id) {
			state.synced = false
			return
		}
		if (event.resumedEventId !== null) {
			throw new Error(`resumed from the wrong event id!`)
		}
		Object.assign(state, getInitialChatState())
		return
	}

	if (event.type === 'APP_EVENT') {
		state.eventBuffer.push(enrichAppEvent(state.interpolatedState, event.appEvent))
		return
	}

	const enriched = interpolateEvent(state.interpolatedState, event, opts)
	// collapse any server event attributed to an app event (source={type:'event'}) into that app event's entry, so a
	// bulk action renders as one expandable summary. Falls back to a standalone entry if the app event isn't buffered.
	const src = (enriched as { source?: { type: string; id?: AppEvents.AppEventId } }).source
	if (src?.type === 'event' && src.id !== undefined) {
		const attributedTo = src.id
		const appEntry = state.eventBuffer.find(
			(e): e is EnrichedAppEvent => e.type === 'APP_EVENT' && e.id === attributedTo,
		)
		if (appEntry) {
			appEntry.collapsed.push(enriched)
			return
		}
	}
	// standalone warns (not folded into an app event above) get deduplicated by text+source into burst groups
	if (enriched.type === 'PLAYER_WARNED') {
		mergeOrPushWarn(state.eventBuffer, enriched)
		return
	}
	state.eventBuffer.push(enriched)
}

// warns arriving within this window of an existing matching group are merged into it; anything further apart
// starts a fresh entry (so unrelated warns that happen to share text stay separate)
const WARN_AGGREGATION_WINDOW_MS = 5000

// dedup key: identical warn text AND the same acting source (a specific in-game admin, RCON, etc.)
function warnDedupKey(reason: string, source: SE.PlayerWarned['source']): string {
	const actor = !source
		? 'none'
		: source.type === 'player'
		? `player:${SM.PlayerIds.getPlayerId(source.playerIds)}`
		: source.type === 'event'
		? `event:${source.id}`
		: source.type
	return `${actor} ${reason}`
}

// merge a standalone warn into a recent matching group, upgrading a lone prior warn in place if needed; else append.
// scans back past interleaving events until the burst window is exceeded (buffer is time-ordered).
function mergeOrPushWarn(buffer: EventEnriched[], warn: SE.PlayerWarned<SM.Player>) {
	const key = warnDedupKey(warn.reason, warn.source)
	const cutoff = warn.time - WARN_AGGREGATION_WINDOW_MS
	for (let i = buffer.length - 1; i >= 0; i--) {
		const entry = buffer[i]
		if (entry.time < cutoff) break
		if (entry.type === 'WARNS_AGGREGATED' && warnDedupKey(entry.reason, entry.source) === key) {
			entry.warns.push(warn)
			entry.id = warn.id
			return
		}
		if (entry.type === 'PLAYER_WARNED' && warnDedupKey(entry.reason, entry.source) === key) {
			buffer[i] = {
				type: 'WARNS_AGGREGATED',
				id: warn.id,
				time: entry.time,
				matchId: entry.matchId,
				reason: entry.reason,
				source: entry.source,
				warns: [entry, warn],
			}
			return
		}
	}
	buffer.push(warn)
}

// the id of the most recent server event in the buffer (skips app events, which have string ids and no
// numeric resume cursor). used to resume the chat stream on reconnect.
export function lastServerEventId(buffer: EventEnriched[]): number | undefined {
	for (let i = buffer.length - 1; i >= 0; i--) {
		const id = buffer[i].id
		if (typeof id === 'number') return id
	}
	return undefined
}

// the unique (instance) id of the squad a player is in per the interpolated state, or undefined if squadless
function playerSquadUniqueId(state: InterpolableState, player: SM.Player): number | undefined {
	if (player.squadId === null || player.teamId === null) return undefined
	return state.squads.find(s => s.squadId === player.squadId && s.teamId === player.teamId)?.uniqueId
}

function enrichAppEvent(state: InterpolableState, appEvent: AppEvents.AppEvent): EnrichedAppEvent {
	const targetPlayers = AppEvents.involvedPlayerIds(appEvent)
		.map(id => SM.PlayerIds.find(state.players, p => p.ids, { eos: id }))
		.filter((p): p is SM.Player => !!p)
	const actorPlayer = appEvent.actor.type === 'ingame-user'
		? SM.PlayerIds.find(state.players, p => p.ids, { eos: appEvent.actor.playerId }) ?? undefined
		: undefined

	const targetSquadIds = new Set<number>()
	// squad-typed actions name an in-game squad + team directly; resolve to the live instance (it still exists when the
	// action is recorded, as the resulting server events arrive afterwards)
	if (appEvent.type === 'SQUAD_DISBANDED' || appEvent.type === 'SQUAD_RENAMED') {
		const squad = state.squads.find(s => s.squadId === appEvent.squadId && s.teamId === appEvent.teamId)
		if (squad) targetSquadIds.add(squad.uniqueId)
	}
	for (const player of targetPlayers) {
		const uniqueId = playerSquadUniqueId(state, player)
		if (uniqueId !== undefined) targetSquadIds.add(uniqueId)
	}

	return {
		type: 'APP_EVENT',
		id: appEvent.id,
		time: appEvent.time,
		matchId: appEvent.matchId,
		appEvent,
		targetPlayers,
		actorPlayer,
		warnSummary: appEvent.type === 'PLAYER_WARNED' ? summarizeWarnTargets(state, targetPlayers) : { type: 'players' },
		collapsed: [],
		targetSquadIds: [...targetSquadIds],
	}
}

// classifies who a warn targeted against the current interpolated state, most-specific first. The renderer still
// prefers naming players directly for small sets; this drives the summary for larger ones.
function summarizeWarnTargets(state: InterpolableState, targets: SM.Player[]): WarnSummary {
	if (targets.length === 0) return { type: 'players' }
	const idOf = (p: SM.Player) => SM.PlayerIds.getPlayerId(p.ids)
	const targetIds = new Set(targets.map(idOf))
	const players = state.players

	// everyone currently on the server
	if (players.length > 0 && players.every(p => targetIds.has(idOf(p)))) return { type: 'everyone' }

	// exactly the set of admins present
	const admins = players.filter(p => p.isAdmin)
	if (admins.length > 0 && targets.length === admins.length && admins.every(p => targetIds.has(idOf(p)))) {
		return { type: 'all-admins' }
	}

	// one or both teams warned in full, with no targets outside those teams
	const fullTeams: SM.TeamId[] = []
	for (const teamId of [1, 2] as SM.TeamId[]) {
		const teamPlayers = players.filter(p => p.teamId === teamId)
		if (teamPlayers.length > 0 && teamPlayers.every(p => targetIds.has(idOf(p)))) fullTeams.push(teamId)
	}
	if (fullTeams.length > 0 && targets.every(p => p.teamId !== null && fullTeams.includes(p.teamId))) {
		return { type: 'teams', teamIds: fullTeams }
	}

	// squads warned in full, plus however many loose players remain
	const fullSquads: { uniqueId: number; squadName: string; teamId: SM.TeamId }[] = []
	let coveredBySquads = 0
	for (const squad of state.squads) {
		const members = players.filter(p => p.squadId === squad.squadId && p.teamId === squad.teamId)
		if (members.length > 0 && members.every(p => targetIds.has(idOf(p)))) {
			fullSquads.push({ uniqueId: squad.uniqueId, squadName: squad.squadName, teamId: squad.teamId })
			coveredBySquads += members.length
		}
	}
	if (fullSquads.length > 0) {
		return { type: 'squads', squads: fullSquads, otherPlayerCount: Math.max(0, targets.length - coveredBySquads) }
	}

	return { type: 'players' }
}

const compiledPatternMap = new WeakMap<string[], RegExp[]>()

const SuppressionSchema = z.string().refine((s) => new RegExp(s))

export const ChatConfigSchema = z.object({
	warnSuppressionPatterns: z.array(SuppressionSchema).prefault([]).describe('Regex patterns to suppress warning messages'),
	broadcastSuppressionPatterns: z.array(SuppressionSchema).prefault([]).describe(
		'Regex patterns to suppress broadcast messages. these will not apply to broadcasts sent via an ingame command.',
	),
})

function testPatterns(patterns: string[], text: string): boolean {
	if (patterns.length === 0) return false
	let compiled = compiledPatternMap.get(patterns)
	if (!compiled) {
		compiled = patterns.map(p => new RegExp(p))
		compiledPatternMap.set(patterns, compiled)
	}
	return compiled.some(pattern => pattern.test(text))
}

type InterpolationOptions = {
	warnSuppressionPatterns?: string[]
	broadcastSuppressionPatterns?: string[]
}

function interpolateEvent(
	state: InterpolableState,
	event: SE.Event,
	opts?: InterpolationOptions,
): EventEnriched {
	switch (event.type) {
		case 'MAP_SET':
		case 'NEW_GAME':
		case 'RESET': {
			// neither a match boundary nor a RESET carries admin camera information, so anyone we thought was in admin
			// camera is no longer known to be. clearing on NEW_GAME too covers the legacy roster-carrying variant,
			// which would otherwise swap a possessing player off the roster and strand their id here
			if (event.type === 'NEW_GAME' || event.type === 'RESET') {
				state.playerStats = {}
				state.adminCamPlayerIds = []
			}
			applyEventTeamMutations(chatLog, state, event)
			return event
		}

		case 'RCON_CONNECTED':
		case 'RCON_DISCONNECTED':
		case 'ROUND_ENDED':
		case 'TEAMS_POLLED_UPDATE':
			return { ...event }

		case 'PLAYER_CONNECTED': {
			if (SM.PlayerIds.find(state.players, p => p.ids, event.player.ids)) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} connected but was already in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: event.player }
		}

		// roster backfill from the teams poll -- adds the player to client state like a connect, but is not
		// rendered in the feed (see isRenderableInFeed / ServerEvent).
		case 'PLAYER_RECONCILED': {
			if (SM.PlayerIds.find(state.players, p => p.ids, event.player.ids)) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} reconciled but was already in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: event.player }
		}

		case 'PLAYER_DISCONNECTED': {
			// cleared before the roster lookup below: a disconnect for someone already off the roster still has to drop
			// them from admin camera, or the id survives to the next RESET and re-icons them if they reconnect
			state.adminCamPlayerIds = state.adminCamPlayerIds.filter(id => id !== event.player)
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} disconnected but was not found in the player list`)
			}
			const player = state.players[index]
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player }
		}

		case 'PLAYER_DETAILS_CHANGED': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} had details changed but was not found in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index] }
		}

		case 'SQUAD_DETAILS_CHANGED': {
			const index = state.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (index === -1) {
				return noop(`Squad ${event.uniqueId} had details changed but was not found in the squad list`)
			}
			const prevDetails: SE.SquadDetailsChanged['details'] = { locked: state.squads[index].locked }
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad: state.squads[index], prevDetails }
		}

		case 'SQUAD_RENAMED': {
			const index = state.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (index === -1) {
				return noop(`Squad ${event.uniqueId} was renamed but was not found in the squad list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad: state.squads[index] }
		}

		case 'PLAYER_CHANGED_TEAM': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was not found in the player list`)
			}
			const prevTeamId = state.players[index].teamId
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], prevTeamId }
		}

		case 'PLAYER_JOINED_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was not found in the player list`)
			}
			const squad = state.squads.find(s => s.uniqueId === event.uniqueId)
			if (!squad) {
				return noop(`Squad ${event.uniqueId} not found`)
			}
			if (SM.Squads.idsEqual(state.players[index], squad)) {
				return noop(
					`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was already in it ${
						SM.PlayerIds.match(state.players[index].ids, squad.creator) ? '(is creator)' : ''
					}`,
				)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], squad }
		}

		case 'PLAYER_PROMOTED_TO_LEADER': {
			const squad = state.squads.find(s => s.uniqueId === event.uniqueId)
			if (!squad) {
				return noop(`Squad ${event.uniqueId} not found for PLAYER_PROMOTED_TO_LEADER`)
			}
			let newLeaderIdx = -1
			for (let i = 0; i < state.players.length; i++) {
				const player = state.players[i]
				if (player.squadId !== squad.squadId || player.teamId !== squad.teamId) continue
				if (SM.PlayerIds.match(player.ids, event.player)) {
					newLeaderIdx = i
					break
				}
			}
			if (newLeaderIdx === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} promoted to leader but was not found in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[newLeaderIdx], squad }
		}

		case 'SQUAD_DISBANDED': {
			const squadIndex = state.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (squadIndex === -1) {
				return noop(`Squad ${event.uniqueId} disbanded but was not found in the squad list`)
			}
			const squad = state.squads[squadIndex]
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad }
		}

		case 'PLAYER_LEFT_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} left squad but was not found in the player list`)
			}
			const wasLeader = state.players[index].isLeader
			const squad = state.squads.find(s => s.uniqueId === event.uniqueId)
			if (!squad) {
				return noop(`Squad ${event.uniqueId} not found for PLAYER_LEFT_SQUAD`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], wasLeader, squad }
		}

		case 'SQUAD_CREATED': {
			const existingSquad = state.squads.find(s => s.uniqueId === event.squad.uniqueId)
			if (existingSquad) {
				return noop(`Squad ${event.squad.uniqueId} already exists`)
			}
			const squad: SM.UniqueSquad = event.squad
			const creatorIndex = SM.PlayerIds.indexOf(state.players, p => p.ids, event.squad.creator)
			if (creatorIndex === -1) {
				return noop(
					`Squad ${SM.Squads.printKey(squad)} "${event.squad.squadName}" created by unknown player ${
						SM.PlayerIds.prettyPrint(squad.creator)
					}`,
				)
			}
			if (state.players[creatorIndex].teamId !== squad.teamId) {
				return noop(
					`Creator ${SM.PlayerIds.prettyPrint(state.players[creatorIndex].ids)} is not in the same team as the squad they created ${
						SM.Squads.printKey(squad)
					}`,
				)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, creator: state.players[creatorIndex] }
		}

		case 'PLAYER_WARNED': {
			if (testPatterns(opts?.warnSuppressionPatterns ?? [], event.reason)) {
				return noop(`Warn reason ${event.reason} matches warn suppression pattern`)
			}
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${
						SM.PlayerIds.prettyPrint(event.player)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return { ...event, player, targetSquadId: playerSquadUniqueId(state, player) }
		}

		case 'PLAYER_BANNED':
		case 'PLAYER_KICKED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA': {
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${
						SM.PlayerIds.prettyPrint(event.player)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			if (event.type === 'PLAYER_KICKED') {
				return { ...event, player, reason: event.reason?.replace('Kicked from the server: ', '').trim() }
			}
			if (event.type === 'POSSESSED_ADMIN_CAMERA' && !state.adminCamPlayerIds.includes(event.player)) {
				state.adminCamPlayerIds = [...state.adminCamPlayerIds, event.player]
			}
			if (event.type === 'UNPOSSESSED_ADMIN_CAMERA') {
				state.adminCamPlayerIds = state.adminCamPlayerIds.filter(id => id !== event.player)
			}
			return { ...event, player }
		}

		case 'CHAT_MESSAGE': {
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${
						SM.PlayerIds.prettyPrint(event.player)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return { ...event, player, authorSquadId: playerSquadUniqueId(state, player) }
		}

		case 'ADMIN_BROADCAST': {
			if (event.from) {
				if (event.from === 'RCON' || event.from === 'unknown') {
					if (testPatterns(opts?.broadcastSuppressionPatterns ?? [], event.message)) {
						return noop(`Broadcast message ${event.message} matches broadcast suppression pattern`)
					}
					return { ...event, player: undefined } as SE.AdminBroadcast & { player: undefined }
				}
				const player = SM.PlayerIds.find(state.players, p => p.ids, event.from)
				if (!player) {
					return noop(
						`Player ${
							SM.PlayerIds.prettyPrint(event.from)
						} was involved in ${event.type} but was not found in the interpolated player list`,
					)
				}
				return { ...event, player } as SE.AdminBroadcast & { player: SM.Player }
			} else if (event.source) {
				if (event.source.type === 'player') {
					const player = SM.PlayerIds.find(state.players, p => p.ids, event.source.playerIds)
					if (!player) {
						return noop(
							`Player ${
								SM.PlayerIds.prettyPrint(event.source)
							} was involved in ${event.type} but was not found in the interpolated player list`,
						)
					}
					return { ...event, player } as SE.AdminBroadcast & { player: SM.Player }
				} else if (event.source.type === 'rcon') {
					return { ...event } as SE.AdminBroadcast
				} else {
					assertNever(event.source)
				}
			} else {
				throw new Error(`AdminBroadcast event must have either from or source property`)
			}
		}

		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED': {
			const victim = SM.PlayerIds.find(state.players, p => p.ids, event.victim)
			if (!victim) {
				return noop(
					`Victim ${
						SM.PlayerIds.prettyPrint(event.victim)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			const attacker = SM.PlayerIds.find(state.players, p => p.ids, event.attacker)
			if (!attacker) {
				return noop(
					`Attacker ${
						SM.PlayerIds.prettyPrint(event.attacker)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			if (event.type === 'PLAYER_DIED') {
				bumpPlayerStat(state.playerStats, SM.PlayerIds.getPlayerId(victim.ids), 'deaths')
				if (event.variant === 'normal') {
					bumpPlayerStat(state.playerStats, SM.PlayerIds.getPlayerId(attacker.ids), 'kills')
				} else if (event.variant === 'teamkill') {
					bumpPlayerStat(state.playerStats, SM.PlayerIds.getPlayerId(attacker.ids), 'teamkills')
				}
			} else if (event.variant === 'normal') {
				bumpPlayerStat(state.playerStats, SM.PlayerIds.getPlayerId(attacker.ids), 'wounds')
			}
			return { ...event, victim, attacker }
		}

		default:
			assertNever(event)
	}
	function noop(reason: string) {
		return {
			type: 'NOOP' as const,
			reason,
			id: event.id,
			time: event.time,
			matchId: event.matchId,
			originalEvent: event,
		}
	}
}

// stat objects are replaced rather than mutated so InterpolableState.clone can shallow-copy the map
function bumpPlayerStat(stats: PlayerStatsMap, playerId: SM.PlayerId, key: keyof PlayerStats) {
	const prev = stats[playerId] ?? { kills: 0, wounds: 0, deaths: 0, teamkills: 0 }
	stats[playerId] = { ...prev, [key]: prev[key] + 1 }
}

export type PrimaryFilterState = null | {
	type: 'player'
	id: SM.PlayerId
} | {
	type: 'squad'
	id: number
}

export const SECONDARY_FILTER_STATE = z.enum(['ALL', 'DEFAULT', 'CHAT', 'SLM_EVENTS', 'ADMIN', 'KILLFEED', 'SELECTED_PLAYERS'])
export type SecondaryFilterState = z.infer<typeof SECONDARY_FILTER_STATE>

// iteration order doubles as the order the filters are offered in the UI
export const SECONDARY_FILTER_LABELS: Record<SecondaryFilterState, string> = {
	ALL: 'All',
	DEFAULT: 'Default',
	CHAT: 'Chat',
	SLM_EVENTS: 'SLM Events',
	ADMIN: 'Admin',
	KILLFEED: 'Killfeed',
	SELECTED_PLAYERS: 'Selected Players',
}

export type ChatViewOptionsStore = {
	primaryFilter: PrimaryFilterState
	setPrimaryFilter(primary: PrimaryFilterState): void
	secondaryFilter: SecondaryFilterState
	setSecondaryFilter(secondary: SecondaryFilterState): void
}

// match boundaries and rcon connectivity anchor the feed in time, so they're shown under every filter. MAP_SET is
// deliberately not one of them: a layer being set is an administrative event, not a marker the other feeds need
function isPinnedSystemEvent(event: EventEnriched): boolean {
	switch (event.type) {
		case 'NEW_GAME':
		case 'RESET':
		case 'ROUND_ENDED':
		case 'RCON_CONNECTED':
		case 'RCON_DISCONNECTED':
			return true
		default:
			return false
	}
}

// rcon-originated broadcasts are SLM/tooling output rather than someone talking, and are already represented by the
// app event that sent them
function isChatEvent(event: EventEnriched): boolean {
	if (event.type === 'CHAT_MESSAGE') return true
	return event.type === 'ADMIN_BROADCAST' && event.from !== 'RCON'
}

function isWarnEvent(event: EventEnriched): boolean {
	if (event.type === 'PLAYER_WARNED' || event.type === 'WARNS_AGGREGATED') return true
	return event.type === 'APP_EVENT' && event.appEvent.type === 'PLAYER_WARNED'
}

function isKillfeedEvent(event: EventEnriched): event is SE.PlayerDied<SM.Player> | SE.PlayerWounded<SM.Player> {
	return event.type === 'PLAYER_DIED' || event.type === 'PLAYER_WOUNDED'
}

// admin actions observed in-game/over rcon. their SLM-initiated counterparts arrive as app events instead
function isAdminActionEvent(event: EventEnriched): boolean {
	switch (event.type) {
		case 'PLAYER_KICKED':
		case 'PLAYER_BANNED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA':
			return true
		default:
			return false
	}
}

export type SecondaryFilterContext = {
	// only read by SELECTED_PLAYERS
	selectedPlayerIds?: ReadonlySet<SM.PlayerId>
}

export function showEventInFeed(event: EventEnriched, filterState: SecondaryFilterState, ctx?: SecondaryFilterContext): boolean {
	if (isPinnedSystemEvent(event)) return true

	switch (filterState) {
		case 'ALL':
			return true
		case 'DEFAULT':
			if (isKillfeedEvent(event) && event.variant !== 'teamkill') return false
			if (event.type === 'PLAYER_JOINED_SQUAD' || event.type === 'PLAYER_LEFT_SQUAD') return false
			return true
		case 'CHAT':
			return isChatEvent(event) || isWarnEvent(event)
		case 'SLM_EVENTS':
			return event.type === 'APP_EVENT' || event.type === 'MAP_SET'
		case 'ADMIN':
			if (event.type === 'APP_EVENT' || event.type === 'MAP_SET') return true
			if (event.type === 'CHAT_MESSAGE') return event.channel.type === 'ChatAdmin'
			if (event.type === 'ADMIN_BROADCAST') return event.from !== 'RCON'
			if (event.type === 'PLAYER_CONNECTED' || event.type === 'PLAYER_DISCONNECTED') return event.player.isAdmin
			if (isKillfeedEvent(event)) return event.variant === 'teamkill'
			return isWarnEvent(event) || isAdminActionEvent(event)
		case 'KILLFEED':
			return isKillfeedEvent(event)
		case 'SELECTED_PLAYERS': {
			const selected = ctx?.selectedPlayerIds
			if (!selected || selected.size === 0) return false
			return hasAnyAssocPlayer(event, selected)
		}
		default:
			assertNever(filterState)
	}
}

// event types the feed renderer (ServerEvent) always renders as nothing. Callers that inject separators/markers
// between events (e.g. the player details window) must drop these first, else an invisible event still produces a
// leading separator, showing up as an empty gap or two markers in a row.
export function isRenderableInFeed(event: EventEnriched): boolean {
	return event.type !== 'RESET'
		&& event.type !== 'PLAYER_DETAILS_CHANGED'
		&& event.type !== 'TEAMS_POLLED_UPDATE'
		&& event.type !== 'PLAYER_RECONCILED'
		&& event.type !== 'NOOP'
}

// the raw server-event assoc types, plus 'actor' for the admin who took an app event's action
export type AssocPlayerType = ServerEventPlayerAssocType | 'actor'

export function* iterAssocPlayers(
	event: EventEnriched,
	playerId?: SM.PlayerId,
): Generator<readonly [SM.Player | SM.PlayerId, AssocPlayerType]> {
	if (event.type === 'NOOP') return
	if (event.type === 'WARNS_AGGREGATED') {
		for (const warn of event.warns) {
			if (!playerId || SM.PlayerIds.getPlayerId(warn.player.ids) === playerId) yield [warn.player, 'player'] as const
		}
		return
	}
	if (event.type === 'APP_EVENT') {
		for (const player of event.targetPlayers) {
			if (!playerId || SM.PlayerIds.getPlayerId(player.ids) === playerId) yield [player, 'player'] as const
		}
		if (event.actorPlayer && (!playerId || SM.PlayerIds.getPlayerId(event.actorPlayer.ids) === playerId)) {
			yield [event.actorPlayer, 'actor'] as const
		}
		for (const collapsed of event.collapsed) {
			yield* iterAssocPlayers(collapsed, playerId)
		}
		return
	}
	for (const [player, assocType] of SE.iterAssocPlayers(event)) {
		const id = typeof player === 'string' ? player : SM.PlayerIds.getPlayerId(player.ids)
		if (!playerId || id === playerId) yield [player, assocType] as const
	}
}

export function hasAssocPlayer(event: EventEnriched, playerId: SM.PlayerId): boolean {
	return Gen.hasValues(iterAssocPlayers(event, playerId))
}

export function hasAnyAssocPlayer(event: EventEnriched, playerIds: ReadonlySet<SM.PlayerId>): boolean {
	for (const [player] of iterAssocPlayers(event)) {
		const id = typeof player === 'string' ? player : SM.PlayerIds.getPlayerId(player.ids)
		if (playerIds.has(id)) return true
	}
	return false
}

// squad-association equivalent of iterAssocPlayers: handles the enriched-only event variants (which have no entry in
// SE.EVENT_META) before delegating to the raw server-event iterator.
export function* iterAssocSquadUniqueIds(event: EventEnriched): Generator<number> {
	if (event.type === 'NOOP' || event.type === 'WARNS_AGGREGATED') return
	if (event.type === 'APP_EVENT') {
		if (event.warnSummary.type === 'squads') {
			for (const squad of event.warnSummary.squads) yield squad.uniqueId
		}
		for (const collapsed of event.collapsed) yield* iterAssocSquadUniqueIds(collapsed)
		return
	}
	yield* SE.iterAssocSquadUniqueIds(null, event as SE.Event)
}

export function hasAssocSquad(event: EventEnriched, uniqueSquadId: number): boolean {
	return Gen.some(iterAssocSquadUniqueIds(event), id => id === uniqueSquadId)
}

// does this event belong in a specific squad instance's detail feed?
// Beyond the events directly associated with the squad (creation, joins/leaves, renames, squad-channel chat), the feed
// also surfaces team/all chat authored by squad members, warns targeting them, and admin actions (disband, remove from
// squad, kick, force team change, ...) that targeted squad members. Those broadened events are attributed by the squad
// unique (instance) id resolved at event time (authorSquadId / targetSquadId / targetSquadIds), so events from a prior
// squad that reused the same in-game id never leak into a later instance. When `squadMessagesOnly` is set, member chat
// outside the squad channel is excluded (warns, admin actions and squad lifecycle events still show).
export function isSquadFeedEvent(
	event: EventEnriched,
	uniqueSquadId: number,
	squadMessagesOnly: boolean,
): boolean {
	if (hasAssocSquad(event, uniqueSquadId)) return true

	switch (event.type) {
		case 'CHAT_MESSAGE':
			return !squadMessagesOnly && event.authorSquadId === uniqueSquadId
		case 'PLAYER_WARNED':
			return event.targetSquadId === uniqueSquadId
		case 'WARNS_AGGREGATED':
			return event.warns.some(w => w.targetSquadId === uniqueSquadId)
		case 'APP_EVENT':
			return event.targetSquadIds.includes(uniqueSquadId)
		default:
			return false
	}
}

export function findLastPlayerInstance(events: EventEnriched[], playerId: SM.PlayerId): SM.Player | undefined {
	for (const event of Arr.revIter(events)) {
		for (const [player] of iterAssocPlayers(event, playerId)) {
			if (typeof player === 'object') return player
		}
	}
}

export function getPlayerRelatedEvents(events: EventEnriched[], playerId: SM.PlayerId): EventEnriched[] {
	return events.filter(event => hasAssocPlayer(event, playerId))
}
