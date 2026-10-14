import { describe, expect, it } from 'vitest'

import * as Chart from '@/lib/chart'

describe('rangeAxis', () => {
	it('fits the data instead of starting at zero, with whole ticks at both ends', () => {
		const axis = Chart.rangeAxis(287, 300, 4)
		expect(axis.min).toBeLessThanOrEqual(287)
		expect(axis.min).toBeGreaterThan(0)
		expect(axis.max).toBeGreaterThanOrEqual(300)
		expect(axis.ticks[0]).toBe(axis.min)
		expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max)
		expect(axis.ticks.every(Number.isInteger)).toBe(true)
	})

	it('gives a flat series a usable domain rather than a zero-height one', () => {
		const axis = Chart.rangeAxis(300, 300, 4)
		expect(axis.min).toBeLessThan(300)
		expect(axis.max).toBeGreaterThan(300)
	})
})

describe('axis', () => {
	it('covers the data and ends on a tick', () => {
		const axis = Chart.axis(37, 4, { integer: true })
		expect(axis.max).toBeGreaterThanOrEqual(37)
		expect(axis.ticks[0]).toBe(0)
		expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max)
	})

	it('keeps every tick whole when asked for integers', () => {
		for (const dataMax of [1, 2, 3, 7, 13, 48, 99, 100]) {
			const axis = Chart.axis(dataMax, 4, { integer: true })
			expect(axis.ticks.every(Number.isInteger), `dataMax ${dataMax} -> ${axis.ticks.join()}`).toBe(true)
			expect(axis.max).toBeGreaterThanOrEqual(dataMax)
		}
	})

	it('gives an empty dataset a usable domain rather than a zero-width one', () => {
		expect(Chart.axis(0, 4, { integer: true })).toEqual({ max: 1, ticks: [0, 1] })
	})

	it('stays near the requested tick count', () => {
		for (const dataMax of [5, 24, 61, 250, 1001]) {
			const axis = Chart.axis(dataMax, 4)
			expect(axis.ticks.length, `dataMax ${dataMax}`).toBeGreaterThanOrEqual(3)
			expect(axis.ticks.length, `dataMax ${dataMax}`).toBeLessThanOrEqual(9)
		}
	})
})

describe('valueAt', () => {
	const points = [
		{ x: 0, y: 0 },
		{ x: 10, y: 1 },
		{ x: 10, y: 2 },
		{ x: 25, y: 3 },
	]

	it('holds each value until the next point', () => {
		expect(Chart.valueAt(points, 0)).toBe(0)
		expect(Chart.valueAt(points, 9.9)).toBe(0)
		expect(Chart.valueAt(points, 24)).toBe(2)
		expect(Chart.valueAt(points, 1000)).toBe(3)
	})

	it('takes the last of several points at the same x', () => {
		expect(Chart.valueAt(points, 10)).toBe(2)
	})

	it('has no value before the first point', () => {
		expect(Chart.valueAt(points, -1)).toBeUndefined()
		expect(Chart.valueAt([], 5)).toBeUndefined()
	})
})

describe('signedAxis', () => {
	it('mirrors its ticks around zero', () => {
		const axis = Chart.signedAxis(7)
		expect(axis.min).toBe(-axis.max)
		expect(axis.max).toBeGreaterThanOrEqual(7)
		expect(axis.ticks).toContain(0)
		expect(axis.ticks.map((tick) => 0 - tick).sort((a, b) => a - b)).toEqual(axis.ticks)
	})
})
