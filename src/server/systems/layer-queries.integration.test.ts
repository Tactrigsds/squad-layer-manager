import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as MatchHistory from '@/server/systems/match-history'
import { beforeAll, expect } from 'vitest'
import { test } from 'vitest'
import { ensureEnvSetup } from '../env'
import * as Log from '../logger'
import { getRandomGeneratedLayers, queryLayers } from './layer-queries'

let ctx!: C.Db & C.Log
beforeAll(async () => {
	ensureEnvSetup()
	Log.ensureLoggerSetup()
	await DB.setupDatabase()
	await MatchHistory.setup()

	ctx = DB.addPooledDb({ log: Log.baseLogger })
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
