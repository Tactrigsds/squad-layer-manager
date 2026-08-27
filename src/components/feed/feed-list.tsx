import React from 'react'
import { createPortal } from 'react-dom'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as CHAT from '@/models/chat.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'

import { AppEventEntry } from '../server-event'
import * as RC from './render-context'
import { buildRow } from './rows'
import { useRenderCtx } from './use-render-ctx'

type AppEvent = Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>

type Built = {
	event: CHAT.EventEnriched
	node: Node | null
	// an app event keeps its react component; the node is the placeholder that component portals into
	appEvent: AppEvent | null
}

function sameAppEvents(a: Built[], b: Built[]) {
	return a.length === b.length && a.every((row, i) => row.event === b[i].event && row.node === b[i].node)
}

/**
 * The activity feed's rows, built as dom rather than rendered.
 *
 * A past match arrives as ~600 rows and ~10,000 nodes in one update, which react spends ~200ms on. The rows have
 * nothing react was buying -- no state, no changing props, no children that reorder -- but they do have a context
 * menu, a tooltip and a window to open per name, which is why those moved to one delegated handler each (see
 * interactions.ts) rather than one radix root each.
 *
 * The list only ever grows at the end while a match is live, so an update walks to the first event that differs and
 * rebuilds from there. Everything before it is left alone, which is what keeps an append cheap.
 */
export function FeedList(props: { events: CHAT.EventEnriched[] | null; stores: SquadServerFrame.KeyProp }) {
	const ctx = useRenderCtx(props.stores)
	const hostRef = React.useRef<HTMLDivElement | null>(null)
	const builtRef = React.useRef<{ ctx: RC.RenderCtx | null; rows: Built[] }>({ ctx: null, rows: [] })
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
			const appEvent = event.type === 'APP_EVENT' ? event : null
			const node = appEvent ? document.createElement('div') : buildRow(ctx, event)
			if (node instanceof HTMLDetailsElement && opened.has(event.id)) node.open = true
			if (node) fragment.appendChild(node)
			rows.push({ event, node, appEvent })
		}
		host.appendChild(fragment)

		builtRef.current = { ctx, rows }
		const nextAppEvents = rows.filter((row) => row.appEvent)
		setAppEvents((current) => (sameAppEvents(current, nextAppEvents) ? current : nextAppEvents))
	}, [events, ctx])

	// a new row is built with the colour it should have; this is for the colours changing under rows already built
	const groupColor = BattlemetricsClient.useGroupColorResolver()
	React.useLayoutEffect(() => {
		if (hostRef.current) RC.applyGroupColors(hostRef.current, groupColor)
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
				createPortal(<AppEventEntry event={row.appEvent!} stores={props.stores} />, row.node as Element, String(row.event.id)),
			)}
		</>
	)
}
