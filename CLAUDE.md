# General

Flag any breaking change to persisted data structures or configuration, so the user can deal with it. That covers
the frontend (localStorage) and the backend (database, config, environment variables).

Prefer copy-on-write unless mutation is proven safe or the code is a hot path.

Async functions should take a cancellation signal by default. For non-lib functions, pass it via the ctx object (see
src/models/context-shared.ts). The client is not converted to this pattern yet, so use judgement about when to
upgrade a function. Never leave a dangling promise.

When branching on a union, especially a discriminated one, cover the default case with `assertNever()` from
src/lib/type-guards.ts, so adding a member raises a type error.

Use namespace imports for all nontrivial modules, unless that module has an established convention against it. Each
namespace must be consistent and unique across the app, except for special cases like the imports in context.ts and
context-shared.ts. Use convenient abbreviations or acronyms for commonly used lib modules, model modules and
packages. The lib vocabulary is in dev_docs/architecture.md under "Namespace imports everywhere".

Never import rxjs, zustand or react-rxjs directly. Each is reached through its wrapper in `src/lib` (`Rx`, `Zus`,
`ReactRx`), which re-exports the package alongside our own additions. Import other packages directly, since a
wrapper that adds nothing is just indirection.

# Comments

Only write a comment that is _absolutely necessary_: one without which it would be hard to work out what is going
on, and why. Everything else is noise. Default to no comment.

Before writing one, try to make it unnecessary. A precise name is almost always better than a comment explaining a
vague one: `DOCS_SOURCE_REPO` needs no comment where `DOCS` needs three lines. Rationale that belongs to a
particular piece of code stays with it, in a comment, however long it has to be. Only the high-level shape of the
app belongs in dev_docs/architecture.md.

Never write a comment that:

- trivially explains what the code does, or restates a name, type or condition already visible on the line
- justifies, editorializes or argues for the approach taken
- refers back to previous versions of the codebase, or to why something changed, without an extremely motivating
  reason

Keep the ones that survive no longer than their point needs. Most are one line.

# Documentation, prose and app text

Write plain technical English. Short declarative sentences, one idea each. State the fact, then the reason if the
reason is needed.

Do not use emdashes.

Cut anything that tells the reader how to feel about the code: "worth internalizing", "the honest test", "elegant",
"surprisingly". Cut throat-clearing that delays the fact. Prefer "X does Y" over "the thing to understand about X is
that it does Y".

Keep concrete numbers, file paths, code and tables. Those are the signal.

"Team A" and "Team B" are not free vocabulary. They mean `MH.NormedTeamId`, the team normalized across the
team1/team2 swap, as against "Team 1" and "Team 2" for the raw slot. Never use A/B to mean an unordered or
interchangeable side, which is roughly the opposite of what it denotes, and be aware that any UI toggling labels
between A/B and 1/2 will read as driving the `displayTeamsNormalized` setting. Use "one side" and "the other side"
when you need a side with no identity.

docs/ and the README are user-facing: what somebody running SLM for their community needs, and nothing else. Keep
implementation detail out of them. dev_docs/ is the other half, for contributors and for whoever operates the
project's own infrastructure. A doc that only makes sense with a checkout in front of you belongs there.

# Editing

Run `pnpm run format` and `pnpm run check` (or a subset that typechecks your changes) before reporting back.

Once a goal or feature is complete, run `pnpm run lint:fix` and fix all lint errors as a cleanup step.

# Running the app in a worktree

Full details in dev_docs/dev_instances.md.

From a worktree, do not run `pnpm server:dev` or `pnpm client:dev`, and do not use ports 3000/5173. Those belong to
the main checkout, and an app you reach there is not running your changes. Each worktree runs its own instance
instead, with its own database and an emulated squad server:

```sh
pnpm dev:init     # once per worktree: claims a port slot, links .env, clones the db. Prints the url.
pnpm dev          # the app, the client and the emulator. Prints the url again.
pnpm -s dev:url   # just the url, for reporting
pnpm emuctl help  # drive the emulated server: join, chat, end, cycle
```

`pnpm dev` is long-lived, so an agent must start it as a tracked background job (`run_in_background`).

`pnpm -s dev:url` prints the one url the instance answers on, and it is the only one to hand anyone. Wait for the
port to answer before opening it: a request that lands during boot bounces into the real Discord oauth flow, which
looks like the bypass is broken when it is not.

Never point a worktree at a real squad server or the real battlemetrics org. `dev:init` deliberately scrubs those,
and re-adding them means an experiment drives production.

# Pull requests

Check for potential merge conflicts before pushing commits to a PR. For frontend changes, always include a link to
the running dev server with the changes up.

