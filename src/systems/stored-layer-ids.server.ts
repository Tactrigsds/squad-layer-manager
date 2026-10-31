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
import * as Sql from '@/server/sql'
import * as CleanupSys from '@/systems/cleanup.server'
import * as LayerData from '@/systems/layer-data.server'
import * as PersistedCache from '@/systems/persistedCache.server'

// Rewrites layer ids stored in a format older than canonical text (the abbreviated format, and the RAW: form before
// it) into canonical text, while the loaded layer data can still read their abbreviations. Every read already takes
// the older formats, so this is for durability rather than correctness: an abbreviation a later layer data drops would
// leave such an id readable only as the text it was written as.
//
// History (match history, the app-event association index, and the server and app events that carry layer ids) is
// rewritten in the background after boot. The saved queues, layer requests, rotations and filters can be edited, so
// they are rewritten during boot, before the squad servers load or any request is served, where no edit can be in
// flight. Archived matches stay as they were packed; their reads take the older formats too.

const module = initModule('stored-layer-ids')
const SQL = Sql.forModule(module)
let log!: CS.Logger

// after match layer reconciliation has had its turn at the same rows
const BOOT_SETTLE_DELAY = ZodUtils.parseHumanTime('3m')
const CANONICALIZED_HASH_KEY = 'storedLayerIds.canonicalizedArtifactHash'
const UPDATE_BATCH = 250
const PAGE_SIZE = 500

// the server event types whose payloads hold a layer id
const LAYER_EVENT_TYPES = ['MAP_SET', 'NEW_GAME', 'ROUND_ENDED'] as const

export function setup() {
	log = module.getLogger()
	canonicalizeEditableRows(DB.withDb({ ...CS.init(), log }))
	void runAtBoot()
}

async function runAtBoot() {
	const ctx = DB.withDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
	try {
		await Timers.setTimeout(BOOT_SETTLE_DELAY, undefined, { signal: ctx.signal })
		await canonicalizeStoredLayerIds(ctx)
	} catch (err) {
		if (!Prom.isAbortError(err)) log.error(err, 'canonicalizing stored layer ids failed')
	}
}

// The canonical text for stored text, or undefined when it already is canonical, no format reads it, or the canonical
// text would read back as another layer.
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

// A copy of a value holding filter trees with the layer ids their `id` comparisons name as canonical text, or undefined
// when none needed rewriting
function canonicalizedFilterIds(value: unknown): unknown {
	let changed = false
	const canonicalize = (id: unknown) => {
		const canonical = typeof id === 'string' ? canonicalFor(id) : undefined
		if (canonical === undefined) return id
		changed = true
		return canonical
	}
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk)
		if (!v || Object.getPrototypeOf(v) !== Object.prototype) return v
		const node = v as Record<string, any>
		const [subject, arg, ...rest] = Array.isArray(node.args) ? node.args : []
		if (subject?.type === 'column' && subject.column === 'id' && arg) {
			if (arg.type === 'value') return { ...node, args: [subject, { ...arg, value: canonicalize(arg.value) }, ...rest] }
			if (arg.type === 'values') return { ...node, args: [subject, { ...arg, values: arg.values.map(canonicalize) }, ...rest] }
		}
		return Object.fromEntries(Object.entries(node).map(([key, field]) => [key, walk(field)]))
	}
	const next = walk(value)
	return changed ? next : undefined
}

// Run during boot, before anything can edit these rows. Few rows, so not gated on the layer data hash.
export const canonicalizeEditableRows = Instr.spanOpSync('canonicalizeEditableRows', { module }, (ctx: C.Db & CS.Log) => {
	const S = Schema
	const counts = {
		savedQueues: rewriteJsonColumn(ctx, S.servers, S.servers.id, S.servers.layerQueue, canonicalizedPayload),
		backburners: rewriteJsonColumn(ctx, S.servers, S.servers.id, S.servers.backburner, canonicalizedFilterIds),
		rotations: rewriteJsonColumn(ctx, S.rotations, S.rotations.id, S.rotations.items, canonicalizedPayload),
		filters: rewriteJsonColumn(ctx, S.filters, S.filters.id, S.filters.filter, canonicalizedFilterIds),
	}
	if (Object.values(counts).some((n) => n > 0)) ctx.log.info('rewrote editable layer ids as canonical text: %o', counts)
	return counts
})

