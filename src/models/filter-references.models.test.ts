import { describe, expect, test } from 'vitest'
import * as z from 'zod'

import * as FB from './filter-builders'
import * as FR from './filter-references.models'
import type * as F from './filter.models'
import * as PLG from './plugins.models'
import * as SETTINGS from './settings.models'

function filter(id: string, node: F.FilterNode): F.FilterEntity {
	return {
		id,
		name: id,
		description: null,
		filter: node,
		owner: 1n,
		alertMessage: null,
		emoji: null,
		invertedAlertMessage: null,
		invertedEmoji: null,
	}
}

function poolConfig(mainPool: Partial<SETTINGS.PoolConfiguration>): FR.ServerPoolConfig {
	const pool = SETTINGS.PublicServerSettingsSchema.parse({}).queue.mainPool
	Object.assign(pool, mainPool)
	return { serverId: 'server-1', mainPool: pool }
}

describe('buildIndex', () => {
	test('an apply-filter operator references the filter it names', () => {
		const index = FR.buildIndex([filter('base', FB.and([])), filter('user', FB.and([FB.includedIn('base')]))], [])
		expect(index.get('base')).toEqual([{ type: 'filter-entity', filterId: 'user' }])
		expect(index.get('user')).toBeUndefined()
	})

	test('excluded-from counts the same as included-in', () => {
		const index = FR.buildIndex([filter('base', FB.and([])), filter('user', FB.and([FB.excludedFrom('base')]))], [])
		expect(index.get('base')).toEqual([{ type: 'filter-entity', filterId: 'user' }])
	})

	test('every pool config key that names filters is counted', () => {
		const index = FR.buildIndex(
			[],
			[
				poolConfig({
					poolFilter: { filterId: 'pool', mode: 'include' },
					indicateMatches: ['matches'],
					indicateMisses: ['misses'],
					defaultSelectable: [{ filterId: 'selectable', applyAs: 'regular' }],
					warnFor: [{ filterId: 'warn', applyAs: 'regular' }],
					constrainGeneration: [{ filterId: 'gen', applyAs: 'regular' }],
				}),
			],
		)
		expect([...index.keys()].sort()).toEqual(['gen', 'matches', 'misses', 'pool', 'selectable', 'warn'])
		expect(index.get('pool')).toEqual([{ type: 'pool-config', serverId: 'server-1', key: 'poolFilter', via: [] }])
	})

	test('a pool reaches the filters its configured filter applies, recording the hops', () => {
		const index = FR.buildIndex(
			[filter('pool', FB.and([FB.includedIn('mid')])), filter('mid', FB.and([FB.includedIn('leaf')])), filter('leaf', FB.and([]))],
			[poolConfig({ poolFilter: { filterId: 'pool', mode: 'include' } })],
		)
		expect(index.get('leaf')).toEqual([
			{ type: 'filter-entity', filterId: 'mid' },
			{ type: 'pool-config', serverId: 'server-1', key: 'poolFilter', via: ['pool', 'mid'] },
		])
	})

	test('a filter referenced by nothing has no entry', () => {
		const index = FR.buildIndex([filter('lonely', FB.and([]))], [poolConfig({})])
		expect(index.get('lonely')).toBeUndefined()
		expect(FR.referencesFor(index, 'lonely')).toEqual([])
	})
})

describe('findCycle', () => {
	test('finds a two-filter loop from either end', () => {
		const filters = [filter('a', FB.and([FB.includedIn('b')])), filter('b', FB.and([FB.includedIn('a')]))]
		expect(FR.findCycle(filters, 'a')).toEqual(['a', 'b', 'a'])
		expect(FR.findCycle(filters, 'b')).toEqual(['b', 'a', 'b'])
	})

	test('finds a loop the starting filter only reaches', () => {
		const filters = [
			filter('start', FB.and([FB.includedIn('a')])),
			filter('a', FB.and([FB.includedIn('b')])),
			filter('b', FB.and([FB.excludedFrom('a')])),
		]
		expect(FR.findCycle(filters, 'start')).toEqual(['a', 'b', 'a'])
	})

	test('a diamond is not a loop', () => {
		const filters = [
			filter('top', FB.and([FB.includedIn('left'), FB.includedIn('right')])),
			filter('left', FB.and([FB.includedIn('bottom')])),
			filter('right', FB.and([FB.includedIn('bottom')])),
			filter('bottom', FB.and([])),
		]
		expect(FR.findCycle(filters, 'top')).toBeNull()
	})

	test('a filter naming itself is a loop', () => {
		expect(FR.findCycle([filter('a', FB.and([FB.includedIn('a')]))], 'a')).toEqual(['a', 'a'])
	})

	test('a reference to a filter that does not exist is not a loop', () => {
		expect(FR.findCycle([filter('a', FB.and([FB.includedIn('gone')]))], 'a')).toBeNull()
	})
})

describe('plugin config references', () => {
	const refs = (fields: { path: string; filterId: string }[]): FR.PluginFilterRefs[] => [{ pluginId: 'seed-roller', fields }]

	test("a plugin's config field references the filter it names", () => {
		const index = FR.buildIndex([], [], refs([{ path: 'seedPool', filterId: 'seeding' }]))
		expect(index.get('seeding')).toEqual([{ type: 'plugin-config', pluginId: 'seed-roller', path: 'seedPool', via: [] }])
	})

	// the same reachability pool configs get: a plugin naming a filter holds everything that filter applies
	test('reaches through apply-filter, recording the hops', () => {
		const index = FR.buildIndex(
			[filter('base', FB.and([])), filter('pool', FB.and([FB.includedIn('base')]))],
			[],
			refs([{ path: 'seedPool', filterId: 'pool' }]),
		)
		expect(index.get('base')).toContainEqual({ type: 'plugin-config', pluginId: 'seed-roller', path: 'seedPool', via: ['pool'] })
	})
})

describe('configFieldValues', () => {
	const schema = z.toJSONSchema(
		z.object({
			seedPool: PLG.Fields.filterId(),
			extraPools: PLG.Fields.filterIds(),
			servers: PLG.Fields.serverIds(),
			nested: z.object({ pool: PLG.Fields.filterId() }),
			plain: z.string(),
		}),
		{ io: 'input', unrepresentable: 'any' },
	)

	test('finds every field declaring the control, and nothing else', () => {
		const config = {
			seedPool: 'seeding',
			extraPools: ['a', 'b'],
			servers: ['sandbox'],
			nested: { pool: 'deep' },
			plain: 'not-a-filter',
		}
		expect(PLG.configFieldValues(schema, config, 'filter-id')).toEqual([
			{ path: 'seedPool', value: 'seeding' },
			{ path: 'nested.pool', value: 'deep' },
		])
		expect(PLG.configFieldValues(schema, config, 'filter-ids')).toEqual([
			{ path: 'extraPools[0]', value: 'a' },
			{ path: 'extraPools[1]', value: 'b' },
		])
		expect(PLG.configFieldValues(schema, config, 'server-ids')).toEqual([{ path: 'servers[0]', value: 'sandbox' }])
	})

	// an unconfigured picker stores '', which is not a reference to anything
	test('skips empty values and missing keys', () => {
		expect(PLG.configFieldValues(schema, { seedPool: '', extraPools: [] }, 'filter-id')).toEqual([])
		expect(PLG.configFieldValues(schema, {}, 'filter-id')).toEqual([])
	})
})
