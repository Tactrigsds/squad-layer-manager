import { describe, expect, it } from 'vitest'

import { structuralArrayDiffWithKnownOffsets } from './diff.ts'

describe('structuralArrayDiffWithKnownOffsets', () => {
	it('should correctly identify added elements', () => {
		const orig = [1, 2, 3]
		const curr = [1, 2, 3, 4]
		const offsets = [0, 1, 2, null]
		const result = structuralArrayDiffWithKnownOffsets(orig, curr, offsets)
		expect(result.added).toEqual([3])
	})

	it('should correctly identify removed elements', () => {
		const orig = [1, 2, 3, 4]
		const curr = [1, 2, 4]
		const offsets = [0, 1, 3]
		const result = structuralArrayDiffWithKnownOffsets(orig, curr, offsets)
		expect(result.removed).toEqual([2])
	})

	it('should correctly identify edited elements', () => {
		const orig = [1, 2, 3]
		const curr = [1, 20, 3]
		const offsets = [0, 1, 2]
		const result = structuralArrayDiffWithKnownOffsets(orig, curr, offsets)
		expect(result.edited).toEqual([1])
	})

	it('should correctly identify moved elements', () => {
		const orig = [1, 2, 3]
		const curr = [2, 3, 1]
		const offsets = [1, 2, 0]
		const result = structuralArrayDiffWithKnownOffsets(orig, curr, offsets)
		expect(result.moved).toEqual([0, 1, 2])
	})

	it.only('should handle complex scenarios with multiple changes', () => {
		const orig = ['a', 'b', 'c', 'd', 'e']
		const curr = ['b', 'x', 'd', 'f', 'c']
		const offsets = [1, null, 3, null, 2]
		const result = structuralArrayDiffWithKnownOffsets(orig, curr, offsets)
		expect(result.added).toEqual([1, 3])
		expect(result.removed).toEqual([0, 4])
		expect(result.moved).toEqual([1, 2])
		expect(result.edited).toEqual([])
	})

	it('should throw an error when current array and offsets have different lengths', () => {
		const orig = [1, 2, 3]
		const curr = [1, 2, 3, 4]
		const offsets = [0, 1, 2]
		expect(() => structuralArrayDiffWithKnownOffsets(orig, curr, offsets)).toThrow()
	})

	it('should throw an error when there are duplicate indices in offsets', () => {
		const orig = [1, 2, 3]
		const curr = [1, 2, 3]
		const offsets = [0, 1, 1]
		expect(() => structuralArrayDiffWithKnownOffsets(orig, curr, offsets)).toThrow()
	})

	it('should use custom equality function when provided', () => {
		const orig = [
			{ id: 1, value: 'a' },
			{ id: 2, value: 'b' },
		]
		const curr = [
			{ id: 1, value: 'a' },
			{ id: 2, value: 'c' },
		]
		const offsets = [0, 1]
		const eq = (a: { id: number; value: string }, b: { id: number; value: string }) => a.id === b.id
		const result = structuralArrayDiffWithKnownOffsets(orig, curr, offsets, eq)
		expect(result.edited).toEqual([1])
	})
})
