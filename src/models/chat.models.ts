import { z } from 'zod'

import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
import * as Arr from '@/lib/array-utils'
import * as Gen from '@/lib/generator-utils'
import { assertNever } from '@/lib/type-guards'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared'
import { applyEventTeamMutations } from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import { baseLogger } from '@/systems/logger.client'

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
	// the live roster: only players currently connected
	players: SM.Player[]
	// everyone who has taken part in the current match, including players who have since disconnected. Reset at match
	// boundaries alongside playerStats, whose keys it is the domain of.
	recentPlayers: SM.RecentPlayer[]
	// the live squads: only squads that currently exist
	squads: SM.UniqueSquad[]
	// every squad instance that has existed in the current match, including disbanded ones. Same bargain as
	// recentPlayers: keyed by uniqueId, which is stable for the lifetime of an instance.
	recentSquads: SM.RecentSquad[]
	// per-match combat stats, keyed by recent player id. kept separate from the player records rather than stored on
	// them, so a player who reconnects mid-match keeps the score they built up before dropping.
	playerStats: PlayerStatsMap
	// players currently in admin camera, tracked from POSSESSED/UNPOSSESSED_ADMIN_CAMERA. kept separate from players
	// since the roster is replaced wholesale by the teams poll, which knows nothing about admin camera
	adminCamPlayerIds: SM.PlayerId[]
}

export namespace InterpolableState {
	export function clone(state: InterpolableState): InterpolableState {
		return {
			players: state.players.map((p) => ({ ...p, ids: { ...p.ids } })),
			recentPlayers: [...state.recentPlayers],
			squads: [...state.squads],
			recentSquads: [...state.recentSquads],
			playerStats: { ...state.playerStats },
			adminCamPlayerIds: [...state.adminCamPlayerIds],
		}
	}

	// records a player as having taken part in the current match, refreshing the ids/admin status of an existing entry.
	export function recordRecentPlayer(state: InterpolableState, player: SM.RecentPlayer) {
		const index = SM.PlayerIds.indexOf(state.recentPlayers, (p) => p.ids, player.ids)
		if (index === -1) state.recentPlayers.push(SM.toRecentPlayer(player))
		else state.recentPlayers[index] = SM.toRecentPlayer(player)
	}

	export function findRecentPlayer(state: InterpolableState, id: SM.PlayerIds.Ref) {
		return SM.PlayerIds.find(state.recentPlayers, (p) => p.ids, id)
	}

	// records a squad instance as having existed in the current match, refreshing an existing entry (e.g. a rename).
	export function recordRecentSquad(state: InterpolableState, squad: SM.RecentSquad) {
		const index = state.recentSquads.findIndex((s) => s.uniqueId === squad.uniqueId)
		if (index === -1) state.recentSquads.push(SM.toRecentSquad(squad))
		else state.recentSquads[index] = SM.toRecentSquad(squad)
	}

