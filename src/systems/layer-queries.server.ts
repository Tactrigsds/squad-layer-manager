import { z } from '@/lib/zod'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LE from '@/models/layer-engine'
import * as LQY from '@/models/layer-queries.models'
import type * as LQ from '@/models/layer-queue.models'
import type * as MH from '@/models/match-history.models'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerEngine from '@/systems/layer-engine.server'
import * as LayerQueries from '@/systems/layer-queries.shared'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Settings from '@/systems/settings.server'

const module = initModule('layer-queries')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export const router = {
	getLayerInfo: orpcBase.input(z.object({ layerId: L.LayerIdSchema })).handler(async ({ context: ctx, input }) => {
		const lqContext = { ...ctx, ...(await resolveLayerEngineContext()) }
		return await LayerQueries.getLayerInfo({ ctx: lqContext, input })
	}),
}

export async function resolveLayerQueryCtx<Ctx extends MH.Ctx & LQ.Ctx>(ctx: Ctx): Promise<Ctx & LQY.Ctx> {
	return {
		...ctx,
		log,
		...(await resolveLayerEngineContext()),
		filters: FilterEntity.state.filters,
		generationConfig: Settings.GLOBAL_SETTINGS.layerGeneration,
	}
}

// for evaluating anonymous filters against explicit layer ids, with no queue or match-history attachment
// (getLayersOutOfPool only reads the engine and the filter entities)
export async function resolveAnonLayerQueryCtx<Ctx extends object>(ctx: Ctx): Promise<Ctx & LayerQueries.QueryCtx> {
	return { ...ctx, ...(await resolveLayerEngineContext()), filters: FilterEntity.state.filters }
}

export async function resolveLayerItemsState(ctx: MH.Ctx & LQ.Ctx & CS.AbortSignal): Promise<LQY.LayerItemsState> {
	return LQY.resolveLayerItemsState(LayerQueue.getSavedQueue(ctx), await MatchHistory.getRecentMatches(ctx))
}

async function resolveLayerEngineContext(): Promise<LE.Ctx> {
	return {
		...CS.init(),
		engine: await LayerEngine.getEngine(),
		// derived from the extra columns the layer data shipped with, and memoized on them, so every request shares
		// one config object
		effectiveColsConfig: LC.getEffectiveColumnConfig(),
	}
}
