import * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import * as FilterEntity from '@/server/systems/filter-entity'
import * as LayerDb from '@/server/systems/layer-db.server'
import * as MatchHistory from '@/server/systems/match-history'

export function resolveLayerQueryCtx(ctx: CS.Log): CS.LayerQuery {
	return {
		...ctx,
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
		recentMatches: MatchHistory.state.recentMatches,
		filters: FilterEntity.state.filters,
	}
}
