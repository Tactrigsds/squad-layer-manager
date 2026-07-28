import { describe, expect, it } from 'vitest'

import * as Flt from '@/lib/floating'

const VIEWPORT: Flt.Bounds = { left: 0, top: 0, right: 1000, bottom: 800 }
const SIZE: Flt.Size = { width: 200, height: 100 }

describe('followPoint', () => {
	it('trails below and to the right when there is room', () => {
		expect(Flt.followPoint({ x: 100, y: 100 }, SIZE, VIEWPORT, { offset: 10, margin: 0 })).toEqual({ x: 110, y: 110 })
	})

	it('flips to the other side of the pointer at each edge', () => {
		expect(Flt.followPoint({ x: 990, y: 100 }, SIZE, VIEWPORT, { offset: 10, margin: 0 })).toEqual({ x: 780, y: 110 })
		expect(Flt.followPoint({ x: 100, y: 790 }, SIZE, VIEWPORT, { offset: 10, margin: 0 })).toEqual({ x: 110, y: 680 })
	})

	it('flips both axes at a corner', () => {
		expect(Flt.followPoint({ x: 990, y: 790 }, SIZE, VIEWPORT, { offset: 10, margin: 0 })).toEqual({ x: 780, y: 680 })
	})

	it('keeps its distance from the bounds', () => {
		const placed = Flt.followPoint({ x: 995, y: 795 }, SIZE, VIEWPORT, { offset: 10, margin: 8 })
		expect(placed).toEqual({ x: 785, y: 685 })
	})

	it('clamps inside when neither side of the pointer fits', () => {
		const narrow: Flt.Bounds = { left: 0, top: 0, right: 220, bottom: 800 }
		const placed = Flt.followPoint({ x: 110, y: 100 }, SIZE, narrow, { offset: 10, margin: 0 })
		expect(placed.x).toBeGreaterThanOrEqual(0)
		expect(placed.x + SIZE.width).toBeLessThanOrEqual(220)
	})

	it('places against a boundary element rather than the viewport', () => {
		const panel: Flt.Bounds = { left: 400, top: 300, right: 700, bottom: 500 }
		expect(Flt.followPoint({ x: 410, y: 310 }, SIZE, panel, { offset: 10, margin: 0 })).toEqual({ x: 420, y: 320 })
		expect(Flt.followPoint({ x: 690, y: 490 }, SIZE, panel, { offset: 10, margin: 0 })).toEqual({ x: 480, y: 380 })
	})
})
