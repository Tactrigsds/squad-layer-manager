import React from 'react'
import { createPortal } from 'react-dom'

import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as CHAT from '@/models/chat.models'
import * as HQ from '@/models/history.models'
import type * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as HistoryClient from '@/systems/history.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'

import { PluginEventRow } from '../server-event'
import * as RC from './render-context'
import { Row } from './rows'
import * as Selection from './selection'
import { renderStatic } from './static-render'
import { useEventsSelectionText, useRenderCtx } from './use-render-ctx'

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

// The history page's link to rows of this log (see HQ.activityLogQuery). Stable, and reads what the log is
// showing only when asked, so it never costs the feed a rebuild. None while the log has no match on record to
// name, such as before the first sync, and none for a user who may not open the history page.
function useActivityLogLink(stores: SquadServerFrame.KeyProp): RC.RenderCtx['linkToRows'] {
	const serverId = stores.squadServer!.serverId
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const recentMatches = MatchHistoryClient.useRecentMatches(serverId)
	return HistoryClient.useRowsLink((selection, rows) => {
		const state = Zus.resolveStore<SquadServerFrame.State>(stores.squadServer!).getState()
		const match = ChatPrt.Sel.displayMatch(state, currentMatch, recentMatches)
		if (!match) return undefined
		const feed = state.chat.secondaryFilterState
		// Under a narrowing filter, an end on a pinned row would name an event the results leave out, so the ends
		// move inward to the nearest rows they keep. ALL and DEFAULT keep every pinned kind.
		let ends: RC.RowSelection | undefined = selection
		if (feed !== 'ALL' && feed !== 'DEFAULT') {
			const kept = rows.filter((row) => !row.hasAttribute(RC.ROW_PINNED_ATTR))
			const first = kept[0]?.getAttribute(RC.ROW_ATTR)
			const last = kept.at(-1)?.getAttribute(RC.ROW_ATTR)
			ends = first && last ? { anchor: first, head: last } : undefined
		}
		if (!ends) return undefined
		return {
			query: HQ.activityLogQuery({ serverId, matchId: match.historyEntryId, feed }),
			ends,
			caveat: state.chat.selectedOnly ? tr.text(CHAT_Msgs.linkOmitsSelectedOnly()) : undefined,
		}
	})
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
	const ctx = useRenderCtx(props.stores, props.events, {
		linkToRows: useActivityLogLink(props.stores),
		selectionText: useEventsSelectionText(props.events),
	})
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
			if (node instanceof Element) {
				RC.setRowIdentity(node, event)
				if (CHAT.isPinnedSystemEvent(event) && event.type !== 'NEW_GAME') node.setAttribute(RC.ROW_PINNED_ATTR, '')
			}
			if (node) fragment.appendChild(node)
			rows.push({ event, node, appEvent })
		}
		host.appendChild(fragment)
		Selection.paint(host)

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
			{/* display:contents so the rows are the feed container's own flex items, as they were when react rendered them.
			    A freshly inserted content-visibility:auto row is skipped, at its placeholder size, until the next
			    intersection pass, so the newest row is exempt: it paints at its real size on the frame it arrives. */}
			<div
				ref={hostRef}
				{...{ [RC.SCOPE_ATTR]: ctx.scopeId, [RC.SELECTABLE_ATTR]: ctx.scopeId }}
				className={`contents [&>*:not(:last-child)]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_29px] ${Selection.HOST_CLASS}`}
			/>
			{appEvents.map((row) =>
				createPortal(<PluginEventRow ctx={ctx} event={row.appEvent!} />, row.node as Element, String(row.event.id)),
			)}
		</>
	)
}
