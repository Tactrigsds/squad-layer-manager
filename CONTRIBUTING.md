# Contributing

## Pull Request Guidelines

All contributions must pass all tests and linting checks before being reviewed.

LLM co-authored code is acceptable, but it:

- Must resolve a previously agreed upon and known issue
- Must be disclosed as being LLM authored, and should include which models were used
- Should be a reasonable size
- Must be thoroughly tested, including e2e/integration tests where applicable
- Must have a human-authored PR description and comments

You are responsible for the code you submit, and you must be able to read and understand it to respond to
feedback. If you are not a programmer fluent in TypeScript (or Rust where applicable), do not contribute.

If you find a problem with the app, open an issue to validate it before working on a PR.

## Getting your bearings

[docs/architecture.md](docs/architecture.md) describes the shape of the app and the patterns that recur
throughout it: the layering, the conventions it leans on (context composition, result codes, namespace imports,
schema-first models), the server and client state machinery, and the layer engine. Skim it before your first
change. [CLAUDE.md](CLAUDE.md) states the rules that architecture.md explains.

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

Copy [.env.example.dev](.env.example.dev) to `.env` and fill in the vars it leaves uncommented. The commented-out
ones are optional and show the default they fall back to.

## Development workspace

```sh
pnpm dev
```

`dev` provisions an isolated database, emulator and port slot when needed, then starts the app and client. It prints
the only browser URL to use.

To work on more than one change at once, create a Git worktree:

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
an emulated squad server. They need no external services, but they are much slower than the unit tests.

`test:e2e` rebuilds the engine only when `layer-engine/` has changed since the last build. Nix is optional:
if the primary checkout has an untracked `flake.nix` and `nix` is installed, `test:e2e` runs inside its dev shell.

