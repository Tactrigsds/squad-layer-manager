// Which seat each player sits in, read from the log's OnPossess and OnUnPossess lines, and the changes to it that
// become PLAYER_VEHICLE_CHANGED events.
//
// Every seat is a pawn of its own, so the log records every move between seats. A move reads as leaving the old
// seat and entering the new one in the same tick, or now and then as the enter alone. A leave is therefore held
// until its tick is over, so that an enter in the same tick makes the pair one change. Some exits are never logged,
// so an enter into another vehicle than the player's last is an enter, not a move.

import type * as SE from '@/models/server-events.models'
import type * as SM from '@/models/squad.models'

export type Change = { player: SM.PlayerId; time: number; from: SE.VehicleSeat | null; to: SE.VehicleSeat | null }

type Tick = { time: number; chainID: number }

export type State = {
	matchId: number | null
	seats: Map<SM.PlayerId, SE.VehicleSeat>
	// leaves whose tick may still hold the enter that makes them a move
	leaving: Map<SM.PlayerId, { seat: SE.VehicleSeat; tick: string; time: number }>
}

export function init(): State {
	return { matchId: null, seats: new Map(), leaving: new Map() }
}

// A seat from the last match is stale, and so is a leave held across the boundary.
export function resetForMatch(state: State, matchId: number) {
	if (state.matchId === matchId) return
	state.matchId = matchId
	state.seats.clear()
	state.leaving.clear()
}

// A tick's key is its time and chainID together, since the chainID alone wraps at 1000.
function tickKey(tick: Tick) {
	return `${tick.time}:${tick.chainID}`
}

export function onEntered(state: State, player: SM.PlayerId, to: SE.VehicleSeat, tick: Tick): Change | null {
	const held = state.leaving.get(player)
	let from = state.seats.get(player) ?? null
	if (held && held.tick === tickKey(tick)) {
		from = held.seat
		state.leaving.delete(player)
	}
	state.seats.set(player, to)
	if (from && !sameVehicle(from, to)) from = null
	if (from?.seat === to.seat) return null
	return { player, time: tick.time, from, to }
}

export function sameVehicle(a: SE.VehicleSeat, b: SE.VehicleSeat): boolean {
	return a.className === b.className && a.instanceId === b.instanceId
}

export function onExited(state: State, player: SM.PlayerId, tick: Tick) {
	const seat = state.seats.get(player)
	if (!seat) return
	state.seats.delete(player)
	state.leaving.set(player, { seat, tick: tickKey(tick), time: tick.time })
}

// A player who leaves the server is in no seat, and leaves no change behind.
export function forget(state: State, player: SM.PlayerId) {
	state.seats.delete(player)
	state.leaving.delete(player)
}

/**
 * The held leaves that can no longer turn into moves, as changes. Pass the tick of the log line being read, which
 * closes every other tick, or null with a time before which every tick is closed.
 */
export function flush(state: State, current: Tick | null, closedBefore?: number): Change[] {
	if (state.leaving.size === 0) return []
	const key = current && tickKey(current)
	const out: Change[] = []
	for (const [player, held] of state.leaving) {
		const closed = key !== null ? held.tick !== key : closedBefore !== undefined && held.time < closedBefore
		if (!closed) continue
		state.leaving.delete(player)
		out.push({ player, time: held.time, from: held.seat, to: null })
	}
	return out
}
