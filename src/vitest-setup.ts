import * as Paths from '$root/paths'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import fs from 'node:fs'
import path from 'node:path'

// mirrors layer-data.server.ts setup(), minus the serving concerns
const file = JSON.parse(fs.readFileSync(path.join(Paths.DATA, 'layer-data.json'), 'utf8')) as L.LayerDataFile
L.setLayerData({
	components: LC.buildFullLayerComponents(file.components),
	factionUnits: file.factionUnits,
	extraColumns: file.extraColumns,
})
