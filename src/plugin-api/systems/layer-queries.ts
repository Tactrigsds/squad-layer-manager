import { assertNever } from '@/lib/type-guards'
import type * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import type * as LQY from '@/models/layer-queries.models'
import * as LayerQueriesSys from '@/systems/layer-queries.server'
import * as LayerQueries from '@/systems/layer-queries.shared'
import type * as PluginsSys from '@/systems/plugins.server'

/**
 * Asking the layer table questions: which layers match, whether one exists, what a queue item violates.
 * These are the same queries the layer table and the queue indicators run, against the same engine.
 *
 * Every one takes the plugin's per-server ctx and resolves the query context itself, so there is no setup
 * step. That context carries the live filter set and generation config, which is why a query reflects a
 * filter an admin edited a moment ago.
 *
 * Constraints are how a query is narrowed. Build them with slm/models/constraint-builders rather than by
 * hand: which of `filterApplState`, `showIndicator` and `warn` a constraint needs is not obvious, and the
 * pool constraint in particular is not what its fields look like.
 *
 * A malformed filter comes back as `err:invalid-node` rather than throwing. It carries what was wrong with
 * which node, and `msg.original` is the english text of the reason.
 */

/** The queue and recent matches a repeat rule is measured against. Queries fill this in when `input.list` is absent. */
export async function itemsState(ctx: PluginsSys.ServerCtx<any>): Promise<LQY.LayerItemsState> {
	return await LayerQueriesSys.resolveLayerItemsState(ctx)
}

export type QueryResult =
	| {
			code: 'ok'
			layers: LayerQueries.PostProcessedLayer[]
			totalCount: number
			pageCount: number
			/** Per-field possible values, for the filter-menu-items constraints in the input. Empty without them. */
			menuItemValues: Record<string, string[]>
	  }
	| F.InvalidFilterNodeResult

/** A page of layers matching the constraints. `pageSize` is required; sort defaults to none. */
export async function query(ctx: PluginsSys.ServerCtx<any>, input: LQY.LayersQueryInput): Promise<QueryResult> {
	const qctx = await LayerQueriesSys.resolveLayerQueryCtx(ctx)
	let page: Extract<LayerQueries.QueryLayersResponsePart, { code: 'layers-page' }> | undefined
	let menuItemValues: Record<string, string[]> = {}
	for await (const part of LayerQueries.queryLayersStreamed({ ctx: qctx, input: await withList(ctx, input) })) {
		switch (part.code) {
			case 'err:invalid-node':
				return part
			case 'layers-page':
				page = part
				break
			case 'menu-item-possible-values':
				menuItemValues = part.values
				break
			default:
				assertNever(part)
		}
	}
	// the generator yields a page or an error, never neither
	return { code: 'ok', layers: page!.layers, totalCount: page!.totalCount, pageCount: page!.pageCount, menuItemValues }
}

/** Whether each id names a layer this install knows. An id that is not even well-formed reports false rather than throwing. */
export async function exists(ctx: PluginsSys.ServerCtx<any>, layerIds: L.LayerId[]) {
	return await LayerQueries.layerExists({ ctx: await LayerQueriesSys.resolveLayerQueryCtx(ctx), input: layerIds })
}

/** Every column of one layer, scores included. Null when the id is unknown. */
export async function info(ctx: PluginsSys.ServerCtx<any>, layerId: L.LayerId) {
	return await LayerQueries.getLayerInfo({ ctx: await LayerQueriesSys.resolveLayerQueryCtx(ctx), input: { layerId } })
}

/** The distinct values of one column among the layers the constraints admit. What a picker is built from. */
export async function componentValues(
	ctx: PluginsSys.ServerCtx<any>,
	input: LQY.LayerComponentInput,
): Promise<{ code: 'ok'; values: string[] } | { code: 'err:unknown-column' } | F.InvalidFilterNodeResult> {
	const res = await LayerQueries.queryLayerComponent({ ctx: await LayerQueriesSys.resolveLayerQueryCtx(ctx), input })
	// the host hands back a bare array on success, which is the one result here that does not carry a code
	return Array.isArray(res) ? { code: 'ok', values: res } : res
}

/** Which of these layers the constraints reject. A layer that does not exist is out of pool. */
export async function outOfPool(ctx: PluginsSys.ServerCtx<any>, input: { layerIds: L.LayerId[]; constraints: LQY.Constraint[] }) {
	return await LayerQueries.getLayersOutOfPool({ ctx: await LayerQueriesSys.resolveLayerQueryCtx(ctx), input })
}

/** What each queue item violates: repeat rules broken, filters matched, and the warnings admins are shown. */
export async function itemStatuses(ctx: PluginsSys.ServerCtx<any>, input: LQY.LayerItemStatusesInput) {
	return await LayerQueries.getLayerItemStatuses({
		ctx: await LayerQueriesSys.resolveLayerQueryCtx(ctx),
		input: await withList(ctx, input),
	})
}

/** The min and max of every score column, for putting one layer's score in context. */
export async function scoreRanges(ctx: PluginsSys.ServerCtx<any>) {
	return await LayerQueries.getScoreRanges({ ctx: await LayerQueriesSys.resolveLayerQueryCtx(ctx) })
}

// Without a list, repeat rules have no history to measure against and quietly match nothing. The live queue is
// what a plugin almost always means; pass one explicitly to ask about a hypothetical queue instead.
async function withList<T extends LQY.BaseQueryInput>(ctx: PluginsSys.ServerCtx<any>, input: T): Promise<T> {
	return input.list ? input : { ...input, list: await LayerQueriesSys.resolveLayerItemsState(ctx) }
}
