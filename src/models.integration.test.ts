import { beforeAll, expect, test } from 'vitest'

import * as M from '@/models'
import * as DB from '@/server/db'
import * as C from '@/server/context'
import { setupEnv } from '@/server/env'
import { baseLogger, setupLogger } from '@/server/logger'
import * as Schema from '@/server/schema'

let ctx!: C.Db & C.Log

beforeAll(async () => {
	setupEnv()
	await setupLogger()
	DB.setupDatabase()
	ctx = DB.addPooledDb({ log: baseLogger })
})

test('getMiniLayerFromId consistency', async () => {
	const sampleLayers = ctx.db().select(Schema.MINI_LAYER_SELECT).from(Schema.layers).iterator()
	for await (const _layer of sampleLayers) {
		const layer = M.includeComputedCollections(_layer)
		const fromId = M.getMiniLayerFromId(layer.id)
		expect(fromId).toEqual(layer)
	}
}, 10000)
