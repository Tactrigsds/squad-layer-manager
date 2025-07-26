import * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as FilterEntity from '@/server/systems/filter-entity'
import * as LayerDb from '@/server/systems/layer-db.server'
import * as MatchHistory from '@/server/systems/match-history'

export function resolveLayerQueryCtx(ctx: CS.Log, serverState: SS.LQServerState): CS.LayerQuery {
	return {
		...ctx,
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
		filters: FilterEntity.state.filters,
		layerItemsState: LQY.resolveLayerItemsState(
			serverState.layerQueue,
			MatchHistory.state.recentMatches,
		),
	}
}
