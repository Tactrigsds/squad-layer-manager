# Writing an SLM plugin

A plugin is an extension that runs in the SLM process. It can use everything core code uses: the database, match
history, the layer queue, RCON, the settings page and the server dashboard. It ships as a folder of prebuilt bundles
that an admin installs from a url.

Plugins are trusted. There is no sandbox. A plugin runs in the SLM process with everything that process can do, so
only install one you would be willing to run as a fork.

## Contents

- [Before you start](#before-you-start)
- [The files](#the-files)
- [The manifest](#the-manifest)
- [The server entry](#the-server-entry)
- [Storing data](#storing-data)
- [Filters](#filters)
- [Layer queries](#layer-queries)
- [Your own rpc](#your-own-rpc)
- [The client entry](#the-client-entry)
- [Your events in the feed](#your-events-in-the-feed)
- [In-game commands](#in-game-commands)
- [Permissions](#permissions)
- [Pickers](#pickers)
- [What you can reach](#what-you-can-reach)
- [Logging and telemetry](#logging-and-telemetry)
- [Packing and publishing](#packing-and-publishing)
- [Repo layouts](#repo-layouts)
- [The dev loop](#the-dev-loop)
- [How an admin installs it](#how-an-admin-installs-it)
- [API versions](#api-versions)
- [Things that will bite you](#things-that-will-bite-you)

## Before you start

You need a checkout of SLM. `slm/*`, the alias a plugin imports the host through, resolves through this repo's
tsconfig, and `pnpm plugin:pack` runs from here. There is no separately published SDK package yet.

```sh
git clone https://github.com/Tactrigsds/squad-layer-manager
cd squad-layer-manager
pnpm install
```

Write your plugin in its own directory. `plugins/<id>/` is the natural place, and your plugin's own git repo can
be kept there without either repo noticing the other. See [Repo layouts](#repo-layouts).

Two working plugins are already there to read. `test/fixtures/plugin-hello` is about sixty lines and touches every
part of the contract. `plugins/balance-triggers` is a real one.

## The files

| File         | Required | What it holds                                                                                 |
| ------------ | -------- | --------------------------------------------------------------------------------------------- |
| `plugin.ts`  | yes      | the manifest, default-exported. Every other file imports it, so it must have no side effects. |
| `server.ts`  | yes      | `activate(ctx)`, plus `migrations` if the plugin stores anything                              |
| `client.tsx` | no       | what the plugin adds to the browser                                                           |
| `client.css` | no       | plain css for the browser, beside the classes the packer compiles                             |

Any other module is an ordinary import and is bundled in.

## The manifest

```ts
// plugin.ts
import * as z from 'zod'

import { definePlugin } from 'slm/plugin'

export default definePlugin({
	id: 'my-plugin',
	name: 'My Plugin',
	version: '1.0.0',
	apiVersion: '^0.8',
	description: 'One line, shown to admins in settings.',
	configSchema: z.object({
		greeting: z.string().prefault('hello').describe('What the plugin answers with'),
	}),
})
```

`id` is lowercase kebab-case. It namespaces your tables and your telemetry, so changing it later orphans both.

`configSchema` must be a `z.object`. SLM renders it as a form on the settings page, taking each field's help text
from `.describe()` and its default from `.prefault()`. Read the values with `PluginConfig.get(ctx)`, which always
returns the latest saved config, so a config change needs no restart.

`apiVersion` is the range of the slm API you build against. See [API versions](#api-versions).

## The server entry

`activate(ctx)` runs when the plugin starts: when an admin enables it, and on every boot after that.

```ts
// server.ts
import type * as P from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as AppEvents from 'slm/systems/app-events'
import * as MatchHistory from 'slm/systems/match-history'
import * as Reminders from 'slm/systems/post-roll-reminders'

import manifest from './plugin.ts'

export async function activate(ctx: P.Ctx<typeof manifest>) {
	// once per managed server, now and for any that appear later
	Servers.setup(ctx, (sctx, cleanup) => {
		cleanup.push(
			sctx.matchHistory.finalized$
				.pipe(
					Instr.durableSub('count-matches', { module: sctx.module }, async () => {
						const history = await MatchHistory.getRecentMatches(sctx)
						await AppEvents.emit(sctx, 'counted', { count: history.length }, `${history.length} matches on record`)
					}),
				)
				.subscribe(),
		)
	})

	// asked after each roll for the lines this plugin wants warned to admins
	Reminders.register(ctx, async (sctx) => [PluginConfig.get(sctx).greeting])
}
```

`ctx` carries:

| Field         | What it is                                          |
| ------------- | --------------------------------------------------- |
| `ctx.log`     | a logger already named for your plugin              |
| `ctx.db()`    | a drizzle handle on SLM's database                  |
| `ctx.signal`  | an `AbortSignal`, aborted when the plugin stops     |
| `ctx.cleanup` | tasks run when the plugin stops                     |
| `ctx.plugin`  | your id and manifest                                |
| `ctx.module`  | your telemetry scope, for `spanOp` and `durableSub` |

`Servers.setup(ctx, cb)` calls `cb` once per managed server. Its `cleanup` is scoped to that plugin and server
pair, so it runs when the server goes down or the plugin stops, whichever comes first. `sctx` is the per-server
ctx, and it is what the `slm/systems/*` functions take.

Everything you start has to be tied to one of those: `ctx.cleanup`, the per-server `cleanup`, or `ctx.signal`.
Work started at module scope keeps running after the plugin stops. Keep
state inside `activate()`.

Use `durableSub` for a long-lived subscription rather than a bare `.subscribe()`. It logs each error and resubscribes, so a
throwing source does not kill the subscription or the process.

## Storing data

Your tables are namespaced. `defineTables(manifest)` prefixes each name with `p_<id>_`, and the migration runner
rejects any DDL that reaches outside that prefix.

```ts
// schema.ts
import * as D from 'drizzle-orm/sqlite-core'

import { defineTables } from 'slm/plugin'

import manifest from './plugin.ts'

const t = defineTables(manifest)

export const greetings = t.table('greetings', {
	id: D.integer('id').primaryKey({ autoIncrement: true }),
	serverId: D.text('serverId').notNull(),
	text: D.text('text').notNull(),
})
```

Migrations are exported from `server.ts`. They run at activation rather than at boot, and are ledgered, so each
runs once per database.

```ts
// server.ts
import { defineTables, type PluginMigration } from 'slm/plugin'

const greetings = defineTables(manifest).name('greetings')

export const migrations: PluginMigration[] = [
	{
		name: '0001_init',
		up: (db) => {
			db.exec(`CREATE TABLE IF NOT EXISTS ${greetings} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				serverId TEXT NOT NULL,
				text TEXT NOT NULL
			)`)
		},
	},
]
```

Two rules apply. First, list migrations in name order. The host checks this. Second, build the table name from the
manifest instead of importing it from `schema.ts`. A migration is frozen in time, and renaming a table later must not
change what an applied migration did.

## Filters

A filter is a predicate over layers: what a server's pool admits, what an indicator marks. `slm/systems/filter-entity`
reads and writes the same filters admins see in the filter index. `slm/models/filter-builders` builds a filter tree
without assembling the nodes by hand.

```ts
import * as FB from 'slm/models/filter-builders'
import * as Filters from 'slm/systems/filter-entity'

await Filters.create(ctx, {
	id: 'no-seed',
	name: 'Not a seed layer',
	filter: FB.and([FB.eq('Collection', 'OWI'), FB.notInValues('Gamemode', ['Seed', 'Training'])]),
	owner: 123456789012345678n,
	description: null,
	alertMessage: null,
	emoji: null,
	invertedAlertMessage: null,
	invertedEmoji: null,
})

Filters.list() // every filter
Filters.get('no-seed') // one, or undefined
await Filters.update(ctx, 'no-seed', { name: 'No seed layers' })
await Filters.remove(ctx, 'no-seed')
Filters.changes(ctx).subscribe((c) => ...) // every write, yours included
```

`owner` is a discord user id. A filter belongs to a person even when a plugin wrote it, so name the admin who is
answerable for it. They get the filter-owner role over it and can edit it by hand afterwards.

Your writes are ordinary writes. Open editors update, the reference index rebuilds, and the audit log records a
`FILTER_CHANGED` naming your plugin rather than a person. Writing the `filters` table through `ctx.db()` skips all
of that and leaves every open page stale until a restart.

Nothing marks a filter as yours. You can write any filter, including one an admin made, and an admin can edit or
delete one you made. Prefix your ids if you want them to be recognisable.

Deactivating your plugin leaves its filters behind. This is deliberate. A server pool naming a filter that
disappeared fails every layer status query for that server. Clean up explicitly if that is wrong for yours, and
delete the pool config first.

`remove` refuses to delete a filter anything still points at, and hands back the references so you can report what.

## Layer queries

`slm/systems/layer-queries` asks the layer table the questions the web client asks it, against the same engine.
Every call takes your per-server ctx and resolves what it needs itself, so there is no setup step.

```ts
import * as CB from 'slm/models/constraint-builders'
import * as LayerQueries from 'slm/systems/layer-queries'

const res = await LayerQueries.query(ctx, {
	pageSize: 20,
	sort: { type: 'column', sortBy: 'Asymmetry_Score', direction: 'ASC:ABS' },
	constraints: [CB.filterEntity('pool', 'no-seed'), CB.repeatRule('no-repeat-map', { field: 'Map', label: 'Map', within: 3 })],
})
if (res.code === 'ok') res.layers // one page, with every column
```

|                   |                                                                |
| ----------------- | -------------------------------------------------------------- |
| `query`           | a page of layers matching the constraints                      |
| `exists`          | whether these ids name layers this install knows               |
| `info`            | every column of one layer, scores included                     |
| `componentValues` | the distinct values of one column, for a picker                |
| `outOfPool`       | which of these layers the constraints reject                   |
| `itemStatuses`    | what each queue item violates, and the warnings admins see     |
| `genVote`         | draws a layer for each undecided choice of a vote              |
| `scoreRanges`     | the min and max of every score column                          |
| `itemsState`      | the queue and recent matches a repeat rule is measured against |

Constraints narrow a query. Write them with `slm/models/constraint-builders`, not by hand. Which of
`filterApplState`, `showIndicator` and `warn` a constraint needs is not obvious, and `poolFilter` in particular does
not mean what its fields look like. The `id` you give a constraint comes back on every warning and match descriptor
it produces. That is how you identify which constraint a result is about.

Repeat rules need to know what is already queued and what was played. `query` and `itemStatuses` fill that in from
the live queue when you leave `input.list` out, which is almost always what you want. Pass `itemsState` yourself
only to ask about a queue other than the current one.

A malformed filter comes back as `{ code: 'err:invalid-node', errors }` rather than throwing. Each error names the
node and the reason, and `msg.original` is that reason in english.

`genVote` draws rather than lists. A choice either names a layer already or carries constraints to draw one from,
and `uniqueConstraints` names the properties the drawn choices have to differ on.

```ts
import * as GV from 'slm/models/gen-vote'

const res = await LayerQueries.genVote(ctx, {
	seed: 'anything-stable',
	choices: [GV.initChoice(), GV.initChoice(), { choiceConstraints: { Gamemode: 'RAAS' } }],
	uniqueConstraints: ['Map'],
	constraints: [CB.filterEntity('pool', 'no-seed')],
})
if (res.code === 'ok') res.chosenLayers // one per choice, undefined where a choice already named a layer
```

The same seed draws the same layers. To repeat a draw, keep the seed. `onlyIndex` redraws one choice and leaves the
rest. `unfilledChoices` holds the indices nothing could be found for, which is how an over-constrained draw reports
itself.

Starting the vote is not here. Draw the choices, then put them in the queue.

There is no client half. The browser runs these in a worker over its own copy of the engine, and that is not part
of the contract. Reach them from your server and hand the results to your client through your own rpc.

## Your own rpc

A plugin's rpc is [oRPC](https://orpc.unnoq.com/). The server half builds a router whose procedures receive your
per-server ctx, and the client half is created from that router's _type_, so nothing on the client is annotated by
hand.

```ts
// server.ts
import * as RBAC from 'slm/models/rbac'
import * as Rpc from 'slm/plugin/rpc.server'

const os = Rpc.os<typeof manifest>()

export const router = {
	// a plain handler is a call
	count: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => (await context.db().select().from(S.greetings)).length),
	// an async generator is a stream
	greetings: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async function* ({ context }) {
			yield await context.db().select().from(S.greetings)
		}),
}

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Rpc.register(ctx, router)
}
```

```tsx
// client.tsx
import type { router } from './server.ts'

const rpc = Rpc.client<typeof router>(ctx, serverId) // plain procedures
const streams = Rpc.stores<typeof router>(ctx) // generator procedures, as stores
```

`import type` is erased at compile time, so naming the server module in the client puts none of it in the browser
bundle. `Rpc.stores` gives a keyed family: `streams.greetings(serverId, {})` returns one store per set of
arguments, shared between every caller that passes equal ones.

Every procedure declares what its caller needs in `.meta({ access })`, and the host checks it before the handler
runs. Registering a router with a procedure that declares nothing fails. `context.user` is the signed-in user who
made the call. See "Permissions" below.

## The client entry

`client.tsx` adds to SLM's own pages through anchors: a component mounted in the server dashboard, data on a match
history row, or your own line in the activity feed.

```tsx
// client.tsx
import { definePluginClient } from 'slm/plugin/client'
import * as Slots from 'slm/plugin/slots'

import { Greeting } from './greeting.tsx'
import manifest from './plugin.ts'

export default definePluginClient(manifest, (ctx) => {
	Slots.register(ctx, 'server-dashboard:alerts', Greeting)
})
```

[Plugin UI](plugin_ui.md) covers the anchors, the components SLM lends a plugin, styling, and how to lay out the
client files.

## Your events in the feed

`AppEvents.emit(ctx, name, payload, message)` records an event against the server and the match in progress. It
shows up in the activity feed and the audit log as `message`, attributed to your plugin. Write `message` to stand
on its own: it is what the audit log shows, and what the feed shows while your plugin is stopped.

A client entry can render the feed line itself. See [Feed lines](plugin_ui.md#feed-lines).

## In-game commands

A plugin can contribute a command admins run from in-game chat. The host owns trigger matching, the
admin/public chat rule, the enabled gate and the access check.

```ts
import * as Commands from 'slm/plugin/commands'
import * as RBAC from 'slm/models/rbac'

Commands.register(ctx, {
	name: 'rolltoseed',
	description: 'Roll to a seeding layer now, without waiting for the criteria.',
	// unprefixed. The default prefix is attached unless an admin configures the command
	triggers: ['rolltoseed'],
	allowedChats: ['admin'],
	// checked against the player who typed it, on the server they typed it on
	access: RBAC.Access.req(({ serverId }) => RBAC.perm('squad-server:end-match', { serverId })),
	handler: async (sctx, input) => {
		// input.text is everything typed after the trigger; input.player is who typed it
		return 'Preparing a seed roll.'
	},
})
```

Returned text is warned back to the caller. The handler is given the ctx of whichever server the command was
typed on, so it reads that server's state without being registered per server.

Being in admin chat is not authorization. Admin chat follows Squad's admin list, not SLM's roles. See "Permissions"
below.

A plugin command takes the words after its trigger as they were typed: `input.text`, or `input.args` split on
spaces. Core commands declare typed arguments (players, squads, durations, reasons, and the prompts that
disambiguate them). The host drives those from declarations it sees at compile time, and a plugin's command has
none.

Admins retune the triggers and chats under the plugin's commands, in its card in the Plugins section of settings.
A command they have not configured runs under what the plugin declared.

Every trigger across core and plugin commands is one namespace. A plugin trigger something else already owns is
dropped rather than dispatched. Precedence is core, then plugin commands an admin has configured, then declared
defaults. A dropped trigger is logged, shown on the plugin in settings, and left off the commands page, so it
reads as broken rather than as working. A command whose triggers were all taken cannot be run.

Declare a trigger specific enough not to collide. A configured trigger outranks another plugin's default, which
is how an admin resolves a collision between two installed plugins.

## Permissions

Every procedure and command declares its access, and the host checks it before the handler runs:

```ts
import * as RBAC from 'slm/models/rbac'

// anyone who can view the server the call is made against (the host checks that first)
os.meta({ access: RBAC.Access.PUBLIC })
// a permission on that server
os.meta({ access: RBAC.Access.req(({ serverId }) => RBAC.perm('queue:write', { serverId })) })
// either of two
os.meta({ access: RBAC.Access.req(({ serverId }) => RBAC.Req.any(RBAC.perm('queue:write', { serverId }), Perms.giveaway(serverId))) })
```

A refused call answers with the permission denial. A refused stream yields it and ends. A refused command warns
it back in the server's own language.

`RBAC.perm(type, args)` builds one permission. A server-scoped permission carries the server it applies to. A
grant on one server never satisfies a check against another, so pass `{ serverId }`, not the type on its own.
`RBAC.Req.any(...)` and `RBAC.Req.all(...)` combine several.

Where the arguments decide what is needed, declare what is needed regardless with
`RBAC.Access.inHandler(why, before)`, and check the rest in the handler:

```ts
import * as Rbac from 'slm/systems/rbac'

// in a command handler, against the player who typed it
const denial = await Rbac.checkPlayer(ctx, input.player, RBAC.Req.timeout(ctx.serverId, durationMs))
if (denial) return Rbac.describe(ctx, denial)

// in an rpc handler, against the signed-in caller
const denial = await Rbac.checkCaller(context, RBAC.perm('queue:write', { serverId: context.serverId }))
if (denial) return denial
```

Both return the denial, or null when the caller may proceed.

Reuse an existing permission where one fits. Use `squad-server:end-match` for anything that decides what plays
next, `queue:write` for queue edits, and `squad-server:warn-players` for warns. Admins already grant these. A plugin
that invents its own asks every install to configure something new.

### Declaring your own

Where the plugin does something SLM has no analogue for, declare an action. The host does not interpret it. It only
carries the grant.

```ts
import * as Permissions from 'slm/plugin/permissions'

const Perms = Permissions.register(ctx, {
	giveaway: { scope: 'server', description: 'Run a giveaway on a server' },
})
// asks for a server because the declaration said the action is about one; a 'global' action takes nothing
os.meta({ access: RBAC.Access.req(({ serverId }) => Perms.giveaway(serverId)) })
```

`global` and `server` are the only scopes. A comparator ("up to N") or a path-restricted grant is something the
permission matcher has to understand specifically, so those stay the host's.

An admin grants it under Plugin Actions on the role, picking from what the running plugins declare. The grant
stores the plugin id and the action name as plain strings. Stopping or uninstalling the plugin keeps the grant. An
action no running plugin declares grants nothing.

## Pickers

A config field that stores a filter, a server or a Discord channel id can render as the picker SLM uses for
one, instead of a text box. Declare it in the schema:

```ts
import { Fields } from 'slm/plugin/fields'

configSchema: z.object({
	seedPool: Fields.filterId().describe('Pool the seeding layer is drawn from'),
	announceIn: Fields.discordChannelId().describe('Where the roll is announced'),
	onlyOn: Fields.serverIds().describe('Servers this applies to. Empty means all of them.'),
})
```

There are six: `filterId`, `serverId`, `discordChannelId`, and an `Ids` plural of each. The stored value is still
a plain string or array of strings. A config written through the YAML editor is unaffected, and an id whose target
has since been deleted still round-trips rather than being dropped.

The same six are components, for a slot that picks something rather than a setting that stores it. See
[Components](plugin_ui.md#components).

## What you can reach

`slm/*` is a curated surface, not the whole codebase. `src/plugin-api/api-report.md` lists every export in the
current build, generated from the source, and each entry's JSDoc states what belongs to the host and is therefore
absent.

| Entry                                                      | What it is                                   |
| ---------------------------------------------------------- | -------------------------------------------- |
| `slm/plugin`                                               | manifests, tables, the ctx types             |
| `slm/plugin/config`                                        | your config                                  |
| `slm/plugin/servers`                                       | per-server setup                             |
| `slm/plugin/rpc.server`, `slm/plugin/rpc.client`           | your own rpc                                 |
| `slm/plugin/client`, `.../slots`, `.../decorations`        | the browser half                             |
| `slm/plugin/events`                                        | rendering your own events in the feed        |
| `slm/plugin/commands`                                      | in-game commands                             |
| `slm/plugin/fields`                                        | config fields that render as a picker        |
| `slm/plugin/permissions`                                   | actions your plugin defines for itself       |
| `slm/components/ui`                                        | alerts, badges, buttons, cards and tooltips  |
| `slm/components/pickers`, `.../combo-box`                  | SLM's pickers, and the combo box under them  |
| `slm/components/layer`                                     | a layer's name, rendered as the app does it  |
| `slm/components/plugin-settings-link`                      | a link to your own config                    |
| `slm/components/icons`                                     | the icon set, as one `Icons` namespace       |
| `slm/server/instrumentation`                               | `spanOp`, `durableSub`                       |
| `slm/server/logger`                                        | `childModule`                                |
| `slm/systems/squad-rcon`                                   | reads, warns, broadcasts, player management  |
| `slm/systems/squad-server`                                 | the live event stream, ending a match, kicks |
| `slm/systems/discord`                                      | posting to a channel                         |
| `slm/systems/layer-queue`                                  | queue reads and edits                        |
| `slm/systems/match-history`                                | match reads                                  |
| `slm/systems/filter-entity`                                | filter reads and writes                      |
| `slm/systems/layer-queries`                                | asking the layer table what matches          |
| `slm/systems/app-events`                                   | writing to the audit log                     |
| `slm/systems/post-roll-reminders`                          | lines warned to admins after a roll          |
| `slm/systems/rbac`                                         | whether a caller may do this                 |
| `slm/models/layer`, `slm/models/match-history`             | the domain types and their helpers           |
| `slm/models/server-events`, `slm/models/squad`             | event and roster types, for `events$`        |
| `slm/models/filter`, `slm/models/filter-builders`          | filter trees, and how to write one           |
| `slm/models/layer-queries`, `.../constraint-builders`      | query inputs, and how to constrain one       |
| `slm/models/gen-vote`                                      | the choices a drawn vote is made of          |
| `slm/models/rbac`                                          | the permission vocabulary                    |
| `slm/lib/rxjs-ext`, `slm/lib/zod-utils`, `slm/lib/zustand` | our additions to those packages              |
| `slm/lib/templating`                                       | rendering the {{var}} templates admins write |
| `slm/lib/display-helpers`                                  | naming a layer in text                       |

Four packages come from the host rather than from your bundle: `rxjs`, `zod`, `drizzle-orm` and `react`. Import
them normally and they resolve to SLM's copies at load time. There has to be exactly one of each in the process,
or zod schemas fail their `instanceof` checks and React hooks break.

Those four and `slm/*` are the only things you may import by name. Anything else is left as a bare specifier the
host cannot answer. A client bundle that carries one loads and then fails to resolve it. That takes your plugin's
entire browser half down, panels and all, while its server half keeps running and the plugin still reads as
healthy. `pnpm plugin:pack` refuses to emit such a bundle. To use another package, vendor it: import it
by a relative path from your own source so it ends up inside your bundle.

`slm/lib/rxjs-ext` holds our additions to rxjs and nothing else. rxjs itself is your own import.

## Logging and telemetry

`ctx.log` is named `plugin:<id>` and carries your id, version and source, so anything you log is attributable
without your writing anything. `spanOp` and `durableSub` take `{ module: ctx.module }` and name their spans and
metrics under your plugin the same way.

```ts
export async function activate(ctx: P.Ctx<typeof manifest>) {
	// one call gives you a span, a log line and a duration metric
	const doTheThing = Instr.spanOp('do-the-thing', { module: ctx.module }, async (sctx: P.ServerCtx<typeof manifest>) => {
		await sctx.db().insert(S.greetings).values({ serverId: sctx.serverId, text: 'hi' })
	})
}
```

Build your ops inside `activate()`. `ctx.module` does not exist before then, which is the same reason state should
not be kept at module scope.

A plugin cannot name its own telemetry scope. `slm/server/logger` exposes `childModule`, which narrows the one you
were given, and nothing that invents a new one. This lets an operator distinguish your plugin's output from SLM's
and from another plugin's.

## Packing and publishing

```sh
pnpm plugin:pack plugins/my-plugin
```

That writes `plugins/my-plugin/dist/`:

```
plugin.json   your manifest, as data
plugin.mjs    your plugin.ts
server.mjs    your server.ts
client.mjs    your client.tsx, if you have one
client.css    the classes it uses, compiled against SLM's theme, plus your client.css
```

The bundles carry no copy of SLM. Publish them together, in one directory: SLM installs from the url of
`plugin.json` and resolves the rest relative to it.

A GitHub release works as-is. Upload the files as release assets and hand out the manifest's url:

```
https://github.com/<owner>/<repo>/releases/download/v1.0.0/plugin.json
```

Redirects are followed, so `releases/latest/download/plugin.json` works too. Whichever one an admin installs is
what Refresh re-fetches: a tag url stays where it is, and the `latest` url picks up each release you publish.

Bump `version` in `plugin.ts` for every release. It is what an admin sees in settings and what your telemetry is
tagged with.

To try a package without publishing it, copy `dist/` into your dev instance's `data/plugins/<id>` and press
_Rescan folder_ in settings, or, from inside the app's container:

```sh
docker exec <container> pnpm plugins:reload --expect <plugin-id>
```

That reports each plugin's status and exits non-zero when one named by `--expect` did not come back up, so a
deployment can fail on a package it just copied in. Nothing restarts, so no admin session is dropped.

Do that at least once before you release, since it is the only thing that exercises the packed bundles and the
shim registry. To have CI do it, point the smoke test at the packed output:

```sh
pnpm plugin:pack <source-dir> packed/<id>
SLM_SMOKE_PLUGIN_DIRS=packed/<id> pnpm test:integration test/integration/plugin-smoke.test.ts
```

It boots a real app with the package installed, turns it on, and fails with whatever activation said: an
`apiVersion` this build does not satisfy, or an entry that only exists in the other side's registry. For
day-to-day work, use [the dev loop](#the-dev-loop) instead.

## Repo layouts

SLM asks one thing of your repo: whatever you publish has to put `plugin.json` and its bundles in one directory,
because the manifest's siblings are resolved relative to its url. Where you keep the source is up to you.

### One plugin, one repo

The repo is the plugin directory: `plugin.ts`, `server.ts` and `client.tsx` at its root. Attach the packed output
to each release.

```
https://github.com/<owner>/my-plugin/releases/download/v1.0.0/plugin.json
```

### Several plugins, one repo

One directory per plugin, packed separately. A GitHub release's assets share one flat namespace, and every packed
plugin produces a file called `plugin.json`, so two plugins cannot go in the same release. Either tag per plugin,

```
git tag my-plugin-v1.0.0
git tag other-plugin-v2.1.0
```

so each release carries one plugin's files, or publish the packed directories to GitHub Pages, where each plugin
keeps its own path:

```
https://<owner>.github.io/<repo>/my-plugin/plugin.json
https://<owner>.github.io/<repo>/other-plugin/plugin.json
```

### Your repo, inside the SLM checkout

You need an SLM checkout to build against. Your plugin's repo can be kept inside it:

```sh
cd squad-layer-manager
git clone git@github.com:<owner>/my-plugin.git plugins/my-plugin
echo 'plugins/my-plugin/' >> .git/info/exclude
```

The two repos do not interact. Git never recurses into a nested repository, so SLM's `git status` sees one
untracked directory and your commits, branches and pulls stay inside your own. `.git/info/exclude` is
per-clone and never committed, so hiding your directory needs no change to SLM.

Add that exclude line before you run anything. Without it `git add -A` in the SLM repo adds your plugin as an
embedded repository: a gitlink recording a commit hash nobody else can fetch. Git warns when it happens.

Keeping it in-tree gives you:

- `pnpm dev` runs your plugin, with no registration step. See [The dev loop](#the-dev-loop)
- `pnpm run check` typechecks it against the exact `slm/*` surface you are building against, because `plugins` is
  in the tsconfig's include
- `pnpm test` runs your `*.test.ts` files alongside SLM's
- `pnpm plugin:pack plugins/my-plugin` needs no arguments beyond the path, and writes to `plugins/my-plugin/dist`,
  which SLM's `.gitignore` already covers. Your own repo needs its own `dist` ignore.

You never edit `plugins/builtins.server.ts` or `plugins/builtins.ts`. Those name what SLM itself ships.

## The dev loop

`pnpm dev` loads every directory in `plugins/` from source, so your own repo cloned in there runs with nothing to
register. Enable it once in settings and the choice sticks. From then on your edits reload like SLM's own code, as
the table below shows.

Discovery goes two levels, so a repo holding several plugins is cloned in as one directory and each plugin
inside it is found: `plugins/my-plugins/first/plugin.ts` works as well as `plugins/first/plugin.ts`.

| You edit                                  | What happens                                                     |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `server.ts`, or anything it imports       | the server restarts under `tsx watch` and the plugin reactivates |
| a component in a components-only `.tsx`   | it swaps in place, with its state intact                         |
| `client.tsx`, or anything else it imports | the page reloads                                                 |

Arrange your files around the middle row. The rule behind it is the one SLM follows for its own code. A module
that exports components and nothing else is a Fast Refresh boundary, and a module that exports anything else is
not. `client.tsx` default-exports what `definePluginClient` returns, so it can never be one. Keep
components out of it.

```tsx
// alert.tsx, which exports one component and nothing else
export function Alert(props: { serverId: string }) { ... }

// client.tsx
import { Alert } from './alert.tsx'

export default definePluginClient(manifest, (ctx) => {
	Slots.register(ctx, 'server-dashboard:alerts', Alert)
})
```

The host holds the component you registered, and that reference is stale the moment you edit the file. React
resolves it through the refresh runtime's family for that component, so the new implementation renders against the
old state anyway. Defining the component inline inside `setup()` loses this. An edit to `client.tsx` then reloads
the page, and every component in it starts from scratch.

Whatever your components need that only exists at setup time (most often an rpc client) goes in a plain `.ts`
module they import. `plugins/balance-triggers` is laid out this way.

Discovery is dev-only. A plugin that has only ever run this way has never been through `plugin:pack` or the shim
registry. Those are most of what running it proves, so pack and install it before you release.

## How an admin installs it

The admin's side is in [configuring.md](configuring.md#10-plugins).

On the settings page, under Plugins, they paste the `plugin.json` url. SLM downloads the files into its own
plugins folder and runs that local copy, so your plugin keeps working when your host does not. Refresh is the only
thing that fetches again.

Installing and enabling are separate. A newly installed plugin does nothing until an admin turns it on.

A plugin folder can also be dropped into `data/plugins` by hand, which is `PLUGINS_DIR`. The folder's name has to
equal the manifest's id. A plugin placed that way has no url to refresh from.

Upgrading a plugin's client bundle asks open pages to reload rather than reloading them, because an admin may be
halfway through a queue edit.

## API versions

`API_VERSION` in `src/models/plugins.models.ts` is the version of the slm surface a build provides, and
`src/plugin-api/api-report.md` records what that version contains. Your manifest declares the range you need as a
caret range: `^0.2`, or `^1.2`.

The surface is at 0.2.0, and semver's 0.x rule applies: below 1.0 the minor carries breaking changes and additions
move the patch. So `^0.2` accepts any 0.2.x build and refuses 0.3.0. Once the surface reaches 1.0, `^1.2` will
accept 1.2 and later 1.x.

A plugin whose range this build does not satisfy is refused at activation, with the mismatch shown in settings. It
is never a boot failure.

## Things that will bite you

**Module scope is not yours to keep state in.** A packaged plugin's bundle is loaded under a fresh url each time
it starts, so module-level state resets. A plugin shipped with SLM is loaded once, so its module-level state lasts
for the whole process. Put state in `activate()` and neither case can surprise you.

**Nothing is unloaded.** ESM has no unload, so stopping a plugin tears down its subscriptions and registrations
while the module graph stays in memory. This is bounded by how often an admin restarts a plugin, and it is the
reason teardown has to go through `ctx.cleanup`, the registration APIs and `ctx.signal`.

**A failure to activate is not fatal.** A bad config, a failed migration or a throwing `activate` puts the plugin
in `errored` with the reason shown in settings. SLM keeps running.

**Uninstalling leaves your data.** The plugin's row and its tables survive so that reinstalling restores an
admin's settings. Admins delete leftovers explicitly from the settings page.

**Test against a dev instance, not a live server.** See [dev_instances.md](dev_instances.md).
