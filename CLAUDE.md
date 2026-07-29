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
packages. The lib vocabulary is in docs/architecture.md under "Namespace imports everywhere".

Never import rxjs, zustand or react-rxjs directly. Each is reached through its wrapper in `src/lib` (`Rx`, `Zus`,
`ReactRx`), which re-exports the package alongside our own additions. Import other packages directly, since a
wrapper that adds nothing is just indirection.

# Comments

Only write a comment that is _absolutely necessary_: one without which it would be hard to work out what is going
on, and why. Everything else is noise. Default to no comment.

Before writing one, try to make it unnecessary. A precise name is almost always better than a comment explaining a
vague one: `DOCS_SOURCE_REPO` needs no comment where `DOCS` needs three lines. If the rationale is long, it belongs
in docs/ once, with the code pointing at it.

Never write a comment that:

- trivially explains what the code does, or restates a name, type or condition already visible on the line
- justifies, editorializes or argues for the approach taken
- refers back to previous versions of the codebase, or to why something changed, without an extremely motivating
  reason

Keep the ones that survive short. A necessary comment is usually one line.

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

docs/ and the README are user-facing. Keep implementation detail out of them, except in docs/architecture.md, which
is for contributors.

# Editing

Run `pnpm run format` and `pnpm run check` (or a subset that typechecks your changes) before reporting back.

Once a goal or feature is complete, run `pnpm run lint:fix` and fix all lint errors as a cleanup step.

# Running the app in a worktree

Full details in docs/dev_instances.md.

Worktrees live in `~/projects/slm/<name>`, outside the repo. `EnterWorktree` puts them there and installs
node_modules on the way, via the hooks in `.claude/settings.json`. By hand it is `pnpm worktree new <name>`, which
provisions the dev instance too.

From a worktree, do not run `pnpm server:dev` or `pnpm client:dev`, and do not use ports 3000/5173. Those belong to
the main checkout, and an app you reach there is not running your changes. Each worktree gets its own instance, on
its own ports, with its own database and an emulated squad server:

```sh
pnpm dev:init    # once per worktree: claims a port slot, links .env, clones the db. Prints the url.
pnpm dev         # the app, the client and the emulator. Prints the url again.
pnpm -s dev:url  # just the url, for reporting
pnpm dev:slots   # which worktree owns which ports
```

`pnpm dev` is long-lived, so an agent must start it as a tracked background job (`run_in_background`).

That url, `http://localhost:<client port>/?login=<user>`, is the whole instance and the only one to hand anyone.
Everything else is proxied behind it, and it arrives signed in, since discord oauth is off for dev instances. Wait
for the port to answer before opening it: a request that lands during boot fails the bypass and bounces into the
real Discord oauth flow, which looks like the bypass is broken when it is not.

Drive the emulated server with `pnpm emuctl <command>` (`pnpm emuctl help`) rather than trying to reach a real squad
server. For example `pnpm emuctl join Alice`, `pnpm emuctl chat Alice '!vote 1'`, `pnpm emuctl end 1`.

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
`CtxDef` beside it; see docs/architecture.md, "Context as duck-typed dependency injection".

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

# Migrations

Data migrations are applied by a custom runner, `pnpm db:migrate` (see ./src/server/migrate.ts). It is
backwards-compatible with `drizzle-kit generate`.
