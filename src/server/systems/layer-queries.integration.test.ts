import * as Schema from '$root/drizzle/schema.ts'
import * as FB from '@/lib/filter-builders'
import * as M from '@/models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as E from 'drizzle-orm/expressions'
import { beforeAll, expect } from 'vitest'
import { test } from 'vitest'
import { ensureEnvSetup } from '../env'
import * as Log from '../logger'
import { areLayersInPool, queryLayers } from './layer-queries'

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
		input: { constraints: [{ type: 'filter', filter, applyAs: 'where-condition' }], previousLayerIds: [], pageSize: 50, pageIndex: 0 },
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
		input: { constraints: [{ type: 'filter', filter, applyAs: 'where-condition' }], previousLayerIds: [], pageSize: 50, pageIndex: 0 },
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
		input: { constraints: [{ type: 'filter', filter, applyAs: 'where-condition' }], previousLayerIds: [], pageSize: 50, pageIndex: 0 },
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
		input: { constraints: [{ type: 'filter', filter, applyAs: 'where-condition' }], previousLayerIds: [], pageSize: 50, pageIndex: 0 },
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

test.only('can check if layer is in pool', async () => {
	const layer = M.getMiniLayerFromId('GD-AAS-V1:IMF-SP:BAF-SP')
	const filter = FB.comp(FB.isTrue('Z_Pool'))
	const [user] = await ctx.db().select().from(Schema.users).limit(1)
	const filterEntity: M.FilterEntity = {
		id: 'zpool',
		name: 'Z Pool',
		filter,
		description: 'Z Pool Description',
		owner: user.discordId,
	}

	// upsert filter entity (Schema.filters)
	const [dbRes] = await ctx.db().update(Schema.filters).set(filterEntity).where(E.eq(Schema.filters.id, filterEntity.id))

	if (dbRes.affectedRows === 0) {
		await ctx.db().insert(Schema.filters).values(filterEntity)
	}

	const res = await areLayersInPool({ input: { layers: [layer.id], poolFilterId: filterEntity.id }, ctx })
	if (res.code !== 'ok') {
		throw new Error(`Failed to check if layer is in pool: ${res.code}`)
	}
	expect(res.results[0].matchesFilter).toBe(true)
})
