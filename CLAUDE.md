# General Guidelines

Any breaking changes to persisted data structures or configuration on either the frontend(localStorage) or the backend(database,config,environment variables) need to be explicitely flagged to the user so they can be dealt with.

Prefer copy-on-write in most cases unless it's proven to be safe to do so, or is in a hot codepath.

Async functions should by-default have the option to pass a signal to cancel an operation. if it's a non-lib function, the signal should be passed via the ctx object (see src/models/context-shared.ts). The client is not yet converted to this pattern, so use your best judgement on when to upgrade a function. Always avoid dangling promises.

When branching on unions(especially discriminated unions), generally use `assertNever()` from src/lib/type-guards.ts to cover off the default case so that type errors are raised if we add new members to the union.
Use namespace imports for all nontrivial modules, unless established convention for that module contradicts this. Make sure that the chosen namespace is consistent and unique across the app, except for special cases like things imported into context.ts or context-shared.ts. Use convenient abbreviations or acronyms for commonly used lib modules, model modules, and imported packages

Only write a comment which is _absolutely necessary_: one without which it would be hard to work out what is actually going on, and why. Everything else is noise. Default to no comment.

Before writing one, try to make it unnecessary. A precise name is almost always better than a comment explaining a vague one: `DOCS_SOURCE_REPO` needs no comment where `DOCS` needs three lines. If the rationale is long, it belongs in docs/ once, with the code pointing at it.

Never write a comment which:

- trivially explains what the code does, or restates a name, type or condition already visible on the line
- justifies, editorializes or argues for the approach taken
- refers back to previous versions of the codebase or to why something changed, unless there's an extremely motivating reason to do so

Keep the ones which survive short. A necessary comment is usually one line.

# Editing

Run `pnpm run format` and `pnpm run check`(or some subset to typecheck your specific changes) before reporting your changes to the user.
If we've completed a goal or feature, then run `pnpm run lint:fix` and fix all lint errors as a cleanup step.

# Running the app in a worktree

If you are working in a git worktree, do not run `pnpm server:dev` / `pnpm client:dev` and do not use ports 3000/5173: those belong to the main checkout, and an app you reach there is not running your changes. Each worktree gets its own instance instead, on its own ports, with its own database and an emulated squad server:

```sh
pnpm install    # a fresh worktree has no node_modules of its own; dev:init fails ("No preset version ... tsx") until this runs
pnpm dev:init   # once per worktree: claims a port slot, links .env, clones the db. Prints your URL.
pnpm dev:emu    # the emulated squad server. Leave it running, it is a separate process on purpose.
pnpm dev        # the app + client
pnpm dev:slots  # which worktree owns which ports
```

`pnpm dev` and `pnpm dev:emu` are long-lived; an agent must start them as tracked background jobs (`run_in_background`).

Log in with `?login=<username>` (discord oauth is off for dev instances -- `dev`'s env sets `QUERY_PARAM_AUTH_BYPASS`/`DISCORD_ENABLED=false` for you; any username in the cloned db works). Wait for the app port to be listening before you hit `?login=`: navigating during boot fails the bypass request and bounces you into the real Discord oauth flow, which looks like the bypass is broken when it is not. Drive the emulated server with `pnpm emuctl <command>` (`pnpm emuctl help`) rather than trying to reach a real squad server -- e.g. `pnpm emuctl join Alice`, `pnpm emuctl chat Alice '!vote 1'`, `pnpm emuctl end 1`.

Never point a worktree at a real squad server or the real battlemetrics org; `dev:init` deliberately scrubs those, and re-adding them means an experiment drives production.

See docs/dev_instances.md.

# Pull Requests

Always do a check for potential merge conflicts before pushing commits to a PR. For frontend changes, always provide a link to the running dev server with the changes up.

# Documentation, prose and app text

No emdashes.

# Server side

Significant actions taken by the user or by the system need to be logged via app events (see src/models/app-events.models.ts)

Commonly passed pieces of state should passed via the ctx object, which should always be the first argument, or in the case of observables, always the first element of the observable's data's tuple. Always check what's already available in context.ts and context-shared.ts before expanding it.

Functions should only specify the minimal amount of context that they need in the ctx parameter type signature.

# Client side

In the main checkout the vite dev server runs on http://localhost:5173 by default. In a worktree it does not: see "Running the app in a worktree" below for the port, and do not assume 5173 is yours.

Stores / frames should be used, at minimum, whenever:

- a component's state is dependent on mutable props. In this case, the component should be passed some variant of ZusUtils.AnyInput<T> in the `stores` prop instead. that input could be contain a derifed state or event sream from some other store, or the store itself.
- We have significant interdependencies between different pieces of state. stores/frames have good facilities for dealing with more reactive state, so use that instead of a useEffect/useState pattern, which should always be a codesmell.

Frames should be used instead of raw zustand stores where the state is non-global and the store may be created and destroyed. Frames can and should directly query and subscribe to async data sources.

Pass any `ZusUtils.AnyInut` instances via the `stores` prop through components(conventionally they should have a KeyProp or a StoreProp defined to standardize what property they should be put on in `props.stores`), and avoid using react context to pass stores or other data sources.

In components, prefer modifying or adding selectors over computing intermediate state in the component body with useMemo. `ZusUtils.useStore` is helpful here, as it allows you to merge multiple data sources together for use in a single selector.

Use the established convention of `Sel` namespaces for selectors.

Generally speaking, actions by the user should be handled at the top level by a function in the relevant system/frame's `Actions` namespace. Avoid closing over or passing state from the component body to the action handler unless it's indirect state, like a store or any other variant of `ZusUtils.AnyInput`, unless absolutely necessary.

Never export non-components from .tsx files, as it breaks hot module replacement.

Never hardcode a z-index. Take one from src/models/zindex.ts via `useZIndex(ZI_OFFSETS.<BAND>)`, which picks the band for what you're layering (in-container overlays, sticky headers, popovers, tooltips, draggable windows, dialogs). Its offsets are relative to the nearest enclosing `BaseZIndexContext` rather than absolute, so a bare `z-50` is right up until the component is rendered inside a dialog or a draggable window. For sticky headers nested inside other sticky headers, use the `StickyGroup` component instead of picking offsets yourself: it measures ancestor heights and assigns both the `top` offset and the z-index.

Avoid controlled inputs and textareas (don't set `value`). Do the same for other fields that are latency-sensitive. make sure we debounce inputs which may otherwise cause frequent re-renders.

# Testing

Unit tests should be reserved for code with two properties: being actually complex, and being largely self-contained, or at least isolatable. Do not write unit tests for trivial code.
Most complex features should be instead covered by integration/e2e tests. Don't try to exhaustively excerise all codepaths -- focus on particularly tricky ones. If convenient, semantic html tags that make the playwright code(and accessibility as a side-effect) better.

# Migrations

Data migrations applied via a custom runner `pnpm db:migrate`. (see ./src/server/migrate.ts) it is backwards-compatible with `drizzle-kit generate`.
