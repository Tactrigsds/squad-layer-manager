import { beforeAll, expect, test } from 'vitest'

import * as SchemaModels from '$root/drizzle/schema.models'
import * as Schema from '$root/drizzle/schema.ts'
import * as M from '@/models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { ensureEnvSetup } from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'

let ctx!: C.Db & C.Log

beforeAll(async () => {
	ensureEnvSetup()
	await ensureLoggerSetup()
	DB.setupDatabase()
	ctx = DB.addPooledDb({ log: baseLogger })
})

test('getMiniLayerFromId consistency', async () => {
	const sampleLayers = ctx.db().select(SchemaModels.MINI_LAYER_SELECT).from(Schema.layers).iterator()
	for await (const _layer of sampleLayers) {
		const layer = M.includeComputedCollections(_layer as M.MiniLayer)
		const fromId = M.getMiniLayerFromId(layer.id)
		expect(fromId).toEqual(layer)
	}
}, 10000)