	export function findRecentSquad(state: InterpolableState, uniqueSquadId: number) {
		return state.recentSquads.find((s) => s.uniqueId === uniqueSquadId)
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

// a map set enriched with the in-game admin who performed it, when the log named one and they're still on the roster
export type EnrichedMapSet = SE.MapSet & { actorPlayer?: SM.Player }

// a round end enriched with the in-game admin who ended it, when one did
export type EnrichedRoundEnded = SE.RoundEnded & { actorPlayer?: SM.Player }

// event enriched with relevant data
export type EventEnriched =
	| EnrichedAppEvent
	| NoopEvent
	| EnrichedMapSet
	| SE.IngameVoteStarted
	| SE.NewGame
	| SE.Reset
	| SE.RconConnected
	| SE.RconDisconnected
	| EnrichedRoundEnded
	| SE.PlayerConnected<SM.Player>
	| SE.PlayerReconciled<SM.Player>
	| SE.PlayerDisconnected<SM.Player>
	| SE.PlayerDetailsChanged<SM.Player>
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

// The other half of ServerEvent's switch (server-event.tsx): each entry decides, from the event alone, whether that
// renderer draws anything. Every `return null` in the component that depends only on the event is mirrored here, and
// the feed filters on it (see showEventInFeed) so an entry that draws nothing is never mounted. Half a busy match's
// entries are roster bookkeeping the feed does not show, and mounting them costs more than everything else on the
// client put together.
//
// Only conditions the event answers by itself belong here. ROUND_ENDED draws nothing until its match reaches
// post-game, which the event cannot know and which changes after the event is buffered, so that stays in the
// component.
const RENDERS_IN_FEED = {
	CHAT_MESSAGE: (event) => event.player.teamId !== null,
	ADMIN_BROADCAST: () => true,
	PLAYER_CONNECTED: () => true,
	// roster backfill from the teams poll -- state only, never surfaced
	PLAYER_RECONCILED: () => false,
	PLAYER_DISCONNECTED: () => true,
	POSSESSED_ADMIN_CAMERA: () => true,
	UNPOSSESSED_ADMIN_CAMERA: () => true,
	PLAYER_KICKED: () => true,
	SQUAD_CREATED: () => true,
	PLAYER_BANNED: () => true,
	PLAYER_WARNED: () => true,
	WARNS_AGGREGATED: () => true,
	// an audit-only MAP_SET repeats the layer its QUEUE_UPDATED already named
	APP_EVENT: (event) => !(event.appEvent.type === 'MAP_SET' && event.appEvent.reason === 'queue-updated'),
	NEW_GAME: () => true,
	// reseeds the roster for a boundary NEW_GAME has already announced
	RESET: () => false,
	ROUND_ENDED: () => true,
	PLAYER_DETAILS_CHANGED: () => false,
	// the only detail with a line of its own is the lock, and only when it actually changed
	SQUAD_DETAILS_CHANGED: (event) => event.details.locked !== undefined && event.details.locked !== event.prevDetails.locked,
	SQUAD_RENAMED: () => true,
	PLAYER_CHANGED_TEAM: () => true,
	PLAYER_LEFT_SQUAD: () => true,
	SQUAD_DISBANDED: () => true,
	PLAYER_JOINED_SQUAD: () => true,
	PLAYER_PROMOTED_TO_LEADER: () => true,
	TEAMS_POLLED_UPDATE: () => false,
	PLAYER_DIED: () => true,
	PLAYER_WOUNDED: () => true,
	MAP_SET: () => true,
	INGAME_VOTE_STARTED: (event) => event.container === 'Vote_NextLayer',
	RCON_CONNECTED: () => true,
	RCON_DISCONNECTED: () => true,
	NOOP: () => false,
} satisfies { [T in EventEnriched['type']]: (event: Extract<EventEnriched, { type: T }>) => boolean }

/**
 * Wire form for a batch of enriched events.
 *
 * Enrichment embeds a whole player object per event, so a busy match sends the same ~160 people several thousand
 * times: two thirds of the payload, and that many objects for the client to allocate. Interpolation hands the same
 * object to every event that mentions a player until something about them changes, so hoisting them into a shared
 * table keyed on object identity -- a Map lookup per field, never a structural comparison -- collapses most of it.
 *
 * Which fields hold one is fixed per event type (FIELDS below), so encoding touches those and nothing else rather
 * than walking each event. Decoding hands the client back the same sharing, so a player is one object there too.
 */
export namespace Wire {
	type Fields = {
		// keys holding a single SM.Player, or nothing
		players?: readonly string[]
		// keys holding an SM.Player[]
		playerLists?: readonly string[]
		// keys holding a single SM.UniqueSquad
		squads?: readonly string[]
		// keys holding an SM.UniqueTeams, i.e. a roster of both
		rosters?: readonly string[]
		// keys holding an EventEnriched[], encoded recursively
		nested?: readonly string[]
	}

	// Exhaustive over the union so a new event type has to declare what it embeds, even if that is nothing.
	const FIELDS = {
		CHAT_MESSAGE: { players: ['player'] },
		ADMIN_BROADCAST: { players: ['player'] },
		PLAYER_CONNECTED: { players: ['player'] },
		PLAYER_RECONCILED: { players: ['player'] },
		PLAYER_DISCONNECTED: { players: ['player'] },
		PLAYER_DETAILS_CHANGED: { players: ['player'] },
		PLAYER_CHANGED_TEAM: { players: ['player'] },
		PLAYER_WARNED: { players: ['player'] },
		PLAYER_BANNED: { players: ['player'] },
		PLAYER_KICKED: { players: ['player'] },
		POSSESSED_ADMIN_CAMERA: { players: ['player'] },
		UNPOSSESSED_ADMIN_CAMERA: { players: ['player'] },
		PLAYER_JOINED_SQUAD: { players: ['player'], squads: ['squad'] },
		PLAYER_LEFT_SQUAD: { players: ['player'], squads: ['squad'] },
		PLAYER_PROMOTED_TO_LEADER: { players: ['player'], squads: ['squad'] },
		SQUAD_CREATED: { players: ['creator'], squads: ['squad'] },
		SQUAD_DISBANDED: { squads: ['squad'] },
		SQUAD_DETAILS_CHANGED: { squads: ['squad'] },
		SQUAD_RENAMED: { squads: ['squad'] },
		PLAYER_DIED: { players: ['victim', 'attacker'] },
		PLAYER_WOUNDED: { players: ['victim', 'attacker'] },
		MAP_SET: { players: ['actorPlayer'] },
		ROUND_ENDED: { players: ['actorPlayer'] },
		APP_EVENT: { players: ['actorPlayer'], playerLists: ['targetPlayers'], nested: ['collapsed'] },
		WARNS_AGGREGATED: { nested: ['warns'] },
		NEW_GAME: { rosters: ['state'] },
		RESET: { rosters: ['state'] },
		TEAMS_POLLED_UPDATE: {},
		INGAME_VOTE_STARTED: {},
		RCON_CONNECTED: {},
		RCON_DISCONNECTED: {},
		NOOP: {},
	} satisfies Record<EventEnriched['type'], Fields>

	// an event type with nothing to hoist crosses the wire untouched, so a match's several hundred teams polls cost
	// neither a copy on the way out nor one on the way back
	const HOISTS = new Set(
		Object.entries(FIELDS)
			.filter(([, f]) => Object.keys(f).length > 0)
			.map(([type]) => type),
	)

	export type Batch = {
		players: SM.Player[]
		squads: SM.UniqueSquad[]
		// each event with the fields FIELDS names replaced by an index into the tables above. Opaque: decode is the
		// only thing that reads them.
		events: readonly unknown[]
	}

	type Interner<T> = (value: T) => number

	function interner<T extends object>(table: T[]): Interner<T> {
		const indices = new Map<T, number>()
		return (value) => {
			let index = indices.get(value)
			if (index === undefined) {
				index = table.push(value) - 1
				indices.set(value, index)
			}
			return index
		}
	}

	export function encode(events: readonly EventEnriched[]): Batch {
		const players: SM.Player[] = []
		const squads: SM.UniqueSquad[] = []
		const internPlayer = interner(players)
		const internSquad = interner(squads)

		function encodeEvent(event: EventEnriched): unknown {
			if (!HOISTS.has(event.type)) return event
			const fields: Fields = FIELDS[event.type]
			const out = { ...event } as Record<string, any>
			for (const key of fields.players ?? []) if (out[key]) out[key] = internPlayer(out[key])
			for (const key of fields.playerLists ?? []) if (out[key]) out[key] = out[key].map(internPlayer)
			for (const key of fields.squads ?? []) if (out[key]) out[key] = internSquad(out[key])
			for (const key of fields.rosters ?? []) {
				if (!out[key]) continue
				out[key] = { ...out[key], players: out[key].players.map(internPlayer), squads: out[key].squads.map(internSquad) }
			}
			for (const key of fields.nested ?? []) if (out[key]) out[key] = out[key].map(encodeEvent)
			return out
		}

		return { players, squads, events: events.map(encodeEvent) }
	}

	export function decode(batch: Batch): EventEnriched[] {
		const { players, squads } = batch

		function decodeEvent(encoded: unknown): EventEnriched {
			const event = encoded as EventEnriched
			if (!HOISTS.has(event.type)) return event
			const fields: Fields = FIELDS[event.type]
			const out = { ...event } as Record<string, any>
			for (const key of fields.players ?? []) if (typeof out[key] === 'number') out[key] = players[out[key]]
			for (const key of fields.playerLists ?? []) if (out[key]) out[key] = out[key].map((i: number) => players[i])
			for (const key of fields.squads ?? []) if (typeof out[key] === 'number') out[key] = squads[out[key]]
			for (const key of fields.rosters ?? []) {
				if (!out[key]) continue
				out[key] = {
					...out[key],
					players: out[key].players.map((i: number) => players[i]),
					squads: out[key].squads.map((i: number) => squads[i]),
				}
			}
			for (const key of fields.nested ?? []) if (out[key]) out[key] = out[key].map(decodeEvent)
			return out as EventEnriched
		}

		return batch.events.map(decodeEvent)
	}
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
		recentPlayers: [],
		squads: [],
		recentSquads: [],
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

export function handleEvent(state: ChatState, event: Event | LifecycleEvent, opts?: InterpolationOptions) {
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
		const appEntry = state.eventBuffer.find((e): e is EnrichedAppEvent => e.type === 'APP_EVENT' && e.id === attributedTo)
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

// dedup key: identical warn text AND the same acting source (a specific in-game admin, RCON, etc.).
// NUL joins the two halves because it can't occur in either, so no actor/reason pair can spell another one's key.
// It's written as an escape rather than the literal byte: inline, it makes this file read as binary to grep, which
// then reports no matches here rather than an error.
function warnDedupKey(reason: string, source: SE.PlayerWarned['source']): string {
	const actor = !source
		? 'none'
		: source.type === 'player'
			? `player:${SM.PlayerIds.getPlayerId(source.playerIds)}`
			: source.type === 'event'
				? `event:${source.id}`
				: source.type
	return `${actor}\u0000${reason}`
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

// Interleaves app events into a stream of server events for replay through handleEvent. The server events keep the
// order they were given in (their id order, which is the order they were interpolated in -- their recorded times are
// log timestamps and are not monotonic, so sorting the whole lot by time desynchronizes the roster interpolation).
// An app event is placed before the first server event it precedes in time, and always before any server event
// attributed to it, since handleEvent can only collapse an attributed server event onto an entry already in the buffer.
export function mergeAppEvents(serverEvents: SE.Event[], appEvents: AppEvents.AppEvent[]): (SE.Event | AppFeedEvent)[] {
	const pending = [...appEvents].sort((a, b) => a.time - b.time)
	const merged: (SE.Event | AppFeedEvent)[] = []
	let next = 0
	for (const event of serverEvents) {
		const source = (event as { source?: { type: string; id?: AppEvents.AppEventId } }).source
		const attributedTo = source?.type === 'event' ? source.id : undefined
		let until = next
		while (until < pending.length && pending[until].time <= event.time) until++
		if (attributedTo !== undefined) {
			const attributionIndex = pending.findIndex((a, i) => i >= next && a.id === attributedTo)
			if (attributionIndex >= until) until = attributionIndex + 1
		}
		for (; next < until; next++) merged.push({ type: 'APP_EVENT', appEvent: pending[next] })
		merged.push(event)
	}
	for (; next < pending.length; next++) merged.push({ type: 'APP_EVENT', appEvent: pending[next] })
	return merged
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
	return state.squads.find((s) => s.squadId === player.squadId && s.teamId === player.teamId)?.uniqueId
}

// resolves an eos id against the live roster, falling back to everyone who has taken part in this match. The fallback
// is what names the target of an action that removed them (a kick, a dropped teamswap) instead of printing their id.
function resolvePlayer(state: InterpolableState, playerId: SM.PlayerId): SM.Player | undefined {
	const live = SM.PlayerIds.find(state.players, (p) => p.ids, { eos: playerId })
	if (live) return live
	const recent = InterpolableState.findRecentPlayer(state, { eos: playerId })
	return recent ? SM.fromRecentPlayer(recent) : undefined
}

function enrichAppEvent(state: InterpolableState, appEvent: AppEvents.AppEvent): EnrichedAppEvent {
	const targetPlayers = AppEvents.involvedPlayerIds(appEvent)
		.map((id) => resolvePlayer(state, id))
		.filter((p): p is SM.Player => !!p)
	const actorPlayer = appEvent.actor.type === 'ingame-user' ? resolvePlayer(state, appEvent.actor.playerId) : undefined

	const targetSquadIds = new Set<number>()
	// squad-typed actions name an in-game squad + team directly; resolve to the live instance (it still exists when the
	// action is recorded, as the resulting server events arrive afterwards)
	if (appEvent.type === 'SQUAD_DISBANDED' || appEvent.type === 'SQUAD_RENAMED') {
		const squad = state.squads.find((s) => s.squadId === appEvent.squadId && s.teamId === appEvent.teamId)
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

// naming this many squads or fewer beats any broader description of the same target set; past it the squad list is
// longer and less informative than "the entire server" / "both teams"
const SQUAD_SUMMARY_PREEMPT_LIMIT = 2

// classifies who a warn targeted against the current interpolated state, most-specific first. The renderer still
// prefers naming players directly for small sets; this drives the summary for larger ones.
function summarizeWarnTargets(state: InterpolableState, targets: SM.Player[]): WarnSummary {
	if (targets.length === 0) return { type: 'players' }
	const idOf = (p: SM.Player) => SM.PlayerIds.getPlayerId(p.ids)
	const targetIds = new Set(targets.map(idOf))
	const players = state.players

	// squads warned in full, plus however many loose players remain
	const fullSquads: { uniqueId: number; squadName: string; teamId: SM.TeamId }[] = []
	let coveredBySquads = 0
	for (const squad of state.squads) {
		const members = players.filter((p) => p.squadId === squad.squadId && p.teamId === squad.teamId)
		if (members.length > 0 && members.every((p) => targetIds.has(idOf(p)))) {
			fullSquads.push({ uniqueId: squad.uniqueId, squadName: squad.squadName, teamId: squad.teamId })
			coveredBySquads += members.length
		}
	}
	const squadSummary: WarnSummary | undefined =
		fullSquads.length > 0
			? { type: 'squads', squads: fullSquads, otherPlayerCount: Math.max(0, targets.length - coveredBySquads) }
			: undefined

	// a warn aimed at a squad stays described as that squad even when the squad happens to be the whole server or a
	// whole team, which is what a near-empty server makes of every squad warn. Requires the squads to account for
	// every target exactly, so a broader set that merely contains a full squad still gets the broader description.
	if (squadSummary && fullSquads.length <= SQUAD_SUMMARY_PREEMPT_LIMIT && coveredBySquads === targets.length) {
		return squadSummary
	}

	// everyone currently on the server
	if (players.length > 0 && players.every((p) => targetIds.has(idOf(p)))) return { type: 'everyone' }

	// exactly the set of admins present
	const admins = players.filter((p) => p.isAdmin)
	if (admins.length > 0 && targets.length === admins.length && admins.every((p) => targetIds.has(idOf(p)))) {
		return { type: 'all-admins' }
	}

	// one or both teams warned in full, with no targets outside those teams
	const fullTeams: SM.TeamId[] = []
	for (const teamId of [1, 2] as SM.TeamId[]) {
		const teamPlayers = players.filter((p) => p.teamId === teamId)
		if (teamPlayers.length > 0 && teamPlayers.every((p) => targetIds.has(idOf(p)))) fullTeams.push(teamId)
	}
	if (fullTeams.length > 0 && targets.every((p) => p.teamId !== null && fullTeams.includes(p.teamId))) {
		return { type: 'teams', teamIds: fullTeams }
	}

	return squadSummary ?? { type: 'players' }
}

const compiledPatternMap = new WeakMap<string[], RegExp[]>()

const SuppressionSchema = z.string().refine((s) => new RegExp(s))

export const ChatConfigSchema = z.object({
	warnSuppressionPatterns: z
		.array(SuppressionSchema)
		.prefault([])
		.describe(
			"Regular expressions matched against a warn's text. A warn matching any of them is left out of the live chat feed; it is still " +
				'delivered in-game. Use it to keep routine SLM notifications from burying real chat.',
		),
	broadcastSuppressionPatterns: z
		.array(SuppressionSchema)
		.prefault([])
		.describe(
			"Regular expressions matched against a broadcast's text. A broadcast matching any of them is left out of the live chat feed; it is " +
				'still sent in-game. Only applies to broadcasts SLM cannot attribute to a player, so one an admin sent with an in-game command ' +
				'is never hidden.',
		),
})

function testPatterns(patterns: string[], text: string): boolean {
	if (patterns.length === 0) return false
	let compiled = compiledPatternMap.get(patterns)
	if (!compiled) {
		compiled = patterns.map((p) => new RegExp(p))
		compiledPatternMap.set(patterns, compiled)
	}
	return compiled.some((pattern) => pattern.test(text))
}

type InterpolationOptions = {
	warnSuppressionPatterns?: string[]
	broadcastSuppressionPatterns?: string[]
}

function interpolateEvent(state: InterpolableState, event: SE.Event, opts?: InterpolationOptions): EventEnriched {
	switch (event.type) {
		case 'MAP_SET':
		case 'NEW_GAME':
		case 'RESET': {
			applyEventTeamMutations(chatLog, state, event)
			if (event.type === 'MAP_SET') {
				const source = event.source
				return {
					...event,
					actorPlayer: source?.type === 'player' ? SM.PlayerIds.find(state.players, (p) => p.ids, source.playerIds) : undefined,
				}
			}
			if (event.type === 'NEW_GAME') {
				// a match boundary restarts participation: only whoever is on the roster right now counts as recent,
				// and last match's scores go with it. NEW_GAME is the only boundary -- a RESET reseeds the roster for
				// a boundary NEW_GAME already announced, but is ALSO emitted on a same-match rcon reconnect
				// (source 'rcon-reconnected'), where wiping would cost the match its scores so far.
				state.playerStats = {}
				state.recentPlayers = state.players.map(SM.toRecentPlayer)
				state.recentSquads = state.squads.map(SM.toRecentSquad)
			} else if (event.type === 'RESET') {
				// RESET restates the roster from scratch and carries no admin camera information, so anyone we thought
				// was in admin camera is no longer known to be
				state.adminCamPlayerIds = []
				// the reseeded roster may name players and squads we haven't seen participate yet
				for (const player of state.players) InterpolableState.recordRecentPlayer(state, player)
				for (const squad of state.squads) InterpolableState.recordRecentSquad(state, squad)
			}
			return event
		}

		case 'RCON_CONNECTED':
		case 'RCON_DISCONNECTED':
		case 'TEAMS_POLLED_UPDATE':
		case 'INGAME_VOTE_STARTED': {
			if (event.type === 'INGAME_VOTE_STARTED' && event.container !== 'Vote_NextLayer')
				return noop("Skipping INGAME_VOTE_STARTED that doesn't have container Vote_NextLayer")
			return { ...event }
		}

		case 'ROUND_ENDED': {
			const source = event.action?.source
			return {
				...event,
				actorPlayer: source?.type === 'player' ? SM.PlayerIds.find(state.players, (p) => p.ids, source.playerIds) : undefined,
			}
		}

		case 'PLAYER_CONNECTED': {
			if (SM.PlayerIds.find(state.players, (p) => p.ids, event.player.ids)) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} connected but was already in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			InterpolableState.recordRecentPlayer(state, event.player)
			return { ...event, player: event.player }
		}

		// roster backfill from the teams poll -- adds the player to client state like a connect, but is not
		// rendered in the feed (see isRenderableInFeed / ServerEvent).
		case 'PLAYER_RECONCILED': {
			const known = SM.PlayerIds.find(state.players, (p) => p.ids, event.player.ids)
			if (known) {
				// Already on the roster, so this is the poll correcting what only it can know. A player who arrived on
				// the log stream carries no role and no admin-list membership: the log does not report either, and this
				// is what fills them in.
				known.role = event.player.role
				known.isAdmin = event.player.isAdmin
				known.adminGroups = event.player.adminGroups
				InterpolableState.recordRecentPlayer(state, known)
				return { ...event, player: known }
			}
			applyEventTeamMutations(chatLog, state, event)
			InterpolableState.recordRecentPlayer(state, event.player)
			return { ...event, player: event.player }
		}

		case 'PLAYER_DISCONNECTED': {
			const index = SM.PlayerIds.indexOf(state.players, (p) => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} disconnected but was not found in the player list`)
			}
			const player = state.players[index]
			state.adminCamPlayerIds = state.adminCamPlayerIds.filter((id) => id !== event.player)
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player }
		}

		case 'PLAYER_DETAILS_CHANGED': {
			const index = SM.PlayerIds.indexOf(state.players, (p) => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} had details changed but was not found in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			InterpolableState.recordRecentPlayer(state, state.players[index])
			return { ...event, player: state.players[index] }
		}

		case 'SQUAD_DETAILS_CHANGED': {
			const index = state.squads.findIndex((s) => s.uniqueId === event.uniqueId)
			if (index === -1) {
				return noop(`Squad ${event.uniqueId} had details changed but was not found in the squad list`)
			}
			const prevDetails: SE.SquadDetailsChanged['details'] = { locked: state.squads[index].locked }
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad: state.squads[index], prevDetails }
		}

		case 'SQUAD_RENAMED': {
			const index = state.squads.findIndex((s) => s.uniqueId === event.uniqueId)
			if (index === -1) {
				return noop(`Squad ${event.uniqueId} was renamed but was not found in the squad list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			InterpolableState.recordRecentSquad(state, state.squads[index])
			return { ...event, squad: state.squads[index] }
		}

		case 'PLAYER_CHANGED_TEAM': {
			const index = SM.PlayerIds.indexOf(state.players, (p) => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was not found in the player list`)
			}
			const prevTeamId = state.players[index].teamId
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], prevTeamId }
		}

		case 'PLAYER_JOINED_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, (p) => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was not found in the player list`)
			}
			const squad = state.squads.find((s) => s.uniqueId === event.uniqueId)
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
			const squad = state.squads.find((s) => s.uniqueId === event.uniqueId)
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
			const squadIndex = state.squads.findIndex((s) => s.uniqueId === event.uniqueId)
			if (squadIndex === -1) {
				return noop(`Squad ${event.uniqueId} disbanded but was not found in the squad list`)
			}
			const squad = state.squads[squadIndex]
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad }
		}

		case 'PLAYER_LEFT_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, (p) => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} left squad but was not found in the player list`)
			}
			const wasLeader = state.players[index].isLeader
			const squad = state.squads.find((s) => s.uniqueId === event.uniqueId)
			if (!squad) {
				return noop(`Squad ${event.uniqueId} not found for PLAYER_LEFT_SQUAD`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], wasLeader, squad }
		}

		case 'SQUAD_CREATED': {
			const existingSquad = state.squads.find((s) => s.uniqueId === event.squad.uniqueId)
			if (existingSquad) {
				return noop(`Squad ${event.squad.uniqueId} already exists`)
			}
			const squad: SM.UniqueSquad = event.squad
			// Track the squad even when its creator isn't on the roster yet. SQUAD_CREATED (parsed from the log
			// stream) races the creator's PLAYER_CONNECTED (reconciled from the teams poll), so it can arrive first;
			// dropping the squad here would strand every later PLAYER_JOINED_SQUAD referencing it (squad-not-found),
			// leaving its members stuck as Unassigned. applyEventTeamMutations tracks it regardless and only skips
			// establishing membership when the creator is unknown.
			applyEventTeamMutations(chatLog, state, event)
			InterpolableState.recordRecentSquad(state, squad)
			const creatorIndex = SM.PlayerIds.indexOf(state.players, (p) => p.ids, event.squad.creator)
			if (creatorIndex === -1) {
				return noop(
					`Squad ${SM.Squads.printKey(squad)} "${event.squad.squadName}" created by unknown player ${SM.PlayerIds.prettyPrint(
						squad.creator,
					)}`,
				)
			}
			if (state.players[creatorIndex].teamId !== squad.teamId) {
				return noop(
					`Creator ${SM.PlayerIds.prettyPrint(state.players[creatorIndex].ids)} is not in the same team as the squad they created ${SM.Squads.printKey(
						squad,
					)}`,
				)
			}
			return { ...event, creator: state.players[creatorIndex] }
		}

		case 'PLAYER_WARNED': {
			if (testPatterns(opts?.warnSuppressionPatterns ?? [], event.reason)) {
				return noop(`Warn reason ${event.reason} matches warn suppression pattern`)
			}
			const player = SM.PlayerIds.find(state.players, (p) => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${SM.PlayerIds.prettyPrint(
						event.player,
					)} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return { ...event, player, targetSquadId: playerSquadUniqueId(state, player) }
		}

		case 'PLAYER_BANNED':
		case 'PLAYER_KICKED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA': {
			const player = SM.PlayerIds.find(state.players, (p) => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${SM.PlayerIds.prettyPrint(
						event.player,
					)} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			if (event.type === 'PLAYER_KICKED') {
				return { ...event, player, reason: event.reason?.replace('Kicked from the server: ', '').trim() }
			}
			if (event.type === 'POSSESSED_ADMIN_CAMERA' && !state.adminCamPlayerIds.includes(event.player)) {
				state.adminCamPlayerIds = [...state.adminCamPlayerIds, event.player]
			}
			if (event.type === 'UNPOSSESSED_ADMIN_CAMERA') {
				state.adminCamPlayerIds = state.adminCamPlayerIds.filter((id) => id !== event.player)
			}
			return { ...event, player }
		}

		case 'CHAT_MESSAGE': {
			const player = SM.PlayerIds.find(state.players, (p) => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${SM.PlayerIds.prettyPrint(
						event.player,
					)} was involved in ${event.type} but was not found in the interpolated player list`,
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
				const player = SM.PlayerIds.find(state.players, (p) => p.ids, event.from)
				if (!player) {
					return noop(
						`Player ${SM.PlayerIds.prettyPrint(
							event.from,
						)} was involved in ${event.type} but was not found in the interpolated player list`,
					)
				}
				return { ...event, player } as SE.AdminBroadcast & { player: SM.Player }
			} else if (event.source) {
				if (event.source.type === 'player') {
					const player = SM.PlayerIds.find(state.players, (p) => p.ids, event.source.playerIds)
					if (!player) {
						return noop(
							`Player ${SM.PlayerIds.prettyPrint(
								event.source,
							)} was involved in ${event.type} but was not found in the interpolated player list`,
						)
					}
					return { ...event, player } as SE.AdminBroadcast & { player: SM.Player }
				}
				// nobody in-game sent it: an external rcon tool, or SLM itself. An SLM broadcast carries the app
				// event that sent it and collapses under that entry rather than rendering here (see handleEvent).
				return { ...event } as SE.AdminBroadcast
			} else {
				throw new Error(`AdminBroadcast event must have either from or source property`)
			}
		}

		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED': {
			const victim = SM.PlayerIds.find(state.players, (p) => p.ids, event.victim)
			if (!victim) {
				return noop(
					`Victim ${SM.PlayerIds.prettyPrint(
						event.victim,
					)} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			const attacker = SM.PlayerIds.find(state.players, (p) => p.ids, event.attacker)
			if (!attacker) {
				return noop(
					`Attacker ${SM.PlayerIds.prettyPrint(
						event.attacker,
					)} was involved in ${event.type} but was not found in the interpolated player list`,
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

export type PrimaryFilterState =
	| null
	| {
			type: 'player'
			id: SM.PlayerId
	  }
	| {
			type: 'squad'
			id: number
	  }

export const SECONDARY_FILTER_STATE = z.enum(['ALL', 'DEFAULT', 'CHAT', 'SLM_EVENTS', 'ADMIN', 'KILLFEED'])
export type SecondaryFilterState = z.infer<typeof SECONDARY_FILTER_STATE>

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

// broadcasts show whoever sent them: an in-game admin, an external rcon tool, or SLM itself (which arrives as the
// BROADCAST_SENT app event, with the raw server event collapsed under it)
function isBroadcastEvent(event: EventEnriched): boolean {
	if (event.type === 'ADMIN_BROADCAST') return true
	return event.type === 'APP_EVENT' && event.appEvent.type === 'BROADCAST_SENT'
}

// raw in-game warns are noise in these feeds; only the SLM-initiated ones, which arrive as app events, show
function isWarnEvent(event: EventEnriched): boolean {
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
	// only read when selectedOnly is set
	selectedPlayerIds?: ReadonlySet<SM.PlayerId>
	// ANDed on top of filterState rather than a filterState of its own, so it composes with any of them
	selectedOnly?: boolean
}

function matchesFilterState(event: EventEnriched, filterState: SecondaryFilterState): boolean {
	switch (filterState) {
		case 'ALL':
			return true
		case 'DEFAULT':
			if (isKillfeedEvent(event) && event.variant !== 'teamkill') return false
			if (event.type === 'PLAYER_JOINED_SQUAD' || event.type === 'PLAYER_LEFT_SQUAD') return false
			return true
		case 'CHAT':
			return event.type === 'CHAT_MESSAGE' || isBroadcastEvent(event) || isWarnEvent(event)
		case 'SLM_EVENTS':
			return event.type === 'APP_EVENT' || event.type === 'MAP_SET'
		case 'ADMIN':
			if (event.type === 'APP_EVENT' || event.type === 'MAP_SET') return true
			if (event.type === 'CHAT_MESSAGE') return event.channel.type === 'ChatAdmin'
			if (isBroadcastEvent(event)) return true
			if (event.type === 'PLAYER_CONNECTED' || event.type === 'PLAYER_DISCONNECTED') return event.player.isAdmin
			return isAdminActionEvent(event)
		case 'KILLFEED':
			return isKillfeedEvent(event)
		default:
			assertNever(filterState)
	}
}

export function showEventInFeed(event: EventEnriched, filterState: SecondaryFilterState, ctx?: SecondaryFilterContext): boolean {
	// ahead of the pinned check: a RESET is pinned by kind but draws nothing
	if (!isRenderableInFeed(event)) return false
	if (isPinnedSystemEvent(event)) return true
	if (!matchesFilterState(event, filterState)) return false
	if (ctx?.selectedOnly) {
		const selected = ctx.selectedPlayerIds
		if (!selected || selected.size === 0) return false
		return hasAnyAssocPlayer(event, selected)
	}
	return true
}

// Whether the feed renderer draws anything for this event; see RENDERS_IN_FEED. showEventInFeed already applies it,
// so this is for callers that filter by something else and still have to drop invisible entries -- one that injects
// separators between events would otherwise emit a leading separator or two markers in a row.
export function isRenderableInFeed(event: EventEnriched): boolean {
	return (RENDERS_IN_FEED[event.type] as (event: EventEnriched) => boolean)(event)
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
	return Gen.some(iterAssocSquadUniqueIds(event), (id) => id === uniqueSquadId)
}

// does this event belong in a specific squad instance's detail feed?
// Beyond the events directly associated with the squad (creation, joins/leaves, renames, squad-channel chat), the feed
// also surfaces team/all chat authored by squad members, warns targeting them, and admin actions (disband, remove from
// squad, kick, force team change, ...) that targeted squad members. Those broadened events are attributed by the squad
// unique (instance) id resolved at event time (authorSquadId / targetSquadId / targetSquadIds), so events from a prior
// squad that reused the same in-game id never leak into a later instance. When `squadMessagesOnly` is set, member chat
// outside the squad channel is excluded (warns, admin actions and squad lifecycle events still show).
export function isSquadFeedEvent(event: EventEnriched, uniqueSquadId: number, squadMessagesOnly: boolean): boolean {
	if (hasAssocSquad(event, uniqueSquadId)) return true

	switch (event.type) {
		case 'CHAT_MESSAGE':
			return !squadMessagesOnly && event.authorSquadId === uniqueSquadId
		case 'PLAYER_WARNED':
			return event.targetSquadId === uniqueSquadId
		case 'WARNS_AGGREGATED':
			return event.warns.some((w) => w.targetSquadId === uniqueSquadId)
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
	return events.filter((event) => hasAssocPlayer(event, playerId))
}
