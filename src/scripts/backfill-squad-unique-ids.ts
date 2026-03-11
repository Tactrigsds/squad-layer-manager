/**
 * Backfills uniqueId onto existing squad-related server events.
 *
 * Before this refactor, squad events used `squadId + teamId` to identify squads.
 * Now they use a stable `uniqueId`. This script:
 *   - Assigns uniqueIds to old squad events by processing matches in order
 *   - Updates event data JSON to include `uniqueId` (and removes old `squadId+teamId` keys where replaced)
 *   - Inserts missing rows into `squads` table
 *   - Inserts `squadEventAssociations` rows for squad-related events
 *
 * Safe to re-run: uses onDuplicateKeyUpdate and skips already-migrated events.
 */

import * as Schema from '$root/drizzle/schema'
import * as CS from '@/models/context-shared'
import * as Config from '@/server/config.ts'
import * as DB from '@/server/db'
import * as Env from '@/server/env.ts'
import { baseLogger, ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/systems/cli.server'
import * as E from 'drizzle-orm'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()
await Config.ensureSetup()
await DB.setup()

const log = baseLogger
const ctx = DB.addPooledDb({ ...CS.init(), log })

const SQUAD_EVENT_TYPES = new Set([
	'SQUAD_CREATED',
	'NEW_GAME',
	'RESET',
	'PLAYER_LEFT_SQUAD',
	'SQUAD_DISBANDED',
	'SQUAD_DETAILS_CHANGED',
	'SQUAD_RENAMED',
	'PLAYER_JOINED_SQUAD',
	'PLAYER_PROMOTED_TO_LEADER',
])

const events = await ctx.db()
	.select()
	.from(Schema.serverEvents)
	.where(E.inArray(Schema.serverEvents.type, [...SQUAD_EVENT_TYPES] as any))
	.orderBy(E.asc(Schema.serverEvents.matchId), E.asc(Schema.serverEvents.id))

log.info(`Found ${events.length} squad-related events`)

// Pre-load existing squad IDs to skip associations with missing squads
const existingSquadRows = await ctx.db().select({ id: Schema.squads.id }).from(Schema.squads)
const existingSquadIds = new Set(existingSquadRows.map(r => r.id))
log.info(`Loaded ${existingSquadIds.size} existing squad IDs`)

// Pre-load existing associations: eventId → Set<uniqueId>
const existingAssocs = await ctx.db().select().from(Schema.squadEventAssociations)
const existingAssocMap = new Map<number, Set<number>>()
for (const assoc of existingAssocs) {
	let set = existingAssocMap.get(assoc.serverEventId)
	if (!set) {
		set = new Set()
		existingAssocMap.set(assoc.serverEventId, set)
	}
	set.add(assoc.squadId)
}
log.info(`Loaded ${existingAssocs.length} existing squad associations`)

const [maxSquadRow] = await ctx.db().select({ maxId: E.max(Schema.squads.id) }).from(Schema.squads)
let nextUniqueId = (maxSquadRow?.maxId ?? 0) + 1

// Pre-load valid EOS IDs to validate creatorId before insertion
const playerRows = await ctx.db().select({ eosId: Schema.players.eosId }).from(Schema.players)
const validEosIds = new Set(playerRows.map(p => p.eosId))
log.info(`Loaded ${validEosIds.size} valid player EOS IDs`)

// matchId → "squadId_teamId" → uniqueId
const matchSquadMaps = new Map<number, Map<string, number>>()

function getOrCreateUniqueId(matchId: number, squadId: number, teamId: number): number {
	let map = matchSquadMaps.get(matchId)
	if (!map) {
		map = new Map()
		matchSquadMaps.set(matchId, map)
	}
	const key = `${squadId}_${teamId}`
	const existing = map.get(key)
	if (existing !== undefined) return existing
	const uniqueId = nextUniqueId++
	map.set(key, uniqueId)
	return uniqueId
}

function registerUniqueId(matchId: number, squadId: number, teamId: number, uniqueId: number) {
	let map = matchSquadMaps.get(matchId)
	if (!map) {
		map = new Map()
		matchSquadMaps.set(matchId, map)
	}
	map.set(`${squadId}_${teamId}`, uniqueId)
}

type SquadRow = typeof Schema.squads.$inferInsert
type SquadAssocRow = typeof Schema.squadEventAssociations.$inferInsert

const squadRows: SquadRow[] = []
const squadAssocRows: SquadAssocRow[] = []
const eventUpdates: { id: number; data: unknown }[] = []
const seenSquadIds = new Set<number>()

for (const event of events) {
	const rawData = event.data as any
	// superjson wraps in { json, meta }; fall back to raw if not wrapped
	const data = rawData?.json ?? rawData
	if (!data) continue

	let modified = false

	if (event.type === 'SQUAD_CREATED') {
		const squad = data.squad
		if (!squad) continue

		// Prefer existing association, then event data, then generate
		const existingAssoc = existingAssocMap.get(event.id)
		let uniqueId: number
		if (existingAssoc?.size === 1) {
			uniqueId = [...existingAssoc][0]
			registerUniqueId(event.matchId, squad.squadId, squad.teamId, uniqueId)
		} else if (typeof squad.uniqueId === 'number') {
			uniqueId = squad.uniqueId
			registerUniqueId(event.matchId, squad.squadId, squad.teamId, uniqueId)
		} else {
			uniqueId = getOrCreateUniqueId(event.matchId, squad.squadId, squad.teamId)
		}

		if (typeof squad.uniqueId !== 'number') {
			data.squad = { ...squad, uniqueId }
			modified = true
		}

		if (!seenSquadIds.has(uniqueId)) {
			seenSquadIds.add(uniqueId)
			const creatorId = typeof squad.creator === 'string' && validEosIds.has(squad.creator)
				? squad.creator
				: null
			squadRows.push({
				id: uniqueId,
				ingameSquadId: squad.squadId,
				teamId: squad.teamId,
				name: squad.squadName,
				creatorId,
			})
		}
		squadAssocRows.push({ squadId: uniqueId, serverEventId: event.id })
	} else if (event.type === 'NEW_GAME' || event.type === 'RESET') {
		const squads: any[] = data.state?.squads ?? []
		const existingAssoc = existingAssocMap.get(event.id)
		let anyModified = false

		const updatedSquads = squads.map((squad: any) => {
			// Prefer existing association matching this squad (by ingameSquadId+teamId), then event data, then generate
			let uniqueId: number
			if (typeof squad.uniqueId === 'number') {
				uniqueId = squad.uniqueId
				registerUniqueId(event.matchId, squad.squadId, squad.teamId, uniqueId)
			} else if (existingAssoc) {
				// Can't correlate association to squad position without more info; fall back to generating
				uniqueId = getOrCreateUniqueId(event.matchId, squad.squadId, squad.teamId)
				anyModified = true
			} else {
				uniqueId = getOrCreateUniqueId(event.matchId, squad.squadId, squad.teamId)
				anyModified = true
			}

			if (!seenSquadIds.has(uniqueId)) {
				seenSquadIds.add(uniqueId)
				squadRows.push({
					id: uniqueId,
					ingameSquadId: squad.squadId,
					teamId: squad.teamId,
					name: squad.squadName,
					creatorId: null,
				})
			}
			squadAssocRows.push({ squadId: uniqueId, serverEventId: event.id })

			return typeof squad.uniqueId === 'number' ? squad : { ...squad, uniqueId }
		})

		if (anyModified) {
			data.state = { ...data.state, squads: updatedSquads }
			modified = true
		}
	} else {
		// PLAYER_LEFT_SQUAD, SQUAD_DISBANDED, SQUAD_DETAILS_CHANGED, SQUAD_RENAMED,
		// PLAYER_JOINED_SQUAD, PLAYER_PROMOTED_TO_LEADER — each references exactly one squad
		const existingAssoc = existingAssocMap.get(event.id)
		let uniqueId: number | undefined

		if (existingAssoc?.size === 1) {
			// Use the existing association as the source of truth
			uniqueId = [...existingAssoc][0]
			if (typeof data.uniqueId !== 'number') {
				data.uniqueId = uniqueId
				delete data.squadId
				delete data.teamId
				modified = true
			}
		} else if (typeof data.uniqueId === 'number') {
			uniqueId = data.uniqueId
		} else if (typeof data.squadId === 'number' && typeof data.teamId === 'number') {
			uniqueId = getOrCreateUniqueId(event.matchId, data.squadId, data.teamId)
			data.uniqueId = uniqueId
			delete data.squadId
			delete data.teamId
			modified = true
		}

		if (uniqueId !== undefined) {
			squadAssocRows.push({ squadId: uniqueId, serverEventId: event.id })
		}
	}

	if (modified) {
		const updatedData = rawData?.json !== undefined
			? { ...rawData, json: data }
			: data
		eventUpdates.push({ id: event.id, data: updatedData })
	}
}

log.info(`Inserting/updating ${squadRows.length} squad rows`)
for (let i = 0; i < squadRows.length; i += 500) {
	await ctx.db().insert(Schema.squads).values(squadRows.slice(i, i + 500))
		.onDuplicateKeyUpdate({ set: { id: E.sql`id` } })
}

const validSquadIds = new Set([...existingSquadIds, ...seenSquadIds])
const filteredAssocRows = squadAssocRows.filter(r => validSquadIds.has(r.squadId!))
const skippedAssocs = squadAssocRows.length - filteredAssocRows.length
if (skippedAssocs > 0) log.warn(`Skipping ${skippedAssocs} associations with missing squads`)

log.info(`Inserting ${filteredAssocRows.length} squad associations`)
for (let i = 0; i < filteredAssocRows.length; i += 500) {
	await ctx.db().insert(Schema.squadEventAssociations).values(filteredAssocRows.slice(i, i + 500))
		.onDuplicateKeyUpdate({ set: { squadId: E.sql`squadId` } })
}

log.info(`Updating ${eventUpdates.length} event data blobs`)
for (const update of eventUpdates) {
	await ctx.db().update(Schema.serverEvents).set({ data: update.data }).where(E.eq(Schema.serverEvents.id, update.id))
}

log.info('Done')
