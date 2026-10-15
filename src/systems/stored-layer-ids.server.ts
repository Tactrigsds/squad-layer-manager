import * as E from 'drizzle-orm'
import * as Timers from 'node:timers/promises'
import superjson from 'superjson'

import * as Schema from '$root/drizzle/schema'
import * as Arr from '@/lib/array-utils'
import * as Prom from '@/lib/promise-utils'
import * as ZodUtils from '@/lib/zod-utils'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared.models'
import * as L from '@/models/layer.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as LayerData from '@/systems/layer-data.server'
import * as PersistedCache from '@/systems/persistedCache.server'

// Rewrites layer ids stored in a format older than canonical text (the abbreviated format, and the RAW: form before
// it) into canonical text, while the loaded layer data can still read their abbreviations. Every read already takes
// the older formats, so this is for durability rather than correctness: an abbreviation a later layer data drops would
// leave such an id readable only as the text it was written as.
//
// History (match history, the app-event association index, and the server and app events that carry layer ids) is
// rewritten in the background after boot. The saved queues and rotations can be edited, so they are rewritten during
// boot, before the squad servers load or any request is served, where no edit can be in flight. Filters already store
// canonical text. Archived matches stay as they were packed; their reads take the older formats too.

const module = initModule('stored-layer-ids')
let log!: CS.Logger

// after match layer reconciliation has had its turn at the same rows
const BOOT_SETTLE_DELAY = ZodUtils.parseHumanTime('3m')
const CANONICALIZED_HASH_KEY = 'storedLayerIds.canonicalizedArtifactHash'
const UPDATE_BATCH = 250
const PAGE_SIZE = 500

// the server event types whose payloads hold a layer id
const LAYER_EVENT_TYPES = ['MAP_SET', 'NEW_GAME', 'ROUND_ENDED'] as const

export async function setup() {
	log = module.getLogger()
	await canonicalizeEditableRows(DB.addPooledDb({ ...CS.init(), log }))
	void runAtBoot()
}

async function runAtBoot() {
	const ctx = DB.addPooledDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
	try {
		await Timers.setTimeout(BOOT_SETTLE_DELAY, undefined, { signal: ctx.signal })
		await canonicalizeStoredLayerIds(ctx)
	} catch (err) {
		if (!Prom.isAbortError(err)) log.error(err, 'canonicalizing stored layer ids failed')
	}
}

// The canonical text for stored text, or undefined when it already is canonical, no format reads it, or the canonical
// text would read back as another layer. An old id whose unit the layer data no longer has resolves without that unit,
// and its text without units would read back with the default ones.
function canonicalFor(text: string): string | undefined {
	const id = L.fromStoredLayerText(text)
	if (id === undefined) return undefined
	const canonical = L.toLayerText(id)
	if (canonical === text || L.fromStoredLayerText(canonical) !== id) return undefined
	return canonical
}

// A copy of a stored payload with its layer ids as canonical text, or undefined when none needed rewriting
function canonicalizedPayload(payload: unknown): unknown {
	let changed = false
	const next = AppEvents.mapLayerIdFields(payload, (id) => {
		const canonical = typeof id === 'string' ? canonicalFor(id) : undefined
		if (canonical === undefined) return id
		changed = true
		return canonical
	})
	return changed ? next : undefined
}

// Run during boot, before anything can edit these rows. Few rows, so not gated on the layer data hash.
export const canonicalizeEditableRows = Instr.spanOp('canonicalizeEditableRows', { module }, async (ctx: C.Db & CS.Log) => {
	const counts = {
		savedQueues: await rewriteSuperjsonColumn(ctx, Schema.servers, Schema.servers.id, Schema.servers.layerQueue),
		rotations: await rewriteSuperjsonColumn(ctx, Schema.rotations, Schema.rotations.id, Schema.rotations.items),
	}
	if (Object.values(counts).some((n) => n > 0)) ctx.log.info('rewrote editable layer ids as canonical text: %o', counts)
	return counts
})

async function rewriteSuperjsonColumn(
	ctx: C.Db,
	table: typeof Schema.servers | typeof Schema.rotations,
	idColumn: typeof Schema.servers.id | typeof Schema.rotations.id,
	column: typeof Schema.servers.layerQueue | typeof Schema.rotations.items,
) {
	const rows = (await ctx
		.db()
		.select({ id: idColumn, value: column })
		.from(table as any)) as { id: string; value: unknown }[]
	let changed = 0
	await DB.runTransaction(ctx, async (ctx) => {
		for (const row of rows) {
			let next: unknown
			try {
				next = canonicalizedPayload(superjson.deserialize(row.value as any))
			} catch {
				continue
			}
			if (next === undefined) continue
			const res = await ctx
				.db()
				.update(table)
				.set({ [column.name]: superjson.serialize(next) })
				.where(E.eq(idColumn, row.id as any))
			changed += res.changes
		}
	})
	return changed
}

