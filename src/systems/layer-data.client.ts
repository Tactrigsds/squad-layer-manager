import * as AR from '@/app-routes'
import * as LC from '@/models/layer-columns.models'
import * as L from '@/models/layer.models'

let loaded: Promise<L.LayerData> | null = null
// the content hash of the layer-data.json this page runs on. Null until loaded
export let hash: string | null = null

// most of the app assumes L.StaticLayerComponents is populated, so this must settle before the
// react root is mounted (see main.tsx)
export function setup(): Promise<L.LayerData> {
	loaded ??= load()
	return loaded
}

async function load(): Promise<L.LayerData> {
	const res = await fetch(AR.link('/layer-data.json'))
	if (!res.ok) throw new Error(`failed to fetch layer data: ${res.status} ${res.statusText}`)
	const bytes = await res.arrayBuffer()
	// the ETag is the server's sha256 of these bytes. Something in front of the app can strip it, and the socket
	// handshake needs the hash regardless, so it is computed the same way when missing.
	hash = AR.parseContentHashEtag(res.headers.get('ETag')) ?? toHex(await crypto.subtle.digest('SHA-256', bytes))
	const file = JSON.parse(new TextDecoder().decode(bytes)) as L.LayerDataFile
	const data: L.LayerData = {
		components: LC.buildFullLayerComponents(file.components),
		factionUnits: file.factionUnits,
		extraColumns: file.extraColumns,
	}
	L.setLayerData(data)
	return data
}

function toHex(buffer: ArrayBuffer) {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
