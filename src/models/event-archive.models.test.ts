import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { describe, expect, test } from 'vitest'

import type * as SchemaModels from '$root/drizzle/schema.models'
import * as EA from '@/models/event-archive.models'

// The archive is the source of truth for a compacted match, and every read path assumes an unpacked row is
// indistinguishable from the row that went in. That equivalence is the whole contract, so it is what is tested.

function row(overrides: Partial<SchemaModels.ServerEvent> = {}): SchemaModels.ServerEvent {
	return {
		id: 1,
		type: 'CHAT_MESSAGE',
		time: new Date(1_700_000_000_000),
		matchId: 42,
		appEventId: null,
		version: 1,
		data: { json: { message: 'hello "there"\n', player: 'eos-1', channel: { type: 'ChatAll' } } },
		...overrides,
	}
}

// the row as compaction reads it: time and data as the columns store them
function stored(r: SchemaModels.ServerEvent): EA.ArchivableEvent {
	return { id: r.id, type: r.type, time: r.time.getTime(), appEventId: r.appEventId, version: r.version, data: JSON.stringify(r.data) }
}

const ROWS = [
	row({ id: 1 }),
	row({ id: 2, type: 'PLAYER_WOUNDED', data: { json: { damage: 139.7, weapon: null, variant: 'teamkill' } } }),
	row({
		id: 3,
		type: 'MAP_SET',
		appEventId: 'ae_123',
		version: null,
		data: { json: { layerId: 'HJ-RAAS-V3' }, meta: { values: {} } },
	}),
]

describe('event archive codec', () => {
	test('unpacked rows equal the rows that were packed', async () => {
		const unpacked = await EA.unpack(42, EA.ENCODING, await EA.pack(ROWS.map(stored)))

		expect(unpacked).toEqual(ROWS)
	})

	// blobs packed from parsed rows are already on disk, so the text has to stay what JSON.stringify gave
	test('the packed json is the text of the parsed rows', async () => {
		const blob = await EA.pack(ROWS.map(stored))
		const json = (await promisify(zlib.zstdDecompress)(blob)).toString('utf8')

		expect(json).toBe(
			JSON.stringify(
				ROWS.map((r) => ({
					id: r.id,
					type: r.type,
					time: r.time.getTime(),
					appEventId: r.appEventId,
					version: r.version,
					data: r.data,
				})),
			),
		)
	})

	test('an empty match round-trips', async () => {
		expect(await EA.unpack(42, EA.ENCODING, await EA.pack([]))).toEqual([])
	})

	test('an unknown encoding is refused rather than misread', async () => {
		await expect(EA.unpack(42, 'zstd-json-v99', await EA.pack([stored(row())]))).rejects.toThrow(/unknown archived-match encoding/)
	})
})
