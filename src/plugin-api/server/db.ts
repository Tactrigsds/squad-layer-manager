/**
 * Statements and transactions, run synchronously on the connection a plugin's ctx carries (`ctx.db`). A plugin calls
 * `forModule(ctx.module)` once each time it activates, and defines its statements from what that returns. Statements
 * are never awaited, and a transaction callback may not await.
 */
import type { OtelModule } from '@/lib/otel'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Sql from '@/server/sql'

export { afterCommit, all, get, run } from '@/server/db'
export type { Changes, Checked, RunResult, Spent, TxResult } from '@/server/db'
export type { Db, Tx } from '@/server/context'

/** Runs `cb` in a transaction, or in a savepoint inside one. An `err:` result rolls back. */
export const transaction: <Ctx extends C.Db, R extends DB.TxResult | void>(
	ctx: Ctx,
	opts: { dryRun?: boolean },
	cb: (ctx: Ctx & C.Tx) => R,
) => DB.Spent<R> = DB.transaction

/** The statement builders, definitions and parameters for the plugin's own module. */
export function forModule(module: OtelModule) {
	return Sql.forModule(module, { replace: true })
}