// the superjson columns decode and encode through their column type, so every column reads and writes the plain value
function rewriteJsonColumn(
	ctx: C.Db,
	table: typeof Schema.servers | typeof Schema.rotations | typeof Schema.filters,
	idColumn: typeof Schema.servers.id | typeof Schema.rotations.id | typeof Schema.filters.id,
	column:
		| typeof Schema.servers.layerQueue
		| typeof Schema.servers.backburner
		| typeof Schema.rotations.items
		| typeof Schema.filters.filter,
	rewrite: (value: unknown) => unknown,
) {
	const rows = DB.all(ctx, SQL.select({ id: idColumn, value: column }).from(table as typeof Schema.servers)) as {
		id: string
		value: unknown
	}[]
	let changed = 0
	DB.transaction(ctx, {}, (ctx) => {
		for (const row of rows) {
			let next: unknown
			try {
				next = rewrite(row.value)
			} catch {
				continue
			}
			if (next === undefined) continue
			const res = DB.run(
				ctx,
				SQL.update(table)
					.set({ [column.name]: next })
					.where(E.eq(idColumn, row.id)),
			)
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
		if (PersistedCache.load<string>(CANONICALIZED_HASH_KEY) === artifactHash) return undefined

		const counts = {
			matchHistory: await rewriteDistinctText(ctx, DB.all(ctx, matchHistoryLayerIds({})), (ctx, r) =>
				DB.run(ctx, renameMatchHistoryLayerId(r)),
			),
			associations: await rewriteDistinctText(ctx, DB.all(ctx, associationLayerIds({})), (ctx, r) =>
				DB.run(ctx, renameAssociationLayerId(r)),
			),
			serverEvents: await rewriteServerEvents(ctx),
			appEvents: await rewriteAppEvents(ctx),
		}

		PersistedCache.save(CANONICALIZED_HASH_KEY, artifactHash)
		if (Object.values(counts).some((n) => n > 0)) ctx.log.info('rewrote stored layer ids as canonical text: %o', counts)
		return counts
	},
)

const matchHistoryLayerIds = SQL.def(
	'matchHistoryLayerIds',
	SQL.params({}),
	SQL.selectDistinct({ text: Schema.matchHistory.layerId }).from(Schema.matchHistory),
	{ scans: ['matchHistory'] },
)
const renameMatchHistoryP = SQL.params({ text: Schema.matchHistory.layerId, canonical: Schema.matchHistory.layerId })
const renameMatchHistoryLayerId = SQL.def(
	'renameMatchHistoryLayerId',
	renameMatchHistoryP,
	SQL.update(Schema.matchHistory)
		.set({ layerId: renameMatchHistoryP.canonical })
		.where(E.eq(Schema.matchHistory.layerId, renameMatchHistoryP.text)),
)
const associationLayerIds = SQL.def(
	'associationLayerIds',
	SQL.params({}),
	SQL.selectDistinct({ text: Schema.appEventAssociations.value })
		.from(Schema.appEventAssociations)
		.where(E.eq(Schema.appEventAssociations.dimension, SQL.lit('layer'))),
)
const renameAssociationP = SQL.params({ text: Schema.appEventAssociations.value, canonical: Schema.appEventAssociations.value })
const renameAssociationLayerId = SQL.def(
	'renameAssociationLayerId',
	renameAssociationP,
	SQL.update(Schema.appEventAssociations)
		.set({ value: renameAssociationP.canonical })
		.where(
			E.and(
				E.eq(Schema.appEventAssociations.value, renameAssociationP.text),
				E.eq(Schema.appEventAssociations.dimension, SQL.lit('layer')),
			),
		),
)

type Rewrite = { text: string; canonical: string }

// a text column holding one layer id per row: rewritten by distinct value, since many rows share one
async function rewriteDistinctText(
	ctx: C.Db & CS.AbortSignal,
	distinct: { text: string }[],
	write: (ctx: C.Db & C.Tx, rewrite: Rewrite) => DB.RunResult,
) {
	const rewrites = distinct.flatMap(({ text }) => {
		const canonical = canonicalFor(text)
		return canonical ? [{ text, canonical }] : []
	})
	let changed = 0
	for (const batch of Arr.paged(rewrites, UPDATE_BATCH)) {
		ctx.signal.throwIfAborted()
		DB.transaction(ctx, {}, (ctx) => {
			for (const rewrite of batch) changed += write(ctx, rewrite).changes
		})
		await Timers.setImmediate(undefined, { signal: ctx.signal })
	}
	return changed
}

const serverEventsPageP = SQL.params({ after: Schema.serverEvents.id })
const layerServerEventsPage = SQL.def(
	'layerServerEventsPage',
	serverEventsPageP,
	SQL.select({ id: Schema.serverEvents.id, type: Schema.serverEvents.type, data: Schema.serverEvents.data })
		.from(Schema.serverEvents)
		.where(
			E.and(
				E.or(...LAYER_EVENT_TYPES.map((type) => E.eq(Schema.serverEvents.type, SQL.lit(type)))),
				E.gt(Schema.serverEvents.id, serverEventsPageP.after),
			),
		)
		.orderBy(Schema.serverEvents.id)
		.limit(PAGE_SIZE),
)
const serverEventDataP = SQL.params({ id: Schema.serverEvents.id, data: Schema.serverEvents.data })
const setServerEventData = SQL.def(
	'setServerEventData',
	serverEventDataP,
	SQL.update(Schema.serverEvents).set({ data: serverEventDataP.data }).where(E.eq(Schema.serverEvents.id, serverEventDataP.id)),
)

// an event table's `data` holds the superjson envelope as JSON, so it is deserialized and serialized here
async function rewriteServerEvents(ctx: C.Db & CS.AbortSignal) {
	let changed = 0
	let after = 0
	for (;;) {
		ctx.signal.throwIfAborted()
		const rows = DB.all(ctx, layerServerEventsPage({ after }))
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
		changed += await writeRows(ctx, rewrites, (ctx, r) => DB.run(ctx, setServerEventData(r)))
	}
}

const appEventsPageP = SQL.params({ after: Schema.appEvents.id })
const layerAppEventsPage = SQL.def(
	'layerAppEventsPage',
	appEventsPageP,
	SQL.select({ id: Schema.appEvents.id, data: Schema.appEvents.data })
		.from(Schema.appEvents)
		.where(
			E.and(
				E.gt(Schema.appEvents.id, appEventsPageP.after),
				E.sql`(instr(${Schema.appEvents.data}, 'layerId') > 0 OR instr(${Schema.appEvents.data}, 'LayerId') > 0 OR instr(${Schema.appEvents.data}, 'choices') > 0)`,
			),
		)
		.orderBy(Schema.appEvents.id)
		.limit(PAGE_SIZE),
)
const appEventDataP = SQL.params({ id: Schema.appEvents.id, data: Schema.appEvents.data })
const setAppEventData = SQL.def(
	'setAppEventData',
	appEventDataP,
	SQL.update(Schema.appEvents).set({ data: appEventDataP.data }).where(E.eq(Schema.appEvents.id, appEventDataP.id)),
)

// Rewrites only the fields that hold layer ids, on the payload as stored. Reading the row through the app event schema
// instead would drop any field the schema no longer knows.
async function rewriteAppEvents(ctx: C.Db & CS.AbortSignal) {
	let changed = 0
	// every id sorts after the empty string
	let after = ''
	for (;;) {
		ctx.signal.throwIfAborted()
		const rows = DB.all(ctx, layerAppEventsPage({ after }))
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
		changed += await writeRows(ctx, rewrites, (ctx, r) => DB.run(ctx, setAppEventData(r)))
	}
}

async function writeRows<R>(ctx: C.Db & CS.AbortSignal, rewrites: R[], write: (ctx: C.Db & C.Tx, rewrite: R) => DB.RunResult) {
	if (rewrites.length === 0) return 0
	let changed = 0
	DB.transaction(ctx, {}, (ctx) => {
		for (const rewrite of rewrites) changed += write(ctx, rewrite).changes
	})
	await Timers.setImmediate(undefined, { signal: ctx.signal })
	return changed
}
