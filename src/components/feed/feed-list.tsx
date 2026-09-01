import React from 'react'
import { createPortal } from 'react-dom'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as CHAT from '@/models/chat.models'
import type * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as PluginsClient from '@/systems/plugins.client'

import { PluginEventRow } from '../server-event'
import * as RC from './render-context'
import { Row } from './rows'
import { renderStatic } from './static-render'
import { useRenderCtx } from './use-render-ctx'

type AppEvent = Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>

type Built = {
	event: CHAT.EventEnriched
	node: Node | null
	// a plugin's own rendering is arbitrary react registered in the browser, so it cannot be walked to dom like
	// every other row; the node is the placeholder its component portals into. Every other app event is a
	// template (see app-event-rows.tsx).
	appEvent: AppEvent | null
}

// whether this row has to keep a react component of its own
function pluginRendered(event: CHAT.EventEnriched): AppEvent | null {
	if (event.type !== 'APP_EVENT' || event.appEvent.type !== 'PLUGIN_EVENT') return null
	const appEvent = event.appEvent
	const rendering = PluginsClient.getEventRendering(appEvent.pluginId, {
		name: appEvent.name,
		payload: appEvent.payload,
		message: appEvent.message,
		time: appEvent.time,
		serverId: appEvent.serverId,
		matchId: appEvent.matchId,
	})
	return rendering ? event : null
}

function sameAppEvents(a: Built[], b: Built[]) {
	return a.length === b.length && a.every((row, i) => row.event === b[i].event && row.node === b[i].node)
}

// The recolor pass runs against the players the rows were rendered from, keyed by id: the element carries
// only the id (see RC.applyGroupColors), and the facts live here rather than serialized onto every name.
function collectFacts(map: Map<string, PG.PlayerFactsSource>, event: CHAT.EventEnriched) {
	const put = (value: unknown) => {
		if (!value || typeof value !== 'object' || !('ids' in value)) return
		const player = value as SM.Player
		map.set(SM.PlayerIds.getPlayerId(player.ids), player)
	}
	const fields = (CHAT.Wire.FIELDS as Record<string, { players?: readonly string[]; playerLists?: readonly string[] }>)[event.type]
	const record = event as unknown as Record<string, unknown>
	for (const key of fields?.players ?? []) put(record[key])
	for (const key of fields?.playerLists ?? []) {
		if (Array.isArray(record[key])) for (const value of record[key] as unknown[]) put(value)
	}
	if (event.type === 'WARNS_AGGREGATED') for (const warn of event.warns) put(warn.player)
}

/**
 * The activity feed's rows, built as dom from the inert row templates.
 *
 * A past match arrives as ~600 rows and ~10,000 nodes in one update, which react spends ~200ms on. The rows
 * have nothing react was buying -- no state, no changing props, no children that reorder -- so the templates
 * are walked straight to dom (see static-render.ts), and one delegated context menu, tooltip and window
 * opener serve the whole feed (see interactions.ts).
 *
 * The list only ever grows at the end while a match is live, so an update walks to the first event that
 * differs and rebuilds from there. Everything before it is left alone, which is what keeps an append cheap.
 */
export function FeedList(props: { events: CHAT.EventEnriched[] | null; stores: SquadServerFrame.KeyProp }) {
	const ctx = useRenderCtx(props.stores, props.events)
	const hostRef = React.useRef<HTMLDivElement | null>(null)
	const builtRef = React.useRef<{ ctx: RC.RenderCtx | null; rows: Built[] }>({ ctx: null, rows: [] })
	const factsRef = React.useRef(new Map<string, PG.PlayerFactsSource>())
	const [appEvents, setAppEvents] = React.useState<Built[]>([])
	const events = props.events

	React.useLayoutEffect(() => {
		const host = hostRef.current
		if (!host) return
		const next = events ?? []
		const previous = builtRef.current

		let shared = 0
		if (previous.ctx === ctx) {
			while (shared < previous.rows.length && shared < next.length && previous.rows[shared].event === next[shared]) shared++
		}
		if (shared === previous.rows.length && shared === next.length) return

		// a disclosure the reader opened survives a rebuild: it is their state, not the event's
		const opened = new Set<CHAT.EventEnriched['id']>()
		for (const row of previous.rows) {
			if (row.node instanceof HTMLDetailsElement && row.node.open) opened.add(row.event.id)
		}

		const rows = previous.rows.slice(0, shared)
		let keptNodes = 0
		for (const row of rows) if (row.node) keptNodes++
		while (host.childNodes.length > keptNodes) host.lastChild!.remove()

		const fragment = document.createDocumentFragment()
		for (let i = shared; i < next.length; i++) {
			const event = next[i]
			const appEvent = pluginRendered(event)
			const node = appEvent ? document.createElement('div') : renderStatic(React.createElement(Row, { ctx, event }))
			if (node instanceof HTMLDetailsElement && opened.has(event.id)) node.open = true
			if (node) fragment.appendChild(node)
			rows.push({ event, node, appEvent })
		}
		host.appendChild(fragment)

		const facts = new Map<string, PG.PlayerFactsSource>()
		for (const event of next) collectFacts(facts, event)
		factsRef.current = facts

		builtRef.current = { ctx, rows }
		const nextAppEvents = rows.filter((row) => row.appEvent)
		setAppEvents((current) => (sameAppEvents(current, nextAppEvents) ? current : nextAppEvents))
	}, [events, ctx])

	// a new row is built with the colour it should have; this is for the colours changing under rows already built
	const groupColor = BattlemetricsClient.useGroupColorResolver()
	React.useLayoutEffect(() => {
		if (hostRef.current) RC.applyGroupColors(hostRef.current, groupColor, (playerId) => factsRef.current.get(playerId))
	}, [groupColor])

	return (
		<>
			{/* display:contents so the rows are the feed container's own flex items, as they were when react rendered them */}
			<div
				ref={hostRef}
				{...{ [RC.SCOPE_ATTR]: ctx.scopeId }}
				className="contents [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_29px]"
			/>
			{appEvents.map((row) =>
				createPortal(<PluginEventRow ctx={ctx} event={row.appEvent!} />, row.node as Element, String(row.event.id)),
			)}
		</>
	)
}
