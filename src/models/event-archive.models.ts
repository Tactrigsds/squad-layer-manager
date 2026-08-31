import { promisify } from 'node:util'
import zlib from 'node:zlib'

import type * as SchemaModels from '$root/drizzle/schema.models'

const zstdCompress = promisify(zlib.zstdCompress)
const zstdDecompress = promisify(zlib.zstdDecompress)

// zstd rather than deflate, and level 12 rather than the default 3. Measured on three real matches
// (150-530KB of events each): level 12 reaches ~16:1 where deflate-with-dictionary reaches ~11:1 and
// brotli, at a comparable ratio, costs 100x the compression time. A whole match compresses this well
// because it repeats itself -- the same player ids, weapon names and json keys, thousands of times.
export const ENCODING = 'zstd-json-v1'
const COMPRESSION_LEVEL = 12

// A match's events, minus what the archive row already records. matchId is constant per blob and the
// column holds it; everything else is per event.
type PackedEvent = {
	id: number
	type: string
	time: number
	appEventId: string | null
	version: number | null
	data: unknown
}

export type ArchivableEvent = Pick<SchemaModels.ServerEvent, 'id' | 'type' | 'time' | 'appEventId' | 'version' | 'data'>

// Async on purpose: node runs zlib on the threadpool, so a compaction pass doesn't block the event loop
// the way better-sqlite3 does. Callers must therefore pack OUTSIDE the write transaction and only insert
// inside it -- awaiting non-query work under the process-wide transaction lock stalls every other write.
export async function pack(events: ArchivableEvent[]): Promise<Buffer> {
	const packed: PackedEvent[] = events.map((e) => ({
		id: e.id,
		type: e.type,
		time: e.time.getTime(),
		appEventId: e.appEventId,
		version: e.version,
		data: e.data,
	}))
	return await zstdCompress(Buffer.from(JSON.stringify(packed), 'utf8'), {
		params: { [zlib.constants.ZSTD_c_compressionLevel]: COMPRESSION_LEVEL },
	})
}

// Returns rows shaped exactly as a `select` from serverEvents would, so a reader cannot tell whether a match
// came from the hot table or the archive. That equivalence is what lets every per-match read path stay
// unaware of compaction.
export async function unpack(matchId: number, encoding: string, blob: Buffer): Promise<SchemaModels.ServerEvent[]> {
	if (encoding !== ENCODING) throw new Error(`unknown archived-match encoding ${encoding} (match ${matchId})`)
	const json = (await zstdDecompress(blob)).toString('utf8')
	const packed = JSON.parse(json) as PackedEvent[]
	return packed.map((e) => ({
		id: e.id,
		type: e.type as SchemaModels.ServerEvent['type'],
		time: new Date(e.time),
		matchId,
		appEventId: e.appEventId,
		version: e.version,
		data: e.data,
	}))
}
