import { describe, expect, it } from 'vitest'

import type { ComboBoxOption } from './combo-box.tsx'
import {
	ALL_GROUPS,
	type ComboBoxGroupingDef,
	controlFor,
	groupCounts,
	groupingBarEntries,
	groupPrefixOf,
	groupRuns,
	liveGroups,
	MAX_TAB_GROUPS,
	normalizeOptions,
	optionsInSelection,
	resolveGroupings,
	resolveGroups,
} from './options.ts'

const COLL = 'collection'
const TYPE = 'vehicleType'

const grouping = (key: string, groups: ComboBoxGroupingDef['groups'], control?: 'tabs' | 'facet') =>
	resolveGroupings([{ key, label: key, groups, control }])[0]

const normalize = (options: (ComboBoxOption<string> | string)[], groupOrder?: readonly string[]) =>
	normalizeOptions('test', options, true, { key: COLL, order: groupOrder }) as ComboBoxOption<string>[]

const values = (options: ComboBoxOption<string>[]) => options.map((o) => o.value)

const coll = (collection: string) => ({ [COLL]: collection })

describe('normalizeOptions grouping', () => {
	it('orders groups by groupOrder, then alphabetically within each', () => {
		const options = normalize(
			[
				{ value: 'zulu', groups: coll('OWI') },
				{ value: 'bravo', groups: coll('GC') },
				{ value: 'alpha', groups: coll('OWI') },
			],
			['OWI', 'GC'],
		)
		expect(values(options)).toEqual(['alpha', 'zulu', 'bravo'])
	})

	it('trails groups missing from groupOrder, alphabetically by group', () => {
		const options = normalize(
			[
				{ value: 'a', groups: coll('Zeta') },
				{ value: 'b', groups: coll('Alpha') },
				{ value: 'c', groups: coll('OWI') },
			],
			['OWI'],
		)
		expect(values(options)).toEqual(['c', 'b', 'a'])
	})

	it('trails ungrouped options behind every group', () => {
		const options = normalize(
			[{ value: 'loose' }, { value: 'grouped', groups: coll('OWI') }, { value: 'unlisted', groups: coll('Zeta') }],
			['OWI'],
		)
		expect(values(options)).toEqual(['grouped', 'unlisted', 'loose'])
	})

	it('sinks excluded options behind every group regardless of their own group', () => {
		const options = normalize(
			[
				{ value: 'excluded', groups: coll('OWI'), disabled: true },
				{ value: 'pointless', groups: coll('OWI'), sortLast: true },
				{ value: 'live', groups: coll('GC') },
			],
			['OWI', 'GC'],
		)
		expect(values(options)).toEqual(['live', 'excluded', 'pointless'])
	})

	it('orders by the first grouping only, leaving the rest to filter', () => {
		const options = normalize(
			[
				{ value: 'b', groups: { [COLL]: 'GC', [TYPE]: 'IFV' } },
				{ value: 'a', groups: { [COLL]: 'OWI', [TYPE]: 'MBT' } },
			],
			['OWI', 'GC'],
		)
		expect(values(options)).toEqual(['a', 'b'])
	})
})

describe('groupRuns', () => {
	const collGrouping = grouping(COLL, ['OWI', 'GC'])

	it('splits consecutive same-group runs into headed sections', () => {
		const runs = groupRuns(
			normalize(
				[
					{ value: 'a', groups: coll('OWI') },
					{ value: 'b', groups: coll('GC') },
					{ value: 'c', groups: coll('OWI') },
				],
				['OWI', 'GC'],
			),
			collGrouping,
		)
		expect(runs.map((r) => [r.heading, values(r.options)])).toEqual([
			['OWI', ['a', 'c']],
			['GC', ['b']],
		])
	})

	it('returns one headingless run when fewer than two groups are live', () => {
		const runs = groupRuns(
			normalize([{ value: 'a', groups: coll('OWI') }, { value: 'b', groups: coll('OWI') }, { value: 'c' }], ['OWI']),
			collGrouping,
		)
		expect(runs).toHaveLength(1)
		expect(runs[0].heading).toBeUndefined()
	})

	it('leaves the excluded tail unheaded', () => {
		const runs = groupRuns(
			normalize(
				[
					{ value: 'live-owi', groups: coll('OWI') },
					{ value: 'live-gc', groups: coll('GC') },
					{ value: 'dead', groups: coll('OWI'), disabled: true },
				],
				['OWI', 'GC'],
			),
			collGrouping,
		)
		expect(runs.map((r) => r.heading)).toEqual(['OWI', 'GC', undefined])
		expect(values(runs[2].options)).toEqual(['dead'])
	})

	it('heads nothing when there is no grouping to head by', () => {
		const options = normalize(
			[
				{ value: 'a', groups: coll('OWI') },
				{ value: 'b', groups: coll('GC') },
			],
			['OWI', 'GC'],
		)
		expect(groupRuns(options, undefined)).toEqual([{ options }])
	})
})

