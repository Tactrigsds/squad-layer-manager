import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'

import * as LQY from '@/models/layer-queries.models'
import { initModule } from '@/server/logger'

import type * as C from '@/server/context'

import { getOrpcBase } from '@/server/orpc-base'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as LayerQueries from '@/systems/layer-queries.shared'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Settings from '@/systems/settings.server'
import { z } from 'zod'

const module = initModule('layer-queries')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export const router = {
	getLayerInfo: orpcBase.input(z.object({ layerId: L.LayerIdSchema })).handler(async ({ context: ctx, input }) => {
		const lqContext = { ...ctx, ...resolveLayerDbContext() }
		return await LayerQueries.getLayerInfo({ ctx: lqContext, input })
	}),
}

export function resolveLayerQueryCtx<Ctx extends C.MatchHistory & C.LayerQueue>(
	ctx: Ctx,
): Ctx & CS.LayerQuery {
	return {
		...ctx,
		log,
		...resolveLayerDbContext(),
		filters: FilterEntity.state.filters,
		generationConfig: Settings.GLOBAL_SETTINGS.layerGeneration,
	}
}

export async function resolveLayerItemsState(ctx: C.MatchHistory & C.LayerQueue & CS.AbortSignal): Promise<LQY.LayerItemsState> {
	return LQY.resolveLayerItemsState(
		LayerQueue.getSavedQueue(ctx),
		await MatchHistory.getRecentMatches(ctx),
	)
}

function resolveLayerDbContext(): CS.LayerDb {
	return {
		...CS.init(),
		layerDb: () => LayerDb.db,
		// derived from the extra columns the layer data shipped with, and memoized on them, so every request shares
		// one config object (the query layer caches drizzle views/schemas/cache keys against its identity)
		effectiveColsConfig: LC.getEffectiveColumnConfig(),
	}
}
