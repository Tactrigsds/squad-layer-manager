import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type * as Types from '@/lib/types'
import type * as CS from '@/models/context-shared'
import type * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import superjson from 'superjson'
import { z } from 'zod'
import { type ActionSource, ActionSourceSchema, type Base, BaseSchema, type EventMeta, meta } from './server-events-base.models'

export type MapSet = {
	type: 'MAP_SET'
	layerId: L.LayerId
	source?: ActionSource | { type: 'layer-queue'; itemId: string }
} & Base
export const MAP_SET_META = meta()

// True when SLM itself caused this map set: a queue save (`layer-queue`), an app-event-attributed
// set-next (`event`, e.g. a QUEUE_UPDATED), or another internal set-next (`system`). Organic sets --
// an in-game admin (`player`), an external RCON tool (`rcon`), or an unattributed one (undefined) --
// return false. Used to avoid reacting to our own layer changes (e.g. unshifting a duplicate queue item).
export function mapSetIsSlmOriginated(source: MapSet['source']): boolean {
	if (!source) return false
	return source.type === 'layer-queue' || source.type === 'event' || source.type === 'system'
}

export type NewGame = {
	type: 'NEW_GAME'
	source: 'slm-started' | 'rcon-reconnected' | 'server-roll' | 'new-game-detected'
	layerId: L.LayerId
	// DEPRECATED payload. NEW_GAME is now a roster-less match-boundary marker; the definitive roster arrives on the
	// following RESET (the first teams poll after the boundary). Kept optional for backward compatibility: matches
	// recorded before the split carry the roster here and are still replayed correctly. Read rosters via
	// getInitialRoster / eventRoster rather than this field directly. Do not populate it on newly emitted events.
	state?: SM.UniqueTeams
} & Base
export const NEW_GAME_META = meta({
	players: [{ assocType: 'game-participant', path: '$.state.players[*]' }],
	squads: ['$.state.squads[*]'],
})

// Whether a NEW_GAME marks a roll that happened while this server was watching, and so is a boundary that held
// actions (teamswaps) should fire on. 'slm-started' is not: it means SLM has just learned about a match that was
// already running, and treating that as a boundary applies held actions to a match mid-flight.
export function newGameIsRoll(source: NewGame['source']): boolean {
	switch (source) {
		case 'server-roll':
		case 'new-game-detected':
		case 'rcon-reconnected':
			return true
		case 'slm-started':
			return false
		default:
			assertNever(source)
	}
}

// RESET carries the definitive team roster: "the roster is now exactly this". Emitted on the first teams poll after
// a match boundary (a NEW_GAME / server roll) and on a same-match RCON reconnect.
export type Reset = {
	type: 'RESET'
	source: 'slm-started' | 'rcon-reconnected' | 'server-roll'
	state: SM.UniqueTeams
} & Base

export const RESET_META = meta({ players: [{ assocType: 'game-participant', path: '$.state.players[*]' }], squads: ['$.state.squads[*]'] })

// Canonical, backward-compatible accessor for the roster an event carries, if any. RESET always carries one;
// NEW_GAME carries one only for pre-split (legacy) matches. Centralizes the "which events seed the roster" rule.
export function eventRoster(event: { type: string; state?: SM.UniqueTeams }): SM.UniqueTeams | undefined {
	return event.type === 'NEW_GAME' || event.type === 'RESET' ? event.state : undefined
}

// The first definitive team roster for a match, from its events in chronological order. For post-split matches this
// is the roster on the first RESET; for legacy matches it is the roster that was stored on NEW_GAME. Use this to
// answer "what was the starting roster" without caring which event carries it.
export function getInitialRoster(events: Iterable<{ type: string; state?: SM.UniqueTeams }>): SM.UniqueTeams | undefined {
	for (const event of events) {
		const roster = eventRoster(event)
		if (roster) return roster
	}
	return undefined
}

export type RconConnected = {
	type: 'RCON_CONNECTED'
	reconnected: boolean
} & Base
export const RCON_CONNECTED_META = meta()

