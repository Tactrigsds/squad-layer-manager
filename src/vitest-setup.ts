import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import fs from 'node:fs'

// mirrors layer-data.server.ts setup(), minus the serving concerns
const file = JSON.parse(fs.readFileSync(LayerArtifacts.resolvePair().layerDataPath, 'utf8')) as L.LayerDataFile
L.setLayerData({
	components: LC.buildFullLayerComponents(file.components),
	factionUnits: file.factionUnits,
	extraColumns: file.extraColumns,
})
