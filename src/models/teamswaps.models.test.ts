import type * as ODSM from '@/lib/odsm'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswaps.models'
import { describe, expect, it } from 'vitest'

const SOURCE = { discordId: 1n }

let opIdCounter = 0
function op<T extends TSW.NewClientOp>(o: T): TSW.Op {
	return { opId: `op-${opIdCounter++}`, ...o } as TSW.Op
}

function stateWith(players: [SM.PlayerId, MH.NormedTeamId][], saved: [SM.PlayerId, MH.NormedTeamId][] = []): TSW.State {
	const state = TSW.initState()
	state.players = new Map(players)
	state.savedSwaps = new Map(saved.map(([playerId, toTeam]) => [playerId, { toTeam, source: SOURCE }]))
	state.editedSwaps = state.savedSwaps
	return state
}

function apply(state: TSW.State, ...ops: TSW.Op[]) {
	const [next, sideEffects] = TSW.reducer(state, ops, [])
	return { state: next, sideEffects }
}

function notifiedUpcoming(sideEffects: TSW.SideEffect[]) {
	return sideEffects.filter(se => se.code === 'notify-upcoming-teamswaps').flatMap(se => se.players)
}

function endedEditing(sideEffects: TSW.SideEffect[]) {
	return sideEffects.some(se => se.code === 'end-all-teamswap-editing')
}

function rejectionOf(run: () => unknown): TSW.Rejection {
	try {
		run()
	} catch (error) {
		return (error as ODSM.RejectedError<TSW.Rejection>).data
	}
	throw new Error('expected the batch to be rejected')
}

describe('reducer notify-upcoming-teamswaps', () => {
	it('notifies only the newly marked player when queuing alongside an existing swap', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		const { sideEffects } = apply(
			state,
			op({ code: 'add-player-teamswap', playerId: 'b', toTeam: 'B', saved: true, source: SOURCE }),
		)
		expect(notifiedUpcoming(sideEffects)).toEqual(['b'])
	})

	it('notifies a player retargeted to a different team', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const { sideEffects } = apply(
			state,
			op({ code: 'remove-player-teamswaps', playerId: 'a', saved: false, source: SOURCE }),
			op({ code: 'add-player-teamswap', playerId: 'a', toTeam: 'A', saved: false, source: SOURCE }),
			op({ code: 'save', source: SOURCE }),
		)
		expect(notifiedUpcoming(sideEffects)).toEqual(['a'])
	})

	it('does not re-notify remaining players when a marked player disconnects', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B'], ['b', 'B']])
		const { sideEffects } = apply(state, op({ code: 'player-left', playerId: 'a' }))
		expect(notifiedUpcoming(sideEffects)).toEqual([])
	})

	it('does not re-notify queued players when another player is swapped now', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		const swaps: TSW.TeamswapCollection = new Map([['b', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }]])
		const { sideEffects } = apply(state, op({ code: 'swap-now', swaps, source: SOURCE }))
		expect(notifiedUpcoming(sideEffects)).toEqual([])
	})

	it('does not notify when saved swaps are restored from the db', () => {
		const state = stateWith([['a', 'A']])
		const swaps: TSW.TeamswapCollection = new Map([
			['a', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }],
			// a player who has since left: dropped, which forces a re-save of the pruned collection
			['gone', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }],
		])
		const { state: next, sideEffects } = apply(state, op({ code: 'init-saved-teamswaps', swaps }))
		expect(next.savedSwaps.has('a')).toBe(true)
		expect(notifiedUpcoming(sideEffects)).toEqual([])
		expect(sideEffects.some(se => se.code === 'save')).toBe(true)
	})

	it('notifies added players and cancels removed players on save', () => {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		state.editedSwaps = new Map([['b', { toTeam: 'B', source: SOURCE }]])
		const { sideEffects } = apply(state, op({ code: 'save', source: SOURCE }))
		expect(notifiedUpcoming(sideEffects)).toEqual(['b'])
		const cancelled = sideEffects.filter(se => se.code === 'notify-teamswaps-cancelled').flatMap(se => se.players)
		expect(cancelled).toEqual(['a'])
	})
})

