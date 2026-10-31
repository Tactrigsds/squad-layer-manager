// Writes a server event and the rows that hang off it. Ingest runs these once per event, inside its own transaction.
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import superjson from 'superjson'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as Obj from '@/lib/object-utils'
import type * as CS from '@/models/context-shared.models'
import * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'

const module = initModule('server-event-writes')
const SQL = Sql.forModule(module)

// index entries before their blueprint names have been resolved to damageSources rows
type Interned = { damageSource: string | null; target: string | null }
type PendingIndexRow = Omit<SchemaModels.PlayerEventIndexEntry, 'damageSourceId' | 'targetId'> & Interned
type PendingEventIndexRow = Omit<SchemaModels.ServerEventIndexEntry, 'damageSourceId' | 'targetId'> & Interned

// the rows that hang off an event, and so can only be built once the insert has allocated its id
type EventAssociationRows = {
	eventIndexRow: PendingEventIndexRow
	playerRows: SchemaModels.NewPlayer[]
	playerIndexRows: PendingIndexRow[]
	squadRows: Omit<SchemaModels.Squad, 'createdAt'>[]
	squadAssociationRows: SchemaModels.NewSquadEventAssociation[]
	rename?: { eosId: string; username: string }
	chatSearchRow?: { message: string; serverEventId: number; playerId: string; matchId: number; serverId: string; time: number }
}

function buildEventRow(event: SE.NewEvent) {
	const persisted = Obj.omit(SE.withStoredLayerIds(event), ['type', 'time', 'matchId'])
	// queryable projection of source when it links to an app event
	const source = (event as { source?: { type: string; id?: string } }).source
	return {
		type: event.type,
		time: new Date(event.time),
		matchId: event.matchId,
		appEventId: source?.type === 'event' ? source.id! : null,
		data: superjson.serialize(persisted),
	}
}

function buildAssociationRows(ctx: CS.Log, serverId: string, event: SE.Event): EventAssociationRows {
	const target = SE.isTargetedEvent(event) ? SE.targetOf(event) : null
	const eventIndexRow: PendingEventIndexRow = {
		serverEventId: event.id,
		time: new Date(event.time),
		matchId: event.matchId,
		serverId,
		type: event.type,
		damageSource: 'damageSource' in event ? event.damageSource : 'weapon' in event ? event.weapon : null,
		variant: 'variant' in event ? event.variant : null,
		channel: event.type === 'CHAT_MESSAGE' ? event.channel.type : null,
		target: target?.className ?? null,
		targetType: target?.targetType ?? null,
	}
	const playerRows: SchemaModels.NewPlayer[] = []
	const playerIndexRows: PendingIndexRow[] = []
	for (const [player, assocType] of SE.iterAssocPlayers(event)) {
		let playerId: SM.PlayerId
		if (typeof player === 'object') {
			playerRows.push({
				steamId: player.ids.steam ? BigInt(player.ids.steam) : null,
				eosId: player.ids.eos,
				username: player.ids.username,
				usernameNoTag: player.ids.usernameNoTag,
				epicId: player.ids.epic,
			})
			playerId = SM.PlayerIds.getPlayerId(player.ids)
		} else {
			playerId = player
		}
		playerIndexRows.push({
			playerId,
			time: new Date(event.time),
			serverEventId: event.id,
			assocType,
			matchId: event.matchId,
			serverId,
			type: event.type,
			damageSource: eventIndexRow.damageSource,
			variant: eventIndexRow.variant,
			channel: eventIndexRow.channel,
			target: eventIndexRow.target,
			targetType: eventIndexRow.targetType,
		})
	}

	const squadRows: Omit<SchemaModels.Squad, 'createdAt'>[] = []
	const squadAssociationRows: SchemaModels.NewSquadEventAssociation[] = []
	for (const squad of SE.iterAssocUniqueSquads(ctx, event)) {
		let uniqueSquadId: number
		if (typeof squad === 'object') {
			squadRows.push({
				id: squad.uniqueId,
				ingameSquadId: squad.squadId,
				name: squad.squadName,
				creatorId: squad.creator,
				teamId: squad.teamId,
				matchId: event.matchId,
			})
			uniqueSquadId = squad.uniqueId
		} else {
			uniqueSquadId = squad
		}
		squadAssociationRows.push({ squadId: uniqueSquadId, serverEventId: event.id })
	}

	const chatSearchRow =
		event.type === 'CHAT_MESSAGE'
			? {
					message: event.message,
					serverEventId: event.id,
					playerId: event.player,
					matchId: event.matchId,
					serverId,
					time: event.time,
				}
			: undefined

	const rename =
		event.type === 'PLAYER_DETAILS_CHANGED' && event.newUsername ? { eosId: event.player, username: event.newUsername } : undefined

	return { eventIndexRow, playerRows, playerIndexRows, squadRows, squadAssociationRows, rename, chatSearchRow }
}

