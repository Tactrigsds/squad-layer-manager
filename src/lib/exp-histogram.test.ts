import { describe, expect, test } from 'vitest'

import * as ExpHist from './exp-histogram'

const make = () => ExpHist.create({ min: 1, max: 60_000, growth: 1.25 })

describe('bucketing', () => {
	test('values at and below min share bucket 0', () => {
		const h = make()
		ExpHist.record(h, -50)
		ExpHist.record(h, 0)
		ExpHist.record(h, 1)
		expect(h.curr[0]).toBe(3)
	})

	test('a bucket edge is a quantile-reachable upper bound of its bucket', () => {
		const h = make()
		// exact edges and values just past them must land in adjacent buckets despite float log error
		for (let i = 1; i < h.edges.length - 1; i++) {
			const edge = h.edges[i]
			ExpHist.record(h, edge)
			ExpHist.record(h, edge * 1.0000001)
			expect(h.curr[i]).toBe(1)
			expect(h.curr[i + 1]).toBe(1)
			h.curr.fill(0)
			h.currCount = 0
		}
	})

	test('values past max clamp into the last bucket', () => {
		const h = make()
		ExpHist.record(h, 10 ** 9)
		expect(h.curr[h.edges.length - 1]).toBe(1)
	})
})

describe('quantile', () => {
	test('empty histogram has no quantile', () => {
		expect(ExpHist.quantile(make(), 0.99)).toBe(null)
	})

	test('errs high but within one growth factor', () => {
		const h = make()
		for (let i = 0; i < 100; i++) ExpHist.record(h, 100)
		ExpHist.record(h, 5000)
		const p50 = ExpHist.quantile(h, 0.5)!
		expect(p50).toBeGreaterThanOrEqual(100)
		expect(p50).toBeLessThan(100 * 1.25)
		const p99 = ExpHist.quantile(h, 0.99)!
		expect(p99).toBeGreaterThanOrEqual(100)
		expect(p99).toBeLessThan(100 * 1.25)
		const p100 = ExpHist.quantile(h, 1)!
		expect(p100).toBeGreaterThanOrEqual(5000)
		expect(p100).toBeLessThan(5000 * 1.25)
	})
})

describe('generations', () => {
	test('a sample survives one flip and ages out after two', () => {
		const h = make()
		ExpHist.record(h, 3000)
		ExpHist.flip(h)
		expect(ExpHist.count(h)).toBe(1)
		expect(ExpHist.quantile(h, 1)!).toBeGreaterThanOrEqual(3000)
		ExpHist.flip(h)
		expect(ExpHist.count(h)).toBe(0)
		expect(ExpHist.quantile(h, 1)).toBe(null)
	})

	test('quantile spans both generations', () => {
		const h = make()
		for (let i = 0; i < 99; i++) ExpHist.record(h, 100)
		ExpHist.flip(h)
		ExpHist.record(h, 8000)
		expect(ExpHist.count(h)).toBe(100)
		expect(ExpHist.quantile(h, 0.5)!).toBeLessThan(100 * 1.25)
		expect(ExpHist.quantile(h, 1)!).toBeGreaterThanOrEqual(8000)
	})
})
