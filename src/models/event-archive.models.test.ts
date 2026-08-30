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
		data: { json: { message: 'hello', player: 'eos-1', channel: { type: 'ChatAll' } } },
		...overrides,
	}
}

describe('event archive codec', () => {
	test('unpacked rows equal the rows that were packed', async () => {
		const rows = [
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

		const unpacked = await EA.unpack(42, EA.ENCODING, await EA.pack(rows))

		expect(unpacked).toEqual(rows)
	})

	test('an empty match round-trips', async () => {
		expect(await EA.unpack(42, EA.ENCODING, await EA.pack([]))).toEqual([])
	})

	test('an unknown encoding is refused rather than misread', async () => {
		await expect(EA.unpack(42, 'zstd-json-v99', await EA.pack([row()]))).rejects.toThrow(/unknown archived-match encoding/)
	})
})
