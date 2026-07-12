import type * as ODSM from '@/lib/odsm'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswitches.models'
import { describe, expect, it } from 'vitest'

const SOURCE = { discordId: 1n }

let opIdCounter = 0
function op<T extends TSW.NewClientOp>(o: T): TSW.Op {
	return { opId: `op-${opIdCounter++}`, ...o } as TSW.Op
}

function stateWith(players: [SM.PlayerId, MH.NormedTeamId][], saved: [SM.PlayerId, MH.NormedTeamId][] = []): TSW.State {
	const state = TSW.initState()
	state.players = new Map(players)
	state.savedSwitches = new Map(saved.map(([playerId, toTeam]) => [playerId, { toTeam, source: SOURCE }]))
	state.editedSwitches = state.savedSwitches
	return state
}

function apply(state: TSW.State, ...ops: TSW.Op[]) {
	const [next, sideEffects] = TSW.reducer(state, ops, [])
	return { state: next, sideEffects }
}

function notifiedUpcoming(sideEffects: TSW.SideEffect[]) {
	return sideEffects.filter(se => se.code === 'notify-upcoming-teamswitches').flatMap(se => se.players)
}

function endedEditing(sideEffects: TSW.SideEffect[]) {
	return sideEffects.some(se => se.code === 'end-all-teamswitch-editing')
}

function rejectionOf(run: () => unknown): TSW.Rejection {
	try {
		run()
	} catch (error) {
		return (error as ODSM.RejectedError<TSW.Rejection>).data
	}
	throw new Error('expected the batch to be rejected')
}

describe('reducer notify-upcoming-teamswitches', () => {
	it('notifies only the newly marked player when queuing alongside an existing switch', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		const { sideEffects } = apply(
			state,
			op({ code: 'add-player-teamswitch', playerId: 'b', toTeam: 'B', saved: true, source: SOURCE }),
		)
		expect(notifiedUpcoming(sideEffects)).toEqual(['b'])
	})

	it('notifies a player retargeted to a different team', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const { sideEffects } = apply(
			state,
			op({ code: 'remove-player-teamswitches', playerId: 'a', saved: false, source: SOURCE }),
			op({ code: 'add-player-teamswitch', playerId: 'a', toTeam: 'A', saved: false, source: SOURCE }),
			op({ code: 'save', source: SOURCE }),
		)
		expect(notifiedUpcoming(sideEffects)).toEqual(['a'])
	})

	it('does not re-notify remaining players when a marked player disconnects', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B'], ['b', 'B']])
		const { sideEffects } = apply(state, op({ code: 'player-left', playerId: 'a' }))
		expect(notifiedUpcoming(sideEffects)).toEqual([])
	})

	it('does not re-notify queued players when another player is switched now', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		const switches: TSW.TeamswitchCollection = new Map([['b', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }]])
		const { sideEffects } = apply(state, op({ code: 'switch-now', switches, source: SOURCE }))
		expect(notifiedUpcoming(sideEffects)).toEqual([])
	})

	it('does not notify when saved switches are restored from the db', () => {
		const state = stateWith([['a', 'A']])
		const switches: TSW.TeamswitchCollection = new Map([
			['a', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }],
			// a player who has since left: dropped, which forces a re-save of the pruned collection
			['gone', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }],
		])
		const { state: next, sideEffects } = apply(state, op({ code: 'init-saved-teamswitches', switches }))
		expect(next.savedSwitches.has('a')).toBe(true)
		expect(notifiedUpcoming(sideEffects)).toEqual([])
		expect(sideEffects.some(se => se.code === 'save')).toBe(true)
	})

	it('notifies added players and cancels removed players on save', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		state.editedSwitches = new Map([['b', { toTeam: 'B', source: SOURCE }]])
		const { sideEffects } = apply(state, op({ code: 'save', source: SOURCE }))
		expect(notifiedUpcoming(sideEffects)).toEqual(['b'])
		const cancelled = sideEffects.filter(se => se.code === 'notify-teamswitches-cancelled').flatMap(se => se.players)
		expect(cancelled).toEqual(['a'])
	})
})

