import * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import * as LayerDb from '@/server/systems/layer-db.server'

export const layers = LC.layers

const ctx: CS.EffectiveColumnConfig = {
	effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
}

export const extraCols = LC.extraColsSchema(ctx)

export const layersView = LC.layersView(ctx)
