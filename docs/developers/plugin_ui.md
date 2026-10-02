# Plugin UI

A plugin's client entry adds to SLM's own pages. It cannot add a page or render anywhere it likes. SLM places
named anchors in its UI, and a plugin registers into them. This page covers the anchors, the components SLM lends
a plugin, and how to style and structure the browser half.

Read [Writing a plugin](writing_plugins.md) first. It covers the manifest, the server entry and your own rpc.

## Contents

- [The client entry](#the-client-entry)
- [Anchors](#anchors)
- [Slots](#slots)
- [Decorations](#decorations)
- [Feed lines](#feed-lines)
- [Getting data](#getting-data)
- [Components](#components)
- [Styling](#styling)
- [Laying out the files](#laying-out-the-files)
- [Things that will bite you](#things-that-will-bite-you)

## The client entry

`client.tsx` default-exports what `definePluginClient` returns.

```tsx
// client.tsx
import { definePluginClient } from 'slm/plugin/client'
import * as Slots from 'slm/plugin/slots'

import { Alert } from './alert.tsx'
import manifest from './plugin.ts'

export default definePluginClient(manifest, (ctx) => {
	Slots.register(ctx, 'server-dashboard:alerts', Alert)
})
```

SLM calls the setup function in every open page when the plugin becomes active. SLM removes everything the setup
function registered when the plugin stops, so nothing needs cleaning up by hand.

`ctx` carries:

| Field        | What it is                                                   |
| ------------ | ------------------------------------------------------------ |
| `ctx.plugin` | your id and manifest                                         |
| `ctx.log`    | a browser logger named `plugin:<id>`, like the server half's |

The setup function runs once per page, not once per server. A component registered in the setup function receives the id
of the server it is shown for as a prop.

## Anchors

An anchor is a place in SLM's UI that accepts plugin content. There are three kinds.

| Kind       | What is registered               | Who renders it    |
| ---------- | -------------------------------- | ----------------- |
| slot       | a React component                | the plugin        |
| decoration | data: a tint, a title and a body | SLM               |
| feed line  | an icon and a line of content    | SLM, around yours |

SLM provides these anchors:

| Anchor                          | Kind       | Where it is                                                        | Props                                       |
| ------------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `server-dashboard:alerts`       | slot       | server dashboard, directly below the match history                 | `serverId`                                  |
| `server-dashboard:queue-alerts` | slot       | server dashboard, above the queue, below SLM's own queue alerts    | `serverId`                                  |
| `match-history:row`             | decoration | each row of the match history on the server dashboard              | `serverId`, `matchId`, `layerId`, `ordinal` |
| your own event names            | feed line  | the activity feed, and the event lists in player and squad windows | the event                                   |

Both slots also appear on the phone layout, in the matches and queue tabs.

The set is closed and typed. Registering to an anchor that does not exist is a type error. To request a new anchor, open
an issue on SLM describing where and why.

SLM isolates a failure in any of the three kinds. A slot that throws renders nothing, and SLM logs the error to the
browser console under your plugin's id. A decoration selector or feed renderer that throws reads as none, and SLM logs
nothing. No failure takes the page down.

## Slots

SLM mounts a slot's component at the anchor and passes it the anchor's props.

```tsx
// alert.tsx
import * as Zus from 'slm/lib/zustand'

import * as E from './client-state.ts'

export function Alert(props: { serverId: string }) {
	const rows = Zus.useStore(E.greetings(props.serverId), (r) => r ?? [])
	if (rows.length === 0) return null
	return <p className="rounded border p-2 text-sm">{rows[0].text}</p>
}
```

Return null when there is nothing to show. SLM renders a slot on every dashboard load, and an empty slot should take no
space.

Several plugins can register at one anchor, and one plugin can register more than once. The components render in
registration order.

## Decorations

A decoration contributes data to something SLM renders. A plugin writes no markup, so every plugin's decoration looks
like SLM's own.

```ts
import * as Decorations from 'slm/plugin/decorations'

Decorations.register(ctx, 'match-history:row', {
	stores: (props) => [E.flaggedMatches(props.serverId)],
	select: (flagged: number[] | undefined, props) =>
		flagged?.includes(props.matchId) ? { tint: 'warn', title: 'Flagged', body: 'An admin flagged this match.' } : null,
})
```

`stores` names the data sources to watch for one row. SLM calls `select` with the current value of each, in the same
order, followed by the row's props. SLM calls `select` again whenever one of those sources changes.

A decoration is `{ tint?, title?, body? }`. `tint` is `info`, `warn` or `violation`, and defaults to `info`. Return an
array to attach several decorations to one row, or null for none.

On `match-history:row`:

- the row takes the background of the most severe tint any plugin contributed
- each tint adds one icon at the end of the row
- hovering an icon lists every decoration of that tint, with its title and body

`layerId` and `ordinal` let a body name a side. Which faction a team played depends on both, so a body that reads "Team
A (USMC)" needs them. See `plugins/balance-triggers/events.client.ts`.

Values that have not arrived yet read as `undefined`. Write `select` to accept `undefined`, as above.

## Feed lines

An event your server half records with `AppEvents.emit` appears in the activity feed as its `message`. A client
entry can render it instead, keyed by the name it was emitted under.

```tsx
import * as Events from 'slm/plugin/events'

Events.register(ctx, 'counted', (e) => ({
	icon: 'success',
	content: <>counted {(e.payload as { count: number }).count} matches</>,
}))
```

`content` is the predicate alone. SLM renders the time, the icon and your plugin's name in front of it, so the
line reads like every other one in the feed.

`icon` is one of `plugin`, `info`, `success`, `warning`, `error`, and defaults to `plugin`.

The event carries `name`, `payload`, `message`, `time`, `serverId` and `matchId`. `payload` is whatever was
emitted, stored as-is, so the renderer casts it.

Return null to fall back to `message` for a particular event. The audit log also shows `message`, and the feed shows it
while your plugin is stopped, so write `message` to stand on its own.

A renderer receives only your own plugin's events. Registering the same name twice replaces the first.

## Getting data

A plugin's client reaches its own data through its own rpc. See
[Your own rpc](writing_plugins.md#your-own-rpc) for the server half.

```ts
import * as Rpc from 'slm/plugin/rpc.client'

import type { router } from './server.ts'

const rpc = Rpc.client<typeof router>(ctx, serverId) // calls
const streams = Rpc.stores<typeof router>(ctx) // streams, as stores
```

Components and decorations read the stores that `Rpc.stores` provides. `streams.greetings(serverId, input)` returns a
store for that server and input. Every caller passing equal arguments shares one store and one stream, so a slot and
fifty decorated rows asking for the same thing open one subscription.

A store reads `undefined` before its first value, while the server is loading, and when the user is refused by the
procedure's declared access. Treat all three as "nothing to show".

Read a store in a component with `Zus.useStore(store, selector)`. Pass the store itself as a decoration's
`stores` entry.

Use `Rpc.client` for calls: an action a user takes from your slot. `Rpc.client` takes the server id because every
procedure runs against one server.

```tsx
const rpc = Rpc.client<typeof router>(ctx, props.serverId)
await rpc.flagMatch({ matchId })
```

A call refused by the procedure's declared access resolves to the permission denial. A call that cannot be made
at all, because the plugin is stopped or the server is not loaded, throws.

The layer engine and SLM's own client state are not part of the plugin API. To read layers, the queue or history, query
them in your server half and pass the result to the client through your rpc.

## Components

SLM lends a plugin some of its own components. Each renders exactly as it does in SLM and fetches its own data.

| Import                                | Exports                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `slm/components/ui`                   | `Alert`, `AlertTitle`, `AlertDescription`, `Badge`, `Button`, `Card` and its parts, `Tooltip`, `TooltipTrigger`, `TooltipContent` |
| `slm/components/pickers`              | `FilterSelect`, `FilterMultiSelect`, `ServerSelect`, `ServerMultiSelect`, `DiscordChannelSelect`, `DiscordChannelMultiSelect`     |
| `slm/components/combo-box`            | `ComboBox`, `ComboBoxMulti`, `LOADING`                                                                                            |
| `slm/components/layer`                | `LayerName`                                                                                                                       |
| `slm/components/plugin-settings-link` | `PluginSettingsLink`                                                                                                              |
| `slm/components/icons`                | `Icons`                                                                                                                           |

### Primitives

SLM builds its own panels from `slm/components/ui`. A slot made of these components matches the page around it, and
needs no classes of its own.

```tsx
import { Alert, AlertDescription, AlertTitle, Badge, Button } from 'slm/components/ui'

<Alert variant="warning">
	<AlertTitle>Seeding</AlertTitle>
	<AlertDescription>Population is below the seed threshold.</AlertDescription>
</Alert>
<Badge variant="outline">12 players</Badge>
<Button variant="outline" size="sm" onClick={roll}>Roll now</Button>
```

| Component | Variants                                                                                      |
| --------- | --------------------------------------------------------------------------------------------- |
| `Alert`   | `default`, `info`, `warning`, `destructive`                                                   |
| `Badge`   | `default`, `primary`, `secondary`, `outline`, `info`, `warning`, `destructive`                |
| `Button`  | `default`, `primary`, `ok`, `outline`, `secondary`, `ghost`, `link`; sizes `sm`, `lg`, `icon` |

The host renders a decoration as an `Alert` with a tint. SLM draws the match history and queue panels with `Card`.
`Tooltip` wraps a `TooltipTrigger` and a `TooltipContent`, and positions itself.

### Pickers

A picker lets the user choose one of SLM's own entities: a filter, a server or a Discord channel. Each picker fetches
its own options.

```tsx
import { FilterSelect, ServerMultiSelect } from 'slm/components/pickers'

<FilterSelect value={filterId} onChange={setFilterId} />
<ServerMultiSelect values={serverIds} onChange={setServerIds} />
```

| Prop             | Single                            | Multi                        |
| ---------------- | --------------------------------- | ---------------------------- |
| value            | `value: string \| null`           | `values: string[]`           |
| change           | `onChange(value: string \| null)` | `onChange(values: string[])` |
| `selectionLimit` |                                   | at most this many            |
| `disabled`       | yes                               | yes                          |
| `title`          | the noun it picks, for its label  | the same                     |
| `className`      | yes                               | yes                          |

An id that no longer names anything, such as a deleted filter, stays selected rather than being dropped.

For a setting rather than a choice made in a slot, declare the field in your config schema instead. See
[Pickers](writing_plugins.md#pickers).

### Combo box

The pickers are built from `ComboBox` and `ComboBoxMulti`. Use them for a searchable list of your own options.

```tsx
import { ComboBox, LOADING } from 'slm/components/combo-box'

;<ComboBox title="mode" value={mode} options={modes ?? LOADING} onSelect={setMode} />
```

Options are strings, or `{ value, label }` objects when the label is not the value. Pass `LOADING` while the list is
still being fetched. `ComboBoxMulti` takes `values` and passes `onSelect` the new array.

### Layer name

`LayerName` renders a layer the way the queue and history do: split into parts, in team colours, and clickable
through to the layer's details.

```tsx
import { LayerName } from 'slm/components/layer'

;<LayerName layerId={layerId} />
```

Pass `allowShowInfo={false}` to render the name as plain text. For a layer's name inside a string, such as a feed line's
title, use `slm/lib/display-helpers`.

### Settings link

`PluginSettingsLink` links to your plugin's section of the settings page.

```tsx
import { PluginSettingsLink } from 'slm/components/plugin-settings-link'

;<PluginSettingsLink pluginId={ctx.plugin.id} path="seedPool">
	Pick a seed pool
</PluginSettingsLink>
```

`path` is a dotted path into your config schema. With `path`, the link opens that field. Without `path`, the link opens
your plugin's section. `PluginSettingsLink` renders nothing for a user who cannot open the settings page, so the plugin
needs no permission check.

### Icons

`Icons` exports the [lucide](https://lucide.dev/icons) set SLM draws from, as one namespace.

```tsx
import { Icons } from 'slm/components/icons'

;<Icons.TriangleAlert className="size-4" />
```

Do not import `lucide-react` directly. See [Things that will bite you](#things-that-will-bite-you).

## Styling

Your components render inside SLM's page, under SLM's stylesheet, with a stylesheet of your own beside it.

SLM uses [Tailwind](https://tailwindcss.com). Write utility classes as SLM itself does. `pnpm plugin:pack` compiles
every class your sources use into `client.css`, against SLM's theme and variants, and SLM loads that file with your
client. SLM's own stylesheet includes only the classes SLM uses, so a class missing from `client.css` has no effect.
In-tree plugins under `plugins/` skip this step, because `pnpm dev` compiles their classes with the app.

For colour, use SLM's theme rather than Tailwind's palette. The theme follows light and dark mode, and the palette
does not.

| Use                   | Class                   |
| --------------------- | ----------------------- |
| secondary text        | `text-muted-foreground` |
| a panel               | `bg-card`, `border`     |
| information           | `text-info`             |
| a warning             | `text-warning`          |
| an error or violation | `text-destructive`      |

`src/theme.css` lists every token.

Plain CSS goes in `client.css` next to `client.tsx`. `pnpm plugin:pack` compiles that CSS into the same output file, so
`@apply` and `theme()` work in it. Prefix your selectors with your plugin id. Without the prefix, a selector can match
SLM's own elements.

Do not set a z-index. Build anything that floats over the page, such as a tooltip or a popover, from
[Components](#components). Those components layer correctly inside dialogs and windows.

## Laying out the files

Keep components in `.tsx` files that export components and nothing else. Keep everything else, including the rpc
stores, in plain `.ts` modules.

```
client.tsx          definePluginClient(...). Registers, and defines no components
client-state.ts     init(ctx), and the stores the components read
alert.tsx           export function Alert(...)
```

```ts
// client-state.ts
import type { ClientCtx } from 'slm/plugin/client'
import * as Rpc from 'slm/plugin/rpc.client'

import type manifest from './plugin.ts'
import type { router } from './server.ts'

let streams: Rpc.Stores<typeof router> | undefined

export function init(ctx: ClientCtx<typeof manifest>) {
	streams = Rpc.stores<typeof router>(ctx)
}

export function greetings(serverId: string) {
	if (!streams) throw new Error('init(ctx) has not run')
	return streams.greetings(serverId, {})
}
```

```tsx
// client.tsx
export default definePluginClient(manifest, (ctx) => {
	E.init(ctx)
	Slots.register(ctx, 'server-dashboard:alerts', Alert)
})
```

With this layout, `pnpm dev` swaps the component in place when `alert.tsx` changes, and keeps its state. When a
component defined inside `client.tsx` changes, `pnpm dev` reloads the page instead. [The dev
loop](writing_plugins.md#the-dev-loop) explains why.

`plugins/balance-triggers` follows this layout, and registers a slot and a decoration.

## Things that will bite you

**A class built at runtime is not compiled.** `pnpm plugin:pack` finds classes by reading your source, so
`` `text-${tint}` `` produces nothing. Write each full class name out, as in a lookup table keyed by tint.

**Only `slm/*` and the host's packages resolve.** Those are `react`, `rxjs`, `zod` and `drizzle-orm`. An import of any
other package by name, such as `lucide-react`, fails to resolve when the client loads. The failure stops your whole
client half. The server half keeps running, and the plugin still reads as healthy. `pnpm plugin:pack` refuses to build
such a bundle. Vendor anything else by importing it through a relative path.

**Never import your server entry as a value.** `import type { router } from './server.ts'` is erased. A plain
import pulls your server code, and everything it imports, into the browser bundle.

**An upgrade does not reload open pages.** When an admin installs a new version, open pages keep running the old
client and show a prompt to reload. Your server half is already on the new version by then, so an rpc change that
the old client cannot read will fail until the page reloads.

**The setup function runs in every open tab.** Put work that must happen once in `activate()` on the server.

**Your component is not tied to one server.** The same component renders for whichever server is being shown. Key
any component state on `serverId`.
