import { beforeAll, expect } from 'vitest'
import { setupEnv } from '../env'
import * as Log from '../logger'
import * as SquadjsSchema from '@/server/schema-squadjs'
import * as Schema from '@/server/schema'
import * as E from 'drizzle-orm/expressions'
import * as C from '@/server/context'
import * as M from '@/models'
import * as DB from '@/server/db'
import * as FB from '@/lib/filter-builders'
import { test } from 'vitest'
import { getHistoryFilter, getWhereFilterConditions, runLayersQuery } from './layers-query'
import { aliasedTable, sql } from 'drizzle-orm'

let ctx!: C.Db & C.Log
beforeAll(() => {
	setupEnv()
	Log.setupLogger()
	DB.setupDatabase()
	ctx = DB.addPooledDb({ log: Log.baseLogger })
})

test('can filter results', async () => {
	const filter = FB.and([FB.comp(FB.eq('Level', 'Lashkar')), FB.comp(FB.eq('Gamemode', 'TC'))])
	const res = await runLayersQuery({
		input: { filter, pageSize: 50, pageIndex: 0 },
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
	const res = await runLayersQuery({
		input: { filter, pageSize: 50, pageIndex: 0 },
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
	const res = await runLayersQuery({
		input: { filter, pageSize: 50, pageIndex: 0 },
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
	const res = await runLayersQuery({
		input: { filter, pageSize: 50, pageIndex: 0 },
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

test('hello there', async () => {
	// 2023-12-31T23:05:09Z
	// 2024-12-09 19:57:07
	// const startTime = addHours(Date.parse('2024-12-09'), 0)

	const queued = [
		'LK-AAS-V1:MEA-AR:USMC-LI',
		'KH-AAS-V1:PLA-LI:TLF-SP',
		'HJ-RAAS-V1:USA-MZ:RGF-SP',
		'SX-AAS-V2:VDV-AR:BAF-AA',
		'SX-AAS-V2:PLANMC-SP:BAF-AA',
		'MN-RAAS-V2:USA-LI:PLANMC-MT',
		'TL-AAS-V1:PLA-SP:INS-SP',
		'LK-TC-V2:VDV-AR:USA-SP',
		'MT-RAAS-V2:INS-MT:USA-AR',
		'MT-RAAS-V2:MEA-LI:WPMC-CA',
		'HJ-AAS-V1:VDV-CA:CAF-AA',
		'SX-RAAS-V1:WPMC-CA:RGF-MZ',
		'MT-RAAS-V1:INS-LI:MEA-LI',
		'AB-TC-V1:PLA-AR:USA-AR',
		'AN-AAS-V1:TLF-SP:PLA-SP',
	]
	const queuedLayersQuery = ctx.db().select().from(Schema.layers).where(E.inArray(Schema.layers.id, queued)).as('layers-in-queue')
	const applicableMatches = ctx
		.db()
		.select({
			...SquadjsSchema.dbLogMatches,
			ord: sql`ROW_NUMBER() OVER()`.as('ord'),
		})
		.from(SquadjsSchema.dbLogMatches)
		.orderBy(E.desc(SquadjsSchema.dbLogMatches.startTime))
		.limit(100 - queued.length)
		.as('applicable-matches')

	// const applicableMatches = union(queuedLayersQuery, historyLayersQuery).as('applicable')

	// console.log(startTime.toLocaleDateString())
	const subfacteam1 = aliasedTable(Schema.subfactions, 'subfacteam1')
	const subfacteam2 = aliasedTable(Schema.subfactions, 'subfacteam2')
	const queuedLayersTable = aliasedTable(Schema.layers, 'queued-layers')
	const historyLayersQuery = ctx
		.db()
		.select()
		.from(applicableMatches)
		.leftJoin(
			subfacteam1,
			E.and(E.eq(subfacteam1.fullName, applicableMatches.subFactionTeam1), E.eq(subfacteam1.factionShortName, applicableMatches.team1Short))
		)
		.leftJoin(
			subfacteam2,
			E.and(E.eq(subfacteam2.fullName, applicableMatches.subFactionTeam2), E.eq(subfacteam2.factionShortName, applicableMatches.team2Short))
		)
		.leftJoin(
			queuedLayersTable,
			E.and(
				E.eq(queuedLayersTable.Layer, applicableMatches.layerClassname),
				E.eq(queuedLayersTable.Faction_1, applicableMatches.team1Short),
				E.eq(queuedLayersTable.Faction_2, applicableMatches.team2Short),
				E.eq(subfacteam1.shortName, queuedLayersTable.SubFac_1),
				E.eq(subfacteam2.shortName, queuedLayersTable.SubFac_2)
			)
		)
		.where(
			E.and(
				// E.like(applicableMatches.layerClassname, '%Goro%')
				// E.isNotNull(queuedLayersTable.id),
				E.gt(applicableMatches.ord, 70),
				await getWhereFilterConditions(FB.comp(FB.eq('Level', 'Gorodok')), [], ctx, queuedLayersTable)
			)
		)

	const res = await historyLayersQuery
	const rawSql = historyLayersQuery.toSQL()
	console.log(rawSql)
	console.log(res)
}, 30_000)

test.only('test ordinal', async () => {
	const layer = 'Narva_AAS_v2'
	const historyFilters: M.HistoryFilter[] = [
		{
			comparison: FB.eq('Layer', layer),
			substitutedColumn: 'Layer',
			excludeFor: { matches: 10 },
		},
		// { comparison: FB.eq('Layer', layer), substitutedColumn: 'FullMatchup', excludeFor: { matches: 10 } },
	]
	const regFilters = FB.and([
		FB.comp(FB.eq('Layer', layer)),
		// FB.comp(FB.eq('Faction_1', 'PLA')),
		// FB.comp(FB.eq('Faction_2', 'RGF')),
		// FB.comp(FB.eq('SubFac_1', 'CombinedArms')),
		// FB.comp(FB.eq('SubFac_2', 'CombinedArms')),
	])
	const regCond = await getWhereFilterConditions(regFilters, [], ctx)
	const historyFilterNode = await getHistoryFilter(ctx, historyFilters, ['AB-AAS-V1:ADF-CA:PLA-SP'])
	console.log(JSON.stringify(historyFilterNode))
	const historyFilterCondition = await getWhereFilterConditions(historyFilterNode, [], ctx)
	const res = await ctx.db().select(Schema.MINI_LAYER_SELECT).from(Schema.layers).where(E.and(regCond, historyFilterCondition))
	console.log({ res })
})
