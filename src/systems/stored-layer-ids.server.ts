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
import * as SETTINGS from '@/models/settings.models'
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
// It only touches history, which is never edited in place: match history, the app-event association index, and the
// server and app events that carry layer ids. The saved queue, rotations and filters are left to rewrite themselves on
// their next save, because a write here could land between an editor's read and write and undo their edit. Archived
// matches stay as they were packed; their reads take the older formats too.

const module = initModule('stored-layer-ids')
let log!: CS.Logger

// after match layer reconciliation has had its turn at the same rows
const BOOT_SETTLE_DELAY = ZodUtils.parseHumanTime('3m')
const CANONICALIZED_HASH_KEY = 'storedLayerIds.canonicalizedArtifactHash'
const UPDATE_BATCH = 250

// the server event types whose payloads hold a layer id
const LAYER_EVENT_TYPES = ['MAP_SET', 'NEW_GAME', 'ROUND_ENDED'] as const

export function setup() {
	log = module.getLogger()
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

// the canonical text for stored text, or undefined when it already is canonical or no format reads it
function canonicalFor(text: string): string | undefined {
	const id = L.fromStoredLayerText(text)
	if (id === undefined) return undefined
	const canonical = L.toLayerText(id)
	return canonical === text ? undefined : canonical
}

// Keyed on the layer data hash: a layer data that adds a layer or an abbreviation can make more older ids readable, and
// a pass over the same data a second time finds nothing.
export const canonicalizeStoredLayerIds = Instr.spanOp('canonicalizeStoredLayerIds', { module }, async (ctx: C.Db & CS.AbortSignal) => {
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
	if (Object.values(counts).some((n) => n > 0)) log.info('rewrote stored layer ids as canonical text: %o', counts)
	return counts
})

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
	const rows = await ctx
		.db()
		.select({ id: Schema.serverEvents.id, type: Schema.serverEvents.type, data: Schema.serverEvents.data })
		.from(Schema.serverEvents)
		.where(E.inArray(Schema.serverEvents.type, [...LAYER_EVENT_TYPES]))
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
	return writeRows(ctx, Schema.serverEvents, Schema.serverEvents.id, rewrites)
}

async function rewriteAppEvents(ctx: C.Db & CS.AbortSignal) {
	// a payload holding a layer id names it in a field spelled with layerId, or lists vote choices
	const rows = await ctx
		.db()
		.select()
		.from(Schema.appEvents)
		.where(E.sql`instr(${Schema.appEvents.data}, 'layerId') > 0 OR instr(${Schema.appEvents.data}, 'choices') > 0`)
	const rewrites: { id: string; data: unknown }[] = []
	for (const row of rows) {
		const event = AppEvents.fromRow(row)
		// a row that does not parse is left exactly as it is
		if (!event) continue
		const data = AppEvents.toRow(event, SETTINGS.redactSettingValue).data
		if (JSON.stringify(data) !== JSON.stringify(row.data)) rewrites.push({ id: row.id, data })
	}
	return writeRows(ctx, Schema.appEvents, Schema.appEvents.id, rewrites)
}

async function writeRows<Id extends string | number>(
	ctx: C.Db & CS.AbortSignal,
	table: typeof Schema.serverEvents | typeof Schema.appEvents,
	idColumn: typeof Schema.serverEvents.id | typeof Schema.appEvents.id,
	rewrites: { id: Id; data: unknown }[],
) {
	let changed = 0
	for (const batch of Arr.paged(rewrites, UPDATE_BATCH)) {
		ctx.signal.throwIfAborted()
		await DB.runTransaction(ctx, async (ctx) => {
			for (const { id, data } of batch) {
				const res = await ctx
					.db()
					.update(table)
					.set({ data: data as any })
					.where(E.eq(idColumn, id as any))
				changed += res.changes
			}
		})
		await Timers.setImmediate(undefined, { signal: ctx.signal })
	}
	return changed
}
