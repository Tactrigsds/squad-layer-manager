import { describe, expect, it } from 'vitest'

import type { ComboBoxOption } from './combo-box.tsx'
import { ALL_GROUPS, groupPrefixOf, groupRuns, liveGroups, normalizeOptions, optionsInGroup, resolveGroups } from './options.ts'

const normalize = (options: (ComboBoxOption<string> | string)[], groupOrder?: readonly string[]) =>
	normalizeOptions('test', options, true, groupOrder) as ComboBoxOption<string>[]

const values = (options: ComboBoxOption<string>[]) => options.map((o) => o.value)

describe('normalizeOptions grouping', () => {
	it('orders groups by groupOrder, then alphabetically within each', () => {
		const options = normalize(
			[
				{ value: 'zulu', group: 'OWI' },
				{ value: 'bravo', group: 'GC' },
				{ value: 'alpha', group: 'OWI' },
			],
			['OWI', 'GC'],
		)
		expect(values(options)).toEqual(['alpha', 'zulu', 'bravo'])
	})

	it('trails groups missing from groupOrder, alphabetically by group', () => {
		const options = normalize(
			[
				{ value: 'a', group: 'Zeta' },
				{ value: 'b', group: 'Alpha' },
				{ value: 'c', group: 'OWI' },
			],
			['OWI'],
		)
		expect(values(options)).toEqual(['c', 'b', 'a'])
	})

	it('trails ungrouped options behind every group', () => {
		const options = normalize([{ value: 'loose' }, { value: 'grouped', group: 'OWI' }, { value: 'unlisted', group: 'Zeta' }], ['OWI'])
		expect(values(options)).toEqual(['grouped', 'unlisted', 'loose'])
	})

	it('sinks excluded options behind every group regardless of their own group', () => {
		const options = normalize(
			[
				{ value: 'excluded', group: 'OWI', disabled: true },
				{ value: 'pointless', group: 'OWI', sortLast: true },
				{ value: 'live', group: 'GC' },
			],
			['OWI', 'GC'],
		)
		expect(values(options)).toEqual(['live', 'excluded', 'pointless'])
	})
})

describe('groupRuns', () => {
	it('splits consecutive same-group runs into headed sections', () => {
		const runs = groupRuns(
			normalize(
				[
					{ value: 'a', group: 'OWI' },
					{ value: 'b', group: 'GC' },
					{ value: 'c', group: 'OWI' },
				],
				['OWI', 'GC'],
			),
		)
		expect(runs.map((r) => [r.heading, values(r.options)])).toEqual([
			['OWI', ['a', 'c']],
			['GC', ['b']],
		])
	})

	it('returns one headingless run when fewer than two groups are live', () => {
		const runs = groupRuns(normalize([{ value: 'a', group: 'OWI' }, { value: 'b', group: 'OWI' }, { value: 'c' }], ['OWI']))
		expect(runs).toHaveLength(1)
		expect(runs[0].heading).toBeUndefined()
	})

	it('leaves the excluded tail unheaded', () => {
		const runs = groupRuns(
			normalize(
				[
					{ value: 'live-owi', group: 'OWI' },
					{ value: 'live-gc', group: 'GC' },
					{ value: 'dead', group: 'OWI', disabled: true },
				],
				['OWI', 'GC'],
			),
		)
		expect(runs.map((r) => r.heading)).toEqual(['OWI', 'GC', undefined])
		expect(values(runs[2].options)).toEqual(['dead'])
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
		const groups = resolveGroups([{ key: 'OWI', prefix: null }, { key: 'GC' }])
		expect(groups).toEqual([
			{ key: 'OWI', label: 'OWI', prefix: null },
			{ key: 'GC', label: 'GC', prefix: 'GC' },
		])
		expect(groupPrefixOf({ value: 'Narva', group: 'OWI' }, groups)).toBeUndefined()
		expect(groupPrefixOf({ value: 'Narva', group: 'GC' }, groups)).toBe('GC')
	})

	it('lists only groups with selectable options, declared order first', () => {
		const options = normalize(
			[
				{ value: 'a', group: 'GC' },
				{ value: 'b', group: 'Undeclared' },
				{ value: 'c', group: 'Empty', disabled: true },
			],
			['OWI', 'GC'],
		)
		expect(liveGroups(options, resolveGroups(['OWI', 'GC', 'Empty'])).map((g) => g.key)).toEqual(['GC', 'Undeclared'])
	})

	it('filters to one group, and passes everything through for the all tab', () => {
		const options = normalize([{ value: 'a', group: 'OWI' }, { value: 'b', group: 'GC' }, { value: 'c' }], ['OWI', 'GC'])
		expect(values(optionsInGroup(options, 'OWI'))).toEqual(['a'])
		expect(values(optionsInGroup(options, ALL_GROUPS))).toEqual(['a', 'b', 'c'])
	})

	it('resolves an option prefix, falling back to the raw group key when undeclared', () => {
		const groups = resolveGroups([{ key: 'SuperMod', prefix: 'SPM' }])
		expect(groupPrefixOf({ value: 'x', group: 'SuperMod' }, groups)).toBe('SPM')
		expect(groupPrefixOf({ value: 'x', group: 'Other' }, groups)).toBe('Other')
		expect(groupPrefixOf({ value: 'x' }, groups)).toBeUndefined()
	})

	it('drops headings when asked, for views where a tab or prefix already names the group', () => {
		const options = normalize(
			[
				{ value: 'a', group: 'OWI' },
				{ value: 'b', group: 'GC' },
			],
			['OWI', 'GC'],
		)
		expect(groupRuns(options, true)).toEqual([{ options }])
	})
})
