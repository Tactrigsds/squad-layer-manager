# Reading and writing the database

How server code runs statements and transactions. The modules are `src/server/db.ts` (connections, transactions,
executors), `src/server/sql.ts` (statements, parameters, definitions) and `drizzle/columns.ts` (superjson and secret
columns). The schema is `drizzle/schema.ts`. Migrations are described in
[architecture.md, "Data and persistence"](architecture.md#data-and-persistence).

## Contents

- [The rules](#the-rules)
- [Statements and executors](#statements-and-executors)
- [Definitions](#definitions)
- [Parameters](#parameters)
- [Definitions built from arguments](#definitions-built-from-arguments)
- [Row counts](#row-counts)
- [Transactions](#transactions)
- [In-memory state](#in-memory-state)
- [Transactions and mutexes](#transactions-and-mutexes)
- [Other connections](#other-connections)
- [JSON columns](#json-columns)
- [Secrets](#secrets)
- [Statements built per call](#statements-built-per-call)
- [Plugins](#plugins)
- [The checks](#the-checks)

## The rules

- Every statement runs synchronously. Never `await` a statement, a transaction or a function that only runs
  statements.
- Define each statement once, at module level, with `SQL.def`. Build a statement inside a function only where its
  shape depends on input no definition can express, such as the history query compiler, or in code that runs once.
- Run a statement with `DB.all`, `DB.get` or `DB.run`, passing the ctx it runs with.
- Writes that belong together go in one `DB.transaction()`, or in a `DB.txOp`. A transaction callback may not await:
  work that waits, such as an rcon command or a discord call, goes before the transaction or after it.
- An `err:` result rolls the transaction back. Return `{ code: 'ok', ... }` for success.
- Change in-memory state that mirrors a write (caches, subjects, emissions) in `DB.afterCommit`.
- Pass the ctx the transaction hands the callback, never one captured from outside it.

## Statements and executors

A statement is a value, built without a connection, and run by an executor that takes the ctx:

```ts
const SQL = Sql.forModule(module)

const rows = DB.all(ctx, userById({ id }))
const row = DB.get(ctx, userById({ id }))
const { changes } = DB.run(ctx, renameUser({ id, nickname }))
```

- `DB.all` returns every row, `DB.get` the first row or `undefined`, and `DB.run` sqlite's `{ changes, lastInsertRowid }`.
  A write with `.returning()` runs with `DB.all`.
- `ctx.db` is the connection (`C.Db`). `DB.withDb(ctx)` adds the main connection to a ctx that has none.
- A file calls `Sql.forModule(module)` once, with its own module. Its statements are registered as `<module>:<name>`,
  and their run times are kept under that name (the `sql.statement.*` metrics). Each `spanOp` records how many
  statements its op ran and how long they took (`slm.db.statements`, `slm.db.statements_ms`).
- A statement that is awaited, or run with drizzle's own `.all()`, `.get()` or `.run()`, throws in every environment.

## Definitions

A statement with a fixed shape is a definition: declared once, rendered and checked once, and prepared once per
connection. Calling it with its values gives what an executor runs.

```ts
const sessionP = SQL.params({ id: Schema.sessions.id })
const sessionById = SQL.def('sessionById', sessionP, SQL.select().from(Schema.sessions).where(E.eq(Schema.sessions.id, sessionP.id)))

const session = DB.get(ctx, sessionById({ id }))
```

- Every value that changes between calls is a parameter. A value fixed in the statement is wrapped in `SQL.lit(...)`:
  `E.eq(Schema.timeouts.cancelled, SQL.lit(false))`, `set({ endTime: SQL.lit(null) })`. A literal without it is
  refused, since it would be bound once, when the module loads, and never change. A `Date` or object literal is always
  refused: make it a parameter. A number given to `limit()` is allowed as it is.
- A `SQL.lit` must fit the column it meets: its type, an enum column's values, and a not-null column. A literal for a
  JSON, timestamp, bigint or other custom column is refused, since it would skip the column's encoder. A null literal
  in a comparison is refused, since `= null` matches no row: use `E.isNull`.
- A list is one JSON parameter, matched by index: `SQL.inJson(Schema.players.eosId, p.ids)`, with
  `ids: SQL.list(Schema.players.eosId)`. Each element is encoded like the column, so a list of bigints matches a
  `bigintText` column.
- A subquery is built inline, inside the definition.
- A multi-row insert is a loop over a one-row definition inside the transaction. Each row costs about 2 µs.
- A definition is about 2.5 µs per call. The same statement built per call is about 29 µs.

## Parameters

`SQL.params({ ... })` declares a definition's parameters. Each one is a SQL expression, not a value, so `p.id === 'x'`
is a type error.

| Declaration                                        | Meaning                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| a column, such as `Schema.users.discordId`         | encoded like that column, and checked against the column it meets   |
| `SQL.value<T>()`                                   | bound as given; `T` must be a string, number, bigint, bytes or null |
| `SQL.value((v: T) => bindable)`                    | any type, through its own encoder                                   |
| `SQL.value(schema)`, `SQL.column(column, schema)`  | checked by a zod schema in development and test                     |
| `SQL.secret(schema)`, `SQL.secret(column, schema)` | takes a `Secret` and binds its revealed value                       |
| `SQL.list(column)`                                 | a list for `SQL.inJson`, each element encoded like the column       |
| `SQL.count()`                                      | a varying `limit` or `offset`                                       |

A parameter that meets a column takes its type from a column: declare it with one, with `SQL.column` or with
`SQL.secret(column, schema)`. `SQL.value<T>()` is for values that meet no column, such as a full-text search phrase,
since nothing checks `T` against a column. A parameter with an encoder of its own may meet a plain text or integer
column, never one whose encoder changes the value, such as a timestamp.

A zod schema here may only check, never change the value: transforms, pipes, coercions and defaults are refused, and
objects must be `z.strictObject`. A null skips the schema and is stored as SQL NULL.

## Definitions built from arguments

A statement whose shape varies, such as an optional condition or a `set` of only the fields given, takes arguments:

```ts
const timeoutsP = SQL.params({ playerId: Schema.timeouts.playerId, now: Schema.timeouts.expiresAt })
const timeoutsFor = SQL.def(
	'timeoutsFor',
	timeoutsP,
	(activeOnly: boolean) =>
		SQL.select()
			.from(Schema.timeouts)
			.where(
				E.and(
					E.eq(Schema.timeouts.playerId, timeoutsP.playerId),
					activeOnly ? E.gt(Schema.timeouts.expiresAt, timeoutsP.now) : undefined,
				),
			),
	{ domains: [[true, false]] },
)

DB.all(ctx, timeoutsFor(activeOnly)({ playerId, now: activeOnly ? new Date() : undefined }))
```

- Arguments are primitives that change the SQL. An argument that changes only a bound value is refused in development
  and test: make it a parameter.
- Each argument list gets its own prepared statement, kept in an LRU of 64 by default (`max`).
- The values may leave a parameter `undefined` when the statement for those arguments does not use it.
- `domains` lists the values each argument can take, so the statement check builds every argument list. `skip`
  leaves out the lists that cannot be built, such as a partial update with every field off, which drizzle refuses:
  `{ domains: [[true, false], [true, false]], skip: (name, map) => !name && !map }`.
- `key: (...args) => primitives` accepts richer arguments and maps them to a cache key.

## Row counts

```ts
const res = DB.run(ctx, renameFilter({ id, name }), { changes: 1, otherwise: 'err:not-found' })
if (res.code !== 'ok') return res
```

`changes` is an exact count or a range (`{ atLeast, atMost }`). A write that changes more than the upper bound is
undone, in a transaction of its own or a savepoint, so after the executor returns, either the write happened and the
result is `ok`, or it did not.

## Transactions

```ts
const res = DB.transaction(ctx, {}, (ctx) => {
	DB.run(ctx, renameFilter({ id, name }))
	if (taken) return { code: 'err:name-taken' as const }
	return { code: 'ok' as const }
})
```

| The callback                                            | The transaction                                          |
| ------------------------------------------------------- | -------------------------------------------------------- |
| returns `{ code: 'ok', ... }` or nothing                | commits                                                  |
| returns `{ code: 'err:...' }`                           | rolls back                                               |
| returns `{ code: 'err:...', commitDespiteError: true }` | commits, and the caller gets the result without the flag |
| throws                                                  | rolls back                                               |

- A transaction inside another is a savepoint, so a nested error undoes only that scope. `commitDespiteError` binds
  only the scope that returns it.
- `{ dryRun: true }` rolls back whatever the callback returns, for a preview.
- A callback that returns a promise is refused.
- `DB.txOp(name, opts, cb)` declares a transactional server function: `spanOpSync` plus `transaction()`. It is
  callable with a ctx inside a transaction or outside one.
- A result that carries data with a `code` property of its own is returned as `{ code: 'ok', ... }`, so the data
  cannot roll the transaction back by accident.

Every statement checks its ctx against the connection, and throws for a ctx from outside the open transaction, and for
a ctx whose transaction has ended (captured by a timer or an `afterCommit` task). sqlite ends the whole transaction on
some errors (`SQLITE_FULL`). After one, every later statement in that transaction throws, even when the error was
caught, since they would otherwise run in autocommit.

## In-memory state

State that mirrors a write changes only once the write commits:

```ts
DB.run(ctx, updateQueue({ id, layerQueue }))
DB.afterCommit(ctx, () => ctx.layerQueue.update$.next(update))
```

`DB.afterCommit(ctx, task)` runs the task after the outermost commit, or at once when the ctx is in no transaction. A
rolled-back scope drops its tasks. A task that throws is logged, since the write has committed. A task is synchronous:
one that starts async work, such as syncing the queue to the game server, starts it with a `ctx` that is outside the
transaction and owns the promise it creates, through `ctx.deferred` or a `durableSub`.

## Transactions and mutexes

A transaction is synchronous, so it needs no lock of its own: nothing else can run between its statements. Mutexes
still guard async flows that read state, wait on rcon or discord, and then write. Take the mutex with `spanOp`'s
`mutexes` option around the whole flow, and keep each transaction inside it synchronous.

## Other connections

The history query and match tallies workers open their own read-only connections. `DB.connect(driver)` wraps any
better-sqlite3 connection, and the executors run on whichever connection the ctx carries. A worker's statements are
defined in the shared module that both threads import, so they are prepared once per connection.

## JSON columns

A superjson column is `superjsonColumn<T>(name)` (`drizzle/columns.ts`): a superjson envelope on disk, read and written
as `T`, so bigints, Dates and Maps round-trip. Nothing checks the value against `T`. A column whose rows can hold old
shapes is declared `unknown`, and its reader parses the value with the model's schema, as `SS.ServerStateSchema`
parses a `servers` row.

The event tables' `data` columns hold the envelope as JSON (`SuperJSONResult`), and `SE.parseEventRow` and
`AppEvents.parseRow` deserialize it, so one unreadable row is dropped instead of failing the whole read. The other
`json()` columns hold plain JSON.

## Secrets

A secret is a value that grants access: a token, a password, a sealed token. It is a `Secret` (`src/lib/secret.ts`),
which throws when serialized, turned into a string or cloned, and which the logger masks. Call `reveal()` only where
the value leaves: the executor binding a secret parameter, the secret box opening it, an rcon login.

A `secretColumn` (`battlemetricsUserTokens.token`) reads as a `Secret` and takes one. A parameter that meets one must
be declared with `SQL.secret`.

In development and tests, the debug log records each statement with its values, cut short where they are long. A
column whose value grants access but is no `Secret`, such as `sessions.id` or a settings document holding sealed
credentials, is marked with `unlogged()` in drizzle/schema.ts. The log shows a parameter that meets one as
`[redacted]`. A parameter that meets no such column is redacted by declaring it with `SQL.unlogged(spec)`, which takes
a column or another declaration: `SQL.params({ token: SQL.unlogged(SQL.value<string>()) })`.

## Statements built per call

A statement built inside a function renders on every call. The connection's text cache keeps one prepared sqlite
statement per SQL text, so it is prepared once. It is for code that runs once, and for statements no definition can
express, such as the history page's compiled queries. Keep secrets out of one: its development debug log shows the
values as bound, revealed.

## Plugins

A plugin reaches the database through `slm/server/db`, which exports the executors, `transaction`, `afterCommit` and
`Sql.forModule`. A plugin calls `Sql.forModule(ctx.module)` once in its server entry and defines its statements from
it. [writing_plugins.md](writing_plugins.md) describes the author's side.

## The checks

- `SQL.def` checks a definition when its module loads, subqueries included:
   - every placeholder is a declared parameter, and every declared parameter is used
   - each parameter that meets a column is declared with a column of its type, and a list matches a column of its type
   - two columns compared are of one type
   - a secret column takes only a secret parameter
   - every other bound value is a `SQL.lit` that fits its column

   Definitions built from arguments are checked as each argument list is first built, and the statement test builds
   every list their `domains` allow.

- `src/server/statements.test.ts` prepares every definition against the migrated database, and fails on a scan of a
  table or of a whole index that the definition does not declare with `{ scans: ['table'] }`. Declare a scan only where it is meant, such as a sweep
  over the whole table; otherwise add an index. The test also keeps each statement's SQL in
  `src/server/statements.snapshot.txt`, so a change to one shows up in review. Update it with
  `pnpm vitest run src/server/statements.test.ts -u`.
- Lint (`scripts/oxlint-sql-plugin.mjs`) refuses a statement that is awaited, dropped or run directly, a builder kept at
  module level outside `SQL.def`, `reveal()` inside a statement built per call, `sql.raw` with anything but a literal,
  `sql.placeholder`, and `drizzle(...)` outside `db.ts`.
