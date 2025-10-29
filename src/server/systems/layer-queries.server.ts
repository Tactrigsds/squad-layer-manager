import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as C from '@/server/context'
import orpcBase from '@/server/orpc-base'
import * as FilterEntity from '@/server/systems/filter-entity'
import * as LayerDb from '@/server/systems/layer-db.server'
import * as LayerQueries from '@/systems.shared/layer-queries.shared'

import { z } from 'zod'

export function resolveLayerQueryCtx<Ctx extends CS.Log & C.MatchHistory>(ctx: Ctx, serverState: SS.ServerState): Ctx & CS.LayerQuery {
	return {
		...ctx,
		...resolveLayerDbContext(),
		filters: FilterEntity.state.filters,
		layerItemsState: LQY.resolveLayerItemsState(
			serverState.layerQueue,
			ctx.matchHistory.recentMatches,
		),
	}
}

function resolveLayerDbContext(): CS.LayerDb {
	return {
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
	}
}

export const orpcRouter = {
	getLayerInfo: orpcBase.input(z.object({ layerId: L.LayerIdSchema })).handler(async ({ context: ctx, input }) => {
		const lqContext = { ...ctx, ...resolveLayerDbContext() }
		return await LayerQueries.getLayerInfo({ ctx: lqContext, input })
	}),
}
