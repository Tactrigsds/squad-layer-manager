import type * as LE from '@/models/layer-engine'
import { foldBackburnerTemplates } from '@/systems/layer-queries.shared'
import { describe, expect, it } from 'vitest'

// distinguishable leaf IRs; the stubbed count treats a col as unsatisfiable when combined with the base
const ir = (col: number): LE.Ir => ({ op: 'eq_val', col, val: 1 })
const BASE: LE.Ir = { op: 'true' }

function usesCol(where: LE.Ir, col: number): boolean {
	switch (where.op) {
		case 'and':
		case 'or':
			return where.children.some(child => usesCol(child, col))
		case 'not':
			return usesCol(where.child, col)
		case 'eq_val':
			return where.col === col
		default:
			return false
	}
}

function countStub(unsatisfiableCols: number[]) {
	return (where: LE.Ir) => (unsatisfiableCols.some(col => usesCol(where, col)) ? 0 : 10)
}

describe('foldBackburnerTemplates', () => {
	it('consumes every satisfiable template oldest-first', () => {
		const templates = [1, 2, 3].map(col => ({ itemId: `t${col}`, ir: ir(col) }))
		const res = foldBackburnerTemplates(templates, BASE, countStub([]))
		expect(res.consumedItemIds).toEqual(['t1', 't2', 't3'])
		expect([1, 2, 3].every(col => usesCol(res.where, col))).toBe(true)
	})

	it('skips an unsatisfiable template but still consumes later ones', () => {
		const templates = [1, 2, 3].map(col => ({ itemId: `t${col}`, ir: ir(col) }))
		const res = foldBackburnerTemplates(templates, BASE, countStub([2]))
		expect(res.consumedItemIds).toEqual(['t1', 't3'])
		expect(usesCol(res.where, 2)).toBe(false)
	})

	it('returns the base constraints untouched when nothing fits', () => {
		const templates = [1, 2].map(col => ({ itemId: `t${col}`, ir: ir(col) }))
		const res = foldBackburnerTemplates(templates, BASE, countStub([1, 2]))
		expect(res.consumedItemIds).toEqual([])
		expect(res.where).toEqual(BASE)
	})

	it('respects accumulated constraints: a template unsatisfiable only in combination is skipped', () => {
		// col 9 is fine alone but the stub kills any where that contains both 1 and 9
		const templates = [{ itemId: 't1', ir: ir(1) }, { itemId: 't9', ir: ir(9) }, { itemId: 't3', ir: ir(3) }]
		const count = (where: LE.Ir) => (usesCol(where, 1) && usesCol(where, 9) ? 0 : 10)
		const res = foldBackburnerTemplates(templates, BASE, count)
		expect(res.consumedItemIds).toEqual(['t1', 't3'])
	})

	it('handles an empty template list', () => {
		const res = foldBackburnerTemplates([], BASE, countStub([]))
		expect(res.consumedItemIds).toEqual([])
		expect(res.where).toEqual(BASE)
	})
})
