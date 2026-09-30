# Domain Glossary

Here are some common terms/phrase that you may find in SLM and their meanings

- Squad : the online team-based tactical fps that this program is made to serve
- Game Server : a gameserver that players can connect to to play Squad
- Faction : a military organization that's playable in the game, like CAF, RGF, USMC
- Unit : A particular configuration of vehicles and weapons for a particular faction and map
- Map : a particular environment that squad matches can be played in
- Layer : the configuration available to administrators for a match of squad, including map, gamemode, version, and factions/units for both teams. Example: Gorodok_RAAS_v1 USA+Motorized RGF+Armored
- Team 1/2 : the two teams in a match of squad. players on each time switch sides between 1/2 on consecutive matches
- Team A/B : a persistent group of players across multiple matches
- Player : someone who is currently in a match of squad. Admins are also considered players for our purposes
- User : Someone who is signed in to SLM.

# Common locations

- src/lib - generic utility code that doesn't relate to what our app is about directly
- src/models - assumed to be stateless side-effectless types, schemas and logic related to a particular topic
- src/systems - both client and server-side code which may be side-effectful and which may hold module-level state
- src/frames and src/frame-partials - similar to systems but client-only and zustand-based, and have well-defined lifecycle hooks. "partials" are potentially reusable across frames
- src/components - react components. Ideally fairly dumb, delegating most of their logic to models/systems.
- src/messages - contains all of the prose/copy used in the app

# General

Flag any breaking change to persisted data structures or configuration, so the user can deal with it. That covers
the frontend (localStorage) and the backend (database, config, environment variables).

Prefer copy-on-write unless mutation is proven safe or the code is a hot path.

Async functions which kick off async work and which return a promise or async iterable should take a cancellation signal by default. For non-lib functions, pass it via the ctx object (see
src/models/context-shared.ts). The client is not converted to this pattern yet, so use judgement about when to
upgrade a function. Never leave a dangling promise.

When branching on a union, especially a discriminated one, cover the default case with `assertNever()` from
src/lib/type-guards.ts, so adding a member raises a type error.

Use namespace imports for all nontrivial modules, unless that module has an established convention against it. Each
namespace must be consistent and unique across the app, except for special cases like the imports in context.ts and
context-shared.ts. Use convenient abbreviations or acronyms for commonly used lib modules, model modules and
packages. The lib vocabulary is in docs/architecture.md under "Namespace imports everywhere".

Never import rxjs, zustand, react-rxjs or zod directly. Each is reached through its wrapper in `src/lib` (`Rx`,
`Zus`, `ReactRx`, `@/lib/zod`), which re-exports the package alongside our own additions. Import other packages
directly, since a wrapper that adds nothing is just indirection.

Plugins under `plugins/` are the exception for rxjs, because `slm/lib/rxjs-ext` carries only our additions and
rxjs is not part of the slm API contract, and for zod, whose bare specifier is part of that contract and resolves
to the app's own instance through the importmap in index.html.

# Comments

Only write a comment that is _absolutely necessary_: one without which it would be hard to work out what is going
on, and why. Everything else is noise. Default to no comment.

Before writing one, try to make it unnecessary. A precise name is almost always better than a comment explaining a
vague one: `DOCS_SOURCE_REPO` needs no comment where `DOCS` needs three lines. Rationale that belongs to a
particular piece of code is kept with it, in a comment, however long it has to be. Only the high-level shape of the
app is kept in docs/architecture.md.

Never write a comment that:

- trivially explains what the code does, or restates a name, type or condition already visible on the line
- justifies, editorializes or argues for the approach taken
- refers back to previous versions of the codebase, or to why something changed, without an extremely motivating
  reason

Keep the ones that survive no longer than their point needs. Most are one line.

# Documentation, prose and app text

Short declarative sentences, one idea each. State the fact, then the reason if the reason is needed.

Do not use emdashes.

Cut anything that tells the reader how to feel about the code: "worth internalizing", "the honest test", "elegant",
"surprisingly". Cut throat-clearing that delays the fact. Prefer "X does Y" over "the thing to understand about X is
that it does Y".

Say what a thing does to the reader's things, or what the reader can do with it, not where it is or what it has. The
test is whether the reader can act on the sentence without translating it. This is a principle, not a list of
phrases: any sentence whose main verb is possession ("has", "comes with", "contains", "has access to") or location
("is in", "runs inside", "is integrated with") needs a second look, however plain it reads.

Location is fine where it is the point ("`test:e2e` runs inside its dev shell"). Say it plainly then: something is
stored, kept or held somewhere, or can be found there. It does not live or sit there. "Belongs to" is for ownership,
never for location.

Do not hedge a statement to make it safe ("most of", "mostly", "generally", "in most cases"). State what is true
plainly, and name the exception if one matters.

- Before: "A plugin runs inside SLM with full access to it."
- After: "A plugin can do anything SLM can, including editing the queue, running commands on your game servers, and
  reading and changing SLM's database."
- Before: "Most of the app has them, so hover over anything you do not recognise."
- After: "Tooltips can be found throughout the app. Hover over a button, icon or label you do not recognise to see
  more about it."

Look for the most specific verb for the action. Generic verbs such as "tells", "says", "handles", "deals with",
"does", "gets" and "makes" often force the reader to guess the action, so treat each one as a prompt to find a
sharper verb: "describes", "warns", "records", "declares", "rejects". Keep the generic verb when it is already the
precise one, as "gets" is for a function that fetches a value.

- Before: "A "Breaking" note tells you something to do."
- After: "A "Breaking" note describes a change you must make to upgrade."

