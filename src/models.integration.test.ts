import { beforeAll, expect, test } from 'vitest'

import * as M from '@/models'
import * as DB from '@/server/db'
import { setupEnv } from '@/server/env'
import { baseLogger, setupLogger } from '@/server/logger'
import * as Schema from '@/server/schema'

let db: DB.Db

beforeAll(async () => {
	setupEnv()
	await setupLogger()
	DB.setupDatabase()
	db = DB.get({ log: baseLogger })
})

test('getMiniLayerFromId consistency', async () => {
	const sampleLayers = await db.select(Schema.MINI_LAYER_SELECT).from(Schema.layers)

	for (const layer of sampleLayers) {
		const fromId = M.getMiniLayerFromId(layer.id)
		expect(fromId).toEqual(layer)
	}
})
