# Writing an SLM plugin

A plugin is an extension that runs in the SLM process. It can use everything core code uses: the database, match
history, the layer queue, RCON, the settings page and the server dashboard. It ships as a folder of prebuilt bundles
that an admin installs from a url, or a local directory.

Plugins are trusted. There is no sandbox. A plugin runs in the SLM process with everything that process can do, so a
plugin is only safe to install if running it as a fork of SLM would be.

## Contents

- [Prerequisites](#prerequisites)
- [The files](#the-files)
- [The manifest](#the-manifest)
- [The server entry](#the-server-entry)
- [Storing data](#storing-data)
- [Filters](#filters)
- [Rotations](#rotations)
- [Repeat rulesets](#repeat-rulesets)
- [Layer queries](#layer-queries)
- [Your own rpc](#your-own-rpc)
- [The client entry](#the-client-entry)
- [Your events in the feed](#your-events-in-the-feed)
- [In-game commands](#in-game-commands)
- [Scheduled jobs](#scheduled-jobs)
- [Permissions](#permissions)
- [Pickers](#pickers)
- [What a plugin can reach](#what-a-plugin-can-reach)
- [Dependencies](#dependencies)
- [Logging and telemetry](#logging-and-telemetry)
- [Packing and publishing](#packing-and-publishing)
- [Repo layouts](#repo-layouts)
- [The dev loop](#the-dev-loop)
- [How an admin installs it](#how-an-admin-installs-it)
- [API versions](#api-versions)
- [Things that will bite you](#things-that-will-bite-you)

## Prerequisites

Building a plugin requires a checkout of SLM. `slm/*`, the alias a plugin imports the host through, resolves through
this repo's tsconfig, and `pnpm plugin:pack` runs from here. There is no separately published SDK package yet.

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
	apiVersion: '^0.15',
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

`apiVersion` is the range of slm API versions the plugin is built against. See [API versions](#api-versions).

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
	Servers.setup(ctx, (sctx) => {
		sctx.cleanup.push(
			sctx.matchHistory.finalized$
				.pipe(
					// Instr.durableSub subscribes to the finalized$ rxjs observable (https://rxjs.dev/) in a way that includes some observability instrumentation, and automatic retries. See its definition for more.
					Instr.durableSub('count-matches', { module: sctx.module }, async () => {
						const history = await MatchHistory.getRecentMatches(sctx)
						await AppEvents.emit(sctx, 'counted', { count: history.length }, `${history.length} matches on record`)
					}),
				)
				.subscribe(),
		)

		// asked after each roll on this server for the lines this plugin wants warned to admins
		Reminders.register(sctx, async () => [PluginConfig.get(sctx).greeting])
	})
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

`Servers.setup(ctx, cb)` calls `cb` once per managed server with `sctx`, the per-server ctx. The `slm/systems/*`
functions take `sctx`. `sctx.cleanup` is scoped to that plugin and server pair, so it runs when the server goes down
or the plugin stops, whichever comes first.

Everything a plugin starts has to be tied to one of those: `ctx.cleanup`, `sctx.cleanup`, or `ctx.signal`.
Work started at module scope keeps running after the plugin stops. Keep state inside `activate()`.

Use `durableSub` for a long-lived subscription rather than a bare `.subscribe()`. It logs each error and resubscribes,
so a throwing source does not kill the subscription or the process.

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
			// we have to give the full DDL inline here because the table schema we defined above may change in the future, and migrations shouldn't be changed later
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

A filter is a predicate over layers. `slm/systems/filter-entity`
reads and writes the same filters admins see in the filter index. `slm/models/filter-builders` builds a filter tree
without assembling the nodes by hand.

```ts
import * as FB from 'slm/models/filter-builders'
import * as Filters from 'slm/systems/filter-entity'

await Filters.create(ctx, {
	id: 'no-seed',
	name: 'Not a seed layer',
	filter: FB.and([FB.eq('Collection', 'OWI'), FB.notInValues('Gamemode', ['Seed', 'Training'])]),
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

A filter that `create` makes is owned by your plugin, and the filter index names your plugin as its owner. Admins with
`filters:write-all` can edit the filter by hand and add contributors, who can then edit it too.

To make an admin the owner instead, pass `owner: { type: 'slm-user', userId: 123456789012345678n }` with their discord
user id. That admin gets the filter-owner role over the filter and can edit it and manage its contributors.

A filter's contributors are users and roles that can edit it without owning it. Your plugin can read and change them
on any filter:

```ts
await Filters.getContributors(ctx, 'no-seed') // [{ type: 'user', userId: 123456789012345678n }, { type: 'role', roleId: 'mappers' }]
await Filters.addContributor(ctx, 'no-seed', { type: 'role', roleId: 'mappers' })
await Filters.removeContributor(ctx, 'no-seed', { type: 'user', userId: 123456789012345678n })
await Filters.copyContributors(ctx, 'no-seed', 'no-seed-2') // adds the first filter's contributors to the second
```

`addContributor` refuses a user who has never signed in to SLM with `err:unknown-user`, and one the filter already has
with `err:already-exists`. The three writes answer `err:not-found` for a filter that does not exist, and
`removeContributor` answers it for a contributor the filter does not have. `copyContributors` keeps the contributors
the target already has. The audit log records a `FILTER_CONTRIBUTOR_CHANGED` naming your plugin for each contributor
added or removed.

Every filter's `owner` is one of `{ type: 'slm-user', userId }`, `{ type: 'plugin', pluginId }` or
`{ type: 'system' }`. A system-owned filter is one SLM itself created, such as a fresh install's starting pool.

Your writes are ordinary writes. Open editors update, the reference index rebuilds, and the audit log records a
`FILTER_CHANGED` naming your plugin rather than a person. Writing the `filters` table through `ctx.db()` skips all
of that and leaves every open page stale until a restart.

Owning a filter does not lock it. A plugin can write any filter, including one an admin made, and an admin with access
can edit or delete one a plugin owns. Find your plugin's filters with
`Filters.list().filter((f) => f.owner.type === 'plugin' && f.owner.pluginId === ctx.plugin.id)`.

Deactivating your plugin leaves its filters behind. This is deliberate. A server pool naming a filter that
disappeared fails every layer status query for that server. Clean up explicitly if that is wrong for yours, and
delete the pool config first.

`remove` refuses to delete a filter anything still points at, and hands back the references so the plugin can report
what.

## Rotations

A rotation is a saved, ordered list of queue items that admins add to a server's queue in one go.
`slm/systems/rotation` reads and writes the same rotations admins see on the _Rotations_ page. `slm/models/rotation`
exports the rotation types and schemas.

```ts
import * as Rotations from 'slm/systems/rotation'

await Rotations.create(ctx, {
	id: 'weekend-mix',
	name: 'Weekend mix',
	description: null,
	repeatRulesetId: null,
	tags: [],
	items: [
		{ type: 'single-list-item', layerId: 'GD-RAAS-V1:USA-CA:RGF-CA' },
		{ type: 'single-list-item', layerId: 'HJ-RAAS-V1:RGF-MZ:PLA-AA' },
	],
})

await Rotations.get(ctx, 'weekend-mix') // one, or undefined
await Rotations.search(ctx, { q: 'weekend', sort: 'name' }) // a page of summaries, without items
await Rotations.update(ctx, 'weekend-mix', { name: 'Weekend mix v2', archived: true })
await Rotations.clone(ctx, { sourceId: 'weekend-mix', id: 'weekend-mix-2', name: 'Weekend mix 2', copyTags: true })
await Rotations.remove(ctx, 'weekend-mix')
Rotations.changes(ctx).subscribe((c) => ...) // every write, yours included, with the actor that made it
```

`search` returns one page of summaries. A summary is a rotation without its items, with `itemCount` and the layers of
its first few items in their place. `q` matches the name and the description. Archived rotations are left out unless
`archived` is set. A page holds 60 summaries unless `limit` sets another size, up to 200. Pass the page's `nextCursor`
back as `cursor` to get the next page, until `nextCursor` is null. Use `get` to read a rotation's items.

An item without an `itemId` or `source` is given one. SLM strips attribution from every item before storing it: the
source becomes `unknown`, tag attribution is dropped and notes lose their `author`. The layers, tags and note text are
kept.

The ownership rules match the filters' rules. A rotation that `create` or `clone` makes is owned by your plugin. Admins
with `rotations:write-all` can edit and delete it by hand, and contributors that an admin adds can edit it too. To make
an admin the owner instead, pass `owner: { type: 'slm-user', userId: 123456789012345678n }`. That admin gets the
rotation-owner role over the rotation, and can edit and delete it and manage its contributors. `clone` copies the
source's items, description and repeat ruleset, and its tags when `copyTags` is set. It never copies contributors.

A rotation's contributors are users and roles that can edit it without owning it. Your plugin can read and change
them on any rotation:

```ts
await Rotations.getContributors(ctx, 'weekend-mix') // [{ type: 'user', userId: 123456789012345678n }, { type: 'role', roleId: 'mappers' }]
await Rotations.addContributor(ctx, 'weekend-mix', { type: 'role', roleId: 'mappers' })
await Rotations.removeContributor(ctx, 'weekend-mix', { type: 'user', userId: 123456789012345678n })
await Rotations.copyContributors(ctx, 'weekend-mix', 'weekend-mix-2') // adds the first rotation's contributors to the second
```

`addContributor` refuses a user who has never signed in to SLM with `err:unknown-user`, and one the rotation already
has with `err:already-exists`. The three writes answer `err:not-found` for a rotation that does not exist, and
`removeContributor` answers it for a contributor the rotation does not have. `copyContributors` keeps the contributors
the target already has. The audit log records a `ROTATION_CONTRIBUTOR_CHANGED` naming your plugin for each
contributor added or removed.

Your writes are ordinary writes. Every open page updates, and the audit log records a `ROTATION_CHANGED` naming your
plugin rather than a person. Writing the `rotations` table through `ctx.db()` skips all of that.

An admin editing a rotation's items works on a shared draft. New items from `update` are saved through that draft, so
the admins editing it see them. While the draft holds edits nobody has saved, `update` refuses new items with
`{ code: 'err:unsaved-edits' }` instead of discarding the admins' work. Try again later. An `update` without `items`
is never refused for this reason.

Owning a rotation does not lock it. A plugin can write any rotation, including one an admin made. Deactivating your
plugin leaves its rotations behind. Find your plugin's rotations with
``Rotations.search(ctx, { author: `plugin:${ctx.plugin.id}`, archived: true })``, paging through `nextCursor`.

`create`, `update` and `clone` refuse a `repeatRulesetId` or a tag that is not configured, with
`err:unknown-repeat-ruleset` or `err:unknown-tags`. Rotation tags are configured in the global settings, separately
from layer tags. To let an admin choose one, declare the config field with `Fields.rotationTagId()`, which renders as a
picker over the configured rotation tags and stores the tag's id. `slm/systems/tags` finds a tag by its label, and
creates it when no tag has that label:

```ts
import * as Tags from 'slm/systems/tags'

const res = await Tags.ensure(ctx, 'rotation', 'Fogless Friday') // or 'layer'
if (res.code === 'ok') await Rotations.update(ctx, 'weekend-mix', { tags: [res.tag.id] })
```

`addToQueue` adds a rotation to the queue of your plugin's server, as _Add Rotation_ does for an admin:

```ts
await Rotations.addToQueue(ctx, 'weekend-mix', { placement: 'end' }) // or 'start', or 'replace'
await Rotations.addToQueue(ctx, 'weekend-mix', { placement: 'replace', tags: ['seeding:a1b2c3'] })
```

`replace` takes the place of every queued item, `start` goes ahead of them and `end` after them. The new items are
sourced to your plugin and carry the rotation's `from-rotation:<id>` tag, plus any layer `tags` given. Their notes name
the rotation. While an admin has queue edits open, `addToQueue` refuses with `{ code: 'err:unsaved-edits' }`, as
`editSaved` does. A layer tag that is not configured is refused with `err:unknown-tags`.

## Repeat rulesets

A repeat ruleset is a named list of repeat rules. Every server and rotation points at one. `slm/systems/repeat-ruleset`
reads and writes the same rulesets admins pick in the pool configuration and the rotation editor.
`slm/models/repeat-ruleset` exports the schemas, `DEFAULT_RULES` and `rulesFor`.

```ts
import * as RepeatRulesets from 'slm/systems/repeat-ruleset'

RepeatRulesets.list() // every ruleset
RepeatRulesets.get('seeding') // one, or undefined
RepeatRulesets.forServer(ctx) // the ruleset your plugin's server applies, or undefined
await RepeatRulesets.save(ctx, { id: 'seeding', name: 'Seeding', rules: [{ field: 'Map', within: 2 }] })
await RepeatRulesets.setForServer(ctx, 'seeding') // your plugin's server applies it from now on
await RepeatRulesets.remove(ctx, 'seeding')
RepeatRulesets.changes(ctx).subscribe((rulesets) => ...) // the rulesets after each change, yours included
```

`save` creates a ruleset, or replaces the one with the same id. A ruleset SLM made for a server when the server was
created stays that server's. `remove` refuses a ruleset that a server or rotation still uses, with
`err:repeat-ruleset-in-use`. `setForServer` refuses an id that names no ruleset, with `err:unknown-repeat-ruleset`.
The audit log records each write as a `SETTINGS_UPDATED` naming your plugin.

## Settings

`slm/systems/settings` reads and writes SLM's global settings and each server's settings. A server's settings are
the ones every signed-in user sees, so its connection details are left out, and cannot be written.

```ts
import * as Settings from 'slm/systems/settings'

Settings.global().defaultTimeZone // global settings
Settings.server(ctx.serverId)?.installedMods // a server's settings, undefined while it is not running
Settings.globalChanges(ctx).subscribe((settings) => ...) // the global settings after each change
Settings.serverChanges(ctx, ctx.serverId).subscribe((settings) => ...) // a server's settings after each change
await Settings.updateGlobal(ctx, [{ path: ['defaultTimeZone'], value: 'Europe/Berlin' }])
await Settings.updateServer(ctx, ctx.serverId, [{ path: ['overrideAdminSetNextLayer'], value: true }])
```

The readers return the live objects SLM itself reads. Do not mutate them: write through `updateGlobal` and
`updateServer` instead. Each takes a list of `{ path, value }` changes and applies all of them or none.
`updateServer` writes a server whether or not it is running, and refuses an id that names no server with
`err:server-not-found`. A write is
checked the way the settings pages check one, and refused with `err:invalid-settings` and the reason when it does
not fit. The audit log records each write as a `SETTINGS_UPDATED` naming your plugin.

## Layer queries

`slm/systems/layer-queries` searches SLM's list of every known layer given a set of constraints, checks queue items against constraints, and
generates votes. The module runs the same query code and layer engine as the layer picker and queue warnings in the
browser, so a plugin gets the same results an admin sees. Every call takes your per-server ctx and resolves what it
needs itself, so there is no setup step.

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
not mean what its fields look like. The `id` given to a constraint comes back on every warning and match descriptor
it produces. That `id` identifies which constraint a result is about.

Repeat rules need to know what is already queued and what was played. `query` and `itemStatuses` fill that in from
the live queue when `input.list` is left out, which is almost always the queue a plugin means. Pass `itemsState`
yourself only to ask about a queue other than the current one.

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

A stream that waits for changes must end when the caller goes away. The handler receives `signal`, which aborts at
that moment. Pipe the source through `withAbortSignal(signal)` from `slm/lib/rxjs-ext`, which completes it as soon as
`signal` aborts. Without it, the stream keeps running for a caller that has left, until its source next emits.

```ts
.handler(async function* ({ context, signal }) {
	yield* RxExt.toAsyncGenerator(change$.pipe(Rx.map(() => read(context)), RxExt.withAbortSignal(signal!)))
}),
```

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

## Scheduled jobs

A job is work SLM runs for your plugin at a time: on a recurring schedule, or once at a time your plugin picks, with
data of its own. SLM keeps scheduled runs across restarts, catches up a run that came due while it was down, and
retries a run that fails. Declare each job with `Schedule.job` and list it in the server entry's `jobs` export:

```ts
import * as z from 'zod'
import * as Schedule from 'slm/plugin/schedule'
import * as LayerQueue from 'slm/systems/layer-queue'
import * as Rotations from 'slm/systems/rotation'

// recurring: `when` returns its schedule, and is read again whenever your config is saved
export const create = Schedule.job({
	id: 'create',
	scope: 'server',
	catchUp: '6d',
	when: (cfg: Config, serverId) => (cfg.enabledServers.includes(serverId!) ? Schedule.weekly(6, cfg.createTime, cfg.timezone) : null),
	run: async (sctx, run) => {
		const tomorrow = run.scheduledFor + 24 * 60 * 60_000
		await Schedule.at(sctx, add, { at: tomorrow, payload: { rotationId: 'weekend-mix' }, key: 'this-week' })
	},
})

// one-off: runs only when scheduled with `at`, with the payload given there
export const add = Schedule.job({
	id: 'add',
	scope: 'server',
	payload: z.object({ rotationId: z.string() }),
	catchUp: '12h',
	run: async (sctx, run, payload) => {
		const res = await Rotations.addToQueue(sctx, payload.rotationId, { placement: 'end' })
		// runs again once nobody has queue edits open
		if (res.code === 'err:unsaved-edits') return Schedule.blocked('the queue has unsaved edits', LayerQueue.editsSettled(sctx))
		if (res.code !== 'ok') throw new Error(`could not add ${payload.rotationId}: ${res.code}`)
	},
})

export const jobs = [create, add]
```

A `server` job runs once per server with that server's ctx. A `plugin` job runs once, with the plugin ctx. `when`
schedules a recurring job: `Schedule.weekly(weekday, 'HH:MM', timezone)` and `Schedule.daily('HH:MM', timezone)`
turn settings fields into a schedule, `{ cron, timezone }` takes a cron pattern, and `{ every: '6h' }` runs the job
that long after its last run finished. Return null from `when` to leave the job unscheduled on that server.

`Schedule.at` stores one run with its payload. The payload is checked against the job's schema when it is
scheduled and again when it runs, and is limited to 16 KB: store an id, not the data it names. Scheduling again under
the same `key` replaces that run, unless that run is running, which returns `err:busy`.
`Schedule.cancel(ctx, job, key)` removes a run that has not started, and stops one that has, as described below.
Neither takes a job that is not in `jobs`.

`catchUp` is how long after its time a run is still attempted. Within it, a run that throws is retried, backing off
from a minute. A run missed while SLM was down runs as soon as SLM is back. Only the latest missed occurrence of a
recurring job runs, and a newer occurrence replaces an older one that has not run yet. A run whose window has passed
is dropped. The default is five minutes.

A run that cannot do its work yet returns `Schedule.blocked(reason, unblock)`. A blocked run is not a failure and does
not count as an attempt. SLM runs it again once `unblock` fires:

- a duration, such as `'5m'` or `300_000`, fires after that long;
- a promise fires when it settles;
- an observable or async iterable fires on its first value, error or end.

A blocked run goes again no sooner than a second after it was blocked. Emit only when it is worth trying again: pass
`connected$.pipe(filter(Boolean))`, not a `connected$` that emits its current `false` straight away. Admins see the
reason while the run waits. A run still blocked when its `catchUp` window ends fails with that reason. SLM blocks a
`server` job's run itself while that server is not loaded.

A run's signal aborts when an admin or your plugin cancels the run, when the run outlasts the job's `timeout`, and when
your plugin or the run's server stops. The signal is on both `run.signal` and the run's ctx, so SLM calls that take
the ctx stop with it. Pass it to your own waits too, and let the abort be thrown:

- A cancelled run that stops by throwing the abort is recorded as `SCHEDULED_JOB_CANCELLED`. One that finishes anyway
  is recorded as it finished, and one that throws something else fails without a retry.
- A run that outlasts its `timeout` and throws the abort fails, and is retried within `catchUp`.
- A run still going 10 seconds after its signal aborted is abandoned. It fails, and its job can run again while the
  abandoned run carries on.

`Schedule.cancel(ctx, job, key)` cancels a running run as well as a pending one. It returns `stopping: true` for a
running run, which is still going when the call returns.

Check what a run needs before it changes anything, so a blocked run leaves nothing half done. A run can be attempted
again after SLM stops partway through it, or after a block, so make it safe to repeat. `run.scheduledFor` and
`run.key` identify the occurrence.

Admins see each job under your plugin in settings: when it next runs, what a blocked run waits for, how its last run
went, and the pending runs it has scheduled. They can run any of them now, cancel a pending run, or stop a running one. A run started by
hand that returns `blocked` is not left waiting: the admin is shown the reason, and a scheduled run stays as it was. A run that finally fails is recorded as
`SCHEDULED_JOB_FAILED`. A successful run is recorded as `SCHEDULED_JOB_SUCCESS` when an admin ran it by hand, and
every time when the job sets `logSuccess: true`. A `server` job's events also appear in that server's activity feed.

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

A config field that stores a filter, a server, a Discord channel or a rotation tag id can render as the picker SLM
uses for one, instead of a text box. Declare it in the schema:

```ts
import { Fields } from 'slm/plugin/fields'

configSchema: z.object({
	seedPool: Fields.filterId().describe('Pool the seeding layer is drawn from'),
	announceIn: Fields.discordChannelId().describe('Where the roll is announced'),
	onlyOn: Fields.serverIds().describe('Servers this applies to. Empty means all of them.'),
})
```

There are seven: `filterId`, `serverId`, `discordChannelId`, an `Ids` plural of each, and `rotationTagId`. The
stored value is still a plain string or array of strings. A config written through the YAML editor is unaffected,
and an id whose target has since been deleted still round-trips rather than being dropped.

The first six are also components, for a slot that picks something rather than a setting that stores it. See
[Components](plugin_ui.md#components).

## What a plugin can reach

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
| `slm/plugin/schedule`                                      | jobs that run on a schedule or at a time     |
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
| `slm/systems/player-activity`                              | who SLM counts as idle, and since when       |
| `slm/systems/discord`                                      | posting to a channel                         |
| `slm/systems/layer-queue`                                  | queue reads and edits                        |
| `slm/systems/match-history`                                | match reads                                  |
| `slm/systems/filter-entity`                                | filter reads and writes                      |
| `slm/systems/rotation`                                     | rotation reads and writes                    |
| `slm/systems/repeat-ruleset`                               | repeat ruleset reads and writes              |
| `slm/systems/tags`                                         | layer and rotation tags, found or created    |
| `slm/systems/settings`                                     | global and server settings, reads and writes |
| `slm/systems/layer-queries`                                | asking the layer table what matches          |
| `slm/systems/app-events`                                   | writing to the audit log                     |
| `slm/systems/post-roll-reminders`                          | lines warned to admins after a roll          |
| `slm/systems/rbac`                                         | whether a caller may do this                 |
| `slm/models/layer`, `slm/models/match-history`             | the domain types and their helpers           |
| `slm/models/server-events`, `slm/models/squad`             | event and roster types, for `events$`        |
| `slm/models/filter`, `slm/models/filter-builders`          | filter trees, and how to write one           |
| `slm/models/rotation`                                      | rotation types and schemas                   |
| `slm/models/repeat-ruleset`                                | repeat ruleset types and schemas             |
| `slm/models/layer-queries`, `.../constraint-builders`      | query inputs, and how to constrain one       |
| `slm/models/gen-vote`                                      | the choices a drawn vote is made of          |
| `slm/models/rbac`                                          | the permission vocabulary                    |
| `slm/lib/rxjs-ext`, `slm/lib/zod-utils`, `slm/lib/zustand` | our additions to those packages              |
| `slm/lib/templating`                                       | rendering the {{var}} templates admins write |
| `slm/lib/display-helpers`                                  | naming a layer in text                       |

Five packages also come from SLM: `rxjs`, `zod`, `drizzle-orm`, `react` and `react-dom`. [Dependencies](#dependencies)
describes them, and how to use any other package.

`slm/lib/rxjs-ext` holds our additions to rxjs and nothing else. rxjs itself is your own import.

## Dependencies

A plugin can use packages from npm. `pnpm plugin:pack` bundles every package your plugin imports, so an installed
plugin needs no `node_modules`.

Five packages are the exception: `rxjs`, `zod`, `drizzle-orm`, `react` and `react-dom`. SLM provides them, and your
imports of them resolve to SLM's copies at load time. There has to be exactly one of each in the process, or zod
schemas fail their `instanceof` checks and React hooks break. Do not install them. Their types come from SLM's own
`node_modules`, and a second copy's types conflict with SLM's when `pnpm run check` runs.

SLM provides two subpaths of these packages: `react/jsx-runtime` and `drizzle-orm/sqlite-core`. `pnpm plugin:pack`
refuses any other subpath, such as `rxjs/operators`, whether your code imports it or a dependency does. Bundling one
would put a second copy of its package in the process.

### Installing a package

Declare dependencies in a `package.json` at the root of your repo. One file serves every plugin in the repo, because
Node and the bundler search each directory above the importing file for packages.

```json
{
	"private": true,
	"type": "module",
	"dependencies": {
		"date-fns": "^4.1.0"
	}
}
```

`"type": "module"` is required. Without it, Node loads your `.ts` files as CommonJS, and `pnpm dev` refuses to load
the plugin. Leave out `name` and `version`: `plugin.ts` declares those.

Add a `pnpm-workspace.yaml` beside `package.json`:

```yaml
packages:
   - .
autoInstallPeers: false
```

That file makes your repo a pnpm workspace of its own, so `pnpm install` in your repo leaves SLM's lockfile alone.
`autoInstallPeers: false` stops pnpm from installing a copy of `react` or `zod` for a dependency that asks for one.
The dependency resolves `react` and `zod` to SLM's copies instead.

Run `pnpm install` in your repo after cloning it, and again after each change to `package.json`.

### What can be bundled

- **ES modules only.** `pnpm plugin:pack` refuses a bundle that contains a CommonJS module, and names the package it
  came from. Where a package ships both formats, the packer picks the ES build.
- **No Node builtins in the browser.** `client.tsx` and `plugin.ts` are loaded in the browser, so the packer refuses
  an import of `node:fs` or any other builtin from either of them, or from a package they import. `server.ts` can
  import builtins.
- **Peer ranges are checked.** A dependency runs against SLM's copy of `react`, `zod` and the rest, whatever version
  it asks for. `pnpm plugin:pack` warns when SLM's version is outside a dependency's peer range. Test that
  dependency before you publish.

## Logging and telemetry

`ctx.log` is named `plugin:<id>` and carries your id, version and source, so anything the plugin logs is
attributable with no extra code. `spanOp` and `durableSub` take `{ module: ctx.module }` and name their spans and
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

A plugin cannot name its own telemetry scope. `slm/server/logger` exposes `childModule`, which narrows the scope the
plugin was given, and nothing that invents a new one. This lets an operator distinguish your plugin's output from SLM's
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
the url they re-fetch with Refresh: a tag url stays where it is, and the `latest` url picks up each new release.

Bump `version` in `plugin.ts` for every release. It is what an admin sees in settings and what your telemetry is
tagged with.

To try a package without publishing it, copy `dist/` into your dev instance's `data/plugins/<id>` and press
_Rescan folder_ in settings, or, from inside the app's container:

```sh
docker exec <container> pnpm plugins:reload --expect <plugin-id>
```

That reports each plugin's status and exits non-zero when one named by `--expect` did not come back up, so a
deployment can fail on a package it just copied in. Nothing restarts, so no admin session is dropped.

Do that at least once before a release, since it is the only thing that exercises the packed bundles and the
shim registry. To have CI do it, point the smoke test at the packed output:

```sh
pnpm plugin:pack <source-dir> packed/<id>
SLM_SMOKE_PLUGIN_DIRS=packed/<id> pnpm test:integration test/integration/plugin-smoke.test.ts
```

It boots a real app with the package installed, turns it on, and fails with whatever activation said: an
`apiVersion` this build does not satisfy, or an entry that only exists in the other side's registry. For
day-to-day work, use [the dev loop](#the-dev-loop) instead.

## Repo layouts

SLM asks one thing of your repo: the published output has to put `plugin.json` and its bundles in one directory,
because the manifest's siblings are resolved relative to its url. The source can be kept anywhere.

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

Building a plugin requires an SLM checkout. Your plugin's repo can be kept inside it:

```sh
cd squad-layer-manager
git clone git@github.com:<owner>/my-plugin.git plugins/my-plugin
echo 'plugins/my-plugin/' >> .git/info/exclude
```

The two repos do not interact. Git never recurses into a nested repository, so SLM's `git status` sees one
untracked directory and your commits, branches and pulls stay inside your own. `.git/info/exclude` is
per-clone and never committed, so hiding your directory needs no change to SLM.

Add that exclude line before running anything. Without it `git add -A` in the SLM repo adds your plugin as an
embedded repository: a gitlink recording a commit hash nobody else can fetch. Git warns when it happens.

Keeping it in-tree means:

- `pnpm dev` runs your plugin, with no registration step. See [The dev loop](#the-dev-loop)
- `pnpm run check` typechecks it against the exact `slm/*` surface of that checkout, because `plugins` is in the
  tsconfig's include
- `pnpm test` runs your `*.test.ts` files alongside SLM's
- `pnpm plugin:pack plugins/my-plugin` needs no arguments beyond the path, and writes to `plugins/my-plugin/dist`,
  which SLM's `.gitignore` already covers. Your own repo needs its own `dist` ignore.

A plugin author never edits `plugins/builtins.server.ts` or `plugins/builtins.ts`. Those name what SLM itself ships.

## The dev loop

`pnpm dev` loads every directory in `plugins/` from source, so your own repo cloned in there runs with nothing to
register. Enable it once in settings and the choice sticks. From then on your edits reload like SLM's own code, as
the table below shows.

Discovery goes two levels, so a repo holding several plugins is cloned in as one directory and each plugin
inside it is found: `plugins/my-plugins/first/plugin.ts` works as well as `plugins/first/plugin.ts`.

| File edited                               | What happens                                                     |
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

The host holds the registered component, and that reference goes stale as soon as the file is edited. React resolves the
reference through the refresh runtime's family for that component, so the new implementation renders against the old
state anyway. Defining the component inline inside `setup()` loses this. An edit to `client.tsx` then reloads the page,
and every component in it starts from scratch.

Whatever your components need that only exists at setup time (most often an rpc client) goes in a plain `.ts`
module they import. `plugins/balance-triggers` is laid out this way.

Discovery is dev-only. A plugin that has only ever run this way has never been through `plugin:pack` or the shim
registry. Those are most of what running it proves, so pack and install it before each release.

## How an admin installs it

The admin's side is in [Plugins](../guide/configuring/plugins.md).

On the settings page, under Plugins, they paste the `plugin.json` url. SLM downloads the files into its own
plugins folder and runs that local copy, so your plugin keeps working when your host does not. SLM fetches again only
when an admin clicks Refresh.

Installing and enabling are separate. A newly installed plugin does nothing until an admin turns it on.

A plugin folder can also be dropped into `data/plugins` by hand, which is `PLUGINS_DIR`. The folder's name has to
equal the manifest's id. A plugin placed that way has no url to refresh from.

Upgrading a plugin's client bundle asks open pages to reload rather than reloading them, because an admin may be
halfway through a queue edit.

## API versions

`API_VERSION` in `src/models/plugins.models.ts` is the version of the slm surface a build provides, and
`src/plugin-api/api-report.md` records what that version contains. Your manifest declares the range it needs as a
caret range: `^0.2`, or `^1.2`.

The surface is below 1.0, so semver's 0.x rule applies: the minor carries breaking changes and additions move the
patch. So `^0.2` accepts any 0.2.x build and refuses 0.3.0. Once the surface reaches 1.0, `^1.2` will accept 1.2 and
later 1.x. The report's `api-version` line gives the current version.

A plugin whose range this build does not satisfy is refused at activation, with the mismatch shown in settings. It
is never a boot failure.

## Things that will bite you

**Module scope is not yours to keep state in.** A packaged plugin's bundle is loaded under a fresh url each time
it starts, so module-level state resets. A plugin shipped with SLM is loaded once, so its module-level state lasts
for the whole process. State kept in `activate()` behaves the same in both cases.

**Nothing is unloaded.** ESM has no unload, so stopping a plugin tears down its subscriptions and registrations
while the module graph stays in memory. This is bounded by how often an admin restarts a plugin, and it is the
reason teardown has to go through `ctx.cleanup`, the registration APIs and `ctx.signal`.

**A failure to activate is not fatal.** A bad config, a failed migration or a throwing `activate` puts the plugin
in `errored` with the reason shown in settings. SLM keeps running.

**Uninstalling leaves your data.** The plugin's row and its tables survive so that reinstalling restores an
admin's settings. Admins delete leftovers explicitly from the settings page.

**Game server reads come from a cache.** `getTeams`, `getServerInfo`, `getLayerStatus` and `getPlayer` in
`slm/systems/squad-rcon` answer from what SLM last polled, so calling them often adds no RCON traffic. To act on a
change, subscribe to `teams$`, `serverInfo$` or `layerStatus$` rather than polling on a timer. `getCurrentLayer` and
`getNextLayer` send an RCON command on every call.

**Test against a dev instance, not a live server.** See [dev_instances.md](dev_instances.md).