describe('group resolution', () => {
	it('fills label and prefix from the key, and prefix from the label', () => {
		expect(resolveGroups(['OWI', { key: 'gc', label: 'Galactic Contention' }, { key: 'su', label: 'SuperMod', prefix: 'SPM' }])).toEqual([
			{ key: 'OWI', label: 'OWI', prefix: 'OWI' },
			{ key: 'gc', label: 'Galactic Contention', prefix: 'Galactic Contention' },
			{ key: 'su', label: 'SuperMod', prefix: 'SPM' },
		])
	})

	it('keeps an explicit null prefix, so a group can tab without badging its options', () => {
		const groups = grouping(COLL, [{ key: 'OWI', prefix: null }, { key: 'GC' }])
		expect(groups.groups).toEqual([
			{ key: 'OWI', label: 'OWI', prefix: null },
			{ key: 'GC', label: 'GC', prefix: 'GC' },
		])
		expect(groupPrefixOf({ value: 'Narva', groups: coll('OWI') }, groups)).toBeUndefined()
		expect(groupPrefixOf({ value: 'Narva', groups: coll('GC') }, groups)).toBe('GC')
	})

	it('lists only groups with selectable options, declared order first', () => {
		const options = normalize(
			[
				{ value: 'a', groups: coll('GC') },
				{ value: 'b', groups: coll('Undeclared') },
				{ value: 'c', groups: coll('Empty'), disabled: true },
			],
			['OWI', 'GC'],
		)
		expect(liveGroups(options, grouping(COLL, ['OWI', 'GC', 'Empty'])).map((g) => g.key)).toEqual(['GC', 'Undeclared'])
	})

	it('resolves an option prefix, falling back to the raw group key when undeclared', () => {
		const groups = grouping(COLL, [{ key: 'SuperMod', prefix: 'SPM' }])
		expect(groupPrefixOf({ value: 'x', groups: coll('SuperMod') }, groups)).toBe('SPM')
		expect(groupPrefixOf({ value: 'x', groups: coll('Other') }, groups)).toBe('Other')
		expect(groupPrefixOf({ value: 'x' }, groups)).toBeUndefined()
	})

	it('drops headings when asked, for views where a control or prefix already names the group', () => {
		const options = normalize(
			[
				{ value: 'a', groups: coll('OWI') },
				{ value: 'b', groups: coll('GC') },
			],
			['OWI', 'GC'],
		)
		expect(groupRuns(options, grouping(COLL, ['OWI', 'GC']), true)).toEqual([{ options }])
	})
})

describe('narrowing by several groupings at once', () => {
	const options = normalize([
		{ value: 'bmp-2', groups: { [COLL]: 'OWI', [TYPE]: 'IFV_TRACKED' } },
		{ value: 'aslav', groups: { [COLL]: 'OWI', [TYPE]: 'IFV_WHEELED' } },
		{ value: 'm1a1', groups: { [COLL]: 'OWI', [TYPE]: 'MBT' } },
		{ value: 'tx-130', groups: { [COLL]: 'GC', [TYPE]: 'APC_OTHER' } },
		{ value: 'gc-bmp', groups: { [COLL]: 'GC', [TYPE]: 'IFV_TRACKED' } },
	])

	it('keeps only the options matching every narrowed grouping', () => {
		expect(values(optionsInSelection(options, { [COLL]: 'OWI', [TYPE]: 'IFV_TRACKED' }))).toEqual(['bmp-2'])
	})

	it('passes everything through while nothing is narrowed', () => {
		expect(optionsInSelection(options, { [COLL]: ALL_GROUPS, [TYPE]: ALL_GROUPS })).toHaveLength(5)
	})

	it('narrows on one grouping while the other is left open', () => {
		expect(values(optionsInSelection(options, { [COLL]: ALL_GROUPS, [TYPE]: 'IFV_TRACKED' }))).toEqual(['gc-bmp', 'bmp-2'])
	})

	it('counts what each group would leave, with the other groupings already applied', () => {
		const counts = groupCounts(options, grouping(TYPE, ['IFV_TRACKED', 'IFV_WHEELED', 'MBT', 'APC_OTHER']), { [COLL]: 'OWI' })
		expect(Object.fromEntries(counts)).toEqual({ IFV_TRACKED: 1, IFV_WHEELED: 1, MBT: 1 })
	})

	it('excludes a grouping from its own counts, so its rows are not counted against themselves', () => {
		const counts = groupCounts(options, grouping(TYPE, ['IFV_TRACKED']), { [COLL]: ALL_GROUPS, [TYPE]: 'MBT' })
		expect(counts.get('IFV_TRACKED')).toBe(2)
	})
})