`test:e2e:firefox` needs firefox installed once (`pnpm exec playwright install firefox`), and `check:compat`
needs a client build to read. See [Browser support](docs/architecture.md#browser-support) for what each covers
and where the supported-browser floor is set.

## The server agent

The server agent ([server-agent/agent](server-agent/agent)) is a standalone rust binary, separate from the app and
not needed to run it. It streams a server's logs to SLM and proxies its RCON. Build it with:

```sh
pnpm run build:agent   # cargo build --release, binary at server-agent/agent/target/release/slm-server-agent
```

See [docs/server_agent.md](docs/server_agent.md) for how to configure it.

## The documentation site

The markdown under `docs/`, this file and `CHANGELOG.md` are also built into a static site:

```sh
pnpm run docs:build   # writes dist-docs/
pnpm run docs:dev     # builds, serves on http://localhost:4400 (DOCS_PORT), and rebuilds on change
```

A markdown file becomes a page only when it is listed in `PAGES` in
[src/models/docs-site.models.ts](src/models/docs-site.models.ts), which also sets its sidebar group. Write links
between files as ordinary relative markdown links, so they work on GitHub too. The build turns a link to a listed file
into a link to its page, and a link to any other file into a link to it on GitHub.

The build fails on a link to a heading that does not exist, and on a code block labelled with a language it has no
grammar for. Add a grammar to `LANGS` in [src/scripts/build-docs.ts](src/scripts/build-docs.ts) if you need a new
one.

The site keeps one folder per version. `/next/` is built from main. Each release is built once from its tag into its
own folder (`/v2026.9.4/`) and never rebuilt. The landing page and the changelog are kept at the root, rebuilt from
main, and link to the latest release. `docs:build` builds `/next/` and the root, so locally the root
points at `/next/`. [.github/workflows/docs-pages.yml](.github/workflows/docs-pages.yml) publishes to the `gh-pages`
branch on every change to the docs on main, on every release tag, and on a manual run.

Take screenshots at a device scale factor of 2, then mark them so the site shows them at their on-screen size:

```sh
node scripts/stamp-png-density.mjs 2 docs/configuring_screenshots/new_shot.png
```

## The changelog and app releases

A pull request that changes something a user or operator can notice adds a fragment to `changes/`. The format,
and how to decide whether a change needs one, are in [changes/README.md](changes/README.md). CI fails a pull request
that needs one and has neither a fragment nor `Changelog: none` in its description.

Every green commit on main is still published as `:latest` and deployed. A release is a named batch of those:

```sh
pnpm release    # moves changes/*.md into changelog/<version>/ and regenerates CHANGELOG.md
```

Commit the result on a branch and merge it. Once CI passes on the merged commit, it tags the commit
`v<version>` and the image `:<version>` and `:stable`.

`pnpm release` also lists the commits since the last release that have no fragment. Read them before merging: add
a fragment for any that should have had one and run it again.

Versions are `year.month.number` (`2026.9.4` is the fourth release of September 2026). A version records when
a release was cut, not what broke. Breaking changes are listed in each release's operator notes. The plugin API keeps its own semver version
(`API_VERSION` in `src/models/plugins.models.ts`), since plugins depend on it.

## Releasing a layer artifact pair

The pair in `assets/layers` is built from the layer sources under `data/sources`, which are tracked. Those exports
come off a Squad install with the workshop mods subscribed, so refreshing them for a new game version is a local
step. The refreshed exports reach a release by being committed first. Everything downstream of them is reproducible
from the repo: a rebuild of the shipped `v10.5.0` pair from the inputs below matches it byte for byte.

Rebuilding takes two things a checkout does not have: the 150MB scores csv, and the `layer-db.json` that lists which
of its columns to ingest. `release:layers` recovers both, so nobody needs to keep a copy of either:

```sh
pnpm release:layers 10.5.1              # build, test, ship, draft the release
pnpm release:layers 10.5.1 --dry-run    # build it and stop
```

- the csv comes off the newest Layer Data release, since each one carries the csv it was built from.
  `--csv-release` picks a different one, `--csv` uses a local file
- the column config is read back out of a pair already in `assets/layers`, since preprocess bakes the defs it built
  with into `layer-data.json`. Your own `layer-db.json` wins if you have one

The image ships that pair, so a layer release is also a commit on main. Each step gates the next:

1. it starts from a clean `main` in sync with `origin`, or it stops. `--no-preflight` skips the checks, and then it
   builds and releases without committing anything
2. `pnpm preprocess` builds the pair into `assets/layers`
3. `pnpm test:e2e` runs against what was just built
4. the json and the `.bin.gz` are committed and pushed to main. The uncompressed table and the csv stay out of git
5. all four go up as a prerelease tagged `layer-db-v<version>`, drafted unless you pass `--publish`

The push happens before the release so nothing is announced that main does not have. Needs the
[`gh` cli](https://cli.github.com) logged in.

The version is a label you choose. Nothing reads it out of the repo. It stamps the filenames, and the same csv
builds whatever version you name. It has to sort _above_ the pair it replaces or `@latest` will not pick it up. That
rules out a suffix, since a suffixed version is a semver prerelease and sorts below.

## The pre-push hook

The hook is optional and enabled per clone. It runs the test, formatting and linting checks before each push:

```sh
pnpm setup:hooks    # git config core.hooksPath .githooks
pnpm remove:hooks   # undo
```

Installing it is recommended. CI runs the same checks, and the hook catches failures before you push. It skips the
e2e and integration tests because they take too long. CI runs those on every pull request and on pushes to main.

To skip it for a push:

```sh
git push --no-verify
```

The hook can be found in [.githooks/pre-push.js](.githooks/pre-push.js).

## Formatting

[oxfmt](https://oxc.rs/docs/guide/usage/formatter) formats everything. It is configured in
[.oxfmtrc.json](.oxfmtrc.json) and pinned to an exact version, because its output can shift between minors while it
is in beta.

```sh
pnpm run format         # write
pnpm run format:check   # what the pre-push hook and CI run
```

For editor support, install the [Oxc extension](https://zed.dev/extensions/oxc) for Zed or
[oxc.oxc-vscode](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode) for VS Code. Both format with
the repo's own oxfmt. `.zed/settings.json` and the devcontainer already point at it.

The formatter also sorts imports into four groups, separated by blank lines: side effect, external, internal (`@/`,
`$root/`), then relative. A side-effect import is hoisted to the top of the file wherever you write it, because its
evaluation order matters and the sorter cannot reason about it.

The whole-tree reformat commits are listed in [.git-blame-ignore-revs](.git-blame-ignore-revs). To keep `git blame`
readable:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```