// Keyed on the layer data hash: a layer data that adds a layer or an abbreviation can make more older ids readable, and
// a pass over the same data a second time finds nothing.
export const canonicalizeStoredLayerIds = Instr.spanOp(
	'canonicalizeStoredLayerIds',
	{ module },
	async (ctx: C.Db & CS.AbortSignal & CS.Log) => {
		const artifactHash = LayerData.hash
		if ((await PersistedCache.load<string>(CANONICALIZED_HASH_KEY)) === artifactHash) return undefined

		const counts = {
			matchHistory: await rewriteDistinctText(ctx, Schema.matchHistory, Schema.matchHistory.layerId),
			associations: await rewriteDistinctText(
				ctx,
				Schema.appEventAssociations,
				Schema.appEventAssociations.value,
				E.eq(Schema.appEventAssociations.dimension, 'layer'),
			),
			serverEvents: await rewriteServerEvents(ctx),
			appEvents: await rewriteAppEvents(ctx),
		}

		await PersistedCache.save(CANONICALIZED_HASH_KEY, artifactHash)
		if (Object.values(counts).some((n) => n > 0)) ctx.log.info('rewrote stored layer ids as canonical text: %o', counts)
		return counts
	},
)

// a text column holding one layer id per row: rewritten by distinct value, since many rows share one
async function rewriteDistinctText(
	ctx: C.Db & CS.AbortSignal,
	table: typeof Schema.matchHistory | typeof Schema.appEventAssociations,
	column: typeof Schema.matchHistory.layerId | typeof Schema.appEventAssociations.value,
	scope?: E.SQL,
) {
	const distinct = await ctx.db().selectDistinct({ text: column }).from(table).where(scope)
	const rewrites = distinct.flatMap(({ text }) => {
		const canonical = canonicalFor(text)
		return canonical ? [{ text, canonical }] : []
	})
	let changed = 0
	for (const batch of Arr.paged(rewrites, UPDATE_BATCH)) {
		ctx.signal.throwIfAborted()
		await DB.runTransaction(ctx, async (ctx) => {
			for (const { text, canonical } of batch) {
				const res = await ctx
					.db()
					.update(table)
					.set({ [column.name]: canonical })
					.where(E.and(E.eq(column, text), scope))
				changed += res.changes
			}
		})
		await Timers.setImmediate(undefined, { signal: ctx.signal })
	}
	return changed
}

async function rewriteServerEvents(ctx: C.Db & CS.AbortSignal) {
	const T = Schema.serverEvents
	let changed = 0
	let after = 0
	for (;;) {
		ctx.signal.throwIfAborted()
		const rows = await ctx
			.db()
			.select({ id: T.id, type: T.type, data: T.data })
			.from(T)
			.where(E.and(E.inArray(T.type, [...LAYER_EVENT_TYPES]), E.gt(T.id, after)))
			.orderBy(T.id)
			.limit(PAGE_SIZE)
		if (rows.length === 0) return changed
		after = rows.at(-1)!.id
		const rewrites: { id: number; data: unknown }[] = []
		for (const row of rows) {
			let payload: Record<string, any>
			try {
				payload = superjson.deserialize(row.data as any)
			} catch {
				continue
			}
			const holder = row.type === 'ROUND_ENDED' ? payload.action : payload
			if (typeof holder?.layerId !== 'string') continue
			const canonical = canonicalFor(holder.layerId)
			if (!canonical) continue
			holder.layerId = canonical
			rewrites.push({ id: row.id, data: superjson.serialize(payload) })
		}
		changed += await writeRows(ctx, T, T.id, rewrites)
	}
}

// Rewrites only the fields that hold layer ids, on the payload as stored. Reading the row through the app event schema
// instead would drop any field the schema no longer knows.
async function rewriteAppEvents(ctx: C.Db & CS.AbortSignal) {
	const T = Schema.appEvents
	let changed = 0
	let after: string | null = null
	for (;;) {
		ctx.signal.throwIfAborted()
		const rows: { id: string; data: unknown }[] = await ctx
			.db()
			.select({ id: T.id, data: T.data })
			.from(T)
			.where(
				E.and(
					after === null ? undefined : E.gt(T.id, after),
					E.sql`(instr(${T.data}, 'layerId') > 0 OR instr(${T.data}, 'LayerId') > 0 OR instr(${T.data}, 'choices') > 0)`,
				),
			)
			.orderBy(T.id)
			.limit(PAGE_SIZE)
		if (rows.length === 0) return changed
		after = rows.at(-1)!.id
		const rewrites: { id: string; data: unknown }[] = []
		for (const row of rows) {
			let payload: unknown
			try {
				payload = superjson.deserialize(row.data as any)
			} catch {
				continue
			}
			const next = canonicalizedPayload(payload)
			if (next !== undefined) rewrites.push({ id: row.id, data: superjson.serialize(next) })
		}
		changed += await writeRows(ctx, T, T.id, rewrites)
	}
}

async function writeRows<Id extends string | number>(
	ctx: C.Db & CS.AbortSignal,
	table: typeof Schema.serverEvents | typeof Schema.appEvents,
	idColumn: typeof Schema.serverEvents.id | typeof Schema.appEvents.id,
	rewrites: { id: Id; data: unknown }[],
) {
	if (rewrites.length === 0) return 0
	let changed = 0
	await DB.runTransaction(ctx, async (ctx) => {
		for (const { id, data } of rewrites) {
			const res = await ctx
				.db()
				.update(table)
				.set({ data: data as any })
				.where(E.eq(idColumn, id as any))
			changed += res.changes
		}
	})
	await Timers.setImmediate(undefined, { signal: ctx.signal })
	return changed
}