describe('reducer end-all-teamswap-editing', () => {
	function withPendingEdit() {
		const state = stateWith([['a', 'A'], ['b', 'A']], [['a', 'B']])
		state.editedSwaps = new Map(state.savedSwaps)
		state.editedSwaps.set('b', { toTeam: 'B', source: SOURCE })
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

	it('ends editing when a map roll executes the saved swaps', () => {
		const { sideEffects } = apply(withPendingEdit(), op({ code: 'execute-teamswaps' }))
		expect(endedEditing(sideEffects)).toBe(true)
	})

	it('leaves pending edits (and their editors) alone when an unrelated player disconnects', () => {
		const { state, sideEffects } = apply(withPendingEdit(), op({ code: 'player-left', playerId: 'a' }))
		expect(endedEditing(sideEffects)).toBe(false)
		expect(state.editedSwaps.has('b')).toBe(true)
	})
})

describe('reducer execution attribution', () => {
	const executed = (sideEffects: TSW.SideEffect[]) => sideEffects.find(se => se.code === 'teamswaps-executed')

	// the queued swaps carry the source of whoever queued each player, which is not who executed them
	function queuedByAdmin() {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		state.savedSwaps = new Map([['a', { toTeam: 'B', source: SOURCE }]])
		state.editedSwaps = state.savedSwaps
		return state
	}

	it('attributes a manual execution to whoever executed it', () => {
		const executor = { discordId: 2n }
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswaps', source: executor }))
		const { sideEffects } = apply(started.state, op({ code: 'teamswap-execution-completed' }))
		expect(executed(sideEffects)?.source).toEqual(executor)
	})

	it('leaves a map-roll execution unattributed', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswaps' }))
		const { sideEffects } = apply(started.state, op({ code: 'teamswap-execution-completed' }))
		expect(executed(sideEffects)?.source).toBeUndefined()
	})

	// watchExecution reads swappingOpId to tell "the execution I fired is still pending" from "it already
	// resolved", which is what stops a late watcher from failing a newer execution
	it('tracks the op that started the execution until it resolves', () => {
		const start = op({ code: 'execute-teamswaps' })
		const started = apply(queuedByAdmin(), start)
		expect(started.state.swappingOpId).toBe(start.opId)
		const done = apply(started.state, op({ code: 'teamswap-execution-completed' }))
		expect(done.state.swappingOpId).toBeNull()
	})

	// an op error rejects the batch, and a rejected batch changes no state, so reporting the failure that way would
	// leave the swaps it cancels pending forever. this is what the stuck-pending bug was.
	it('cancels the pending swaps when an execution fails, and reports it as a side effect', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswaps' }))
		expect(started.state.pendingSwaps.size).toBe(1)

		const failed = apply(started.state, op({ code: 'teamswap-execution-failed', reason: 'timeout' }))
		expect(failed.state.swapping).toBe(false)
		expect(failed.state.pendingSwaps.size).toBe(0)
		expect(failed.state.swappingOpId).toBeNull()
		const se = failed.sideEffects.find(se => se.code === 'teamswap-execution-failed')
		expect(se?.reason).toBe('timeout')
	})

	it('reports the players who never swapped', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswaps' }))
		const { sideEffects } = apply(
			started.state,
			op({ code: 'teamswap-execution-failed', reason: 'not-all-players-swapped', playerIds: ['a'] }),
		)
		const se = sideEffects.find(se => se.code === 'teamswap-execution-failed')
		expect(se?.playerIds).toEqual(['a'])
	})

	it('ignores a failure for an execution that already resolved', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswaps' }))
		const done = apply(started.state, op({ code: 'teamswap-execution-completed' }))
		const rejection = rejectionOf(() => apply(done.state, op({ code: 'teamswap-execution-failed', reason: 'timeout' })))
		expect(rejection.code).toBe('noop')
	})
})

describe('reducer save trigger', () => {
	const triggerOf = (sideEffects: TSW.SideEffect[]) => sideEffects.find(se => se.code === 'save')?.trigger

	it('marks an admin save as a user edit', () => {
		const state = stateWith([['a', 'A']])
		state.editedSwaps = new Map([['a', { toTeam: 'B', source: SOURCE }]])
		expect(triggerOf(apply(state, op({ code: 'save', source: SOURCE })).sideEffects)).toBe('user-edit')
	})

	it('marks a map-roll execution as executed, with nobody to attribute it to', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const save = apply(state, op({ code: 'execute-teamswaps' })).sideEffects.find(se => se.code === 'save')
		expect(save?.trigger).toBe('executed')
		expect(save?.source).toBeUndefined()
	})

	it('attributes a manual execution to the admin who fired it', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const save = apply(state, op({ code: 'execute-teamswaps', source: SOURCE })).sideEffects.find(se => se.code === 'save')
		expect(save?.trigger).toBe('executed')
		expect(save?.source).toEqual(SOURCE)
	})

	// an immediate swap is a TEAM_CHANGE_FORCED, not a queue execution: the server skips the app event for it, so
	// it doesn't double-log the same swap
	it('marks an immediate swap of a queued player as swapped-now', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const swaps: TSW.TeamswapCollection = new Map([['a', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }]])
		expect(triggerOf(apply(state, op({ code: 'swap-now', swaps, source: SOURCE })).sideEffects)).toBe('swapped-now')
	})

	it('marks a swap dropped by a disconnect as a roster change', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		expect(triggerOf(apply(state, op({ code: 'player-left', playerId: 'a' })).sideEffects)).toBe('roster-change')
	})
})

