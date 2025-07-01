import * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import * as LayerDb from '@/server/systems/layer-db.server'

export const genLayerColumnOrder = LC.genLayerColumnOrder
export const genLayerWeights = LC.genLayerWeights

export const layers = LC.layers
export const layer = LC.layerStrIds

const ctx: CS.EffectiveColumnConfig = {
	effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.EXTRA_COLS_CONFIG),
}

export const extraCols = LC.extraColsSchema(ctx)

export const layersView = LC.layersView(ctx)