describe('reducer end-all-teamswitch-editing', () => {
	function withPendingEdit() {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		state.editedSwitches = new Map(state.savedSwitches)
		state.editedSwitches.set('b', { toTeam: 'B', source: SOURCE })
		return state
	}

	it('ends editing once the pending edits are committed by a save', () => {
		const { sideEffects } = apply(withPendingEdit(), op({ code: 'save', source: SOURCE }))
		expect(endedEditing(sideEffects)).toBe(true)
	})

	it('ends editing once the pending edits are discarded by a revert', () => {
		const { sideEffects } = apply(withPendingEdit(), op({ code: 'revert-to-saved', source: SOURCE }))
		expect(endedEditing(sideEffects)).toBe(true)
	})

	it('ends editing when a map roll executes the saved switches', () => {
		const { sideEffects } = apply(withPendingEdit(), op({ code: 'execute-teamswitches' }))
		expect(endedEditing(sideEffects)).toBe(true)
	})

	it('leaves pending edits (and their editors) alone when an unrelated player disconnects', () => {
		const { state, sideEffects } = apply(withPendingEdit(), op({ code: 'player-left', playerId: 'a' }))
		expect(endedEditing(sideEffects)).toBe(false)
		expect(state.editedSwitches.has('b')).toBe(true)
	})
})

describe('reducer saved-set writes', () => {
	it('re-syncs the edit set when a saved switch is removed, so the player can be re-added', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const removed = apply(state, op({ code: 'remove-player-teamswitches', playerId: 'a', saved: true, source: SOURCE }))
		expect(removed.state.editedSwitches.has('a')).toBe(false)
		const readded = apply(
			removed.state,
			op({ code: 'add-player-teamswitch', playerId: 'a', toTeam: 'B', saved: true, source: SOURCE }),
		)
		expect(readded.state.savedSwitches.get('a')?.toTeam).toBe('B')
	})

	// a chat command commits straight to the saved set while a gui client may have unsaved edits in flight
	describe('with an unsaved edit in flight', () => {
		// 'a' is queued and saved; a gui client has additionally marked 'b' without saving
		function withPendingEdit() {
			const state = stateWith([['a', 'A'], ['b', 'A'], ['c', 'A']], [['a', 'B']])
			state.editedSwitches = new Map(state.savedSwitches)
			state.editedSwitches.set('b', { toTeam: 'B', source: SOURCE })
			return state
		}

		it('keeps the pending edit when a chat command queues another player', () => {
			const { state } = apply(
				withPendingEdit(),
				op({ code: 'add-player-teamswitch', playerId: 'c', toTeam: 'B', saved: true, source: SOURCE }),
			)
			expect(state.savedSwitches.get('c')?.toTeam).toBe('B')
			expect(state.savedSwitches.has('b')).toBe(false)
			expect([...state.editedSwitches.keys()].sort()).toEqual(['a', 'b', 'c'])
		})

		it('keeps the pending edit when a chat command clears the queue', () => {
			const { state, sideEffects } = apply(withPendingEdit(), op({ code: 'clear-teamswitches', save: true, source: SOURCE }))
			expect(state.savedSwitches.size).toBe(0)
			expect([...state.editedSwitches.keys()]).toEqual(['b'])
			const cancelled = sideEffects.filter(se => se.code === 'notify-teamswitches-cancelled').flatMap(se => se.players)
			expect(cancelled).toEqual(['a'])
			expect(endedEditing(sideEffects)).toBe(false)
		})

		it('keeps the pending edit when a chat command switches a player now', () => {
			const switches: TSW.TeamswitchCollection = new Map([['a', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }]])
			const { state } = apply(withPendingEdit(), op({ code: 'switch-now', switches, source: SOURCE }))
			expect(state.savedSwitches.size).toBe(0)
			expect([...state.editedSwitches.keys()]).toEqual(['b'])
		})

		it("does not reject a chat command over another client's unsaved mark for the same player", () => {
			const { state } = apply(
				withPendingEdit(),
				op({ code: 'add-player-teamswitch', playerId: 'b', toTeam: 'B', saved: true, source: SOURCE }),
			)
			expect(state.savedSwitches.get('b')?.toTeam).toBe('B')
		})

		it('still rejects a chat command for a player who is actually queued', () => {
			const rejection = rejectionOf(() =>
				apply(withPendingEdit(), op({ code: 'add-player-teamswitch', playerId: 'a', toTeam: 'B', saved: true, source: SOURCE }))
			)
			expect(rejection.code).toBe('err:already-marked')
		})

		// the reply to !clearswitches is driven by this rejection, so an empty queue has to be distinguishable
		// from a successful clear
		it('rejects a clear of an empty queue rather than committing an empty save', () => {
			const state = stateWith([['b', 'A']])
			state.editedSwitches = new Map([['b', { toTeam: 'B', source: SOURCE }]])
			const rejection = rejectionOf(() => apply(state, op({ code: 'clear-teamswitches', save: true, source: SOURCE })))
			expect(rejection.code).toBe('err:nothing-queued')
		})
	})
})
