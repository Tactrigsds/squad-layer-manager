import * as Schema from '$root/drizzle/schema'
import { sleep } from '@/lib/async'
import * as CS from '@/models/context-shared'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { eq, lt, sql } from 'drizzle-orm'
import superjson from 'superjson'

const module = initModule('persistedCache')
let log!: ReturnType<typeof module.getLogger>

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export function setup() {
	log = module.getLogger()
	void runCleanupLoop()
}

async function runCleanupLoop() {
	while (true) {
		await sleep(CLEANUP_INTERVAL_MS)
		await module.tracer.startActiveSpan('persistedCache:cleanup', async (span) => {
			try {
				const result = await deleteExpiredRows()
				log.debug('Deleted %d expired persistedCache rows', result[0].affectedRows)
			} catch (err) {
				log.warn({ err }, 'Failed to clean up expired persistedCache rows')
			} finally {
				span.end()
			}
		})
	}
}

async function deleteExpiredRows() {
	const ctx = DB.addPooledDb(CS.init())
	// A row is expired when updatedAt is older than the longest possible TTL we'd store.
	// We store the per-entry expiresAt inside the JSON, so the row itself can be removed
	// once it hasn't been refreshed for longer than that TTL. We use updatedAt < NOW() as
	// the signal: rows are upserted on every persist cycle, so a row that hasn't been
	// touched in STALE_ROW_AGE_MS was never re-written (i.e. all its entries expired and
	// the caller stopped persisting it).
	return ctx.db()
		.delete(Schema.persistedCache)
		.where(lt(Schema.persistedCache.updatedAt, new Date(Date.now() - STALE_ROW_AGE_MS)))
}

/** How long a row can go without being re-written before we consider it fully stale. */
const STALE_ROW_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

export async function load<T>(key: string): Promise<T | null> {
	const ctx = DB.addPooledDb(CS.init())
	const rows = await ctx.db()
		.select()
		.from(Schema.persistedCache)
		.where(eq(Schema.persistedCache.key, key))
	if (rows.length === 0) return null
	return superjson.deserialize(rows[0].value as ReturnType<typeof superjson.serialize>, { inPlace: true })
}

export async function save<T>(key: string, value: T): Promise<void> {
	const ctx = DB.addPooledDb(CS.init())
	const serialized = superjson.serialize(value)
	await ctx.db()
		.insert(Schema.persistedCache)
		.values({ key, value: serialized })
		.onDuplicateKeyUpdate({ set: { value: sql`VALUES(value)`, updatedAt: sql`NOW()` } })
}