const eventP = SQL.params({
	type: Schema.serverEvents.type,
	time: Schema.serverEvents.time,
	matchId: Schema.serverEvents.matchId,
	appEventId: Schema.serverEvents.appEventId,
	data: Schema.serverEvents.data,
})
const insertServerEvent = SQL.def(
	'insertServerEvent',
	eventP,
	SQL.insert(Schema.serverEvents)
		.values({ type: eventP.type, time: eventP.time, matchId: eventP.matchId, appEventId: eventP.appEventId, data: eventP.data })
		.returning({ id: Schema.serverEvents.id }),
)

const eventIndexP = SQL.params(E.getTableColumns(Schema.serverEventIndex))
const insertEventIndex = SQL.def(
	'insertEventIndex',
	eventIndexP,
	SQL.insert(Schema.serverEventIndex).values(eventIndexP).onConflictDoNothing({ target: Schema.serverEventIndex.serverEventId }),
)

const damageSourceP = SQL.params({ name: Schema.damageSources.name })
const insertDamageSource = SQL.def(
	'insertDamageSource',
	damageSourceP,
	SQL.insert(Schema.damageSources).values({ name: damageSourceP.name }).onConflictDoNothing({ target: Schema.damageSources.name }),
)
const damageSourceId = SQL.def(
	'damageSourceId',
	damageSourceP,
	SQL.select({ id: Schema.damageSources.id }).from(Schema.damageSources).where(E.eq(Schema.damageSources.name, damageSourceP.name)),
)

const playerP = SQL.params({
	eosId: Schema.players.eosId,
	steamId: Schema.players.steamId,
	username: Schema.players.username,
	usernameNoTag: Schema.players.usernameNoTag,
	epicId: Schema.players.epicId,
	now: Schema.players.createdAt,
})
const upsertPlayer = SQL.def(
	'upsertPlayer',
	playerP,
	SQL.insert(Schema.players)
		.values({
			eosId: playerP.eosId,
			steamId: playerP.steamId,
			username: playerP.username,
			usernameNoTag: playerP.usernameNoTag,
			epicId: playerP.epicId,
			createdAt: playerP.now,
			modifiedAt: playerP.now,
		})
		.onConflictDoUpdate({
			target: Schema.players.eosId,
			set: {
				steamId: sql`excluded.steamId`,
				// a join log only knows the tagless name, and reports it as the username too. Keep the stored
				// tagged username while it still ends in that name.
				username: sql`CASE WHEN excluded.username = excluded.usernameNoTag AND substr(${Schema.players.username}, -length(excluded.username)) = excluded.username THEN ${Schema.players.username} ELSE excluded.username END`,
				// polled players never carry it, so only a join log may set it. A polled rename keeps the stored one
				// only while the new username still ends in it.
				usernameNoTag: sql`CASE WHEN excluded.usernameNoTag IS NOT NULL THEN excluded.usernameNoTag WHEN substr(excluded.username, -length(${Schema.players.usernameNoTag})) = ${Schema.players.usernameNoTag} THEN ${Schema.players.usernameNoTag} END`,
				modifiedAt: sql`excluded.modifiedAt`,
			},
		}),
)

const renameP = SQL.params({ eosId: Schema.players.eosId, username: Schema.players.username, time: Schema.players.modifiedAt })
const renamePlayer = SQL.def(
	'renamePlayer',
	renameP,
	SQL.update(Schema.players)
		.set({
			username: renameP.username,
			// still valid if only the tag changed
			usernameNoTag: sql`CASE WHEN substr(${renameP.username}, -length(${Schema.players.usernameNoTag})) = ${Schema.players.usernameNoTag} THEN ${Schema.players.usernameNoTag} END`,
			modifiedAt: renameP.time,
		})
		.where(E.eq(Schema.players.eosId, renameP.eosId)),
)

