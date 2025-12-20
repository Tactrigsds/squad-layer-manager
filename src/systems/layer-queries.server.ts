import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import type * as SS from '@/models/server-state.models'
import type * as C from '@/server/context'
import orpcBase from '@/server/orpc-base'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as LayerQueries from '@/systems/layer-queries.shared'
import * as MatchHistory from '@/systems/match-history.server'
import { z } from 'zod'

export const router = {
	getLayerInfo: orpcBase.input(z.object({ layerId: L.LayerIdSchema })).handler(async ({ context: ctx, input }) => {
		const lqContext = { ...ctx, ...resolveLayerDbContext() }
		return await LayerQueries.getLayerInfo({ ctx: lqContext, input })
	}),
}

export async function resolveLayerQueryCtx<Ctx extends CS.Log & C.MatchHistory>(
	ctx: Ctx,
	serverState: SS.ServerState,
): Promise<Ctx & CS.LayerQuery> {
	return {
		...ctx,
		...resolveLayerDbContext(),
		filters: FilterEntity.state.filters,
		layerItemsState: LQY.resolveLayerItemsState(
			serverState.layerQueue,
			await MatchHistory.getRecentMatches(ctx),
		),
	}
}

function resolveLayerDbContext(): CS.LayerDb {
	return {
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
	}
}
