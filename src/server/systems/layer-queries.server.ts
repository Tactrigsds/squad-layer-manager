import * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import * as FilterEntity from '@/server/systems/filter-entity'
import * as LayerDb from '@/server/systems/layer-db.server'

export function resolveLayerQueryCtx(ctx: CS.Log): CS.LayerQuery {
	return {
		...ctx,
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
		filters: FilterEntity.state.filters,
	}
}
