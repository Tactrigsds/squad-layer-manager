import { describe, expect, it } from 'vitest'

import * as DW from '@/models/draggable-windows.models'

const viewport = { width: 1200, height: 950 }
const base = { offset: 8, padding: 16, viewport, rtl: false }

// a DOMRect exposes its fields as prototype getters, so spreading one copies nothing
class Box {
	#size: { width: number; height: number }
	constructor(size: { width: number; height: number }) {
		this.#size = size
	}
	get width() {
		return this.#size.width
	}
	get height() {
		return this.#size.height
	}
}

function solve(input: Partial<DW.SolvePositionInput> & Pick<DW.SolvePositionInput, 'anchor' | 'size' | 'preferred'>) {
	return DW.solveInitialPosition({ ...base, ...input, size: new Box(input.size) })
}

describe('solveInitialPosition', () => {
	it('opens a tall window beside an anchor at the screen edge instead of centering it', () => {
		const anchor = { left: 16, top: 425, width: 72, height: 20 }
		const size = { width: 700, height: 880 }
		expect(solve({ anchor, size, preferred: 'left' })).toEqual({ x: 96, y: 16 })
	})

	it('uses the preferred side when the window fits there', () => {
		const anchor = { left: 900, top: 400, width: 100, height: 20 }
		expect(solve({ anchor, size: { width: 300, height: 200 }, preferred: 'left' })).toEqual({ x: 592, y: 310 })
	})

	it('mirrors left and right in a right-to-left page', () => {
		const anchor = { left: 500, top: 400, width: 100, height: 20 }
		expect(solve({ anchor, size: { width: 300, height: 200 }, preferred: 'left', rtl: true })).toEqual({ x: 608, y: 310 })
	})

	it('covers as little of the anchor as possible when no side has room', () => {
		const anchor = { left: 200, top: 100, width: 950, height: 750 }
		expect(solve({ anchor, size: { width: 400, height: 400 }, preferred: 'below' })).toEqual({ x: 16, y: 275 })
	})

	it('pins a window larger than the viewport to the top-left padding', () => {
		const anchor = { left: 600, top: 400, width: 10, height: 10 }
		expect(solve({ anchor, size: { width: 1400, height: 1000 }, preferred: 'right' })).toEqual({ x: 16, y: 16 })
	})

	it('centers in the viewport without an anchor', () => {
		expect(solve({ anchor: null, size: { width: 400, height: 300 }, preferred: 'below' })).toEqual({ x: 400, y: 325 })
	})
})
