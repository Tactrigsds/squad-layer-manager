import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import type * as CS from '@/models/context-shared'
import * as HQ from '@/models/history.models'
import type * as L from '@/models/layer'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as HistoryQuery from '@/systems/history-query.shared'
import * as LayerQueriesServer from '@/systems/layer-queries.server'
import * as LayerQueries from '@/systems/layer-queries.shared'
import * as Rbac from '@/systems/rbac.server'

// The main-thread half of query resolution: the parts the query engine must not depend on. Visibility comes
// from rbac; match-layer nodes need the layer engine's wasm artifact, so they are evaluated here and
// rewritten into match-id sets before the tree is shipped to the engine, which may be running in a worker

const MAX_LAYER_MATCHES = 100_000

export async function visibleServerIds(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal): Promise<string[]> {
	const servers = await ctx.db().select({ id: Schema.servers.id }).from(Schema.servers)
	const visible: string[] = []
	for (const { id } of servers) {
		if (await Rbac.canViewServerForUser(ctx, id)) visible.push(id)
	}
	return visible
}

export type RewriteResult = { code: 'ok'; node: HQ.Node; unrecognisedLayerMatches: number } | HistoryQuery.QueryError

/**
 * Replaces every match-layer node (including inside subqueries) with a match-ids node holding the matches
 * whose played layer passes its filter, scoped to `bounds`. Matches whose layer this build cannot parse are
 * excluded and counted in `unrecognisedLayerMatches` -- silently dropping them would make a layer-filtered
 * query quietly incomplete. Copy-on-write: subtrees without layer nodes are returned as-is.
 */
export async function rewriteLayerNodes(ctx: C.Db & CS.AbortSignal, root: HQ.Node, bounds: HistoryQuery.Bounds): Promise<RewriteResult> {
	// most queries carry no layer node, so the engine ctx is resolved on first use
	let lqCtx: LayerQueries.QueryCtx | undefined
	let sawLayerNode = false
	const scope = HistoryQuery.matchBoundsCond(bounds)

	const rewrite = async (node: HQ.Node): Promise<{ code: 'ok'; node: HQ.Node } | HistoryQuery.QueryError> => {
		if (HQ.isBlockNode(node)) {
			let changed = false
			const children: HQ.Node[] = []
			for (const child of node.children) {
				const res = await rewrite(child)
				if (res.code !== 'ok') return res
				changed ||= res.node !== child
				children.push(res.node)
			}
			return { code: 'ok', node: changed ? { ...node, children } : node }
		}
		if (node.type === 'subquery') {
			const res = await rewrite(node.filter)
			if (res.code !== 'ok') return res
			return { code: 'ok', node: res.node === node.filter ? node : { ...node, filter: res.node } }
		}
		if (node.type !== 'match-layer') return { code: 'ok', node }

		sawLayerNode = true
		lqCtx ??= await LayerQueriesServer.resolveAnonLayerQueryCtx({ ...ctx })

		// the filter is evaluated against the layers actually played, not against the layer universe: the
		// played set is bounded by the match count, while the universe is combinatorial
		const played = await ctx
			.db()
			.selectDistinct({ layerId: Schema.matchHistory.layerId })
			.from(Schema.matchHistory)
			.where(E.and(E.isNotNull(Schema.matchHistory.layerMap), scope))
		const pool = await LayerQueries.getLayersOutOfPool({
			ctx: lqCtx,
			input: {
				layerIds: played.map((p) => p.layerId as L.LayerId),
				constraints: [
					{ type: 'filter-anon', filter: node.filter, filterApplState: 'regular', showIndicator: 'disabled', id: 'history' },
				],
			},
		})
		if (pool.code !== 'ok') return pool
		const outOfPool = new Set<string>(pool.outOfPool)
		const inPool = played.map((p) => p.layerId).filter((id) => !outOfPool.has(id))
		if (inPool.length === 0) return { code: 'ok', node: { type: 'match-ids', neg: node.neg, matchIds: [] } }

		const matches = await ctx
			.db()
			.select({ id: Schema.matchHistory.id })
			.from(Schema.matchHistory)
			.where(E.and(E.inArray(Schema.matchHistory.layerId, inPool), scope))
			.limit(MAX_LAYER_MATCHES + 1)
		if (matches.length > MAX_LAYER_MATCHES) return { code: 'err:too-broad', message: 'a layer filter matched too many matches' }
		return { code: 'ok', node: { type: 'match-ids', neg: node.neg, matchIds: matches.map((m) => m.id) } }
	}

	const res = await rewrite(root)
	if (res.code !== 'ok') return res

	let unrecognisedLayerMatches = 0
	if (sawLayerNode) {
		const [{ count } = { count: 0 }] = await ctx
			.db()
			.select({ count: E.count() })
			.from(Schema.matchHistory)
			.where(E.and(E.isNull(Schema.matchHistory.layerMap), scope))
		unrecognisedLayerMatches = count
	}
	return { code: 'ok', node: res.node, unrecognisedLayerMatches }
}
