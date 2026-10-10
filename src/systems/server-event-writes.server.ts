// Writes a server event and the rows that hang off it. Every statement is prepared once per db handle, because
// building and preparing a drizzle query costs more than running it, and ingest runs these once per event.
// Everything here is synchronous, so a caller can batch many events inside one transaction without yielding.
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
import type * as DB from '@/server/db'

const ph = sql.placeholder

// index entries before their blueprint names have been resolved to damageSources rows
type Interned = { damageSource: string | null; target: string | null }
type PendingIndexRow = Omit<SchemaModels.NewPlayerEventIndexEntry, 'damageSourceId' | 'targetId'> & Interned
type PendingEventIndexRow = Omit<SchemaModels.NewServerEventIndexEntry, 'damageSourceId' | 'targetId'> & Interned

// the rows that hang off an event, and so can only be built once the insert has allocated its id
type EventAssociationRows = {
	eventIndexRow: PendingEventIndexRow
	playerRows: SchemaModels.NewPlayer[]
	playerIndexRows: PendingIndexRow[]
	squadRows: SchemaModels.NewSquad[]
	squadAssociationRows: SchemaModels.NewSquadEventAssociation[]
	chatSearchRow?: { message: string; serverEventId: number; playerId: string; matchId: number; serverId: string; time: number }
}

function buildEventRow(event: SE.NewEvent) {
	const persisted = Obj.omit(event, ['type', 'time', 'matchId'])
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
		// the event model calls this `weapon` because the log line does; see the damageSourceId comment in
		// the schema for why the projection does not
		damageSource: 'weapon' in event ? event.weapon : null,
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

	const squadRows: SchemaModels.NewSquad[] = []
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

	return { eventIndexRow, playerRows, playerIndexRows, squadRows, squadAssociationRows, chatSearchRow }
}

function prepareStatements(db: DB.Db) {
	return {
		insertEvent: db
			.insert(Schema.serverEvents)
			.values({ type: ph('type'), time: ph('time'), matchId: ph('matchId'), appEventId: ph('appEventId'), data: ph('data') })
			.returning({ id: Schema.serverEvents.id })
			.prepare(),
		insertEventIndex: db
			.insert(Schema.serverEventIndex)
			.values({
				serverEventId: ph('serverEventId'),
				time: ph('time'),
				matchId: ph('matchId'),
				serverId: ph('serverId'),
				type: ph('type'),
				damageSourceId: ph('damageSourceId'),
				variant: ph('variant'),
				channel: ph('channel'),
				targetId: ph('targetId'),
				targetType: ph('targetType'),
			})
			.onConflictDoNothing({ target: Schema.serverEventIndex.serverEventId })
			.prepare(),
		insertDamageSource: db
			.insert(Schema.damageSources)
			.values({ name: ph('name') })
			.onConflictDoNothing({ target: Schema.damageSources.name })
			.prepare(),
		selectDamageSourceId: db
			.select({ id: Schema.damageSources.id })
			.from(Schema.damageSources)
			.where(E.eq(Schema.damageSources.name, ph('name')))
			.prepare(),
		upsertPlayer: db
			.insert(Schema.players)
			.values({
				eosId: ph('eosId'),
				// wrapped in sql so the placeholder skips the column's encoder, which can't take a null
				steamId: sql`${ph('steamId')}`,
				username: ph('username'),
				usernameNoTag: ph('usernameNoTag'),
				epicId: ph('epicId'),
				createdAt: ph('now'),
				modifiedAt: ph('now'),
			})
			.onConflictDoUpdate({
				target: Schema.players.eosId,
				set: {
					steamId: sql`excluded.steamId`,
					// a join log only knows the tagless name, and reports it as the username too. Keep the stored
					// tagged username while it still ends in that name.
					username: sql`CASE WHEN excluded.username = excluded.usernameNoTag AND substr(${Schema.players.username}, -length(excluded.username)) = excluded.username THEN ${Schema.players.username} ELSE excluded.username END`,
					// polled players never carry it, so only a join log may set it
					usernameNoTag: sql`coalesce(excluded.usernameNoTag, ${Schema.players.usernameNoTag})`,
					modifiedAt: sql`excluded.modifiedAt`,
				},
			})
			.prepare(),
		selectPlayerExists: db
			.select({ eosId: Schema.players.eosId })
			.from(Schema.players)
			.where(E.eq(Schema.players.eosId, ph('eosId')))
			.prepare(),
		insertPlayerIndex: db
			.insert(Schema.playerEventIndex)
			.values({
				playerId: ph('playerId'),
				time: ph('time'),
				serverEventId: ph('serverEventId'),
				assocType: ph('assocType'),
				matchId: ph('matchId'),
				serverId: ph('serverId'),
				type: ph('type'),
				damageSourceId: ph('damageSourceId'),
				variant: ph('variant'),
				channel: ph('channel'),
				targetId: ph('targetId'),
				targetType: ph('targetType'),
			})
			.onConflictDoNothing({
				target: [
					Schema.playerEventIndex.playerId,
					Schema.playerEventIndex.time,
					Schema.playerEventIndex.serverEventId,
					Schema.playerEventIndex.assocType,
				],
			})
			.prepare(),
		upsertSquad: db
			.insert(Schema.squads)
			.values({
				id: ph('id'),
				ingameSquadId: ph('ingameSquadId'),
				teamId: ph('teamId'),
				name: ph('name'),
				creatorId: ph('creatorId'),
				matchId: ph('matchId'),
				createdAt: ph('now'),
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
			})
			.prepare(),
		// chat text goes into the standalone fts index at insert time, so it survives the compaction that deletes
		// the event it came from
		insertChatSearch: db
			.insert(Schema.Virtual.chatSearch)
			.values({
				message: ph('message'),
				serverEventId: ph('serverEventId'),
				playerId: ph('playerId'),
				matchId: ph('matchId'),
				serverId: ph('serverId'),
				time: ph('time'),
			})
			.prepare(),
		insertSquadAssociation: db
			.insert(Schema.squadEventAssociations)
			.values({ serverEventId: ph('serverEventId'), squadId: ph('squadId'), createdAt: ph('now') })
			.onConflictDoNothing({ target: [Schema.squadEventAssociations.serverEventId, Schema.squadEventAssociations.squadId] })
			.prepare(),
	}
}

