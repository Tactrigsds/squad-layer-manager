import { describe, expect, test } from 'vitest'
import type * as LQY from './layer-queries.models'
import * as SETTINGS from './settings.models'

function settingsWith(mainPool: Partial<SETTINGS.PoolConfiguration>) {
	const settings = SETTINGS.PublicServerSettingsSchema.parse({})
	Object.assign(settings.queue.mainPool, mainPool)
	return settings
}

describe('pool configuration schema', () => {
	test('defaults to an unconstrained pool', () => {
		const settings = SETTINGS.PublicServerSettingsSchema.parse({})
		expect(settings.queue.mainPool.poolFilter).toBeNull()
		expect(settings.queue.mainPool.indicateMatches).toEqual([])
		expect(settings.queue.mainPool.defaultSelectable).toEqual([])
		expect(SETTINGS.getPoolMembershipConstraints(settings)).toEqual([])
	})

	test('parse is stable (no one-way coercions)', () => {
		const config = {
			poolFilter: { filterId: 'the-pool', mode: 'exclude' },
			indicateMatches: ['a-filter'],
			indicateMisses: ['a-filter', 'b-filter'],
			defaultSelectable: [{ filterId: 'a-filter', applyAs: 'inverted' }],
			warnFor: [{ filterId: 'b-filter', applyAs: 'regular' }],
			constrainGeneration: [{ filterId: 'the-pool', applyAs: 'regular' }],
			repeatRules: [{ label: 'Map', field: 'Map', within: 4, constrainGeneration: true }],
		}
		const parsed = SETTINGS.PoolConfigurationSchema.parse(config)
		expect(parsed).toEqual(config)
		expect(SETTINGS.PoolConfigurationSchema.parse(parsed)).toEqual(parsed)
	})

	test('rejects duplicate repeat rule labels', () => {
		expect(() =>
			SETTINGS.PoolConfigurationSchema.parse({
				repeatRules: [
					{ label: 'Map', field: 'Map', within: 4 },
					{ label: 'Map', field: 'Layer', within: 2 },
				],
			})
		).toThrow()
	})
})

describe('pool membership constraint', () => {
	test('include mode requires a match', () => {
		const settings = settingsWith({ poolFilter: { filterId: 'the-pool', mode: 'include' } })
		const [constraint] = SETTINGS.getPoolMembershipConstraints(settings) as Extract<LQY.Constraint, { type: 'filter-entity' }>[]
		expect(constraint).toMatchObject({
			type: 'filter-entity',
			id: 'pool-filter',
			filterId: 'the-pool',
			poolFilterMode: 'include',
			filterApplState: 'regular',
			showIndicator: 'both',
			warn: 'disabled',
		})
	})

	test('exclude mode inverts the filter', () => {
		const settings = settingsWith({ poolFilter: { filterId: 'the-pool', mode: 'exclude' } })
		const [constraint] = SETTINGS.getPoolMembershipConstraints(settings)
		expect(constraint).toMatchObject({ poolFilterMode: 'exclude', filterApplState: 'inverted' })
	})
})

describe('getSettingsConstraints', () => {
	const settings = settingsWith({
		poolFilter: { filterId: 'the-pool', mode: 'include' },
		indicateMatches: ['a-filter', 'c-filter'],
		indicateMisses: ['b-filter', 'c-filter'],
		defaultSelectable: [{ filterId: 'a-filter', applyAs: 'regular' }],
		warnFor: [{ filterId: 'b-filter', applyAs: 'inverted' }, { filterId: 'd-filter', applyAs: 'regular' }],
		constrainGeneration: [{ filterId: 'e-filter', applyAs: 'inverted' }],
		repeatRules: [
			{ label: 'Map', field: 'Map', within: 4, constrainGeneration: true },
			{ label: 'Layer', field: 'Layer', within: 2, constrainGeneration: false },
		],
	})

	test('selection/status context: pool warns on a miss, lists merge into indication constraints', () => {
		const constraints = SETTINGS.getSettingsConstraints(settings)
		const byId = new Map(constraints.map(c => [c.id, c]))

		// include-mode pool filter warns when the layer does NOT match
		expect(byId.get('pool-filter')).toMatchObject({ filterApplState: 'regular', showIndicator: 'both', warn: 'inverted' })

		expect(byId.get('filter-cfg:a-filter')).toMatchObject({ filterApplState: 'disabled', showIndicator: 'regular', warn: 'disabled' })
		expect(byId.get('filter-cfg:b-filter')).toMatchObject({ showIndicator: 'inverted', warn: 'inverted' })
		expect(byId.get('filter-cfg:c-filter')).toMatchObject({ showIndicator: 'both' })
		// warn-only: no indication configured, but the warn still needs the constraint present
		expect(byId.get('filter-cfg:d-filter')).toMatchObject({ showIndicator: 'disabled', warn: 'regular' })

		// every repeat rule warns/indicates during selection, regardless of its generation flag
		expect(byId.get('layer-pool:mainPool:Map')).toMatchObject({ type: 'do-not-repeat' })
		expect(byId.get('layer-pool:mainPool:Layer')).toMatchObject({ type: 'do-not-repeat' })
		// generation-only config stays out of selection contexts
		expect(constraints.some(c => c.type === 'filter-entity' && c.filterId === 'e-filter')).toBe(false)
	})

	test('generation context: pool filter always constrains, constrainGeneration applies, no warns', () => {
		const constraints = SETTINGS.getSettingsConstraints(settings, { generatingLayers: true })
		const byId = new Map(constraints.map(c => [c.id, c]))

		expect(byId.get('pool-filter')).toMatchObject({ filterApplState: 'regular', warn: 'disabled' })
		expect(byId.get('gen:e-filter')).toMatchObject({ filterApplState: 'inverted' })
		// only rules with constrainGeneration on constrain autogeneration
		expect(byId.has('layer-pool:mainPool:Map')).toBe(true)
		expect(byId.has('layer-pool:mainPool:Layer')).toBe(false)
		// indication lists don't constrain generation
		expect(byId.has('filter-cfg:a-filter')).toBe(false)
	})

	test('repeat rules constrain generation by default', () => {
		const withRules = settingsWith({
			repeatRules: SETTINGS.PoolConfigurationSchema.parse({
				repeatRules: [{ label: 'Map', field: 'Map', within: 4 }],
			}).repeatRules,
		})
		const constraints = SETTINGS.getSettingsConstraints(withRules, { generatingLayers: true })
		expect(constraints.some(c => c.id === 'layer-pool:mainPool:Map')).toBe(true)
	})
})
