# Architecture and coding style

The shape of SLM and the patterns that recur throughout it. This is orientation, not a specification: where the code
and this document disagree, the code wins. Individual modules document their own quirks in-code.

[CLAUDE.md](../CLAUDE.md) states the rules that this document gives the reasoning for.

## Contents

- [The shape of the thing](#the-shape-of-the-thing)
- [Cross-cutting conventions](#cross-cutting-conventions)
- [Server-side patterns](#server-side-patterns)
- [Client-side patterns](#client-side-patterns)
- [ODSM: optimistic distributed state](#odsm-optimistic-distributed-state)
- [The domain layer](#the-domain-layer)
- [Messages and locales](#messages-and-locales)
- [The layer engine (rust/wasm)](#the-layer-engine-rustwasm)
- [Data and persistence](#data-and-persistence)
- [Observability](#observability)
- [Testing](#testing)

## The shape of the thing

One single-tenant TypeScript process serving a React SPA, talking to one or more game servers over RCON and their
log files. Persistence is a local SQLite database in WAL mode (better-sqlite3 + drizzle), on one connection held for
the life of the process. There is no external datastore.

Two Rust components sit alongside the TypeScript:

- **The query engine**, compiled to wasm and run in both the server and the browser. Squad's layer set is ~730k
  map/gamemode/faction/unit combinations, too many to filter row-by-row in JS at interactive speed and too many to
  page over the wire.
- **The server agent**, an optional binary installed next to a game server. It streams that server's logs to SLM and
  proxies its RCON, so SLM never holds the RCON password and never needs to reach the RCON port. It is not required
  to run SLM. See [configuring.md](configuring.md#server-agent).

The tree, in layering order:

| Directory            | What lives there                                                 |
| -------------------- | ---------------------------------------------------------------- |
| `src/lib`            | Generic utilities with no domain knowledge.                      |
| `src/models`         | Framework-agnostic domain: zod schemas, pure reducers, encoding. |
| `src/systems`        | The feature layer. Suffix says where it runs.                    |
| `src/server`         | Process bootstrap, context types, db, env, oRPC wiring.          |
| `src/frames`         | Client state containers with a lifecycle.                        |
| `src/frame-partials` | Composable slices of client frame state.                         |
| `src/components`     | React components. Presentation, plus a lot of bespoke editors.   |
| `src/routes`         | TanStack Router route definitions.                               |
| `src/emulator`       | A fake Squad server. Backs the test suites and sandbox servers.  |
| `test`               | Integration and e2e suites.                                      |

The layering is `lib` -> `models` -> `systems` -> `components`/`routes`, and it describes **runtime imports only**.
`import type` erases at compile time, so it cannot create a cycle, and the codebase uses upward type imports freely.
An upward `import type` is normal. An upward value import is the thing to look twice at, and the handful that exist
are debts rather than precedent.

### The `.server` / `.client` / `.shared` suffix

Every file in `src/systems` declares which side of the wire it runs on. `*.server.ts` runs in node only and may
import `src/server/*`; `*.client.ts` runs in the browser only; `*.shared.ts` runs in both.

`shared` is load-bearing rather than incidental. `layer-queries.shared.ts` is the single implementation of every
layer query in the app: it executes server-side for RPC callers and inside a browser Web Worker for the layer table
UI, both against the same wasm engine. The client is not calling a thin API over a server-side query layer; it is
running the query layer.

Systems otherwise pair up across the wire (`layer-queue.server.ts` / `layer-queue.client.ts`), sharing types through
`src/models`.

## Cross-cutting conventions

### Namespace imports everywhere

Nontrivial modules are imported as namespaces, with a short abbreviation that is **globally consistent across the
app**. `import * as F from '@/models/filter.models'` means `F` is the filter model in every file that uses it.
Likewise `L` (layer), `LC` (layer-columns), `LQY` (layer-queries), `SM` (squad models), `CS` (context-shared), `C`
(server context), `SLL` (shared-layer-list).

An alias is only worth anything if it is the _only_ one for its module, since the payoff is that a reader who knows
the abbreviations reads any file quickly. The lib vocabulary:

| namespace                        | module                                                        |                                                    |
| -------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `Arr` `Obj` `Str` `Gen`          | `array-utils` `object-utils` `string-utils` `generator-utils` | free functions over a builtin                      |
| `MapUtils` `SetUtils` `ZodUtils` | `map-utils` `set-utils` `zod-utils`                           | no good abbreviation, so none is invented          |
| `Prom`                           | `promise-utils`                                               | promises, abort signals, mutex acquisition         |
| `Rx`                             | `rxjs`                                                        | rxjs itself, plus our own operators under `Rx.Ext` |
| `Zus`                            | `zustand`                                                     | zustand itself, plus our store helpers             |
| `ReactRx`                        | `react-rxjs`                                                  | react-rxjs itself, plus the first-emit guard       |
| `Typo` `ItemMut`                 | `typography` `item-mutations`                                 |                                                    |

Modules exporting a data structure rather than free functions (`lru-map`, `one-to-many-map`) are outside the
convention.

**Libraries we extend are wrapped, not imported.** rxjs, zustand and react-rxjs are each reached through exactly one
module in `src/lib`, which re-exports the package alongside our own additions, so there is no per-file choice
between two spellings of the same thing. Everything else is imported directly, because a barrel that adds nothing is
just indirection.

### Result codes instead of exceptions

The dominant error convention is a returned discriminated union tagged with a `code` field, not a thrown error:

```ts
{ code: 'ok', data: ... }
{ code: 'err:filter-not-found' }
{ code: 'err:permission-denied', ... }
```

Error codes are namespaced by colon (`err:invalid-op:different-user`). Exceptions are reserved for genuine bugs and
for aborts.

Both routes are instrumented, so this is not about telemetry. It is about handling. An error code is part of the
return type, so the compiler forces every caller to acknowledge it, and `assertNever` forces them to widen when a
new code appears. A thrown error is invisible to the signature, and is handled, or not, at whatever distance the
nearest `catch` happens to sit.

### `assertNever` on every union

Every `switch` over a discriminated union ends in `default: assertNever(x)` from `src/lib/type-guards.ts`, so adding
a variant turns into a compile error at every site that must handle it. The domain layer has 30+ discriminated
unions, and this is the main mechanism keeping them honest.

### Schema-first models

The zod schema is declared first and the type derived from it (`export type X = z.infer<typeof XSchema>`), near
universally. House conventions:

- `.prefault(...)` rather than `.default(...)`, so defaults are themselves validated.
- `.describe(...)` / `.meta({description})` are **UI**, not only documentation. The settings page renders a
  schema-driven form from them, and the in-app editors render them as tooltips via the generated JSON schema.
- `z.preprocess` is treated as a hazard and banned outright in `GlobalSettings`.
- No `z.brand()`. Nominal-ish typing is done informally through type aliases.

## Server-side patterns

### Context as duck-typed dependency injection

There is no DI container. A `ctx` object is threaded as the **first argument** to essentially every server function,
and capabilities are expressed as intersection types over a branded base. A function declares the **minimal**
intersection it actually needs:

```ts
async function doThing(ctx: C.Db & USR.Ctx & CS.AbortSignal, ...) { ... }
```

Callers build up context by spreading. A signature becomes a precise, checked statement of what a function touches.
For observables, the same rule applies with the ctx as the first element of the emitted tuple.

**A domain's contexts live in that domain's models file.** `V.Ctx` is the vote context, `MH.Ctx` the match-history
one, reached under the same namespace as the rest of that domain, with the runtime object it carries at
`Ctx.Payload`. Two modules stay general rather than domain-owned: `src/models/context-shared.ts` (`CS`) is the leaf
every context composes on, and `src/server/context.ts` (`C`) holds server infrastructure with no domain models file,
plus the composition root `ManagedServer`.

**Contexts are types, so they erase.** Each therefore has a **def** beside it, following the `XSchema` convention,
giving something to merge, project and check at runtime:

```ts
export type Ctx = CS.Ctx & { vote: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['vote'], { name: 'vote', extends: [CS.ServerIdDef] })
```

The key tuple is checked against the type: a missing, extra or duplicated key is a compile error naming the
offender. `extends` is what keeps composition from reporting false collisions. `CD.select([...])` projects exactly
those keys out of a wider ctx, which is how a handler avoids carrying context it should not.

### spanOp: the unit of server work

Server functions of any significance are wrapped in `spanOp`, so it is worth understanding before reading any of
them:

```ts
export const dispatchOp = C.spanOp('dispatchOp', { module }, async (ctx, op, opts) => { ... })
```

`spanOp` declares "this is one unit of server work". It returns a function with the same signature, so call sites
are unaffected, and gives the unit four things uniformly: it is traced and timed, it logs itself once with a
consistent shape, its outcome is classified (succeeded, threw, or returned an error code), and it can **declare**
mutexes to hold for its duration rather than acquiring them by hand.

That last part makes `spanOp` structural rather than merely observational. `durableSub` is the RxJS counterpart for
long-lived pipelines, with the same treatment plus error recovery.

### ManagedServer: one live game server

`ManagedServer` is a large intersection representing everything about one running Squad server: rcon, vote, layer
queue, match history, teamswaps, settings, cleanup and an abort signal. SLM does not instantiate squad servers, it
connects to and supervises them, so the entity is a server _under management_, which is also the user-facing name.

Four patterns hold it together, and each recurs elsewhere:

- **Cleanup tasks live on the ctx.** Every subsystem's `init*` pushes its own teardown on at the moment it creates
  the thing needing teardown, so nothing maintains a separate destructor that drifts from the setup function. Tasks
  are heterogeneous (a function, a `Subscription`, a mutex, an `AbortController`) and run FILO, with per-task errors
  caught. The same primitive runs at process level for shutdown.
- **Every managed server owns an AbortController**, combined with the caller's signal. The signal stops anything
  watching it; the cleanup array disposes what needs an explicit call.
- **Lifecycle transitions are serialized per server** under one non-reentrant mutex, so the codebase splits each
  operation into a locking entry point and an unlocked `*Locked` internal. Acquiring the lock twice in one call
  stack self-deadlocks, which is the trap when adding a lifecycle operation.
- **Streams resolve the managed server on every tick, not once**, so a crashed and restarted game server heals
  itself instead of leaving every client's subscription silently dead.

### Cancellation, resources and locks

Async functions take cancellation via `ctx.signal` (`CS.AbortSignal`), not a separate parameter. Signals come from
four sources and compose with `anySignal`: the oRPC middleware (per-call), the managed server (per-server), fastify
(per-request), and the process-level shutdown signal.

`AsyncResource` (`src/lib/async-resource.ts`) is a TTL cache for an async value with push-based observation, and the
backbone of every polled thing: admin lists, server info, roster, layer status. It caches the _promise_, so
concurrent callers dedupe onto one fetch, and it keeps a background refetch loop alive only while an observer
exists.

Mutexes are **declared, not acquired**, via the `mutexes` option on `spanOp` and `durableSub`. Underneath,
`src/lib/nodejs-reentrant-mutexes.ts` uses `AsyncLocalStorage` to make re-acquiring a held mutex a no-op rather than
a self-deadlock, and sorts multiple acquisitions into a stable global order so overlapping mutex sets cannot
deadlock. The `IsolatedSubject` family exists because of this: they re-enter the root async context before emitting,
so a subscriber does not inherit the publisher's mutex ownership.

Three parallel buckets defer work until an enclosing critical section really ends, all mutable arrays shared by
reference through ctx spreads:

| Bucket               | Runs after                | Typical use                                                   |
| -------------------- | ------------------------- | ------------------------------------------------------------- |
| `ctx.tx.unlockTasks` | a db transaction commits  | don't broadcast a change a rollback would undo                |
| mutex `releaseTasks` | a mutex set fully unlocks |                                                               |
| `ctx.deferred`       | an ancestor awaits it     | best-effort background work, kept inside the ancestor's scope |

### oRPC over a WebSocket

All client-server communication is oRPC over a **single WebSocket**, not HTTP. The router is a flat object of
per-system subrouters, each built from `getOrpcBase(module)`, which installs exactly one middleware: it wraps the
handler in `spanOp` and narrows the connection-level signal down to the individual call.

The consequence worth internalising: **auth happens once, at the HTTP upgrade**, not per call. The ctx object minted
there lives for the lifetime of the socket and is reused for every RPC over it.

RBAC and db access are deliberately **not** middleware. Handlers call `Rbac.tryDeny*` themselves, returning a denial
_value_ per the result-code convention, and attach a db explicitly. This is more verbose and more explicit; it also
means you cannot tell whether a handler is permission-checked without reading it.

## Client-side patterns

Most of the client's state is neither global nor local. It belongs to "the server dashboard you currently have
open", which is created and destroyed as you navigate. The answer is frames.

### Stores, frames, partials

**A zustand store** is the primitive, used directly for genuinely app-global singletons: selected server, public
settings, presence.

**A frame** is a reference-counted, keyed, lazily-created and torn-down zustand store, managed by a singleton
`FrameManager`. `setup()` runs once per instance and subscribes to async sources directly (oRPC observables, piped
through RxJS), writing results back with `set()`. There is no separate "async state" concept. Instances are keyed by
deep equality, so structurally-equal inputs share one instance, and release is refcounted with a
`FinalizationRegistry` backstop.

```ts
const frameKey = useFrameLifecycle(SquadServerFrame.frame, {
	input: SquadServerFrame.createInput(props.serverId),
})
useFrameTeardownOnUnmount(frameKey)
return <ServerDashboard stores={FRM.toProp(frameKey)} />
```

**A frame-partial** (`src/frame-partials/*.partial.ts`) is not a frame. It is a module exporting a slice type, an
`init*(args)`, and its own `Sel`/`Actions`, which a real frame composes by intersecting the types and calling
`init*` from `setup()`. This is how a large frame stays modular without every slice needing its own FrameManager
entry.

### Zus

`src/lib/zustand.ts` is the client's central abstraction. Its key type unifies a raw zustand store, a frame instance
key, a react-query options object and a react-rxjs `StateObservable`:

```ts
type AnyInput<T> = AnyStore<T> | QuerySource<T> | StateObservable<T>
```

Everything downstream accepts `AnyInput`, so a component neither knows nor cares which of the four it was handed.

`Zus.useStore` is the sanctioned read path in components, and `Zus.getState` is its non-subscribing counterpart
outside render. Both are overloaded the same way: one input returns its state, N inputs plus a trailing selector
calls `selector(...states)`. Merging several sources into one selector is the intended way to derive state:

```ts
// in a component: subscribes, and re-renders when the derived value changes
Zus.useStore(ConfigClient.Store, UPClient.Store, Sel.clientPresence)

// in an event handler: reads once, subscribes to nothing
const presence = Zus.getState(ConfigClient.Store, UPClient.Store, Sel.clientPresence)
```

The two call shapes rhyme, so moving a selector between render and handler code is a mechanical edit.

`Zus.toObservable(store)` converts any store into an `Observable<[state, prev]>`, which is how frames drive RxJS
pipelines from zustand state, and how ODSM side effects react to prev/next diffs.

### Sel and Actions

Every stateful client file exports two namespaces:

- **`Sel`** holds pure selectors, memoized with `reselect`. Per-item selectors should index, not scan: one O(N) pass
  building a `Map` plus an O(1) lookup beats each item's selector walking the list, which is O(N^2) on every change
  and shows up in a profiler as recompute rather than re-render.
- **`Actions`** holds every user-initiated operation. An action takes `stores` (a `KeyProp`) as its first argument
  and resolves the concrete store itself. Actions must not close over component state.

Components pass `stores: SomeFrame.KeyProp`, built by `FRM.toProp`. React context is deliberately not used for
stores: frame instances are refcounted per consumer, and context would obscure who is keeping an instance alive
versus merely reading it.

### Component rules

Conventions from CLAUDE.md, each with a specific reason:

- **Never export non-components from a `.tsx` file.** It breaks hot module replacement. Hence the `*.helpers.ts`
  files next to components.
- **Avoid controlled inputs** (do not set `value`); debounce anything that would re-render often.
- **Prefer adding a selector over `useMemo` in the component body.**
- **`useEffect`/`useState` interdependence is a code smell.** That is what frames are for.
- React Compiler is on, and memoizes against stable mutable objects. This bites with TanStack Table: derive render
  data from React state, and only call table methods in event handlers.
- All overlays are z-50 body-level portal siblings, so **DOM order decides stacking**. Mount on demand rather than
  reaching for z-index.

## ODSM: optimistic distributed state

`src/lib/odsm.ts` (Optimistic Distributed State Machine) keeps collaboratively edited state coherent across the
server and every connected client. It is the answer to "two admins are editing the queue at once, and one of them
has 80ms of latency".

The state machine is defined **once**, in a `.ts` model shared by both sides, as a pure
`Reducer<Op, State, SideEffect>`. It runs in three places against three different base states: the client applies an
op optimistically the instant you perform it, the server applies the same op authoritatively, and the client
reconciles its guess against the server's replay. Ops are deterministic, so the two normally agree. The library has
no I/O, no transport and no zustand, which is why the same file backs both sides.

A client session carries a **synced** timeline, what the server has confirmed, alongside a **local** one, what you
are looking at.

Before touching a reducer:

- **Rejection throws `RejectedError`**, and it is all-or-nothing for the batch, since ops handed in together are
  dependent. This is the one place the codebase deliberately throws rather than returning a result code, because it
  has to unwind an arbitrarily deep reducer.
- **Rejection means different things depending on where the op came from.** A rejected client-authored batch is
  dropped entirely and never sent. A batch that arrives over the wire keeps its ops in history for coherence but
  leaves state untouched.
- **The same op is replayed against several base states.** This is why reducers must be pure, and why side effects
  are _returned_ rather than performed. For the same reason a side-effect handler must never have reduced state
  threaded into it: react to the resulting state via store subscriptions instead.
- Op history is **bounded**, so it is a reconciliation buffer, not an audit log. Durable history is the app-events
  subsystem's job.

Three state machines are built on it today, each as a model/server/client trio:

| Machine                      | Model (reducer)                   | Server                                | Client                                      |
| ---------------------------- | --------------------------------- | ------------------------------------- | ------------------------------------------- |
| Shared layer list, the queue | `src/models/shared-layer-list.ts` | `src/systems/layer-queue.server.ts`   | `src/frame-partials/layer-queue.partial.ts` |
| Team swaps                   | `src/models/teamswaps.models.ts`  | `src/systems/teamswaps.server.ts`     | `src/frame-partials/teamswaps.partial.ts`   |
| User presence                | `src/models/user-presence.ts`     | `src/systems/user-presence.server.ts` | `src/systems/user-presence.client.ts`       |

The layer queue is the fullest example. Presence is the outlier: its client half lives in a plain global store
rather than a frame partial, because presence is genuinely app-global.

## The domain layer

### Filters

A filter is a recursive AST that is **operator-primary**: the operator name carries what used to be separate
negation and conjunction flags. Comparisons (`eq`, `lt`, `gt`, `in`, `inrange`) constrain their first argument to be
a column rather than a bare constant, since every value-first comparison has a column-first equivalent. Blocks
(`all`, `some`, `none`, `notall`) fold the old and/or x negation matrix into four self-negating quantifiers. A
filter can also reference another filter entity by id.

Validation is two-tiered: `EditableFilterNode` is what the editor manipulates mid-keystroke, with everything
optional, against a fully-valid `FilterNode`. Errors are collected **by path** rather than thrown, so the editor can
highlight the exact offending node.

Builders are layered and each only knows the level below it: `filter-builders.ts` constructs `FilterNode`s, and
`constraint-builders.ts` wraps those into query `Constraint`s.

### Layers

`LayerId` is a **structured string**, not an opaque id:

```
<Map>-<Gamemode>[-<Version>][-<Collection>]:<Faction1>[-<Unit1Abbr>]:<Faction2>[-<Unit2Abbr>]
```

Anything SLM cannot parse, such as an admin typing a layer by hand, becomes `RAW:<text>`, and `normalize()` can
later upgrade it once new layer data makes it resolvable. For the engine, a known layer's component indices are
bit-packed into a single integer, which is the row id the columnar store indexes by.

The set of columns is not fixed: `layer-columns.ts` combines base columns with server-configurable extra columns
into an `EffectiveColumnConfig`, and downstream query state is memoized against that object, so the same columns
must always produce the same object.

### Events: three distinct things with similar names

- **server events** are SLM's domain events derived from game server input (`NEW_GAME`, `PLAYER_CONNECTED`,
  `MAP_SET`). High volume, low level.
- **app events** (`app-events.models.ts`) are SLM's **audit log**: one entry per user- or system-initiated action,
  with an actor and a `causeId` naming the app event that caused this one. A server event's `source` can point back
  at the app event that caused it, which is what lets a warnAll's N `PLAYER_WARNED` events collapse into one
  readable feed entry.
- **pending events** (`pending-events.models.ts`) is the **state machine that produces server events** out of raw
  input.

`pending-events.models.ts` is the most intricate module in the codebase and worth reading in full before touching
it. It reconciles two unreliable, differently-lagged views of the same reality, a tailed log file and periodic RCON
roster polls, ordering them into a single event stream while mutating the live roster. It also owns
expectation-based attribution: an action arms an expectation before issuing the RCON command, so the resulting event
can be stamped with its cause. It is pure (`init` + `on*` transitions) and the most heavily tested module in the
codebase.

### Settings

Almost all configuration is runtime-editable settings in the database, not config files, so hosts get a smooth
upgrade path via database migrations with limited manual intervention.

Two schemas: `GlobalSettingsSchema` (one document: RBAC, commands, layer generation, admin action reasons,
broadcasts, vote and queue tunables) and `ServerSettingsSchema` (per server: connections, admin list sources, queue,
nav links). `PublicServerSettingsSchema` is the latter minus `connections`, and **that omission is the security
boundary**, not a display convenience.

RBAC lives _inside_ global settings so it is admin-editable. Roles carry flat permission expressions plus
path-restricted grants that the flat grammar cannot express. Permissions are computed fresh per request and merged
into a traced list where every grant records which role granted it, so the UI and the audit log can both explain
why someone has access.

## Messages and locales

Every string a person reads lives in `src/messages/<domain>.messages.ts`, read through a `<Domain>_Msgs` namespace
that mirrors the domain's models alias. The tree is isomorphic, and the same message feeds an in-game RCON broadcast
and the web app's preview of that broadcast, so it must not import anything node-only.

`Msgs.def` takes the shape that fits. Most messages are a plain string. One that takes arguments declares an ICU
pattern plus a mapping from its own parameters to that pattern's values, so the call site keeps an ordinary typed
signature:

```ts
export const close = Msgs.def('Close')
export const addLayers = Msgs.def('{count, plural, =0 {Add Layers} one {Add # Layer} other {Add # Layers}}', (count: number) => ({ count }))
```

A message with more than a string to say returns a **target map** instead, whose shared logic lives in the factory's
closure. The targets are `text`, `toast`, `react`, `confirm`, `warn` and `broadcast`. A message offers whichever it
has something sensible to say on, and the compiler rejects the others.

Messages are **keyed by their own English**, so no message declares an id. Two messages whose English is identical
but whose translations differ are told apart by a `context`, which is part of the key and never rendered. Catalogues
live in `src/messages/locales/`.

**Who supplies the locale depends on who is reading.** In the browser there is one viewer per tab, so the locale is
ambient and negotiated once at startup. `warn` and `broadcast` render for a game server and one of its players
rather than for whoever is looking at the web app, so they are handed a locale explicitly.

## The layer engine (rust/wasm)

`layer-engine/` is Rust compiled to wasm. It queries a columnar table of all known layer combinations and handles
filtering, sorting, paging, distinct values and weighted random selection. **One module serves both hosts:** the
server and the browser's query worker load the same `.wasm`.

The table is held column-by-column rather than row-by-row, so a filter scans one tightly packed array per column it
touches. It is immutable for its lifetime, which is what makes caching evaluated bitsets safe and what makes
shipping the same engine to both sides practical.

Three things shape working on it:

- **The ABI is deliberately primitive**, with no wasm-bindgen. The host allocates, writes bytes into linear memory,
  calls in, and reads the response back out. Requests and responses are JSON.
- **All semantic lowering is done in TypeScript.** `models/layer-engine.ts` compiles the filter AST down to a small
  IR of primitive comparisons over column indices and encoded values, inlining referenced filters recursively, so
  the IR handed to Rust is always self-contained.
- **The evaluator is three-valued**, tracking true and unknown as separate bitsets so SQL null semantics survive
  negation. A two-valued port would let nulls through every negated comparison, which is the bug class that makes
  the engine disagree with the pool the UI displays.

The browser runs the engine for everything the UI does, so the server's copy exists for a few narrow jobs: queue
autogen, the force-write pool check, backburner template probes and one route. The server loads it at boot and never
drops it, because loading costs considerably more resident memory than holding it does.

The data it reads is a versioned pair of artifacts. See [layer_data.md](layer_data.md).

## Data and persistence

better-sqlite3 + drizzle, WAL mode. The schema is deliberately small, because most structured state lives in JSON
columns rather than being normalized. Those columns are **superjson**, not plain JSON, transformed by a pair that
walks the drizzle table config, which is what lets bigints (Discord snowflakes) and Dates round-trip.

**Transactions serialize globally.** better-sqlite3 is one synchronous connection, so `runTransaction` serializes
logical transactions behind a promise-chain lock. It is re-entrant: an inner transaction joins the outer one, and an
inner rollback rolls back the outer.

Because that lock is process-wide, **a `runTransaction` callback must never await anything but a query.** Queries
resolve immediately, so a query-only transaction holds the lock for microseconds. Awaiting rcon, discord, sftp or
any other network call inside one stalls every write in the process for that round-trip, and the external call is
not rolled back with the transaction anyway. Two ways out, both already used:

- **Hoist** the call above the transaction, when the write depends on its result.
- **Defer** it onto `ctx.tx.unlockTasks`, when it is a side effect of the write. Note these belong to the
  _outermost_ transaction, so a deferred task escapes an enclosing transaction too.

**The rule is enforced, not just documented.** `runTransaction` races every callback against a `setImmediate`: a
query-only callback settles on a microtask and always wins, while one that reaches the network, the disk or a timer
has to yield and loses. Losing throws in development and test and warns in production, where a violation is a
latency bug and failing the write would be worse.

**Migrations** use a custom runner (`src/server/migrate.ts`, `pnpm db:migrate`) that merges drizzle-kit generated
`.sql` files with hand-written `.ts` data migrations into one filename-ordered sequence. Two constraints shape it:

- **Migrations are frozen in time.** A `.ts` migration gets only the raw driver and must not import from the rest of
  the codebase, so a later refactor can never retroactively change what a historical migration meant.
- **The prod server is bundled**, so `.ts` migrations cannot be globbed at runtime and are statically imported
  through `src/migrations/registry.ts`.

`drizzle-kit generate` still authors schema SQL. Only the _apply_ step is replaced.

**Secrets** are read from a mounted `.env.secrets` file rather than `process.env`, switched by `secret: true` in the
env schema's `.meta()`. Connection secrets are sealed at the db boundary only, and always plaintext in memory.

## Observability

OpenTelemetry (traces, metrics, logs) plus pino, with a local VictoriaMetrics + Grafana stack in `observability/`.
One store per signal, read back over PromQL, the Jaeger API and LogsQL.

Almost all of it arrives through **`spanOp`**, which is why there is very little manual instrumentation anywhere.
One call produces a span, a structured log line and an op-duration histogram sample.

**`durableSub`** is its RxJS counterpart, and it **owns all error handling**: neither a failing source nor a
torn-down task ever reaches the subscriber. These are always-on server pipelines subscribed with a bare
`.subscribe()`, where RxJS's default of an uncaught error killing the subscription would take down the process.

## Testing

The stance is explicit: **unit tests are reserved for code that is both actually complex and self-contained**.
Everything else is covered by integration and e2e tests, which target the tricky codepaths rather than trying to
walk all of them. A unit test over trivial or tightly-coupled code mostly pins the implementation in place, so it
costs refactoring freedom without catching much.

| Suite                   | What it does                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm test`             | vitest unit tests.                                                                                              |
| `pnpm test:integration` | Boots the **real app** as a child process (ephemeral db and ports) against the emulator, one app per test file. |
| `pnpm test:e2e`         | Builds the engine and client bundle, then drives that app with Playwright.                                      |

Neither heavy suite needs an external service, which is the payoff for having written the emulator.

Both are dominated by two costs. **Booting apps:** a fixture is a whole server process and a run makes dozens, so
both suites bundle the server once with rolldown rather than loading its module graph through tsx on every boot.
**Waiting on polls:** the app learns the roster from a polled `ListPlayers`, so a test that acts in-game and then
asserts cannot resolve faster than two poll intervals. Poll interval, worker count and per-boot cost all trade
against each other, so none should be changed without re-measuring the whole suite.
