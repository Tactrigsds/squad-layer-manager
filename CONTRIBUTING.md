# Contributing

## Pull Request Guidelines

All contributions must pass all tests and linting checks before being reviewed.

LLM co-authored code is acceptable, but it:

- Must resolve a previously agreed upon and known issue
- Must be disclosed as being LLM authored, and should include which models were used
- Should be a reasonable size
- Must be thoroughly tested, including e2e/integration tests where applicable
- Must have a human-authored PR description and comments

You as the contributor must take responsibility for the code you submit, and you need to be able to understand/read it in order to deal with feedback. If you are not a programmer yourself that's not fluent in typescript(or rust where applicable), then you shouldn't contribute.

If you find an issue with the app, it's recommended that you submit an issue first for validation before working on a PR.

## Getting your bearings

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes what the app is built out of: the layering, the
conventions it leans on (context composition, result codes, namespace imports, schema-first models), the
server and client state machinery, the layer engine, and a list of quirks that are easier to read about than
to discover. Worth a skim before your first change, and [CLAUDE.md](CLAUDE.md) states the rules it explains
the reasoning behind.

## Prerequisites

nodejs 24.18.0
pnpm

## Setup

```sh
pnpm install
pnpm run build:engine   # the layer engine is rust -> wasm and the wasm blob is not checked in
pnpm exec playwright install chromium   # only needed if you want to run the e2e suite
```

## Dev Container

There is a devcontainer configured that reproduces a working environment on linux. Not yet tested on macos or wsl.

## Environment Variables

Copy [.env.example.dev](.env.example.dev) to `.env` and fill in the vars it leaves uncommented; the commented-out ones are optional and show the default they fall back to.

## Running the App

```sh
## Get the database ready
pnpm run db:migrate

## run the server

pnpm run server:dev

## in a separate terminal...
pnpm run client:dev
```

### Several at once

To work on more than one change at a time, run each in its own git worktree as a self-contained instance --
its own ports, database and emulated squad server, so no two contend for a real server or for 5173:

```sh
pnpm dev:init   # once per worktree
pnpm dev:emu    # the emulated squad server
pnpm dev        # the app + client
```

See [docs/DEV_INSTANCES.md](docs/DEV_INSTANCES.md).

## Tests

| command                 | what it runs                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `pnpm test`             | unit tests (vitest)                                                     |
| `pnpm test:integration` | boots the real app against the squad server emulator, per test file     |
| `pnpm test:e2e`         | builds the engine + client bundle, then drives that app with playwright |

Both the integration and e2e suites spawn a real app instance (child process, ephemeral db and ports) against
an emulated squad server, so they need no external services, but they are slow relative to the unit tests.

## The server agent

The server agent ([server-agent/agent](server-agent/agent)) is a standalone rust binary, separate from the app and not needed to run it. It streams a server's logs to SLM and proxies its RCON. Build it with:

```sh
pnpm run build:agent   # cargo build --release, binary at server-agent/agent/target/release/slm-server-agent
```

See [docs/CONFIGURING.md#server-agent](docs/CONFIGURING.md#server-agent) for more details on how to configure it.

## The pre-push hook

Optional, and opt-in per clone. Once enabled, it runs the test, formatting, and linting checks before pushing:

```sh
pnpm setup:hooks    # git config core.hooksPath .githooks
pnpm remove:hooks   # undo
```

All of the same checks are run in CI on PRs and pushes to main, so I would recommend installing the hooks to catch issues early.

To skip it for a push:

```sh
git push --no-verify
```

The hook lives in [.githooks/pre-push.js](.githooks/pre-push.js).
