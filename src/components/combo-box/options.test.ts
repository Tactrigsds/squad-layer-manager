import { describe, expect, it } from 'vitest'

import type { ComboBoxOption } from './combo-box.tsx'
import { groupRuns, normalizeOptions } from './options.ts'

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
