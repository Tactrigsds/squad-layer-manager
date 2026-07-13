import * as AR from '@/app-routes'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'

let loaded: Promise<L.LayerData> | null = null

// most of the app assumes L.StaticLayerComponents is populated, so this must settle before the
// react root is mounted (see main.tsx)
export function setup(): Promise<L.LayerData> {
	loaded ??= load()
	return loaded
}

async function load(): Promise<L.LayerData> {
	const res = await fetch(AR.link('/layer-data.json'))
	if (!res.ok) throw new Error(`failed to fetch layer data: ${res.status} ${res.statusText}`)
	const file = (await res.json()) as L.LayerDataFile
	const data: L.LayerData = {
		components: LC.buildFullLayerComponents(file.components),
		factionUnits: file.factionUnits,
		extraColumns: file.extraColumns,
	}
	L.setLayerData(data)
	return data
}
