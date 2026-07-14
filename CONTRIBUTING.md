# Contributing

## Setup

```sh
pnpm install
pnpm run build:engine   # the layer engine is rust -> wasm and the wasm blob is not checked in
pnpm exec playwright install chromium   # only needed if you want to run the e2e suite
```

There is a devcontainer configured that reproduces a working environment on linux. Not tested on macos or wsl.

The layer artifacts themselves _are_ checked in (`assets/layers`), so there is nothing to download before
the app or the tests can boot. See the README for how they are resolved.


Make sure to configure `.env` according to what's required in [env.ts](src/server/env.ts).
```sh
pnpm run server:dev0
```

## Tests

| command                 | what it runs                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `pnpm test`             | unit tests (vitest)                                                     |
| `pnpm test:integration` | boots the real app against the squad server emulator, per test file     |
| `pnpm test:e2e`         | builds the engine + client bundle, then drives that app with playwright |

Both the integration and e2e suites spawn a real app instance (child process, ephemeral db and ports) against
an emulated squad server, so they need no external services, but they are slow relative to the unit tests.

## The pre-push hook

Optional, and opt-in per clone:

```sh
pnpm setup:hooks    # git config core.hooksPath .githooks
pnpm remove:hooks   # undo
```

Once enabled, pushing to `main` (and only `main` -- pushes to any other branch are left alone) runs the full
suite before the push goes out, in this order, stopping at the first failure:

1. `pnpm run format:check` -- dprint
2. `pnpm run check --force` -- `tsc -b`, forced so an incremental build can't serve a stale pass
3. `pnpm run lint` -- oxlint, type-aware
4. `pnpm run test` -- unit tests
5. `pnpm run build:engine` -- the wasm the app loads at runtime, needed by everything below
6. `pnpm run test:integration`
7. `pnpm run test:e2e` -- builds the client bundle, then runs playwright

This mirrors what CI does on the way to tagging an image (see `.github/workflows/integration-tests.yml`), so a
green hook run means a push to `main` should not come back red. It also means a push to `main` takes minutes
rather than seconds, which is the trade being made deliberately: `main` is what gets built and deployed.

To skip it for a push:

```sh
git push --no-verify
```

The hook lives in [.githooks/pre-push.js](.githooks/pre-push.js).