# Server side

Log significant actions taken by the user or by the system via app events (see src/models/app-events.models.ts).

Pass commonly used state via the ctx object. It is always the first argument, or for observables always the first
element of the observable's data tuple. A domain's contexts live in that domain's models file (`V.Ctx`, `MH.Ctx`,
...), with the runtime object it carries at `Ctx.Payload`. Check the domain's models file first, then
context-shared.ts for the shared primitives, then server/context.ts for server infrastructure. Every context has a
`CtxDef` beside it; see dev_docs/architecture.md, "Context as duck-typed dependency injection".

A function's ctx parameter type should name the minimum context it needs.

# Client side

In the main checkout the vite dev server runs on http://localhost:5173 by default. In a worktree it does not: see
"Running the app in a worktree" above, and do not assume 5173 is yours.

Use stores or frames at minimum whenever:

- A component's state depends on mutable props. Pass the component some variant of `Zus.AnyInput<T>` in the `stores`
  prop instead. That input can be a derived state or event stream from another store, or the store itself.
- Different pieces of state have significant interdependencies. Stores and frames handle reactive state well, so use
  them instead of a useEffect/useState pattern, which is always a code smell.

Use frames instead of raw zustand stores where the state is non-global and the store may be created and destroyed.
Frames can and should query and subscribe to async data sources directly.

Pass `Zus.AnyInput` instances through components via the `stores` prop. By convention a component defines a `KeyProp`
or `StoreProp` to standardize which property they go on in `props.stores`. Do not use react context to pass stores or
other data sources.

Only use React.Context when the base case of the context not being set yet is harmless. Ask the user before
violating this rule.

In components, prefer modifying or adding selectors over computing intermediate state in the component body with
useMemo. `Zus.useStore` helps here: it merges multiple data sources for use in a single selector.

Use the established `Sel` namespace convention for selectors.

Handle user actions at the top level, in a function in the relevant system or frame's `Actions` namespace. Avoid
closing over or passing state from the component body to the action handler, unless it is indirect state like a
store or another variant of `Zus.AnyInput`.

Never export non-components from .tsx files. It breaks hot module replacement.

Never hardcode a z-index. Take one from src/models/zindex.ts via `useZIndex(ZI_OFFSETS.<BAND>)`, picking the band
for what you are layering: in-container overlays, sticky headers, popovers, tooltips, draggable windows, dialogs.
The offsets are relative to the nearest enclosing `BaseZIndexContext` rather than absolute, so a bare `z-50` is
right up until the component is rendered inside a dialog or a draggable window. For sticky headers nested inside
other sticky headers, use the `StickyGroup` component instead of picking offsets yourself: it measures ancestor
heights and assigns both the `top` offset and the z-index.

Avoid controlled inputs and textareas: do not set `value`. Do the same for other latency-sensitive fields. Debounce
inputs that would otherwise cause frequent re-renders.

# Testing

Reserve unit tests for code that is both actually complex and largely self-contained, or at least isolatable. Do not
unit test trivial code.

Cover most complex features with integration or e2e tests instead. Do not try to exercise all codepaths; focus on
the tricky ones. Where convenient, use semantic html tags, which make the playwright code better and improve
accessibility as a side effect.

Favour vertical scenario files over per-system ones. In test/integration and test/e2e every app fixture boots the
real app as a child process, so fixtures are the unit of both isolation and cost. Before writing a new test file or
booting a fresh fixture, look for an existing scenario file whose app config can carry the test, and extend its
journey: order tests so earlier ones hand their state to later ones, with destructive steps last. Boot a separate
app only when the config is the subject of the test (auth mode, otel, generation weights, a second server, agent
mode) or when the test dirties state nothing after it can tolerate. When two files' configs differ only in seeded
data, re-pick the data so one fixture serves both before accepting a second boot.

Arrange through the harness, not inline: seeding via createAppFixture options, builders in test/harness/arrange.ts
(queue, filter, role, ...), db and RCON readers in test/harness/inspect.ts (savedQueue, warnsTo, latestMatch, ...).
Do not re-implement these in a test file.

Two traps in tests that share an app. Draft edit-session state (queue ops, backburner edits) is not guaranteed to
outlive the page that made it: a test that leaves a draft must commit it, or the test after it must read its
starting state dynamically instead of assuming counts. And a save clicked before the page has hydrated can commit
clobbered state (see the rename test in test/e2e/filter-editor.test.ts), so a test whose save is incidental runs
after the tests that read what it saves.

# Migrations

Data migrations are applied by a custom runner, `pnpm db:migrate` (see ./src/server/migrate.ts). It is
backwards-compatible with `drizzle-kit generate`.
