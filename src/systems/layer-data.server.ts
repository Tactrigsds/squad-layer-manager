import crypto from 'crypto'
import * as fsPromise from 'node:fs/promises'
import * as Os from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { z } from 'zod'

import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import { initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

const gzip = promisify(zlib.gzip)

const module = initModule('layer-data')
let log!: CS.Logger

// What the /layer-data.json route serves, and its etag. Two paths rather than two Buffers: the file is ~14MB and
// its gzip ~4MB, and holding both resident costs that per process forever to answer a request the browser caches
// on the first load. On the demo fleet, where 98 instances share one box, it is also the difference between 98
// private copies and one set of pages in the OS cache -- the gzip is written to a path keyed by the artifact's
// own hash, so every instance running the same layer version reads the same file.
export let hash!: string
export let path!: string
// null when the gzip could not be written, in which case the route serves the file uncompressed
export let gzipPath: string | null = null

async function writeGzipOnce(source: Buffer, target: string) {
	try {
		await fsPromise.access(target)
		return
	} catch {
		// not written yet, or written by an instance that died mid-write. Either way, write it.
	}
	// atomic: 98 instances booting together must never read a half-written file, and rename within a directory is
	// the only way to promise that
	const staging = `${target}.${process.pid}.tmp`
	await fsPromise.writeFile(staging, await gzip(source))
	await fsPromise.rename(staging, target)
}

export async function setup() {
	log = module.getLogger()
	// the components are half of a versioned pair, and the layer engine loads the other half from the same
	// directory: whichever table it runs, these are the components its encoded values index into
	const { layerDataPath } = LayerArtifacts.resolvePair()
	const raw = await fsPromise.readFile(layerDataPath)
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
	path = layerDataPath
	const target = NodePath.join(Os.tmpdir(), `slm-layer-data-${hash.slice(0, 16)}.json.gz`)
	try {
		await writeGzipOnce(raw, target)
		gzipPath = target
	} catch (err) {
		log.warn({ err }, 'could not write %s; /layer-data.json will be served uncompressed', target)
	}
	log.info('loaded %s (%d bytes, hash %s)', layerDataPath, raw.length, hash.slice(0, 12))
}
