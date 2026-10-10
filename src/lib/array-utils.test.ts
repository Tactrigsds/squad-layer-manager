import { describe, expect, it } from 'vitest'

import * as Arr from '@/lib/array-utils'

describe('set operations', () => {
	// one size takes the linear scan and the other the Set, and both must match the naive definitions
	for (const size of [5, 60]) {
		const before = Array.from({ length: size }, (_, i) => i % (size - 2)).concat(NaN)
		const after = Array.from({ length: size }, (_, i) => i + (size >> 1)).concat(NaN)

		it(`matches the reference results with ${size} items`, () => {
			expect(Arr.union(before, after)).toEqual([...new Set([...before, ...after])])
			expect(Arr.intersect(before, after)).toEqual([...new Set(before.filter((x) => after.includes(x)))])
			expect(Arr.missing(before, after)).toEqual(before.filter((x) => !after.includes(x)))
			expect(Arr.delta(before, after)).toEqual({
				added: after.filter((x) => !before.includes(x)),
				removed: before.filter((x) => !after.includes(x)),
			})
			expect(Arr.isSubset(before, after)).toBe(false)
			expect(Arr.isSubset(after, Arr.intersect(before, after))).toBe(true)
		})
	}
})

describe('moveItem', () => {
	const items = ['a', 'b', 'c', 'd']

	it('moves an item up, before and after the target', () => {
		expect(Arr.moveItem(items, 2, 0, 'before')).toEqual(['c', 'a', 'b', 'd'])
		expect(Arr.moveItem(items, 2, 0, 'after')).toEqual(['a', 'c', 'b', 'd'])
	})

	// moving down is where naive index math goes wrong: pulling the dragged item out shifts every later index down one
	it('moves an item down, before and after the target', () => {
		expect(Arr.moveItem(items, 0, 2, 'after')).toEqual(['b', 'c', 'a', 'd'])
		expect(Arr.moveItem(items, 0, 2, 'before')).toEqual(['b', 'a', 'c', 'd'])
	})

	it('moves an item to either end', () => {
		expect(Arr.moveItem(items, 3, 0, 'before')).toEqual(['d', 'a', 'b', 'c'])
		expect(Arr.moveItem(items, 0, 3, 'after')).toEqual(['b', 'c', 'd', 'a'])
	})

	it('is a no-op when dropped on itself or out of range', () => {
		expect(Arr.moveItem(items, 1, 1, 'before')).toBe(items)
		expect(Arr.moveItem(items, 1, 1, 'after')).toBe(items)
		expect(Arr.moveItem(items, 9, 0, 'before')).toBe(items)
		expect(Arr.moveItem(items, 0, 9, 'before')).toBe(items)
	})

	it('never drops or duplicates an item', () => {
		for (const from of [0, 1, 2, 3]) {
			for (const to of [0, 1, 2, 3]) {
				for (const position of ['before', 'after'] as const) {
					const next = Arr.moveItem(items, from, to, position)
					expect(next).toHaveLength(items.length)
					expect([...next].sort()).toEqual(['a', 'b', 'c', 'd'])
				}
			}
		}
	})
})
