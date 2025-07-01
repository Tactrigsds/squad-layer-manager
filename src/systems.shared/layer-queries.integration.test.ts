import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as LayerDb from '@/server/systems/layer-db.server'
import * as MatchHistory from '@/server/systems/match-history'
import { getRandomGeneratedLayers, queryLayers } from '@/systems.shared/layer-queries.shared'
import { beforeAll, expect } from 'vitest'
import { test } from 'vitest'
import { ensureEnvSetup } from '../server/env'
import * as Log from '../server/logger'

let ctx!: CS.LayerQuery
beforeAll(async () => {
	ensureEnvSetup()
	Log.ensureLoggerSetup()
	await DB.setupDatabase()
	await MatchHistory.setup()
	await LayerDb.setup({ skipHash: true })

	ctx = C.resolveLayerQueryCtx({ log: Log.baseLogger })
})

test('can filter results', async () => {
	const filter = FB.and([FB.comp(FB.eq('Map', 'Lashkar')), FB.comp(FB.eq('Gamemode', 'TC'))])
	const res = await queryLayers({
		input: {
			constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'idk' }],
			previousLayerIds: [],
			pageSize: 50,
			pageIndex: 0,
		},
		ctx,
	})
	expect(res.layers.length).toBeGreaterThan(0)
	for (const layer of res.layers) {
		expect(layer.Map).toBe('Skorpo')
		expect(layer.Gamemode).toBe('TC')
	}
})

test.only('generate random layers', async () => {
	console.log(await getRandomGeneratedLayers(ctx, 50, [], [], true))
})
