import { describe, expect, it } from 'vitest'

import type * as SE from '@/models/server-events.models'
import * as VS from '@/models/vehicle-seats.models'

const seat = (n: number, vehicle = 'BP_M60T_Desert', instanceId: number | null = 100): SE.VehicleSeat => ({
	className: vehicle,
	instanceId,
	targetType: 'MBT',
	seat: n,
	pawn: n === 0 ? vehicle : `${vehicle}_Turret`,
})
const tick = (time: number, chainID = time % 1000) => ({ time, chainID })
const kinds = (changes: (VS.Change | null)[]) =>
	changes.map((c) =>
		c === null ? null : !c.from ? `enter ${c.to!.seat}` : !c.to ? `exit ${c.from.seat}` : `move ${c.from.seat}->${c.to.seat}`,
	)

function init() {
	const state = VS.init()
	VS.resetForMatch(state, 1)
	return state
}

describe('vehicle seats', () => {
	it('reads an exit and an enter in one tick as one move', () => {
		const state = init()
		const entered = VS.onEntered(state, 'p', seat(0), tick(1000))
		VS.onExited(state, 'p', tick(2000))
		const moved = VS.onEntered(state, 'p', seat(1), tick(2000))
		expect(kinds([entered, moved])).toEqual(['enter 0', 'move 0->1'])
		expect(VS.flush(state, tick(3000))).toEqual([])
	})

	it('reads an enter with no exit before it as a move within the same vehicle', () => {
		const state = init()
		VS.onEntered(state, 'p', seat(0), tick(1000))
		expect(kinds([VS.onEntered(state, 'p', seat(2), tick(2000))])).toEqual(['move 0->2'])
	})

	it('reads an enter into another vehicle as an enter, whatever seat the player was last seen in', () => {
		const state = init()
		VS.onEntered(state, 'p', seat(0, 'BP_Loach'), tick(1000))
		expect(kinds([VS.onEntered(state, 'p', seat(0), tick(2000))])).toEqual(['enter 0'])
	})

	it('holds an exit until a line of a later tick is read', () => {
		const state = init()
		VS.onEntered(state, 'p', seat(0), tick(1000))
		VS.onExited(state, 'p', tick(2000))
		expect(VS.flush(state, tick(2000))).toEqual([])
		expect(kinds(VS.flush(state, tick(2001)))).toEqual(['exit 0'])
	})

	it('closes at the end of a pass only the ticks before the latest line', () => {
		const state = init()
		VS.onEntered(state, 'p', seat(0), tick(1000))
		VS.onExited(state, 'p', tick(2000))
		expect(VS.flush(state, null, 2000)).toEqual([])
		expect(kinds(VS.flush(state, null, 2001))).toEqual(['exit 0'])
	})

	it('drops seats and held exits at a new match, and for a player who leaves', () => {
		const state = init()
		VS.onEntered(state, 'a', seat(0), tick(1000))
		VS.onEntered(state, 'b', seat(1), tick(1000))
		VS.onExited(state, 'a', tick(2000))
		VS.forget(state, 'b')
		VS.resetForMatch(state, 2)
		expect(VS.flush(state, tick(3000))).toEqual([])
		expect(kinds([VS.onEntered(state, 'b', seat(2), tick(4000))])).toEqual(['enter 2'])
	})
})