describe('membership in several groups of one grouping', () => {
	const options = normalize(
		[
			{ value: 'owi-only', groups: coll('OWI') },
			{ value: 'shared', groups: { [COLL]: ['both', 'OWI', 'GC'] } },
			{ value: 'gc-only', groups: coll('GC') },
		],
		['OWI', 'GC', 'both'],
	)

	it('shows the option under either group it belongs to', () => {
		expect(values(optionsInSelection(options, { [COLL]: 'OWI' }))).toEqual(['owi-only', 'shared'])
		expect(values(optionsInSelection(options, { [COLL]: 'GC' }))).toEqual(['gc-only', 'shared'])
	})

	it('orders and prefixes it by the first group it names', () => {
		expect(values(options)).toEqual(['owi-only', 'gc-only', 'shared'])
		expect(groupPrefixOf(options[2], grouping(COLL, ['OWI', 'GC', 'both']))).toBe('both')
	})

	it('lists and counts it under every group it belongs to', () => {
		expect(liveGroups(options, grouping(COLL, ['OWI', 'GC', 'both'])).map((g) => g.key)).toEqual(['OWI', 'GC', 'both'])
		expect(Object.fromEntries(groupCounts(options, grouping(COLL, ['OWI', 'GC', 'both']), {}))).toEqual({ OWI: 2, GC: 2, both: 1 })
	})
})

describe('grouping controls', () => {
	const manyGroups = Array.from({ length: MAX_TAB_GROUPS + 1 }, (_, i) => `g${i}`)

	it('tabs while the groups fit and drills in past that', () => {
		expect(controlFor(grouping(COLL, ['a', 'b']), 2)).toBe('tabs')
		expect(controlFor(grouping(COLL, manyGroups), manyGroups.length)).toBe('facet')
	})

	it('honours a pinned control either way', () => {
		expect(controlFor(grouping(COLL, manyGroups, 'tabs'), manyGroups.length)).toBe('tabs')
		expect(controlFor(grouping(COLL, ['a', 'b'], 'facet'), 2)).toBe('facet')
	})

	it('leaves out a grouping that cannot narrow anything', () => {
		const options = normalize([
			{ value: 'a', groups: { [COLL]: 'OWI', [TYPE]: 'MBT' } },
			{ value: 'b', groups: { [COLL]: 'GC', [TYPE]: 'MBT' } },
		])
		const groupings = resolveGroupings([
			{ key: COLL, label: 'Collection', groups: ['OWI', 'GC'] },
			{ key: TYPE, label: 'Vehicle type', groups: ['MBT'] },
		])
		expect(groupingBarEntries(options, groupings, {}).map((e) => e.grouping.key)).toEqual([COLL])
	})

	it('degrades a pick naming a group with no live options back to all', () => {
		const options = normalize([
			{ value: 'a', groups: coll('OWI') },
			{ value: 'b', groups: coll('GC') },
		])
		const groupings = resolveGroupings([{ key: COLL, label: 'Collection', groups: ['OWI', 'GC', 'RS'] }])
		expect(groupingBarEntries(options, groupings, { [COLL]: 'RS' })[0].narrowed).toBe(ALL_GROUPS)
		expect(groupingBarEntries(options, groupings, { [COLL]: 'GC' })[0].narrowed).toBe('GC')
	})
})
