import type * as CHAT from '@/models/chat.models'

import type * as RC from './render-context'
import { SCOPE_ATTR } from './render-context'
import { Row } from './rows'

/**
 * One feed row, for the short per-player and per-squad feeds that interleave their own markup between rows.
 *
 * The row is the same inert template the activity feed serializes; here it renders as a plain react child.
 * The activity feed itself does not go through here -- it inserts rendered strings straight into one
 * container (see feed-list.tsx), which is the whole point.
 */
export function ServerEvent(props: { event: CHAT.EventEnriched; ctx: RC.RenderCtx }) {
	return (
		<div className="contents" {...{ [SCOPE_ATTR]: props.ctx.scopeId }}>
			<Row ctx={props.ctx} event={props.event} />
		</div>
	)
}
