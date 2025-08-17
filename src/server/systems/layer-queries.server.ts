import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as FilterEntity from '@/server/systems/filter-entity'
import * as LayerDb from '@/server/systems/layer-db.server'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as MatchHistory from '@/server/systems/match-history'
import * as LayerQueries from '@/systems.shared/layer-queries.shared'

import { z } from 'zod'
import { procedure, router } from '../trpc.server'

export function resolveLayerQueryCtx<Ctx extends CS.Log>(ctx: Ctx, serverState: SS.LQServerState): Ctx & CS.LayerQuery {
	return {
		...ctx,
		...resolveLayerDbContext(),
		filters: FilterEntity.state.filters,
		layerItemsState: LQY.resolveLayerItemsState(
			serverState.layerQueue,
			MatchHistory.state.recentMatches,
		),
	}
}

function resolveLayerDbContext(): CS.LayerDb {
	return {
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
	}
}

export const layerQueriesRouter = router({
	getLayerInfo: procedure.input(z.object({ layerId: L.LayerIdSchema })).query(async ({ ctx, input }) => {
		const lqContext = { ...ctx, ...resolveLayerDbContext() }
		return await LayerQueries.getLayerInfo({ ctx: lqContext, input })
	}),
})
