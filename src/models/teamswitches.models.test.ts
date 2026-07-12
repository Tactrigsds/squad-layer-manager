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

describe('reducer execution attribution', () => {
	const executed = (sideEffects: TSW.SideEffect[]) => sideEffects.find(se => se.code === 'teamswitches-executed')

	// the queued switches carry the source of whoever queued each player, which is not who executed them
	function queuedByAdmin() {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		state.savedSwitches = new Map([['a', { toTeam: 'B', source: SOURCE }]])
		state.editedSwitches = state.savedSwitches
		return state
	}

	it('attributes a manual execution to whoever executed it', () => {
		const executor = { discordId: 2n }
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswitches', source: executor }))
		const { sideEffects } = apply(started.state, op({ code: 'teamswitch-execution-completed' }))
		expect(executed(sideEffects)?.source).toEqual(executor)
	})

	it('leaves a map-roll execution unattributed', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswitches' }))
		const { sideEffects } = apply(started.state, op({ code: 'teamswitch-execution-completed' }))
		expect(executed(sideEffects)?.source).toBeUndefined()
	})

	// watchExecution reads switchingOpId to tell "the execution I fired is still pending" from "it already
	// resolved", which is what stops a late watcher from failing a newer execution
	it('tracks the op that started the execution until it resolves', () => {
		const start = op({ code: 'execute-teamswitches' })
		const started = apply(queuedByAdmin(), start)
		expect(started.state.switchingOpId).toBe(start.opId)
		const done = apply(started.state, op({ code: 'teamswitch-execution-completed' }))
		expect(done.state.switchingOpId).toBeNull()
	})

	// an op error rejects the batch, and a rejected batch changes no state, so reporting the failure that way would
	// leave the switches it cancels pending forever. this is what the stuck-pending bug was.
	it('cancels the pending switches when an execution fails, and reports it as a side effect', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswitches' }))
		expect(started.state.pendingSwitches.size).toBe(1)

		const failed = apply(started.state, op({ code: 'teamswitch-execution-failed', reason: 'timeout' }))
		expect(failed.state.switching).toBe(false)
		expect(failed.state.pendingSwitches.size).toBe(0)
		expect(failed.state.switchingOpId).toBeNull()
		const se = failed.sideEffects.find(se => se.code === 'teamswitch-execution-failed')
		expect(se?.reason).toBe('timeout')
	})

	it('reports the players who never switched', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswitches' }))
		const { sideEffects } = apply(
			started.state,
			op({ code: 'teamswitch-execution-failed', reason: 'not-all-players-switched', playerIds: ['a'] }),
		)
		const se = sideEffects.find(se => se.code === 'teamswitch-execution-failed')
		expect(se?.playerIds).toEqual(['a'])
	})

	it('ignores a failure for an execution that already resolved', () => {
		const started = apply(queuedByAdmin(), op({ code: 'execute-teamswitches' }))
		const done = apply(started.state, op({ code: 'teamswitch-execution-completed' }))
		const rejection = rejectionOf(() => apply(done.state, op({ code: 'teamswitch-execution-failed', reason: 'timeout' })))
		expect(rejection.code).toBe('noop')
	})
})

describe('reducer save trigger', () => {
	const triggerOf = (sideEffects: TSW.SideEffect[]) => sideEffects.find(se => se.code === 'save')?.trigger

	it('marks an admin save as a user edit', () => {
		const state = stateWith([['a', 'A']])
		state.editedSwitches = new Map([['a', { toTeam: 'B', source: SOURCE }]])
		expect(triggerOf(apply(state, op({ code: 'save', source: SOURCE })).sideEffects)).toBe('user-edit')
	})

	it('marks a map-roll execution as executed, with nobody to attribute it to', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const save = apply(state, op({ code: 'execute-teamswitches' })).sideEffects.find(se => se.code === 'save')
		expect(save?.trigger).toBe('executed')
		expect(save?.source).toBeUndefined()
	})

	it('attributes a manual execution to the admin who fired it', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const save = apply(state, op({ code: 'execute-teamswitches', source: SOURCE })).sideEffects.find(se => se.code === 'save')
		expect(save?.trigger).toBe('executed')
		expect(save?.source).toEqual(SOURCE)
	})

	// an immediate switch is a TEAM_CHANGE_FORCED, not a queue execution: the server skips the app event for it, so
	// it doesn't double-log the same switch
	it('marks an immediate switch of a queued player as switched-now', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		const switches: TSW.TeamswitchCollection = new Map([['a', { toTeam: 'B' as MH.NormedTeamId, source: SOURCE }]])
		expect(triggerOf(apply(state, op({ code: 'switch-now', switches, source: SOURCE })).sideEffects)).toBe('switched-now')
	})

	it('marks a switch dropped by a disconnect as a roster change', () => {
		const state = stateWith([['a', 'A']], [['a', 'B']])
		expect(triggerOf(apply(state, op({ code: 'player-left', playerId: 'a' })).sideEffects)).toBe('roster-change')
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
