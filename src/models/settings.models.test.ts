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
			skipWarningsForTags: ['planned:aaaaaa'],
			repeatRules: [{ label: 'Map', field: 'Map', within: 4, warn: true, indicate: true }],
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
			}),
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
		warnFor: [
			{ filterId: 'b-filter', applyAs: 'inverted' },
			{ filterId: 'd-filter', applyAs: 'regular' },
		],
		constrainGeneration: [{ filterId: 'e-filter', applyAs: 'inverted' }],
		repeatRules: [
			{ label: 'Map', field: 'Map', within: 4, warn: true, indicate: true },
			{ label: 'Gen', field: 'Layer', within: 2, autogen: true, warn: true, indicate: true },
		],
	})

	test('selection/status context: pool warns on a miss, lists merge into indication constraints', () => {
		const constraints = SETTINGS.getSettingsConstraints(settings)
		const byId = new Map(constraints.map((c) => [c.id, c]))

		// include-mode pool filter warns when the layer does NOT match
		expect(byId.get('pool-filter')).toMatchObject({ filterApplState: 'regular', showIndicator: 'both', warn: 'inverted' })

		expect(byId.get('filter-cfg:a-filter')).toMatchObject({ filterApplState: 'disabled', showIndicator: 'regular', warn: 'disabled' })
		expect(byId.get('filter-cfg:b-filter')).toMatchObject({ showIndicator: 'inverted', warn: 'inverted' })
		expect(byId.get('filter-cfg:c-filter')).toMatchObject({ showIndicator: 'both' })
		// warn-only: no indication configured, but the warn still needs the constraint present
		expect(byId.get('filter-cfg:d-filter')).toMatchObject({ showIndicator: 'disabled', warn: 'regular' })

		// all repeat rules apply in selection/status contexts, autogen-flagged or not
		expect(byId.get('layer-pool:mainPool:Map')).toMatchObject({ type: 'do-not-repeat' })
		expect(byId.get('layer-pool:mainPool:Gen')).toMatchObject({ type: 'do-not-repeat' })
		// generation-only config stays out of selection contexts
		expect(constraints.some((c) => c.type === 'filter-entity' && c.filterId === 'e-filter')).toBe(false)
	})

	test('generation context: pool filter always constrains, constrainGeneration and autogen rules apply', () => {
		const constraints = SETTINGS.getSettingsConstraints(settings, { generatingLayers: true })
		const byId = new Map(constraints.map((c) => [c.id, c]))

		expect(byId.get('pool-filter')).toMatchObject({ filterApplState: 'regular', warn: 'disabled' })
		expect(byId.get('gen:e-filter')).toMatchObject({ filterApplState: 'inverted' })
		// only autogen-flagged repeat rules constrain generation
		expect(byId.has('layer-pool:mainPool:Gen')).toBe(true)
		expect(byId.has('layer-pool:mainPool:Map')).toBe(false)
		// indication lists don't constrain generation
		expect(byId.has('filter-cfg:a-filter')).toBe(false)
	})
})

describe('message variable cycles', () => {
	const parse = (messageVariables: { name: string; value: string }[]) => SETTINGS.parseGlobalSettings({ messageVariables })
	const messageVariableIssues = (res: ReturnType<typeof parse>) =>
		res.success ? [] : res.error.issues.filter((i) => i.path[0] === 'messageVariables')

	test('accepts variables that reference each other acyclically', () => {
		const res = parse([
			{ name: 'discord', value: 'discord.gg/x' },
			{ name: 'appeal', value: 'Appeal at {{discord}}' },
		])
		expect(messageVariableIssues(res)).toEqual([])
	})

	test('rejects a cycle, flagging every variable on it', () => {
		const res = parse([
			{ name: 'a', value: '{{b}}' },
			{ name: 'b', value: '{{a}}' },
			{ name: 'c', value: 'fine' },
		])
		const issues = messageVariableIssues(res)
		expect(issues.map((i) => i.path)).toEqual([
			['messageVariables', 0, 'value'],
			['messageVariables', 1, 'value'],
		])
		expect(issues[0].message).toContain('a -> b -> a')
	})

	test('rejects a variable that references itself', () => {
		expect(messageVariableIssues(parse([{ name: 'a', value: 'loop {{a}}' }]))).toHaveLength(1)
	})
})
