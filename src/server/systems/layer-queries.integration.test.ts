import * as FB from '@/lib/filter-builders'
import * as M from '@/models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { beforeAll, expect } from 'vitest'
import { test } from 'vitest'
import { ensureEnvSetup } from '../env'
import * as Log from '../logger'
import { queryLayers } from './layer-queries'

let ctx!: C.Db & C.Log
beforeAll(async () => {
	ensureEnvSetup()
	Log.ensureLoggerSetup()
	await DB.setupDatabase()
	ctx = DB.addPooledDb({ log: Log.baseLogger })
})

test('can filter results', async () => {
	const filter = FB.and([FB.comp(FB.eq('Level', 'Lashkar')), FB.comp(FB.eq('Gamemode', 'TC'))])
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
		expect(layer.Level).toBe('Skorpo')
		expect(layer.Gamemode).toBe('TC')
	}
})

test('can filter by faction matchup', async () => {
	const filter = FB.comp(FB.hasAll('FactionMatchup', ['MEA', 'PLA']))
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
		expect([layer.Faction_1, layer.Faction_2]).toContain('MEA')
		expect([layer.Faction_1, layer.Faction_2]).toContain('PLA')
	}
})

test('can filter by sub-faction matchup', async () => {
	const filter = FB.comp(FB.hasAll('SubFacMatchup', ['CombinedArms', 'Armored']))
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
		expect([layer.SubFac_1, layer.SubFac_2]).toContain('CombinedArms')
		expect([layer.SubFac_1, layer.SubFac_2]).toContain('Armored')
	}
})

test('can filter by full faction matchup', async () => {
	const matchup = ['USA-CA', 'PLA-CA']
	const filter = FB.comp(FB.hasAll('FullMatchup', matchup))
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
		const team1 = M.getLayerTeamString(layer.Faction_1, layer.SubFac_1)
		const team2 = M.getLayerTeamString(layer.Faction_2, layer.SubFac_2)
		expect([team1, team2]).toContain(matchup[0])
		expect([team1, team2]).toContain(matchup[1])
	}
})
