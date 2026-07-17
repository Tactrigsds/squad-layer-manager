# Architecture and Coding Style

A map of what SLM is built out of, the patterns it leans on, and the places where it deliberately does
something unusual. This is a description of the codebase as it stands, not a spec: where the code and this
document disagree, the code wins.

Companion reading: [CLAUDE.md](../CLAUDE.md) states the rules this document explains the reasoning behind.

## Contents

- [The shape of the thing](#the-shape-of-the-thing)
- [Cross-cutting conventions](#cross-cutting-conventions)
- [Server-side machinery](#server-side-machinery)
- [Client machinery](#client-machinery)
- [ODSM: optimistic distributed state](#odsm-optimistic-distributed-state)
- [The domain layer](#the-domain-layer)
- [The layer engine (rust/wasm)](#the-layer-engine-rustwasm)
- [Out-of-process pieces](#out-of-process-pieces)
- [Data and persistence](#data-and-persistence)
- [Observability](#observability)
- [Testing](#testing)
- [Quirks worth knowing](#quirks-worth-knowing)

## The shape of the thing

One single-tenant TypeScript process serving a React SPA, talking to one or more game servers over RCON and
their log files. Persistence is a local SQLite database in WAL mode (better-sqlite3 + drizzle), held open on
one connection for the life of the process. There is no external datastore, which is a constraint worth
keeping in mind throughout: see [Data and persistence](#data-and-persistence) for what that costs and buys.

Two Rust components sit alongside the TypeScript codebase, and both exist for a specific reason:

- **The query engine**, compiled to wasm and run in both the server and the browser. Squad's layer set is
  ~730k map/gamemode/faction/unit combinations (732,937 in the shipped v10.4.0 artifact), which is too many to
  filter row-by-row in JS at interactive speed and too many to page over the wire. Compiling one columnar
  engine to wasm means the same query code answers both the server's RPC callers and the layer table UI, with
  the whole set resident on each side.
- **The server agent**, an optional standalone binary installed next to a game server. It streams that
  server's logs to SLM over a WebSocket and proxies its RCON, which is a better interface than SLM reaching
  for the logs itself over SFTP and holding an RCON connection across the internet. It is not required to run
  SLM.

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
| `src/emulator`       | A fake Squad server, for tests.                                  |
| `test`               | Integration and e2e suites.                                      |

The layering is `lib` -> `models` -> `systems` -> `components`/`routes`. `src/components` is the largest
directory by some margin and `src/models` the next, which is the shape you would expect: the domain is wide
and the UI is mostly bespoke editors over it.

**That ordering describes runtime imports, and the type graph is much looser.** `import type` erases at compile
time, so it cannot create an import cycle or pull a module's transitive dependencies along with it, and the
codebase leans on that freely: `lib` modules take `CS.Ctx`, `CS.Logger`, `CMD` and `SM` types from `models`
(`import type * as CS from '@/models/context-shared'` in `async-resource.ts`, `cleanup.ts`, `sftp-tail.ts`,
`fetch-admin-lists.ts`) while depending on nothing there at runtime. Read the layer ordering as a claim about
runtime edges only. An upward `import type` is normal and not a smell; an upward value import is the thing to
look twice at.

Even the runtime ordering is aspirational rather than enforced, and there is no lint rule holding it up. The
live exceptions are worth knowing, since they are the ones you will trip over:

- A few `lib` modules reach up into `models` and even `src/server` for instrumentation: `async-resource.ts`,
  `rcon/core-rcon.ts` and `rcon/fetch-admin-lists.ts` all import `C.spanOp` from `@/server/context`, and
  `lib/otel.ts` imports otel attribute names from `@/models/otel-attrs`. Wanting a span in a `lib` module is
  what pulls the whole context layer upward into it.
- `models/teams-panel.models.ts` imports a **frame partial** at runtime for its selectors, which is a
  three-layer inversion and the clearest violation in the tree.

Treat those as debts, not precedent.

### The `.server` / `.client` / `.shared` suffix

`src/systems/*` is the feature layer, and every file's suffix declares which side of the wire it runs on:

- `*.server.ts` runs in node only. May import `src/server/*`.
- `*.client.ts` runs in the browser only.
- `*.shared.ts` runs in **both**, and this is load-bearing rather than incidental. `layer-queries.shared.ts`
  is the single implementation of every layer query in the app; it executes server-side for RPC callers and
  inside a browser Web Worker (`layer-queries.worker.ts`) for the layer table UI, both against the same wasm
  engine. The client is not calling a thin API over a server-side query layer, it is running the query layer.

  That engine is the **columnar store**: the full table of Squad layers (every map/gamemode/faction
  combination) held column-by-column in memory rather than row-by-row, so a filter scans one tightly packed
  array per column it touches instead of walking whole rows. It is immutable for its lifetime and small enough
  to ship to the browser, which is what makes running the same query layer on both sides practical in the
  first place. It gets a full treatment in [The layer engine](#the-layer-engine-rustwasm).

Systems pair up across the wire: `layer-queue.server.ts` / `layer-queue.client.ts`, `settings.server.ts` /
`settings.client.ts`, and so on, sharing types through `src/models`.

## Cross-cutting conventions

### Namespace imports everywhere

Nontrivial modules are imported as namespaces, with a short abbreviation that is **globally consistent across
the app**. `import * as F from '@/models/filter.models'` means `F` is the filter model in every file that uses
it. Likewise `L` (layer), `LC` (layer-columns), `LQY` (layer-queries), `SM` (squad models), `CS`
(context-shared), `C` (server context), `SLL` (shared-layer-list), `Obj`, `Arr`, `Rx`.

A reader who knows the abbreviations reads any file quickly. The cost is a vocabulary you have to learn that
is written down nowhere but convention.

### Result codes instead of exceptions

The dominant error convention is a returned discriminated union tagged with a `code` field, not a thrown error:

```ts
{ code: 'ok', data: ... }
{ code: 'err:filter-not-found' }
{ code: 'err:permission-denied', ... }
```

There are ~216 `code: 'ok'` and ~153 `code: 'err:*'` sites, with error codes namespaced by colon
(`err:invalid-op:different-user`). Exceptions are reserved for genuine bugs and for aborts.

Both routes are instrumented, so the preference is not about telemetry: `spanOp` (below) records a throw as an
`error` outcome and a returned `err:*` as a `value-error` outcome. It is about the handling. An error code is
part of the return type, so the compiler forces every caller to acknowledge it and `assertNever` forces them to
widen when a new code appears, whereas a thrown error is invisible to the signature and is handled, or not, at
whatever distance the nearest `catch` happens to sit.

### `assertNever` on every union

~98 call sites. Every `switch` over a discriminated union ends in `default: assertNever(x)` from
`src/lib/type-guards.ts`, so adding a variant to a union turns into a compile error at every site that must
handle it. Given how many discriminated unions the domain layer has (30+), this is the main mechanism keeping
them honest.

### Schema-first models

Zod schema is declared first, the type is derived from it (`export type X = z.infer<typeof XSchema>`), near
universally. Notable house conventions:

- `.prefault(...)` rather than `.default(...)`, so defaults are themselves validated.
- `.describe(...)` / `.meta({description})` are not only documentation, they are **UI**. The settings page renders
  a schema-driven form and reads these as field help text, and the LSPs of the in-app editors will render these as tooltips due to the generated JSON schema.
- `z.preprocess` is used sparingly and treated as a hazard. It is explicitly banned in `GlobalSettings`
  after a past incident.
- No `z.brand()` anywhere. Nominal-ish typing is done informally through type aliases.
- Exactly one `z.codec`: `HumanTime` in `src/lib/zod.ts`, which round-trips `"5m"` <-> `300000`.

## Server-side machinery

### Context as duck-typed dependency injection

There is no DI container. Instead, a `ctx` object is threaded as the **first argument** to essentially every
server function, and capabilities are expressed as intersection types over a branded base:

```ts
const CtxSymbol = Symbol('context')
export type Ctx = { [CtxSymbol]: true }
```

Each capability is its own `Ctx &` type in `src/server/context.ts`: `Db`, `Rcon`, `ServerId`, `User`,
`AbortSignal`, `Tx`, `Mutexes`, and so on. A function declares the **minimal** intersection it actually needs:

```ts
async function doThing(ctx: C.Db & C.User & CS.AbortSignal, ...) { ... }
```

Callers build up context by spreading. The payoff is that a signature becomes a precise, checked statement of
what a function touches. The `CtxSymbol` brand exists so `CS.isCtx()` can recognize a ctx at runtime, which
`spanOp` uses to find it among a function's arguments.

For observables, the same rule applies with the ctx as the first element of the emitted tuple.

### spanOp: the unit of server work

Server functions of any significance are wrapped in `spanOp`. It is on nearly every exported server function,
so it is worth understanding before reading any of them:

```ts
export const dispatchOp = C.spanOp('dispatchOp', { module }, async (ctx, op, opts) => { ... })
```

`spanOp` declares "this is one unit of server work". It returns a function with the same signature, so call
sites are unaffected, and gives the unit four things uniformly: it is traced and timed, it logs itself once
with a consistent shape, its outcome is classified (succeeded, threw, or returned an error code), and it can
declare mutexes to hold for its duration rather than acquiring them by hand.

That last part makes `spanOp` structural rather than merely observational. Locking is declared as an option:

```ts
export const dispatchOp = C.spanOp('dispatchOp', {
	module,
	mutexes: (ctx) => [ctx.layerQueue.updateLayerMtx, ctx.matchHistory.mtx],
}, async (ctx, op, opts) => { ... })
```

`durableSub` is the RxJS counterpart, wrapping a long-lived server pipeline with the same treatment plus error
recovery. [Observability](#observability) covers what both emit.

### ServerSlice: one live game server

`ServerSlice` is the big intersection representing everything about one running Squad server:

```ts
export type ServerSlice =
	& CS.Ctx
	& SquadRcon
	& SquadServer
	& Vote
	& LayerQueue
	& MatchHistory
	& Teamswap
	& ServerSettings
	& ServerSliceCleanup
	& AdminList
	& CS.AbortSignal
```

Slices live in a module-level `Map<serverId, ServerSlice>` in `squad-server.server.ts`, guarded by a
per-server mutex, with an `IsolatedSubject` firing on every add/remove. `setupSlice()` is one long imperative
function that opens RCON, builds the admin list resource, constructs the event reconciliation state, calls
each subsystem's `init*`, registers the slice, and wires up the event pipelines.

Four details are load-bearing:

**Cleanup tasks are part of the slice.** `ServerSliceCleanup` puts a `Cleanup.Tasks` array on the ctx itself,
so every subsystem's `init*` pushes its own teardown on at the moment it creates the thing needing teardown.
Nothing maintains a separate destructor that mirrors, and drifts from, `setupSlice`'s list of subsystems. A
`Cleanup.Task` is heterogeneous by design (a function, an RxJS `Subscription` or `Subject`, a mutex, an
`AbortController`, or a nested array of those), so a subsystem registers whatever it holds without wrapping it
in a closure. Teardown runs the array **FILO**, catching per-task errors so one bad teardown cannot strand the
rest. The same machinery runs at process level (see [Cleanup and shutdown](#cleanup-and-shutdown)); a slice is
just a smaller scope.

**Every slice owns an AbortController**, combined with the caller's signal via `anySignal`. Destroying a slice
cancels every RxJS task and in-flight fetch inside it and touches nothing else. This is the coarse half of
teardown, and it pairs with the cleanup array: the signal stops anything watching it, the array disposes what
needs an explicit call.

**Lifecycle transitions are serialized per server.** Setup, teardown and restart all run under one per-server
mutex (`withSliceLock`), so no two can interleave and observe each other's half-applied state. The mutex is
`async-mutex`'s, which is **not** reentrant, so the codebase splits each operation into a locking entry point
and an unlocked `*Locked` internal: compound operations like `restartSliceIfRunning` take the lock once and
call the internals. Acquiring it twice in one call stack self-deadlocks, which is the trap to watch for when
adding a lifecycle operation.

The subtle case is the teardown triggered by a resource's `onFatalError`, which can fire while `setupSlice`
still holds the lock. It is safe only because `AsyncResource` discards the callback's return rather than
awaiting it, so nothing holding the lock ever waits on the teardown: it queues behind setup and tears down the
slice setup just finished building. Awaiting that callback would close the cycle and deadlock.

**Streams resolve the slice on every tick, not once.** `sliceStream$` re-subscribes to the lifecycle subject
and switches to `err:server-not-loaded` whenever the slice vanishes, which is why a crashed and restarted
game server heals itself instead of leaving every connected client's subscription silently dead. This is
documented in-code as the only correct way for an oRPC stream to resolve a slice.

### Abort signals

Async functions take cancellation via `ctx.signal` (`CS.AbortSignal`), not a separate parameter. Signals come
from four sources: the oRPC middleware (per-call), the slice controller (per-server), fastify (per-request),
and `CleanupSys.shutdownSignal` (per-process). They compose with `anySignal`.

There is one loudly-documented exception. `killPlayers` in `squad-rcon.server.ts` deliberately ignores its
signal partway through, because the "kill" is implemented as two `AdminForceTeamChange` calls around a sleep,
and aborting between them leaves the player alive on the wrong team rather than dead. It also holds the teams
resource's fetch mutex across the whole trick so nothing observes the intermediate state.

### oRPC over a WebSocket

All client-server communication is oRPC (`@orpc/*`) over a **single WebSocket**, not HTTP. The router is a
flat object of per-system subrouters in `orpc-app-router.ts`. Every router is built from `getOrpcBase(module)`,
which installs exactly one middleware: it wraps the handler in `spanOp` and narrows the connection-level
signal down to the individual call.

The consequence worth internalizing: **auth happens once, at the HTTP upgrade**, not per call. A session
cookie is validated in a fastify `preValidation` hook, a `wsClientId` is minted, and the resulting ctx object
lives for the lifetime of the socket and is reused for every RPC over it.

RBAC and db access are deliberately **not** middleware. Handlers call `Rbac.tryDeny*` themselves (which
returns a denial _value_, per the result-code convention, rather than throwing) and attach a db with
`DB.addPooledDb`. This is more verbose and more explicit; it also means you cannot tell whether a handler is
permission-checked without reading it.

The client side uses `partysocket` for transparent reconnection, and surfaces connection state as an RxJS
observable that deliberately waits 750ms before admitting anything is wrong.

### AsyncResource

`src/lib/async-resource.ts` is a TTL cache for an async value with push-based observation, and the backbone of
every polled thing (admin lists, server info, teams/roster, layer status). It caches the _promise_, not the
value, so concurrent callers dedupe onto one fetch. Less obviously:

- It distinguishes one-shot `get()` subscribers from long-lived `observe()` subscribers, keeps a background
  refetch loop alive only while an observer exists, and **aborts an in-flight fetch if the last subscriber
  drops mid-flight**.
- `fetchMtx` is deliberately public so external code can freeze refetches across a window where the fetched
  state would be transiently incoherent (this is what the kill trick above holds).
- A callback can throw `ImmediateRefetchError` via `ctx.refetch(...)` to force a retry instead of serving
  known-incoherent data (used when RCON reports a squad with no leader).
- `onFatalError` exists because the alternative is an unhandled rejection killing the process. Every
  per-slice resource wires it to "tear down this slice", on the reasoning that a resource that will not
  fetch means the slice cannot do its job.

### Reentrant mutexes via AsyncLocalStorage

`src/lib/nodejs-reentrant-mutexes.ts` builds reentrancy on top of `async-mutex` using `AsyncLocalStorage` to
track which mutexes the current call stack already holds, so re-acquiring is a no-op rather than a self-
deadlock. Two further details:

- When acquiring multiple new mutexes it sorts them into a **stable process-global order** (a `WeakMap`
  assigning an increasing integer on first sight) and acquires them **sequentially**, not via `Promise.all`.
  This is what prevents two concurrent operations needing overlapping mutex pairs from deadlocking.
- `addReleaseTask` registers work to run once _all_ enclosing mutexes release.

As noted above, mutexes are usually declared rather than acquired: `spanOp` and `durableSub` take a `mutexes`
option and wrap the callback in `withAcquired` for you.

`IsolatedSubject` / `IsolatedBehaviorSubject` / `IsolatedReplaySubject` (`src/lib/isolated-subject.ts`) exist
because of this: they re-enter the root async context before calling `next()`, so a subscriber does not
inherit the _publisher's_ mutex ownership and wrongly believe it already holds a lock.

### Deferred work buckets

Three parallel instances of "defer this until the enclosing critical section really ends", all implemented as
mutable arrays shared by reference through ctx spreads:

- `ctx.tx.unlockTasks` runs after a **db transaction** commits. This is how a settings broadcast is prevented
  from firing for a transaction that later rolls back.
- mutex `releaseTasks` runs after a **mutex** set fully unlocks.
- `ctx.deferred` + `awaitDeferred` (`context-shared.ts`) is a bucket where a callee schedules best-effort
  background work for an ancestor to await, keeping it inside the ancestor's lifetime and signal instead of
  leaking as a fire-and-forget promise. It uses `allSettled` (never `all`) specifically so one rejection
  cannot abandon its still-pending siblings and resurrect the unhandled-rejection risk it exists to prevent.

### Cleanup and shutdown

`Cleanup.runCleanup` is the shared primitive described under [ServerSlice](#serverslice-one-live-game-server):
a heterogeneous task array, disposed FILO, errors caught per task. Slices use it for their own scope;
`cleanup.server.ts` is the process-level registry that drives SIGTERM and owns `shutdownSignal`.

`using` / explicit resource management appears (via `acquireInBlock` returning a `Symbol.dispose`) but is a
targeted tool, not the house style. Babel's explicit-resource-management plugin is in the build for it.

## Client machinery

The client's core problem is that most of its state is neither global nor local: it belongs to "the server
dashboard you currently have open", which is created and destroyed as you navigate. The answer is frames.

### Stores, frames, partials

**A zustand store** is the primitive, used directly for genuinely app-global singletons (selected server,
public settings, presence).

**A frame** is a reference-counted, keyed, lazily-created and torn-down zustand store, managed by a singleton
`FrameManager`. You define one with `createFrame({ name, createKey, setup, ... })`; `setup()` runs once per
instance and receives `{ get, set, input, sub, update$, key }`. Frames subscribe to async sources directly
inside `setup()` (oRPC observables, piped through RxJS) and write results back with `set()`. There is no
separate "async state" concept.

Lifecycle:

- Instances are keyed by a derived key and looked up by **deep equality**, so structurally-equal inputs share
  one instance.
- Each `ensureSetup` bumps a refcount and hands back a fresh outer key object.
- Release paths: `dropKey` (refcount decrement, tears down at zero), `teardown` (unconditional), and a
  `FinalizationRegistry` callback as a GC-driven backstop for keys dropped without an explicit call. The
  `registry.unregister` calls exist to stop a key being released twice.
- `useFrameTeardownOnUnmount` defers the drop to `requestIdleCallback` and cancels it if the same key
  reappears, which is what lets frames survive React StrictMode's mount/unmount/remount simulation in dev.

```ts
const frameKey = useFrameLifecycle(SquadServerFrame.frame, {
	input: SquadServerFrame.createInput(props.serverId),
})
useFrameTeardownOnUnmount(frameKey)
return <ServerDashboard stores={FRM.toProp(frameKey)} />
```

**A frame-partial** (`src/frame-partials/*.partial.ts`) is not a frame at all. It is a module exporting a
slice type, an `init*(args)`, and its own `Sel`/`Actions`, which a real frame composes into its state by
intersecting the types and calling `init*` from `setup()`. `squad-server.frame.ts` composes four of them
(chat, server settings, layer queue, teamswaps). Partials get a scoped view of the composite state via
`ZusUtils.toPartialSetter`/`toPartialGetter`. This is how a large frame stays modular without every slice
needing its own FrameManager entry.

### ZusUtils

`src/lib/zustand.ts` is the client's central abstraction. Its key type:

```ts
type AnyInput<T> = AnyStore<T> | QuerySource<T> | StateObservable<T>
```

which unifies a raw zustand store, a frame instance key, a react-query options object, and a react-rxjs
`StateObservable` behind one interface. Everything downstream accepts `AnyInput`, so a component neither knows
nor cares which of the four it was handed.

`ZusUtils.useStore` is heavily overloaded and is the sanctioned read path for component display logic: one input
returns its state;
N inputs plus a trailing selector calls `selector(...states)`; N inputs alone returns a tuple. It runs
`useQueries` for query sources, subscribes to sync sources in an effect, and bails out on `Object.is`
(element-wise for the tuple case, since the tuple is freshly allocated each compute and would otherwise always
look changed). Nullish inputs are tolerated as placeholders so hook dependency counts stay stable.

Outside render, the counterpart is **`ZusUtils.getState`**: a point-in-time read with no subscription, for
event handlers and `Actions` code. Both resolve frame keys the same way and feed the same `Sel` selectors, so
the choice is only whether you want to subscribe.

Merging several sources into one selector is the intended way to derive state:

```ts
// in a component: subscribes, and re-renders when the derived value changes
ZusUtils.useStore(ConfigClient.Store, UPClient.Store, Sel.clientPresence)
```

The same selectors are reusable verbatim off the render path, applied to a `getState` read instead. From
`layer-table.partial.ts`, inside an `Actions` handler:

```ts
// in an event handler: reads once, subscribes to nothing
const current = Sel.tanstackSortingState(ZusUtils.getState(stores.layerTable))
```

Note the shape difference: `useStore` takes N sources and hands their states to the selector, while `getState`
reads one source and you apply the selector yourself. Merging several sources has no `getState` equivalent;
read each one and combine them in the handler.

Frame keys are recognized structurally and resolved through a resolver that `frame-manager.ts` injects at init
(`registerFrameKeyResolver`), purely because `zustand.ts` cannot import `frame.ts` without a cycle.

`ZusUtils.toObservable(store)` converts any store into an `Observable<[state, prev]>`, and is the bridge that
lets frames drive RxJS pipelines from zustand state. It is also how side-effect handling works: per the
`RbSync` rule, ops replay against several base states, so side effects never carry reduced state and instead
react to prev/next diffs from a store subscription.

### Sel and Actions

Every stateful client file exports two namespaces:

- **`Sel`** holds pure selectors, memoized with `reselect`. `createDeepSelector` (a selector creator with
  `resultEqualityCheck: Obj.deepEqual`) is preferred for reusable selectors so call sites do not each need to
  wrap in `useDeep`. `RSel.memoizeFactory` (weakMap memoization) builds parameterized per-item selectors.
- **`Actions`** holds every user-initiated operation. An action takes `stores` (a `KeyProp`) as its first
  argument and resolves the concrete store itself. Actions must not close over component state.

Components pass `stores: SomeFrame.KeyProp`, an object like `{ squadServer: Key }` built by `FRM.toProp`.
React context is deliberately not used for stores: frame instances are refcounted per consumer, and context
would obscure who is keeping an instance alive versus merely reading it.

The per-item selector index in `layer-queue.partial.ts` is the pattern worth copying: one O(N) pass builds a
`Map`, and each item's selector does an O(1) lookup. The naive version (each item's selector scanning the
list) is O(N^2) on every change and is invisible in a profiler because it shows up as recompute, not re-render.

### React and RxJS interop

`zustand-rx`'s `toStream` is used in the client systems, always with the `fireImmediately` caveat: omit it and
the stream silently skips the store's current value and only emits on subsequent changes.

`@react-rxjs/core`'s `bind` is wrapped by a local `src/lib/react-rxjs-helpers.ts`, which adds a first-emit
timeout guard. react-rxjs's Suspense integration has no timeout, so a stream that never emits suspends a
component forever with nothing to attribute it to. The local `bind` races the source against a timer, and the
timer **only runs while the websocket transport is up**, so a dropped connection reads as "still loading"
rather than a hard error.

### Component rules

Conventions from CLAUDE.md, each with a specific reason:

- **Never export non-components from a `.tsx` file.** It breaks hot module replacement. Hence the
  `*.helpers.ts` files sitting next to components.
- **Avoid controlled inputs** (do not set `value`); debounce anything that would re-render often.
- **Prefer adding a selector over `useMemo` in the component body.**
- **`useEffect`/`useState` interdependence is a code smell**; that is what frames are for.
- React Compiler is on (babel plugin, in both vite and the prod rolldown build), which memoizes against stable
  mutable objects. This bites with TanStack Table: derive render data from React state, and only call table
  methods in event handlers.
- All overlays are z-50 body-level portal siblings, so **DOM order decides stacking**. Mount on demand rather
  than reaching for z-index.

## ODSM: optimistic distributed state

`src/lib/odsm.ts` (Optimistic Distributed State Machine) is how every piece of collaboratively edited state
stays coherent across the server and every connected client. It is the answer to "two admins are editing the
queue at once, and one of them has 80ms of latency".

The state machine is defined **once**, in a `.ts` model shared by both sides, as a pure
`Reducer<Op, State, SideEffect>`. It runs in three places against three different base states: the client
applies an op **optimistically** the instant you perform it, the server applies the same op authoritatively,
and the client reconciles its guess against the server's replay. Ops are deterministic, so the two normally
agree and reconciliation is a no-op. The library has no I/O, no transport and no zustand, just session structs
and functions over them, which is why the same file backs both sides.

A `Client.Session` carries a **synced** timeline (`syncedState` + `syncedOps`, what the server has confirmed)
alongside a **local** one (`localState` + `pendingOps`, what you are looking at). The client's entry points are
`processOutgoingOps` (you authored an op: apply locally, queue to send), `processIncomingOps` (someone else's
op arrived), `processAcks` (the server confirmed yours) and `processInit` (a fresh snapshot). The server's side
is just `initSession` / `applyOps`.

Before touching a reducer:

- **Rejection is a thrown `RejectedError` with a typed `data` payload**, and it is all-or-nothing for the
  batch: ops handed in together are dependent. This is the one place the codebase deliberately throws rather
  than returning a result code, because it has to unwind an arbitrarily deep reducer.
- **Rejection means different things depending on where the op came from.** A client-authored batch that is
  rejected is dropped entirely, never queued and never sent, so no-ops stay out of every history. A batch that
  arrives over the wire keeps its ops in history for coherence but leaves state untouched.
- **The same op is replayed against several base states**, so a batch can be rejected against one and applied
  against another. This is why reducers must be pure, and why side effects are _returned_ rather than
  performed: only the non-rejected branch of `Applied` even exposes them. For the same reason a side-effect
  handler must never have reduced state threaded into it; react to the resulting state via store
  subscriptions instead.
- Op history is **bounded** (last 50 guaranteed, 75 max), so it is a reconciliation buffer, not an audit log.
  Durable history is the app-events subsystem's job.

Three state machines are built on it today, each as a model/server/client trio:

| Machine                      | Model (reducer)                   | Server                                | Client                                      |
| ---------------------------- | --------------------------------- | ------------------------------------- | ------------------------------------------- |
| Shared layer list, the queue | `src/models/shared-layer-list.ts` | `src/systems/layer-queue.server.ts`   | `src/frame-partials/layer-queue.partial.ts` |
| Team swaps                   | `src/models/teamswaps.models.ts`  | `src/systems/teamswaps.server.ts`     | `src/frame-partials/teamswaps.partial.ts`   |
| User presence                | `src/models/user-presence.ts`     | `src/systems/user-presence.server.ts` | `src/systems/user-presence.client.ts`       |

The layer queue is the fullest example. `dispatchOp` on the server calls `ODSM.Server.applyOps`, assigns the
returned session back onto the slice, broadcasts the op, and then awaits each returned side effect in turn
through a `spanOp`-wrapped `handleSideEffect`, all in one uninterrupted async context. Presence is the outlier
in that its client half lives in a plain global store rather than a frame partial, because presence is
genuinely app-global.

`ODSM` is also re-exported into the debug console namespace on both sides (`src/server/console.ts`,
`src/systems/console.client.ts`) so you can drive sessions by hand while poking at a live instance.

## The domain layer

### Filters

A filter is a recursive AST that is **operator-primary**: the operator name carries what used to be separate
negation and conjunction flags.

- **Comparison**: `eq | lt | gt | in | inrange`, each with `neg` and an args tuple. `args[0]` is
  structurally constrained to be a column or team-column, never a bare constant, because every value-first
  comparison has a column-first equivalent (symmetric for `eq`/`in`, flip the operator for `lt`/`gt`).
- **Block**: `all | some | none | notall`, folding the old and/or x negation matrix into four self-negating
  quantifiers.
- **Apply-filter**: `included-in | excluded-from`, referencing another filter entity by id.

`team-column` args reference a `_1`/`_2` pair generically with an `either|both` quantifier that expands to
OR/AND over both teams.

Validation is two-tiered: `EditableFilterNode` (everything optional, what the editor manipulates mid-keystroke)
versus a fully-valid `FilterNode`. Errors are collected **by path** rather than thrown, so the editor can
highlight the exact offending node. There is a separate sparse-tree layer (`src/lib/sparse-tree.ts`) keeping a
flat id->node/id->path map in sync with the recursive tree for drag-and-drop editing.

Builders are layered and each only knows the level below it: `filter-builders.ts` constructs `FilterNode`s,
`constraint-builders.ts` wraps those into query `Constraint`s.

### Layers

`LayerId` is a **structured string**, not an opaque id:

```
<Map>-<Gamemode>[-<Version>][-<Collection>]:<Faction1>[-<Unit1Abbr>]:<Faction2>[-<Unit2Abbr>]
```

parsed by one large regex, resolving abbreviations against static component tables. Anything SLM cannot parse
(an admin typing a layer by hand) becomes `RAW:<text>`, and `normalize()` can later upgrade a raw layer once
new layer data makes it resolvable.

For the engine, a known layer's component indices are **bit-packed into a single integer** (`packId`/
`unpackId`), which is the row id the columnar store indexes by.

Column configuration (`layer-columns.ts`) declares 13 base columns plus server-configurable extra columns,
combined into an `EffectiveColumnConfig` memoized by `WeakMap` on the extra-columns array identity. That
memoization is required, not an optimization: downstream query state is memoized against the returned config
object, so the same columns must always produce the same object.

Float columns are stored as **integers scaled by 10^precision** (3dp default), which is what shrank the layer
data by ~112MB.

### Events: three distinct things with similar names

- **server events** are SLM's domain events derived from game server input (`NEW_GAME`, `PLAYER_CONNECTED`,
  `MAP_SET`). High volume, low level.
- **app events** (`app-events.models.ts`) are SLM's **audit log**: one entry per user- or system-initiated
  action, with an `actor` (`slm-user | ingame-user | system`) and a `causeId` naming the app event that caused
  this one. The only chain written today is `QUEUE_UPDATED` -> `MAP_SET`, and nothing reads `causeId` back.
  Not every app event reaches the activity feed: see `isFeedVisible`, which both the emit path and the feed
  backfill gate on.
- **pending events** (`pending-events.models.ts`) is the **state machine that produces server events** out of
  raw input.

The link between the first two is that a server event's `source` can point at the app event that caused it,
which is what lets a warnAll's N `PLAYER_WARNED` server events collapse into one readable feed entry.

`pending-events.models.ts` is the most intricate module in the codebase and worth reading in full before
touching. It reconciles two unreliable, differently-lagged views of the same reality: a tailed log file and
periodic RCON roster polls. It buffers inputs, orders them by time subject to a "safe lead time" guard so
RCON-only events wait for log lines that may still be in flight, and yields ordered server events from an async
generator while mutating the live roster. It also owns:

- **Expectations/attribution**: an action arms an expectation _before_ issuing the RCON command, so when the
  resulting event arrives it can be stamped with the app event that caused it. Expectations have a TTL purely
  as a GC safety net, not as a matching window.
- **A sync/roll state machine** (`desynced | syncing | rolling | synced`) with a watchdog that force-resyncs
  from RCON if it gets stuck.
- Heuristics with documented reasoning: cull a player after 2 consecutive absent polls (one grace poll, so a
  single dropped poll never evicts a live player); synthesize a squad after 3 polls if its creation log never
  arrives.

The distinction between `time` (poll response received) and `polledAt` (poll issued) exists because a poll in
flight across a layer roll carries the pre-roll roster but arrives post-roll, and only the roll-completion gate
keys off `polledAt` for exactly that reason.

It is a pure state machine (`init` + `on*` transitions), and the most heavily tested module in the codebase.

### Settings

Almost all configuration is runtime-editable settings in the database, not config files. This is done so that
all hosts can have a smooth upgrade path via database migrations with limited manual intervention.

Two schemas: `GlobalSettingsSchema` (one document: RBAC, commands, layer generation, admin action reasons,
broadcasts, vote/queue tunables) and `ServerSettingsSchema` (per server: connections, admin list sources,
queue, nav links). `PublicServerSettingsSchema` is the latter minus `connections`, and **that omission is the
security boundary** rather than a display convenience.

RBAC lives _inside_ global settings so it is admin-editable. Roles carry flat permission expressions plus
path-restricted grants (`globalSettingsGrants`, `serverSettingsGrants`) that the flat grammar cannot express.

Permissions are computed fresh per request from three sources merged into a traced list where every grant
records **which role granted it** (for UI and audit): env-var super users/roles (the bootstrap that cannot be
locked out), admin-editable roles, and per-filter contributor grants.

A server whose stored settings fail validation is marked `broken` and force-disabled, so that fixing an
unrelated thing does not silently reactivate it. An admin must re-enable it explicitly.

## The layer engine (rust/wasm)

`layer-engine/` is Rust compiled to wasm, which can query into a set columnar data format containing all known layer combinations.
It handles a number of different query behaviors, including filtering, sorting, paging,
distinct values, and weighted random selection.

**One module serves both hosts.** The server and the browser's query worker load the same `.wasm`.

**The ABI is deliberately primitive**: no wasm-bindgen. The host calls `alloc`, writes bytes into linear
memory, calls in, and reads the response back via `result_ptr`/`result_len`. Requests and responses are JSON.
(Host-side gotcha: take a fresh `Uint8Array` view after every call, since allocation can grow and detach
memory.)

**All semantic lowering is done in TypeScript.** `models/layer-engine.ts` compiles the filter AST down to a
small IR of primitive comparisons over column indices and encoded values.

```ts
type Ir =
	| { op: 'and' | 'or'; children: Ir[] }
	| { op: 'not'; child: Ir }
	| { op: 'true' | 'false' }
	| { op: 'is_null'; col: number }
	| { op: 'eq_val' | 'lt_val' | 'gt_val' | 'ge_val' | 'le_val'; col: number; val: number }
	| { op: 'in_vals'; col: number; vals: number[] }
	| { op: 'eq_col' | 'lt_col' | 'gt_col'; col: number; other: number }
```

Referenced filters are inlined recursively (with mutual-recursion detection), so IR is always self-contained.

**The evaluator is three-valued.** `Tri { t: bitset, u: bitset }` tracks true and unknown separately so SQL
null semantics survive negation: `NOT(NULL)` stays NULL. A two-valued port would let nulls through every
negated comparison, which is the bug class that makes the engine disagree with the pool the UI displays.

Performance work that is load-bearing: AND sorts children by a `cost()` estimate so cheap leaves
narrow the candidate bitset before expensive nested blocks run; `in_vals` does one membership-LUT pass rather
than an OR-chain (real pool filters carry 60-value layer lists); evaluated filter bitsets are cached keyed by
the IR's JSON, which can never go stale because the layer table is immutable for the engine's lifetime.

The one place duplication _is_ accepted is generation key packing, which is implemented identically in
`layer-columns.ts` and `gen.rs`, so a key computed from a weight entry matches the key computed from a row.

## Out-of-process pieces

**The server agent** (`server-agent/agent`, Rust) runs on the game host. It tails
`SquadGame.log` and streams lines over a WebSocket to `/server-agent`, and it proxies RCON: it holds the RCON password itself,
authenticates to localhost, and tunnels an already-authenticated byte stream. **SLM never holds the RCON
password and never needs to reach the RCON port.**

The RCON abstraction reflects this: `RconTransport` is a byte pipe plus lifecycle, with two implementations (a
direct TCP socket, and the agent tunnel). It has a distinct `onReady` separate from `onConnect` so a
self-authenticating transport can say "usable, and I did the handshake myself".

**The emulator** (`src/emulator/`) is a fake Squad server: a `World` model plus protocol frontends (an RCON
server and a log file sink). It is what makes the integration and e2e suites need no external services.

## Data and persistence

better-sqlite3 + drizzle, WAL mode. The schema is deliberately small (18 tables), because most structured
state lives in JSON columns rather than being normalized. Those columns are **superjson**, not plain JSON,
handled by a `superjsonify`/`unsuperjsonify` pair that walks the drizzle table config and transforms only
`json`-typed columns. This is what allows bigints (Discord snowflakes) and Dates to round-trip.

**Transactions serialize globally.** better-sqlite3 is one synchronous connection, but callbacks
are still treated as though they could be async in the future, so
`runTransaction` serializes logical transactions with a manual promise-chain lock around manual `BEGIN
IMMEDIATE`/`COMMIT`/`ROLLBACK`. Re-entrant: an inner transaction joins the outer one, and an inner `rollback()`
rolls back the outer. This is one process-wide lock, a deliberate simplicity-over-throughput call.

Because that lock is process-wide, **a `runTransaction` callback must never await anything but a query.** Queries
resolve immediately (the driver is synchronous), so a transaction that only queries holds the lock for microseconds.
Awaiting rcon, discord, sftp, or any other network call inside one instead stalls every write in the process for the
length of that round-trip, and the external call is not rolled back with the transaction anyway. Two ways out, both
already used: hoist the call above the transaction when the write depends on its result (`Sessions.logInUser` resolves
the discord member first; `filterEntity.updateFilter` does its rbac check first), or push it onto `ctx.tx.unlockTasks`
when it's a side effect of the write (`LayerQueue.saveQueueAndUpdateServer` defers its rcon layer-set this way). Note
that `unlockTasks` belong to the _outermost_ transaction, so a deferred task escapes an enclosing transaction too; it
runs after `COMMIT` with the mutex context still ambient, but with `tx` spent.

**Migrations** use a custom runner (`src/server/migrate.ts`, `pnpm db:migrate`) that merges drizzle-kit
generated `.sql` files with hand-written `.ts` data migrations into one filename-ordered sequence tracked in
`_slm_migrations`. Two constraints shape it:

- **Migrations are frozen in time.** A `.ts` migration gets only the raw driver and must not import from the
  rest of the codebase, so a later refactor can never retroactively change what a historical migration meant.
- **The prod server is bundled**, so `.ts` migrations cannot be globbed at runtime and are instead statically
  imported through `src/migrations/registry.ts`.

`drizzle-kit generate` still authors schema SQL; only the _apply_ step is replaced.

Boot refuses to start against a database that is behind when `DB_AUTOMIGRATE` is off, rather than silently
mutating it, and there is a guard that refuses to boot if it finds a database at the old default path.

**Secrets** are read from a mounted `.env.secrets` file rather than `process.env`. The only switch is
`secret: true` in the env schema's `.meta()`; env-var fallback still works for dev and tests, with a warning in
prod. Connection secrets are AES-256-GCM sealed at the db boundary only (`enc:v<n>:base64(iv||tag||ciphertext)`),
always plaintext in memory, keyed by `SETTINGS_ENCRYPTION_KEY`, with transparent fallback to a legacy key
derivation and an opportunistic reseal on load.

**Layer data** ships as a versioned _pair_ of artifacts (a columnar `.bin.gz` and a components `.json`) that
are only ever valid together, since a table read against the wrong components silently resolves to the wrong
layers. Half a pair is a startup error. Both are checked into `assets/layers` and ship in the docker image;
any complete pair in the mounted `data/` always wins.

## Observability

OpenTelemetry (traces, metrics, logs) plus pino, with a local Grafana/Tempo/Loki stack in `observability/`.

Almost all of it arrives through **`spanOp`** ([above](#spanop-the-unit-of-server-work)), which is why there
is very little manual instrumentation anywhere: one call produces a span, a structured log line, and an
op-duration histogram sample, and the full option set is `{ module, attrs, mutexes, kind }`.

**`durableSub`** is its RxJS counterpart, and it **owns all error handling**: neither a failing source nor a
torn-down task ever reaches the subscriber. These are always-on server pipelines subscribed with a bare
`.subscribe()`, where RxJS's default of an uncaught error killing the subscription would take down the
process. It retries per-task, then retries the source indefinitely.

Span kind is set deliberately (CLIENT on egress, SERVER on ingress) because that is what Tempo's service graph
keys off.

## Testing

The stance (CLAUDE.md) is explicit: **unit tests are reserved for code that is both actually complex and
self-contained**. Everything else is covered by integration and e2e tests, and those do not try to
exhaustively walk codepaths, they target the tricky ones. The reasoning is that a unit test over trivial or
tightly-coupled code mostly pins the implementation in place, so it costs refactoring freedom without catching
much.

In practice the unit-tested modules are the ones that meet the bar: `pending-events`, `filter.models`,
`app-events`, `command.models`, `teamswaps`, `user-presence`, `odsm`, `zustand`, `templating`, `layer`.

| Suite                   | What it does                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm test`             | vitest unit tests.                                                                                              |
| `pnpm test:integration` | Boots the **real app** as a child process (ephemeral db and ports) against the emulator, one app per test file. |
| `pnpm test:e2e`         | Builds the engine and client bundle, then drives that app with Playwright.                                      |

Neither of the heavy suites needs an external service, which is the payoff for having written the emulator.

Two nice touches in the harness: `SLM_TEST_SERVER_ENTRY` points at the bundled server inside the docker image
so CI drives the exact artifact that gets deployed, while locally it runs source through tsx so there is
nothing to rebuild between edit and test. And the tests boot through `main-instrumented`, so a test's telemetry
actually exists and a run id lets you scope a Grafana query to one test.