type Statements = ReturnType<typeof prepareStatements>
const statementsByDb = new WeakMap<DB.Db, Statements>()
function statementsFor(db: DB.Db) {
	let statements = statementsByDb.get(db)
	if (!statements) {
		statements = prepareStatements(db)
		statementsByDb.set(db, statements)
	}
	return statements
}

// blueprint name -> damageSources.id. Process-wide and never invalidated: the table is append-only and an id
// is never reused, so a name seen once is correct for the life of the process. An install sees a couple of
// thousand distinct names, so this settles quickly and takes the lookup off the per-kill path.
const damageSourceIdCache = new Map<string, number>()

function internDamageSource(statements: Statements, name: string | null, interned: string[]): number | null {
	if (name === null) return null
	let id = damageSourceIdCache.get(name)
	if (id !== undefined) return id
	statements.insertDamageSource.run({ name })
	id = statements.selectDamageSourceId.get({ name })!.id
	damageSourceIdCache.set(name, id)
	interned.push(name)
	return id
}

function insertAssociationRows(ctx: CS.Log, statements: Statements, rows: EventAssociationRows, interned: string[]) {
	const { damageSource, target, ...eventIndexRow } = rows.eventIndexRow
	const damageSourceId = internDamageSource(statements, damageSource, interned)
	const targetId = internDamageSource(statements, target, interned)
	statements.insertEventIndex.run({ ...eventIndexRow, damageSourceId, targetId })

	const now = new Date()
	const insertedEosIds = new Set<string>()
	for (const player of rows.playerRows) {
		statements.upsertPlayer.run({
			eosId: player.eosId,
			steamId: player.steamId === null || player.steamId === undefined ? null : player.steamId.toString(),
			username: player.username,
			usernameNoTag: player.usernameNoTag ?? null,
			epicId: player.epicId ?? null,
			now,
		})
		insertedEosIds.add(player.eosId)
	}
	const playerKnown = (eosId: string) => insertedEosIds.has(eosId) || statements.selectPlayerExists.get({ eosId }) !== undefined

	for (const { damageSource: _damageSource, target: _target, ...row } of rows.playerIndexRows) {
		if (!playerKnown(row.playerId)) {
			ctx.log.error('skipping playerEventIndex entry for unknown player %s (event %d)', row.playerId, row.serverEventId)
			continue
		}
		statements.insertPlayerIndex.run({ ...row, damageSourceId, targetId })
	}

	for (const squad of rows.squadRows) {
		// creatorId references players.eosId, but the creator may have left before we ever persisted them (e.g. a
		// squad snapshotted or synthesized from a poll). Null the reference out rather than failing the whole event.
		let creatorId = squad.creatorId ?? null
		if (creatorId && !playerKnown(creatorId)) {
			ctx.log.warn({ squadId: squad.id, creatorId }, 'squad creator not in players table; inserting with null creatorId')
			creatorId = null
		}
		statements.upsertSquad.run({
			id: squad.id,
			ingameSquadId: squad.ingameSquadId,
			teamId: squad.teamId,
			name: squad.name,
			creatorId,
			matchId: squad.matchId ?? null,
			now,
		})
	}

	if (rows.chatSearchRow) {
		statements.insertChatSearch.run({ ...rows.chatSearchRow, time: new Date(rows.chatSearchRow.time) })
	}

	for (const association of rows.squadAssociationRows) {
		statements.insertSquadAssociation.run({ ...association, now })
	}
}

// Persists one event and the rows that hang off it, returning it with the id the insert allocated. serverEvents.id
// is autoincrement, so the db, not the app, hands out ids and they can't drift from what's on disk. Throws on any
// failed statement; the caller owns the transaction or savepoint that rolls the partial write back.
export function insertEvent(ctx: C.Db & CS.Log, serverId: string, newEvent: SE.NewEvent): SE.Event {
	const statements = statementsFor(ctx.db({ redactParams: true }))
	const interned: string[] = []
	try {
		const { id } = statements.insertEvent.get(buildEventRow(newEvent))!
		const event = { ...newEvent, id } as SE.Event
		insertAssociationRows(ctx, statements, buildAssociationRows(ctx, serverId, event), interned)
		return event
	} catch (err) {
		// the rollback takes the damageSources rows this event added with it
		for (const name of interned) damageSourceIdCache.delete(name)
		throw err
	}
}