describe('reducer saved-set writes', () => {
	it('re-syncs the edit set when a saved swap is removed, so the player can be re-added', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const removed = apply(state, op({ code: 'remove-player-teamswaps', playerId: 'a', saved: true, source: SOURCE }))
		expect(removed.state.editedSwaps.has('a')).toBe(false)
		const readded = apply(
			removed.state,
			op({ code: 'add-player-teamswap', playerId: 'a', toTeam: 'B', saved: true, source: SOURCE }),
		)
		expect(readded.state.savedSwaps.get('a')?.toTeam).toBe('B')
	})

	// a chat command commits straight to the saved set while a gui client may have unsaved edits in flight
	describe('with an unsaved edit in flight', () => {
		// 'a' is queued and saved; a gui client has additionally marked 'b' without saving
		function withPendingEdit() {
			const state = stateWith([['a', 'A'], ['b', 'A'], ['c', 'A']], [['a', 'B']])
			state.editedSwaps = new Map(state.savedSwaps)
			state.editedSwaps.set('b', { toTeam: 'B', source: SOURCE })
			return state
		}

		it('keeps the pending edit when a chat command queues another player', () => {
			const { state } = apply(
				withPendingEdit(),
				op({ code: 'add-player-teamswap', playerId: 'c', toTeam: 'B', saved: true, source: SOURCE }),
			)
			expect(state.savedSwaps.get('c')?.toTeam).toBe('B')
			expect(state.savedSwaps.has('b')).toBe(false)
			expect([...state.editedSwaps.keys()].sort()).toEqual(['a', 'b', 'c'])
		})

		it('keeps the pending edit when a chat command clears the queue', () => {
			const { state, sideEffects } = apply(withPendingEdit(), op({ code: 'clear-teamswaps', save: true, source: SOURCE }))
			expect(state.savedSwaps.size).toBe(0)
			expect([...state.editedSwaps.keys()]).toEqual(['b'])
			const cancelled = sideEffects.filter(se => se.code === 'notify-teamswaps-cancelled').flatMap(se => se.players)
			expect(cancelled).toEqual(['a'])
			expect(endedEditing(sideEffects)).toBe(false)
		})

		it('keeps the pending edit when a chat command swaps a player now', () => {
			const swaps: TSW.TeamswapCollection = new Map([['a', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }]])
			const { state } = apply(withPendingEdit(), op({ code: 'swap-now', swaps, source: SOURCE }))
			expect(state.savedSwaps.size).toBe(0)
			expect([...state.editedSwaps.keys()]).toEqual(['b'])
		})

		it("does not reject a chat command over another client's unsaved mark for the same player", () => {
			const { state } = apply(
				withPendingEdit(),
				op({ code: 'add-player-teamswap', playerId: 'b', toTeam: 'B', saved: true, source: SOURCE }),
			)
			expect(state.savedSwaps.get('b')?.toTeam).toBe('B')
		})

		it('still rejects a chat command for a player who is actually queued', () => {
			const rejection = rejectionOf(() =>
				apply(withPendingEdit(), op({ code: 'add-player-teamswap', playerId: 'a', toTeam: 'B', saved: true, source: SOURCE }))
			)
			expect(rejection.code).toBe('err:already-marked')
		})

		// the reply to !clearswaps is driven by this rejection, so an empty queue has to be distinguishable
		// from a successful clear
		it('rejects a clear of an empty queue rather than committing an empty save', () => {
			const state = stateWith([['b', 'A']])
			state.editedSwaps = new Map([['b', { toTeam: 'B', source: SOURCE }]])
			const rejection = rejectionOf(() => apply(state, op({ code: 'clear-teamswaps', save: true, source: SOURCE })))
			expect(rejection.code).toBe('err:nothing-queued')
		})
	})
})
