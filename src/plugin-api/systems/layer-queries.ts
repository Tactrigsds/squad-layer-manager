import { assertNever } from '@/lib/type-guards'
import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import type * as L from '@/models/layer.models'
import type * as GV from '@/plugin-api/models/gen-vote'
import * as LayerQueries from '@/systems/layer-queries.server'
import * as LayerQueriesShared from '@/systems/layer-queries.shared'
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
 * A constraint whose filter cannot be applied, because it names a column or value this install's layer data does
 * not have or applies a filter that no longer exists, is left out of the query rather than failing it. The query
 * runs on the remaining constraints and lists what it left out in `problems`. A query on a single filter-entity
 * constraint therefore matches every layer when that filter cannot be applied, so check `problems` before trusting
 * the result. Each error names the stored filter and the node it is in, and `msg.original` is the english text of
 * the reason.
 */

/** The queue and recent matches a repeat rule is measured against. Queries fill this in when `input.list` is absent. */
export async function itemsState(ctx: PluginsSys.ServerCtx<any>): Promise<LQY.LayerItemsState> {
	return await LayerQueries.resolveLayerItemsState(ctx)
}

export type QueryResult = {
	code: 'ok'
	layers: LayerQueriesShared.PostProcessedLayer[]
	totalCount: number
	pageCount: number
	/** Per-field possible values, for the filter-menu-items constraints in the input. Empty without them. */
	menuItemValues: Record<string, string[]>
	/** The constraints left out because their filters cannot be applied. Empty when every constraint applied. */
	problems: LQY.ConstraintProblem[]
}

/** A page of layers matching the constraints. `pageSize` is required; sort defaults to none. */
export async function query(ctx: PluginsSys.ServerCtx<any>, input: LQY.LayersQueryInput): Promise<QueryResult> {
	const qctx = await LayerQueries.resolveLayerQueryCtx(ctx)
	let page: Extract<LayerQueriesShared.QueryLayersResponsePart, { code: 'layers-page' }> | undefined
	let menuItemValues: Record<string, string[]> = {}
	for await (const part of LayerQueriesShared.queryLayersStreamed({ ctx: qctx, input: await withList(ctx, input) })) {
		switch (part.code) {
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
	// the generator always yields a page
	return {
		code: 'ok',
		layers: page!.layers,
		totalCount: page!.totalCount,
		pageCount: page!.pageCount,
		menuItemValues,
		problems: page!.problems,
	}
}

/** Whether each id names a layer this install knows. An id that is not even well-formed reports false rather than throwing. */
export async function exists(ctx: PluginsSys.ServerCtx<any>, layerIds: L.LayerId[]) {
	return await LayerQueriesShared.layerExists({ ctx: await LayerQueries.resolveLayerQueryCtx(ctx), input: layerIds })
}

/** Every column of one layer, scores included. Null when the id is unknown. */
export async function info(ctx: PluginsSys.ServerCtx<any>, layerId: L.LayerId) {
	return await LayerQueriesShared.getLayerInfo({ ctx: await LayerQueries.resolveLayerQueryCtx(ctx), input: { layerId } })
}

/** The distinct values of one column among the layers the constraints admit. What a picker is built from. */
export async function componentValues(
	ctx: PluginsSys.ServerCtx<any>,
	input: LQY.LayerComponentInput,
): Promise<{ code: 'ok'; values: string[]; problems: LQY.ConstraintProblem[] } | { code: 'err:unknown-column' }> {
	const res = await LayerQueriesShared.queryLayerComponent({ ctx: await LayerQueries.resolveLayerQueryCtx(ctx), input })
	return res.code === 'ok' ? { code: 'ok', values: res.values, problems: res.problems } : res
}

/**
 * Which of these layers the constraints reject. A layer that does not exist is out of pool. A constraint whose filter
 * cannot be applied rejects nothing and is listed in `problems`.
 */
export async function outOfPool(
	ctx: PluginsSys.ServerCtx<any>,
	input: { layerIds: L.LayerId[]; constraints: LQY.Constraint[] },
): Promise<{ code: 'ok'; outOfPool: L.LayerId[]; problems: LQY.ConstraintProblem[] }> {
	return await LayerQueriesShared.getLayersOutOfPool({ ctx: await LayerQueries.resolveLayerQueryCtx(ctx), input })
}

/**
 * What each queue item violates: repeat rules broken, filters matched, and the warnings admins are shown. The
 * constraints whose filters cannot be applied are left unchecked and listed in `statuses.problems`.
 */
export async function itemStatuses(ctx: PluginsSys.ServerCtx<any>, input: LQY.LayerItemStatusesInput) {
	return await LayerQueriesShared.getLayerItemStatuses({
		ctx: await LayerQueries.resolveLayerQueryCtx(ctx),
		input: await withList(ctx, input),
	})
}

export type GenVoteResult =
	| {
			code: 'ok'
			/** One per input choice, in order. Undefined where the choice already named a layer, or nothing was drawn. */
			chosenLayers: (LayerQueriesShared.PostProcessedLayer | undefined)[]
			/** Indices of the choices that had no layer and could not be filled. Empty on a full draw. */
			unfilledChoices: number[]
			/** The constraints left out of the draw because their filters cannot be applied. */
			problems: LQY.ConstraintProblem[]
	  }
	| {
			code: 'err:invalid-choices'
			/** The choices whose own conditions cannot be applied, by index into `input.choices`. */
			choices: { index: number; errors: F.NodeValidationError[] }[]
	  }

/**
 * Draws a layer for each choice that does not already name one, from the constraints minus what the other
 * choices took. Pass `seed` to make the draw reproducible, and `onlyIndex` to redraw a single choice.
 * `err:invalid-choices` lists the choices whose own conditions cannot be applied, and nothing is drawn. A constraint
 * that cannot be applied is left out of the draw and listed in `problems` instead.
 */
export async function genVote(ctx: PluginsSys.ServerCtx<any>, input: GV.Input): Promise<GenVoteResult> {
	const res = await LayerQueriesShared.genVote({ ctx: await LayerQueries.resolveLayerQueryCtx(ctx), input: await withList(ctx, input) })
	if (res.code !== 'ok') return res
	// the host reports a failed draw as an english sentence per choice, which is not a string to freeze into
	// this contract. Which choices came up empty is the same information and cannot rot.
	const unfilledChoices = res.choiceErrors.flatMap((err, i) => (err ? [i] : []))
	return { code: 'ok', chosenLayers: res.chosenLayers, unfilledChoices, problems: res.problems }
}

/** The min and max of every score column, for putting one layer's score in context. */
export async function scoreRanges(ctx: PluginsSys.ServerCtx<any>) {
	return await LayerQueriesShared.getScoreRanges({ ctx: await LayerQueries.resolveLayerQueryCtx(ctx) })
}

// Without a list, repeat rules have no history to measure against and quietly match nothing. The live queue is
// what a plugin almost always means; pass one explicitly to ask about a hypothetical queue instead.
async function withList<T extends LQY.BaseQueryInput>(ctx: PluginsSys.ServerCtx<any>, input: T): Promise<T> {
	return input.list ? input : { ...input, list: await LayerQueries.resolveLayerItemsState(ctx) }
}