export type RconDisconnected = {
	type: 'RCON_DISCONNECTED'
} & Base
export const RCON_DISCONNECTED_META = meta()

export type RoundEnded = {
	type: 'ROUND_ENDED'
	outcome: MH.MatchOutcome
	action?: {
		type: 'AdminChangeLayer'
		layerId: L.LayerId
		source: ActionSource
	} | {
		type: 'AdminEndMatch'
		source: ActionSource
	}
} & Base
export const ROUND_ENDED_META = meta({ players: [{ assocType: 'player', path: '$.action.source.playerIds.eos' }] })

export type PlayerConnected<P = SM.Player> =
	& {
		type: 'PLAYER_CONNECTED'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_CONNECTED_META = meta({ players: [{ assocType: 'player' }] })

// Emitted by the teams-poll reconciler for a player RCON reports as present but who was missing from our roster
// (e.g. their PLAYER_CONNECTED landed during a round roll and was dropped). Semantically distinct from
// PLAYER_CONNECTED -- it is a roster backfill, not a fresh join -- so join-only consumers (feed card, battlemetrics,
// connection indicator, teamswap tracking) ignore it. Carries the full player so the event insert registers them.
export type PlayerReconciled<P = SM.Player> =
	& {
		type: 'PLAYER_RECONCILED'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_RECONCILED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerDisconnected<P = SM.PlayerId> =
	& {
		type: 'PLAYER_DISCONNECTED'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_DISCONNECTED_META = meta({ players: [{ assocType: 'player' }] })

export type SquadCreated = {
	type: 'SQUAD_CREATED'
	squad: SM.UniqueSquad
	// present when the creation log never made it (missed/unparseable/dropped) and the squad was instead synthesized
	// from an RCON teams poll (see reconcileTeamsUpdate). membership/leadership for synthesized squads is established
	// by the join/promote events reconciled from the same poll rather than by this event.
	synthesized?: true
} & Base

export const SQUAD_CREATED_META = meta({ squads: ['$.squad'], players: [{ assocType: 'player', path: '$.squad.creator' }] })

export type ChatMessage<P = SM.PlayerId> =
	& {
		type: 'CHAT_MESSAGE'
		message: string
		channel: SM.ChatChannel
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const CHAT_MESSAGE_META = meta({ players: [{ assocType: 'player' }], squads: ['$.channel.uniqueId'] })

export type AdminBroadcast = {
	type: 'ADMIN_BROADCAST'
	message: string
	from?: SM.LogEvents.AdminBroadcast['from']
	source?: SM.LogEvents.AdminBroadcast['source']
} & Base
export const ADMIN_BROADCAST_META = meta()

// synthetic events from player state
export type PlayerDetailsChanged<P = SM.PlayerId> =
	& {
		type: 'PLAYER_DETAILS_CHANGED'
		details: Pick<SM.Player, (typeof SM.PLAYER_DETAILS)[number]>
		newUsername?: string
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_DETAILS_CHANGED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerChangedTeam<P = SM.PlayerId> =
	& {
		type: 'PLAYER_CHANGED_TEAM'
		newTeamId: SM.TeamId | null
		// present when an admin forced the change (parsed from the log); absent for organic switches inferred from team polling
		source?: ActionSource
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_CHANGED_TEAM_META = meta({ players: [{ assocType: 'player' }] })

// can originate if the player manually leaves the squad, or is removed for some other reason
export type PlayerLeftSquad<P = SM.PlayerId> =
	& {
		type: 'PLAYER_LEFT_SQUAD'
		uniqueId: number
		// present when an admin removed the player / disbanded their squad (parsed from the log); absent for organic leaves inferred from team polling
		source?: ActionSource
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_LEFT_SQUAD_META = meta({ players: [{ assocType: 'player' }], squads: ['$.uniqueId'] })

// this event is redundant in terms of state transfer, as it could be inferred as the last player leaving a particular squad
export type SquadDisbanded = {
	type: 'SQUAD_DISBANDED'
	uniqueId: number
	// present when an admin disbanded the squad (parsed from the log); absent when inferred from team polling
	source?: ActionSource
} & Base
export const SQUAD_DISBANDED_META = meta({ squads: ['$.uniqueId'] })

export type SquadDetailsChanged = {
	type: 'SQUAD_DETAILS_CHANGED'
	uniqueId: number
	details: {
		locked?: boolean
	}
} & Base
export const SQUAD_DETAILS_CHANGED_META = meta({ squads: ['$.uniqueId'] })

export type SquadRenamed = {
	type: 'SQUAD_RENAMED'
	uniqueId: number
	oldSquadName: string
	newSquadName: string
	// present when an admin renamed the squad through SLM (links to an app event); absent otherwise
	source?: ActionSource
} & Base
export const SQUAD_RENAMED_META = meta({ squads: ['$.uniqueId'] })

/**
 * Player joined pre-existing squad
 */
export type PlayerJoinedSquad<P = SM.PlayerId> =
	& {
		type: 'PLAYER_JOINED_SQUAD'
		uniqueId: number
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_JOINED_SQUAD_META = meta({ players: [{ assocType: 'player' }], squads: ['$.uniqueId'] })

export type PlayerPromotedToLeader<P = SM.PlayerId> =
	& {
		type: 'PLAYER_PROMOTED_TO_LEADER'
		uniqueId: number
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_PROMOTED_TO_LEADER_META = meta({ players: [{ assocType: 'player' }], squads: ['$.uniqueId'] })

export type TeamsPolledUpdate = {
	type: 'TEAMS_POLLED_UPDATE'
} & Base

export const TEAMS_POLLED_UPDATE_META = meta({})

export type PlayerKicked<P = SM.PlayerId> =
	& {
		type: 'PLAYER_KICKED'
		reason?: string
		source?: ActionSource
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_KICKED_META = meta({ players: [{ assocType: 'player' }] })

export type PossessedAdminCamera<P = SM.PlayerId> =
	& {
		type: 'POSSESSED_ADMIN_CAMERA'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const POSSESSED_ADMIN_CAMERA_META = meta({ players: [{ assocType: 'player' }] })

export type UnpossessedAdminCamera<P = SM.PlayerId> =
	& {
		type: 'UNPOSSESSED_ADMIN_CAMERA'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const UNPOSSESSED_ADMIN_CAMERA_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerBanned<P = SM.PlayerId> = { type: 'PLAYER_BANNED'; interval: string } & SM.PlayerAssoc<'player', P> & Base
export const PLAYER_BANNED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerWarned<P = SM.PlayerId> =
	& { type: 'PLAYER_WARNED'; reason: string; source?: ActionSource }
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_WARNED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerDied<P = SM.PlayerId> =
	& {
		type: 'PLAYER_DIED'
		damage: number
		// null when the killing weapon was logged as `caused by nullptr`
		weapon: string | null
		variant: PlayerWoundedOrDiedVariant
	}
	& SM.PlayerAssoc<'victim', P>
	& SM.PlayerAssoc<'attacker', P>
	& Base

export const PLAYER_DIED_META = meta({ players: [{ assocType: 'victim' }, { assocType: 'attacker' }] })

export type PlayerWoundedOrDiedVariant = 'normal' | 'suicide' | 'teamkill'

export type PlayerWounded<P = SM.PlayerId> =
	& {
		type: 'PLAYER_WOUNDED'
		damage: number
		// null when the wounding weapon was logged as `caused by nullptr`
		weapon: string | null
		variant: PlayerWoundedOrDiedVariant
	}
	& SM.PlayerAssoc<'victim', P>
	& SM.PlayerAssoc<'attacker', P>
	& Base

export const PLAYER_WOUNDED_META = meta({ players: [{ assocType: 'victim' }, { assocType: 'attacker' }] })

export type SyntheticEvent<P = SM.PlayerId> =
	| PlayerDetailsChanged<P>
	| PlayerChangedTeam<P>
	| PlayerLeftSquad<P>
	| SquadDisbanded
	| SquadDetailsChanged
	// | SquadCreated
	| PlayerJoinedSquad<P>
	| PlayerPromotedToLeader<P>
	| TeamsPolledUpdate

export type Event<P = SM.PlayerId> =
	| MapSet
	| NewGame
	| Reset
	| RconConnected
	| RconDisconnected
	| RoundEnded
	| PlayerConnected<SM.Player>
	| PlayerReconciled<SM.Player>
	| PlayerDisconnected<P>
	| SquadCreated
	| ChatMessage<P>
	| AdminBroadcast
	// from rcon
	| PossessedAdminCamera<P>
	| UnpossessedAdminCamera<P>
	| PlayerKicked<P>
	| PlayerBanned<P>
	| PlayerWarned<P>
	| PlayerDied<P>
	| PlayerWounded<P>
	// synthetic
	| PlayerDetailsChanged<P>
	| PlayerChangedTeam<P>
	| PlayerLeftSquad<P>
	| SquadDisbanded
	| SquadDetailsChanged
	| SquadRenamed
	| PlayerJoinedSquad<P>
	| PlayerPromotedToLeader<P>
	| TeamsPolledUpdate

// An event before it has been written to the db. `id` is serverEvents.id, allocated by the insert, so it only
// exists once the row does -- see the createEvent hook in pending-events.models.ts.
export type NewEvent = Types.DistributiveOmit<Event, 'id'>

// ---- persisted form (serverEvents.data), validated on read by fromEventRow.
//
// These mirror the types above at their default instantiation -- `Event`, i.e. P = SM.PlayerId -- which is exactly
// the shape that reaches the db (`Event<P>` pins PLAYER_CONNECTED / PLAYER_RECONCILED to a full SM.Player regardless
// of P). The types stay hand-written rather than inferred from these schemas because they're generic over P and zod
// can't express that; `assertEventSchemaMatchesType` below is what keeps the two from drifting.
//
// layerId is a bare z.string() here, NOT L.LayerIdSchema. That schema refines against the loaded layer components,
// so it would drop any event referencing a layer since retired from them -- history shouldn't vanish from the feed
// because a layer was removed. It also throws outright (escaping safeParse) when layer data isn't loaded, which is
// a bad failure mode for a boundary whose whole contract is not to throw. All 223 distinct layerIds currently in
// prod pass it anyway, so validating here would buy nothing for that risk.

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
	z.object({ ...BaseSchema.shape, type: z.literal(type), ...shape })

const MapSetSourceSchema = z.discriminatedUnion('type', [
	...ActionSourceSchema.options,
	z.object({ type: z.literal('layer-queue'), itemId: z.string() }),
])

export const MapSetSchema = event('MAP_SET', { layerId: z.string(), source: MapSetSourceSchema.optional() })
export const NewGameSchema = event('NEW_GAME', {
	source: z.enum(['slm-started', 'rcon-reconnected', 'server-roll', 'new-game-detected']),
	layerId: z.string(),
	state: SM.UniqueTeamsSchema.optional(),
})
export const ResetSchema = event('RESET', {
	source: z.enum(['slm-started', 'rcon-reconnected', 'server-roll']),
	state: SM.UniqueTeamsSchema,
})
export const RconConnectedSchema = event('RCON_CONNECTED', { reconnected: z.boolean() })
export const RconDisconnectedSchema = event('RCON_DISCONNECTED', {})
export const RoundEndedSchema = event('ROUND_ENDED', {
	outcome: MH.MatchOutcomeSchema,
	action: z.discriminatedUnion('type', [
		z.object({ type: z.literal('AdminChangeLayer'), layerId: z.string(), source: ActionSourceSchema }),
		z.object({ type: z.literal('AdminEndMatch'), source: ActionSourceSchema }),
	]).optional(),
})
export const PlayerConnectedSchema = event('PLAYER_CONNECTED', { player: SM.PlayerSchema })
export const PlayerReconciledSchema = event('PLAYER_RECONCILED', { player: SM.PlayerSchema })
export const PlayerDisconnectedSchema = event('PLAYER_DISCONNECTED', { player: SM.PlayerIdSchema })
export const SquadCreatedSchema = event('SQUAD_CREATED', { squad: SM.UniqueSquadSchema, synthesized: z.literal(true).optional() })
export const ChatMessageSchema = event('CHAT_MESSAGE', {
	message: z.string(),
	channel: SM.ChatChannelSchema,
	player: SM.PlayerIdSchema,
})
export const AdminBroadcastSchema = event('ADMIN_BROADCAST', {
	message: z.string(),
	from: z.union([z.literal('RCON'), z.literal('unknown'), SM.PlayerIds.Schema]).optional(),
	source: SM.LogEvents.ActionSourceSchema.optional(),
})
export const PossessedAdminCameraSchema = event('POSSESSED_ADMIN_CAMERA', { player: SM.PlayerIdSchema })
export const UnpossessedAdminCameraSchema = event('UNPOSSESSED_ADMIN_CAMERA', { player: SM.PlayerIdSchema })
export const PlayerKickedSchema = event('PLAYER_KICKED', {
	reason: z.string().optional(),
	source: ActionSourceSchema.optional(),
	player: SM.PlayerIdSchema,
})
export const PlayerBannedSchema = event('PLAYER_BANNED', { interval: z.string(), player: SM.PlayerIdSchema })
export const PlayerWarnedSchema = event('PLAYER_WARNED', {
	reason: z.string(),
	source: ActionSourceSchema.optional(),
	player: SM.PlayerIdSchema,
})
const PlayerWoundedOrDiedVariantSchema = z.enum(['normal', 'suicide', 'teamkill'])
const woundedOrDiedShape = {
	damage: z.number(),
	weapon: z.string().nullable(),
	variant: PlayerWoundedOrDiedVariantSchema,
	victim: SM.PlayerIdSchema,
	attacker: SM.PlayerIdSchema,
}
export const PlayerDiedSchema = event('PLAYER_DIED', woundedOrDiedShape)
export const PlayerWoundedSchema = event('PLAYER_WOUNDED', woundedOrDiedShape)
export const PlayerDetailsChangedSchema = event('PLAYER_DETAILS_CHANGED', {
	details: SM.PlayerSchema.pick({ role: true, isAdmin: true }),
	newUsername: z.string().optional(),
	player: SM.PlayerIdSchema,
})
export const PlayerChangedTeamSchema = event('PLAYER_CHANGED_TEAM', {
	newTeamId: SM.TeamIdSchema.nullable(),
	source: ActionSourceSchema.optional(),
	player: SM.PlayerIdSchema,
})
export const PlayerLeftSquadSchema = event('PLAYER_LEFT_SQUAD', {
	uniqueId: z.number(),
	source: ActionSourceSchema.optional(),
	player: SM.PlayerIdSchema,
})
export const SquadDisbandedSchema = event('SQUAD_DISBANDED', { uniqueId: z.number(), source: ActionSourceSchema.optional() })
export const SquadDetailsChangedSchema = event('SQUAD_DETAILS_CHANGED', {
	uniqueId: z.number(),
	details: z.object({ locked: z.boolean().optional() }),
})
export const SquadRenamedSchema = event('SQUAD_RENAMED', {
	uniqueId: z.number(),
	oldSquadName: z.string(),
	newSquadName: z.string(),
	source: ActionSourceSchema.optional(),
})
export const PlayerJoinedSquadSchema = event('PLAYER_JOINED_SQUAD', { uniqueId: z.number(), player: SM.PlayerIdSchema })
export const PlayerPromotedToLeaderSchema = event('PLAYER_PROMOTED_TO_LEADER', { uniqueId: z.number(), player: SM.PlayerIdSchema })
export const TeamsPolledUpdateSchema = event('TEAMS_POLLED_UPDATE', {})

export const EventSchema = z.discriminatedUnion('type', [
	MapSetSchema,
	NewGameSchema,
	ResetSchema,
	RconConnectedSchema,
	RconDisconnectedSchema,
	RoundEndedSchema,
	PlayerConnectedSchema,
	PlayerReconciledSchema,
	PlayerDisconnectedSchema,
	SquadCreatedSchema,
	ChatMessageSchema,
	AdminBroadcastSchema,
	PossessedAdminCameraSchema,
	UnpossessedAdminCameraSchema,
	PlayerKickedSchema,
	PlayerBannedSchema,
	PlayerWarnedSchema,
	PlayerDiedSchema,
	PlayerWoundedSchema,
	PlayerDetailsChangedSchema,
	PlayerChangedTeamSchema,
	PlayerLeftSquadSchema,
	SquadDisbandedSchema,
	SquadDetailsChangedSchema,
	SquadRenamedSchema,
	PlayerJoinedSquadSchema,
	PlayerPromotedToLeaderSchema,
	TeamsPolledUpdateSchema,
])

// The schemas above and the `Event` union have to describe the same shape, but neither can be derived from the
// other (the types are generic over P; zod can't be). These two assertions are what enforce that: add a field to a
// type without adding it to its schema (or vice versa) and one of them stops compiling. Type-level only, no runtime.
type Assignable<A extends B, B> = A
type _SchemaSatisfiesType = Assignable<z.infer<typeof EventSchema>, Event>
type _TypeSatisfiesSchema = Assignable<Event, z.infer<typeof EventSchema>>

export const EVENT_META = {
	MAP_SET: MAP_SET_META,
	NEW_GAME: NEW_GAME_META,
	RESET: RESET_META,
	RCON_CONNECTED: RCON_CONNECTED_META,
	RCON_DISCONNECTED: RCON_DISCONNECTED_META,
	ROUND_ENDED: ROUND_ENDED_META,
	PLAYER_CONNECTED: PLAYER_CONNECTED_META,
	PLAYER_RECONCILED: PLAYER_RECONCILED_META,
	PLAYER_DISCONNECTED: PLAYER_DISCONNECTED_META,
	SQUAD_CREATED: SQUAD_CREATED_META,
	CHAT_MESSAGE: CHAT_MESSAGE_META,
	ADMIN_BROADCAST: ADMIN_BROADCAST_META,
	PLAYER_DETAILS_CHANGED: PLAYER_DETAILS_CHANGED_META,
	PLAYER_CHANGED_TEAM: PLAYER_CHANGED_TEAM_META,
	PLAYER_LEFT_SQUAD: PLAYER_LEFT_SQUAD_META,
	SQUAD_DISBANDED: SQUAD_DISBANDED_META,
	SQUAD_DETAILS_CHANGED: SQUAD_DETAILS_CHANGED_META,
	SQUAD_RENAMED: SQUAD_RENAMED_META,
	PLAYER_JOINED_SQUAD: PLAYER_JOINED_SQUAD_META,
	PLAYER_PROMOTED_TO_LEADER: PLAYER_PROMOTED_TO_LEADER_META,
	PLAYER_KICKED: PLAYER_KICKED_META,
	POSSESSED_ADMIN_CAMERA: POSSESSED_ADMIN_CAMERA_META,
	UNPOSSESSED_ADMIN_CAMERA: UNPOSSESSED_ADMIN_CAMERA_META,
	PLAYER_BANNED: PLAYER_BANNED_META,
	PLAYER_WARNED: PLAYER_WARNED_META,
	PLAYER_DIED: PLAYER_DIED_META,
	PLAYER_WOUNDED: PLAYER_WOUNDED_META,
	TEAMS_POLLED_UPDATE: TEAMS_POLLED_UPDATE_META,
} satisfies Record<Event['type'], EventMeta>

// Reconstructs an event from a row and validates the payload blob against its schema. Returns null (rather than
// throwing) for rows that don't parse, mirroring AppEvents.fromRow: the table is append-only and accumulates
// old-shaped rows across schema changes, and one bad row shouldn't break a whole match's feed. Callers filter nulls.
//
// Note the stakes differ from the app-event audit log: server events are replayed to rebuild match state, so a
// dropped RESET/PLAYER_CONNECTED silently skews a roster rather than just hiding a line. That's the argument for
// keeping these schemas permissive about fields the data never guaranteed (see `adminGroups`) instead of tightening
// them and dropping history. Anything dropped here is logged by the callers.
export function fromEventRow(row: SchemaModels.ServerEvent): Event | null {
	let payload: unknown
	try {
		payload = superjson.deserialize(row.data as any, { inPlace: true })
	} catch {
		return null
	}
	const candidate = {
		...(payload as object),
		id: row.id,
		type: row.type,
		time: row.time.getTime(),
		matchId: row.matchId,
	}
	const parsed = EventSchema.safeParse(candidate)
	return parsed.success ? parsed.data as Event : null
}

// The batch counterpart to fromEventRow, for the usual case of reading a match's events. Drops are always logged
// with the offending row ids: an unparseable row here means replayed state silently disagrees with what actually
// happened, which is worth a look even though it can't be allowed to break the read.
export function fromEventRows(ctx: CS.Log, rows: SchemaModels.ServerEvent[]): Event[] {
	const events: Event[] = []
	const dropped: number[] = []
	for (const row of rows) {
		const event = fromEventRow(row)
		if (event) events.push(event)
		else dropped.push(row.id)
	}
	if (dropped.length > 0) {
		ctx.log.warn({ droppedEventIds: dropped }, 'dropped %d unparseable server-event row(s)', dropped.length)
	}
	return events
}

export function* iterAssocPlayers(event: Event<SM.PlayerId | SM.Player>) {
	const meta = EVENT_META[event.type]
	for (const playerMeta of meta.players) {
		let values: (SM.Player | SM.PlayerId | undefined | null)[]
		if (playerMeta.path) {
			values = Obj.queryPath<SM.Player | SM.PlayerId>(playerMeta.path, event)
		} else {
			// @ts-expect-error idgaf
			values = [event[playerMeta.assocType]]
		}

		for (const value of values) {
			if (!value) continue
			yield [value, playerMeta.assocType] as const
		}
	}
}

export function* iterAssocPlayerIds(event: Event<SM.Player | SM.PlayerId>) {
	for (const [player, assocType] of iterAssocPlayers(event)) {
		if (typeof player === 'object') {
			yield [SM.PlayerIds.getPlayerId(player.ids), assocType] as const
		} else {
			yield [player, assocType] as const
		}
	}
}

// ctx is null on display-only paths (client selectors) that have no logger; persistence paths must pass one so a
// dropped squad object is never silent (its squads row would never be written, and every later event referencing
// its uniqueId would fail its FK).
export function* iterAssocUniqueSquads(ctx: CS.Log | null, event: Event): Generator<SM.UniqueSquad | number> {
	const meta = EVENT_META[event.type]
	for (const path of meta.squads) {
		const results = Obj.queryPath<unknown>(path, event)
		for (const result of results) {
			if (typeof result === 'number') {
				yield result
				continue
			}
			const parseRes = SM.UniqueSquadSchema.safeParse(result)
			if (!parseRes.success) {
				ctx?.log.error(
					{ err: parseRes.error, value: result },
					'iterAssocUniqueSquads: dropping squad that failed UniqueSquadSchema parse (event %d %s)',
					event.id,
					event.type,
				)
				continue
			}
			yield parseRes.data
		}
	}
}

export function* iterAssocSquadUniqueIds(ctx: CS.Log | null, event: Event): Generator<number> {
	for (const squad of iterAssocUniqueSquads(ctx, event)) {
		if (typeof squad === 'object') {
			yield squad.uniqueId
		} else {
			yield squad
		}
	}
}
