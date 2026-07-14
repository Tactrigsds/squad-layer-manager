import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import { initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import crypto from 'crypto'
import * as fsPromise from 'node:fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { z } from 'zod'

const gzip = promisify(zlib.gzip)

const module = initModule('layer-data')
let log!: CS.Logger

// raw file bytes and their hash/gzipped form, kept around to serve the same data to clients
// (see the /layer-data.json route)
export let hash!: string
export let raw!: Buffer
export let gzipped!: Buffer

export async function setup() {
	log = module.getLogger()
	// the components are half of a versioned pair, and the layer engine loads the other half from the same
	// directory: whichever table it runs, these are the components its encoded values index into
	const { layerDataPath } = LayerArtifacts.resolvePair()
	raw = await fsPromise.readFile(layerDataPath)
	const file = JSON.parse(raw.toString('utf8')) as L.LayerDataFile
	if (!file.components || !file.factionUnits || !file.extraColumns) {
		throw new Error(`${layerDataPath} is malformed: expected { components, factionUnits, extraColumns }. re-run pnpm preprocess`)
	}
	L.setLayerData({
		components: LC.buildFullLayerComponents(file.components),
		factionUnits: file.factionUnits,
		// the layer db's extra columns are described by the artifact that ships them, so nothing but preprocess
		// ever reads layer-db.json
		extraColumns: z.array(LC.ColumnDefSchema).parse(file.extraColumns),
	})
	hash = crypto.createHash('sha256').update(raw).digest('hex')
	gzipped = await gzip(raw)
	log.info('loaded %s (%d bytes, hash %s)', layerDataPath, raw.length, hash.slice(0, 12))
}
