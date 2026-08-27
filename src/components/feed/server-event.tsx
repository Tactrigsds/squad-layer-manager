import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as CHAT from '@/models/chat.models'

import { AppEventEntry } from '../server-event'
import type * as RC from './render-context'
import { SCOPE_ATTR } from './render-context'
import { buildRow } from './rows'

/**
 * One feed row, for the short per-player and per-squad feeds that interleave their own markup between rows.
 *
 * The row is the same dom the activity feed builds; this only mounts it. The activity feed itself does not go
 * through here -- it builds its rows straight into one container (see feed-list.tsx), which is the whole point.
 */
export function ServerEvent(props: { event: CHAT.EventEnriched; ctx: RC.RenderCtx; stores: SquadServerFrame.KeyProp }) {
	if (props.event.type === 'APP_EVENT') return <AppEventEntry event={props.event} stores={props.stores} />
	return <DomRow ctx={props.ctx} event={props.event} />
}

function DomRow(props: { ctx: RC.RenderCtx; event: CHAT.EventEnriched }) {
	const hostRef = React.useRef<HTMLDivElement | null>(null)
	const { ctx, event } = props

	React.useLayoutEffect(() => {
		const host = hostRef.current
		if (!host) return
		const node = buildRow(ctx, event)
		if (node) host.replaceChildren(node)
		else host.replaceChildren()
	}, [ctx, event])

	// display:contents so the row is its container's own flex item, as it was when react rendered it
	return <div ref={hostRef} className="contents" {...{ [SCOPE_ATTR]: ctx.scopeId }} />
}
