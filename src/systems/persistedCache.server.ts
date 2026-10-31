import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as Prom from '@/lib/promise-utils'
import * as CS from '@/models/context-shared.models'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'
import * as CleanupSys from '@/systems/cleanup.server'

const module = initModule('persistedCache')
const SQL = Sql.forModule(module)
let log!: ReturnType<typeof module.getLogger>

const cutoffP = SQL.params({ cutoff: Schema.persistedCache.updatedAt })
const deleteRowsUpdatedBefore = SQL.def(
	'deleteRowsUpdatedBefore',
	cutoffP,
	SQL.delete(Schema.persistedCache).where(E.lt(Schema.persistedCache.updatedAt, cutoffP.cutoff)),
)

const keyP = SQL.params({ key: Schema.persistedCache.key })
const rowByKey = SQL.def('rowByKey', keyP, SQL.select().from(Schema.persistedCache).where(E.eq(Schema.persistedCache.key, keyP.key)))

const rowP = SQL.params(E.getTableColumns(Schema.persistedCache))
const upsertRow = SQL.def(
	'upsertRow',
	rowP,
	SQL.insert(Schema.persistedCache)
		.values(rowP)
		.onConflictDoUpdate({ target: Schema.persistedCache.key, set: { value: rowP.value, updatedAt: rowP.updatedAt } }),
)

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export function setup() {
	log = module.getLogger()
	void runCleanupLoop()
}

async function runCleanupLoop() {
	while (!CleanupSys.shutdownSignal.aborted) {
		try {
			await Prom.sleep(CLEANUP_INTERVAL_MS, CleanupSys.shutdownSignal)
		} catch {
			break
		}
		await module.tracer.startActiveSpan('persistedCache:cleanup', async (span) => {
			try {
				const result = deleteExpiredRows()
				log.debug('Deleted %d expired persistedCache rows', result.changes)
			} catch (err) {
				log.warn({ err }, 'Failed to clean up expired persistedCache rows')
			} finally {
				span.end()
			}
		})
	}
}

function deleteExpiredRows() {
	const ctx = DB.withDb(CS.init())
	// A row is expired when updatedAt is older than the longest possible TTL we'd store.
	// We store the per-entry expiresAt inside the JSON, so the row itself can be removed
	// once it hasn't been refreshed for longer than that TTL. We use updatedAt < NOW() as
	// the signal: rows are upserted on every persist cycle, so a row that hasn't been
	// touched in STALE_ROW_AGE_MS was never re-written (i.e. all its entries expired and
	// the caller stopped persisting it).
	return DB.run(ctx, deleteRowsUpdatedBefore({ cutoff: new Date(Date.now() - STALE_ROW_AGE_MS) }))
}

/** How long a row can go without being re-written before we consider it fully stale. */
const STALE_ROW_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

export function load<T>(key: string): T | null {
	const ctx = DB.withDb(CS.init())
	const row = DB.get(ctx, rowByKey({ key }))
	if (!row) return null
	return row.value as T
}

export function save(key: string, value: unknown): void {
	const ctx = DB.withDb(CS.init())
	DB.run(ctx, upsertRow({ key, value, updatedAt: new Date() }))
}