// steamId and epicId are unique, but an account's eos id can change under the same one. The newest sighting keeps it.
const releaseSteamIdP = SQL.params({ steamId: Schema.players.steamId, eosId: Schema.players.eosId, now: Schema.players.modifiedAt })
const releaseSteamId = SQL.def(
	'releaseSteamId',
	releaseSteamIdP,
	SQL.update(Schema.players)
		.set({ steamId: SQL.lit(null), modifiedAt: releaseSteamIdP.now })
		.where(E.and(E.eq(Schema.players.steamId, releaseSteamIdP.steamId), E.ne(Schema.players.eosId, releaseSteamIdP.eosId)))
		.returning({ eosId: Schema.players.eosId }),
)
const releaseEpicIdP = SQL.params({ epicId: Schema.players.epicId, eosId: Schema.players.eosId, now: Schema.players.modifiedAt })
const releaseEpicId = SQL.def(
	'releaseEpicId',
	releaseEpicIdP,
	SQL.update(Schema.players)
		.set({ epicId: SQL.lit(null), modifiedAt: releaseEpicIdP.now })
		.where(E.and(E.eq(Schema.players.epicId, releaseEpicIdP.epicId), E.ne(Schema.players.eosId, releaseEpicIdP.eosId)))
		.returning({ eosId: Schema.players.eosId }),
)

const playerExistsP = SQL.params({ eosId: Schema.players.eosId })
const playerExists = SQL.def(
	'playerExists',
	playerExistsP,
	SQL.select({ eosId: Schema.players.eosId }).from(Schema.players).where(E.eq(Schema.players.eosId, playerExistsP.eosId)),
)

const playerIndexP = SQL.params(E.getTableColumns(Schema.playerEventIndex))
const insertPlayerIndex = SQL.def(
	'insertPlayerIndex',
	playerIndexP,
	SQL.insert(Schema.playerEventIndex)
		.values(playerIndexP)
		.onConflictDoNothing({
			target: [
				Schema.playerEventIndex.playerId,
				Schema.playerEventIndex.time,
				Schema.playerEventIndex.serverEventId,
				Schema.playerEventIndex.assocType,
			],
		}),
)

const squadP = SQL.params({
	id: Schema.squads.id,
	ingameSquadId: Schema.squads.ingameSquadId,
	teamId: Schema.squads.teamId,
	name: Schema.squads.name,
	creatorId: Schema.squads.creatorId,
	matchId: Schema.squads.matchId,
	now: Schema.squads.createdAt,
})
const upsertSquad = SQL.def(
	'upsertSquad',
	squadP,
	SQL.insert(Schema.squads)
		.values({
			id: squadP.id,
			ingameSquadId: squadP.ingameSquadId,
			teamId: squadP.teamId,
			name: squadP.name,
			creatorId: squadP.creatorId,
			matchId: squadP.matchId,
			createdAt: squadP.now,
		})
		.onConflictDoUpdate({
			target: Schema.squads.id,
			set: {
				ingameSquadId: sql`excluded.ingameSquadId`,
				teamId: sql`excluded.teamId`,
				name: sql`excluded.name`,
				creatorId: sql`excluded.creatorId`,
				matchId: sql`excluded.matchId`,
			},
		}),
)

// chat text goes into the standalone fts index at insert time, so it survives the compaction that deletes the event it
// came from
const chatSearchP = SQL.params(E.getTableColumns(Schema.Virtual.chatSearch))
const insertChatSearch = SQL.def('insertChatSearch', chatSearchP, SQL.insert(Schema.Virtual.chatSearch).values(chatSearchP))

const squadAssocP = SQL.params({
	serverEventId: Schema.squadEventAssociations.serverEventId,
	squadId: Schema.squadEventAssociations.squadId,
	now: Schema.squadEventAssociations.createdAt,
})
const insertSquadAssociation = SQL.def(
	'insertSquadAssociation',
	squadAssocP,
	SQL.insert(Schema.squadEventAssociations)
		.values({ serverEventId: squadAssocP.serverEventId, squadId: squadAssocP.squadId, createdAt: squadAssocP.now })
		.onConflictDoNothing({ target: [Schema.squadEventAssociations.serverEventId, Schema.squadEventAssociations.squadId] }),
)

// blueprint name -> damageSources.id. Process-wide and never invalidated: the table is append-only and an id
// is never reused, so a name seen once is correct for the life of the process. An install sees a couple of
// thousand distinct names, so this settles quickly and takes the lookup off the per-kill path.
const damageSourceIdCache = new Map<string, number>()

function internDamageSource(ctx: C.Db, name: string | null, interned: string[]): number | null {
	if (name === null) return null
	let id = damageSourceIdCache.get(name)
	if (id !== undefined) return id
	DB.run(ctx, insertDamageSource({ name }))
	id = DB.get(ctx, damageSourceId({ name }))!.id
	damageSourceIdCache.set(name, id)
	interned.push(name)
	return id
}

