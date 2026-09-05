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

[docs/architecture.md](docs/architecture.md) describes the shape of the app and the patterns that recur
throughout it: the layering, the conventions it leans on (context composition, result codes, namespace imports,
schema-first models), the server and client state machinery, and the layer engine. Worth a skim before your
first change. [CLAUDE.md](CLAUDE.md) states the rules it gives the reasoning for.

## Prerequisites

nodejs 24.18.0
pnpm

## Dev Container

There is a devcontainer configured that reproduces a working environment on linux. Not yet tested on macos or wsl.

## Setup

```sh
pnpm install
pnpm exec playwright install chromium   # only needed if you want to run the e2e suite
```

## Environment Variables

Copy [.env.example.dev](.env.example.dev) to `.env` and fill in the vars it leaves uncommented; the commented-out ones are optional and show the default they fall back to.

## Development workspace

```sh
pnpm dev
```

`dev` provisions an isolated database, emulator and port slot when needed, then starts the app and client. It prints
the only browser URL to use.

To work on more than one change, create an optional Git worktree:

```sh
pnpm worktree new <name> # creates and provisions a workspace
cd ~/projects/slm/<name>
pnpm dev
```

Any checkout location works, including one made by `git worktree add` or an agent. `pnpm dev --reset-data` replaces
that checkout's isolated database. `pnpm dev --emu-only` runs only the emulator with its REPL. See
[docs/dev_instances.md](docs/dev_instances.md).

## Tests

| command                 | what it runs                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `pnpm test`             | unit tests (vitest)                                                     |
| `pnpm test:integration` | boots the real app against the squad server emulator, per test file     |
| `pnpm test:e2e`         | builds the engine + client bundle, then drives that app with playwright |
| `pnpm test:e2e:firefox` | the `@firefox`-tagged part of the e2e suite, on firefox instead         |
| `pnpm check:compat`     | checks the built client against the browsers we support                 |

Both the integration and e2e suites spawn a real app instance (child process, ephemeral db and ports) against
an emulated squad server, so they need no external services, but they are slow relative to the unit tests.

`test:e2e:firefox` needs firefox installed once (`pnpm exec playwright install firefox`), and `check:compat`
needs a client build to read. See [Browser support](docs/architecture.md#browser-support) for what each covers
and where the supported-browser floor is set.

## The server agent

The server agent ([server-agent/agent](server-agent/agent)) is a standalone rust binary, separate from the app and not needed to run it. It streams a server's logs to SLM and proxies its RCON. Build it with:

```sh
pnpm run build:agent   # cargo build --release, binary at server-agent/agent/target/release/slm-server-agent
```

See [docs/server_agent.md](docs/server_agent.md) for more details on how to configure it.

## Releasing a layer artifact pair

The pair in `assets/layers` is built from the layer sources under `data/sources`, which are tracked. Those exports
come off a Squad install with the workshop mods subscribed, so refreshing them for a new game version is a local
step, and it reaches a release by being committed first. Everything downstream of them is reproducible from the
repo: a rebuild of the shipped `v10.5.0` pair from the inputs below matches it byte for byte.

Rebuilding takes two things a checkout does not have: the 150MB scores csv, and the `layer-db.json` that says which
of its columns to ingest. `release:layers` recovers both, so nobody has to hold either one:

```sh
pnpm release:layers 10.5.1              # build, test, ship, draft the release
pnpm release:layers 10.5.1 --dry-run    # build it and stop
```

- the csv comes off the newest Layer Data release, since each one carries the csv it was built from.
  `--csv-release` picks a different one, `--csv` uses a local file
- the column config is read back out of a pair already in `assets/layers`, since preprocess bakes the defs it built
  with into `layer-data.json`. Your own `layer-db.json` wins if you have one

That pair is what the image ships, so a release is a commit on main as much as it is a release. Each step gates the
next:

1. it starts from a clean `main` in sync with `origin`, or it stops. `--no-preflight` skips the checks, and then it
   builds and releases without committing anything
2. `pnpm preprocess` builds the pair into `assets/layers`
3. `pnpm test:e2e` runs against what was just built
4. the json and the `.bin.gz` are committed and pushed to main. The uncompressed table and the csv stay out of git
5. all four go up as a prerelease tagged `layer-db-v<version>`, drafted unless you pass `--publish`

The push happens before the release so nothing is announced that main does not have. Needs the
[`gh` cli](https://cli.github.com) logged in.

The version is a label, not something read out of the repo: it is what stamps the filenames, and the same csv
builds whatever version you name. It has to sort _above_ the pair it replaces or `@latest` will not pick it up,
which rules out a suffix: those are semver prereleases and sort below.

## The pre-push hook

Optional, and opt-in per clone. Once enabled, it runs the test, formatting, and linting checks before pushing:

```sh
pnpm setup:hooks    # git config core.hooksPath .githooks
pnpm remove:hooks   # undo
```

All of the same checks are run in CI, so I would recommend installing the hooks to catch issues early. E2e/integration tests are skipped due to run length. CI runs those on every pull request and on pushes to main.

To skip it for a push:

```sh
git push --no-verify
```

The hook lives in [.githooks/pre-push.js](.githooks/pre-push.js).

## Formatting

[oxfmt](https://oxc.rs/docs/guide/usage/formatter) formats everything, configured in [.oxfmtrc.json](.oxfmtrc.json) and pinned to an exact version because its output can shift between minors while it is in beta.

```sh
pnpm run format         # write
pnpm run format:check   # what the pre-push hook and CI run
```

Editors: install the [Oxc extension](https://zed.dev/extensions/oxc) for Zed or [oxc.oxc-vscode](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode) for VS Code, both of which format with the repo's own oxfmt. `.zed/settings.json` and the devcontainer already point at it.

The formatter also sorts imports into four groups, blank-line separated: side effect, external, internal (`@/`, `$root/`), then relative. A side-effect import is hoisted to the top of the file wherever you write it, since its evaluation order matters and the sorter cannot reason about it.

The whole-tree reformat commits are listed in [.git-blame-ignore-revs](.git-blame-ignore-revs). To keep `git blame` readable:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```
