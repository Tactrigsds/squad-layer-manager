import * as SchemaModels from '$root/drizzle/schema.models'
import * as Schema from '$root/drizzle/schema.ts'
import * as L from '@/models/layer'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { ensureEnvSetup } from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import { beforeAll, expect, test } from 'vitest'

let ctx!: C.Db & C.Log

beforeAll(async () => {
	ensureEnvSetup()
	ensureLoggerSetup()
	await DB.setupDatabase()
	ctx = DB.addPooledDb({ log: baseLogger })
})

test('getKnownLayerFromId consistency', async () => {
	const sampleLayers = ctx.db().select(SchemaModels.MINI_LAYER_SELECT).from(Schema.layers).iterator()
	for await (const _layer of sampleLayers) {
		const layer = _layer as L.KnownLayer
		const fromId = L.parseKnownLayerId(layer.id)
		expect(fromId).toEqual(layer)
	}
}, 10000)