function insertAssociationRows(ctx: C.Db & CS.Log, rows: EventAssociationRows, interned: string[]) {
	const { damageSource, target, ...eventIndexRow } = rows.eventIndexRow
	const damageSourceId = internDamageSource(ctx, damageSource, interned)
	const targetId = internDamageSource(ctx, target, interned)
	DB.run(ctx, insertEventIndex({ ...eventIndexRow, damageSourceId, targetId }))

	const now = new Date()
	// the event's time rather than now: the username-history triggers stamp a new name with modifiedAt
	const eventTime = eventIndexRow.time
	const insertedEosIds = new Set<string>()
	for (const player of rows.playerRows) {
		const steamId = player.steamId ?? null
		if (steamId !== null) {
			const released = DB.all(ctx, releaseSteamId({ steamId, eosId: player.eosId, now: eventTime }))
			if (released.length > 0) {
				ctx.log.warn({ steamId, from: released.map((r) => r.eosId), to: player.eosId }, 'steam id moved to another eos id')
			}
		}
		if (player.epicId) {
			const released = DB.all(ctx, releaseEpicId({ epicId: player.epicId, eosId: player.eosId, now: eventTime }))
			if (released.length > 0) {
				ctx.log.warn({ epicId: player.epicId, from: released.map((r) => r.eosId), to: player.eosId }, 'epic id moved to another eos id')
			}
		}
		DB.run(
			ctx,
			upsertPlayer({
				eosId: player.eosId,
				steamId,
				username: player.username,
				usernameNoTag: player.usernameNoTag ?? null,
				epicId: player.epicId ?? null,
				now: eventTime,
			}),
		)
		insertedEosIds.add(player.eosId)
	}
	if (rows.rename) DB.run(ctx, renamePlayer({ ...rows.rename, time: eventTime }))
	const playerKnown = (eosId: string) => insertedEosIds.has(eosId) || DB.get(ctx, playerExists({ eosId })) !== undefined

	for (const { damageSource: _damageSource, target: _target, ...row } of rows.playerIndexRows) {
		if (!playerKnown(row.playerId)) {
			ctx.log.error('skipping playerEventIndex entry for unknown player %s (event %d)', row.playerId, row.serverEventId)
			continue
		}
		DB.run(ctx, insertPlayerIndex({ ...row, damageSourceId, targetId }))
	}

	for (const squad of rows.squadRows) {
		// creatorId references players.eosId, but the creator may have left before we ever persisted them (e.g. a
		// squad snapshotted or synthesized from a poll). Null the reference out rather than failing the whole event.
		let creatorId = squad.creatorId ?? null
		if (creatorId && !playerKnown(creatorId)) {
			ctx.log.warn({ squadId: squad.id, creatorId }, 'squad creator not in players table; inserting with null creatorId')
			creatorId = null
		}
		DB.run(
			ctx,
			upsertSquad({
				id: squad.id,
				ingameSquadId: squad.ingameSquadId,
				teamId: squad.teamId,
				name: squad.name,
				creatorId,
				matchId: squad.matchId,
				now,
			}),
		)
	}

	if (rows.chatSearchRow) {
		DB.run(ctx, insertChatSearch({ ...rows.chatSearchRow, time: new Date(rows.chatSearchRow.time) }))
	}

	for (const association of rows.squadAssociationRows) {
		DB.run(ctx, insertSquadAssociation({ ...association, now }))
	}
}

// Persists one event and the rows that hang off it, returning it with the id the insert allocated. serverEvents.id
// is autoincrement, so the db, not the app, hands out ids and they can't drift from what's on disk. Throws on any
// failed statement, in which case none of the event's rows are written.
export function insertEvent(ctx: C.Db & CS.Log, serverId: string, newEvent: SE.NewEvent): SE.Event {
	const interned: string[] = []
	try {
		return DB.transaction(ctx, {}, (ctx) => {
			const { id } = DB.get(ctx, insertServerEvent(buildEventRow(newEvent)))!
			const event = { ...newEvent, id } as SE.Event
			insertAssociationRows(ctx, buildAssociationRows(ctx, serverId, event), interned)
			return { code: 'ok' as const, event }
		}).event
	} catch (err) {
		// the rollback takes the damageSources rows this event added with it
		for (const name of interned) damageSourceIdCache.delete(name)
		throw err
	}
}