Keep concrete numbers, file paths, code and tables. Those are the signal.

"Team A" and "Team B" are not free vocabulary. They mean `MH.NormedTeamId`, the team normalized across the
team1/team2 swap, as against "Team 1" and "Team 2" for the raw slot. Never use A/B to mean an unordered or
interchangeable side, which is roughly the opposite of what it denotes, and be aware that any UI toggling labels
between A/B and 1/2 will read as driving the `displayTeamsNormalized` setting. Use "one side" and "the other side"
when you need a side with no identity.

docs/ and the README are user-facing. Keep implementation detail out of them, except in docs/architecture.md, which
is for contributors.

# Editing

Before reporting back on prose you wrote (docs, app text, comments, PR descriptions), re-read every new sentence
against the rules in "Documentation, prose and app text" and "Comments". Check each against the principles, not only
the example phrases they list.

Run `pnpm run format` and `pnpm run check` (or a subset that typechecks your changes) before reporting back.

Once a goal or feature is complete, run `pnpm run lint:fix` and fix all lint errors as a cleanup step.

# Worktrees and the shell

Several sessions share the main checkout at once, each with uncommitted work. Do not edit, commit, stash or switch
branches there unless the user asks for it. Start work with `EnterWorktree` or `pnpm worktree new <name>`, never a
raw `git worktree add`: those two copy in node_modules and the gitignored artifacts (`assets/layer-engine.wasm`,
`layer-db.json`) a build needs. When moving work out of the main checkout, remove the originals there afterwards.

In a worktree session the Bash tool refuses any command it cannot prove stays inside the worktree. Keep commands
flat:

- one git or gh command per call, with no `$(...)` feeding it
- no `for` loops, `xargs` or `bash script.sh` around git, pnpm, npx, sed or gh
- multi-file edits as a script written to the scratchpad with Write and run as `python3 <file>`, not a heredoc

Never `sleep N; tail` to wait on something. Run it with `run_in_background` and get notified when it exits, or use
Monitor with an until-loop. Stop a background job with TaskStop. `pkill -f <pattern>` matches the calling shell's own
command line and kills it.

# Running the app in a worktree

Full details in docs/dev_instances.md.

Do not run `pnpm server:dev` or `pnpm client:dev`, and do not use ports 3000/5173. A development workspace runs its
own instance instead, with its own database and an emulated Squad server:

```sh
pnpm dev          # provisions the workspace, then starts the app, client and emulator
pnpm dev --url    # just the URL, for reporting
pnpm dev --wait   # block until a running `pnpm dev` answers
pnpm emuctl help  # drive the emulated server: join, chat, end, cycle
pnpm probe <path> # headless chromium against the instance: --shot, --target, --click, --eval, --script
```

`pnpm dev` works from any checkout, including one made by a Git worktree command or an agent. It is long-lived, so an
agent must start it as a tracked background job (`run_in_background`).

`pnpm dev --url` prints the one URL the instance answers on, and it is the only one to hand anyone. Run `pnpm dev
--wait` before opening it: a request that lands during boot bounces into the real Discord oauth flow, which looks
like the bypass is broken when it is not. Edits hot-reload, so there is no need to restart `pnpm dev` after one.

When checking UI with `pnpm probe`, screenshot the element under test (`--target`) rather than the page, and read
the result back only when a picture is the question. A still cannot show hover, overlays that eat pointer events,
or gaps in a hit area: check those with `document.elementFromPoint` at the points that matter.

Never point a development workspace at a real Squad server or the real BattleMetrics org. `pnpm dev` deliberately scrubs those,
and re-adding them means an experiment drives production.

# Pull requests

Check for potential merge conflicts before pushing commits to a PR. For frontend changes, always include a link to
the running dev server with the changes up.

Treat every CI failure as a bug to find, including one that looks unrelated to the diff. Do not re-run a job and call
it flaky: find the cause, or show the user the evidence that it is a known flake.

# Server side

Log significant actions taken by the user or by the system via app events (see src/models/app-events.models.ts).

Pass commonly used state via the ctx object. It is always the first argument, or for observables always the first
element of the observable's data tuple. A domain's contexts are kept in that domain's models file (`V.Ctx`, `MH.Ctx`,
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

Before building UI that shows data, look for an existing component that already displays the same kind of data
(filter cards, layer displays, player rows) and reuse or extend it.

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

`pnpm test:integration` and `pnpm test:e2e [spec...]` need no environment setup. Extra args to `test:e2e` go to
playwright. Nothing under test/harness may import `@/messages/i18n`: it imports JSON, which Playwright cannot load.
Tests must not depend on `data/generated/messages`, which exists locally but not in CI.

Whenever we add or modify integration/e2e tests, or behavior which may affect one or more existing tests integration/e2e tests, let's take extra care that we have not introduced any flaky/race condition behaviors, in either the test itself or the excercized logic. Run the relevant tests multiple times to catch any potential flakiness.

# Changelog

When a change is something a user or operator could notice without reading the code or the logs, add a fragment
to `changes/` in the same PR. changes/README.md has the format and the test for what counts. Write it for the people
it affects, following the prose rules above. Otherwise put `Changelog: none` in the PR description, followed by a short reason on the same line. A breaking
change (`!` in the commit subject) always needs an `operators` fragment saying what an upgrade has to do.

# Migrations

Data migrations are applied by a custom runner, `pnpm db:migrate` (see ./src/server/migrate.ts). It is
backwards-compatible with `drizzle-kit generate`.
