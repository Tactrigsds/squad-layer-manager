import { describe, expect, it } from 'vitest'

import { Client, type Reducer, RejectedError, Server } from './odsm'

type Op = { opId: string; value: number }
type State = number[]

// Reducer simply appends each op's value to the state array; produces no side effects
const reducer: Reducer<Op, State> = (state, ops) => [[...state, ...ops.map(op => op.value)], []]

const op = (opId: string, value = 0): Op => ({ opId, value })

describe('initSession', () => {
	it('initializes with provided state', () => {
		let session = Client.initSession<Op, State>([1, 2])
		expect(session.syncedState).toEqual([1, 2])
		expect(session.localState).toEqual([1, 2])
		expect(session.syncedOps).toEqual([])
		expect(session.pendingOps).toEqual([])
	})
})

describe('processOutgoingOps', () => {
	it('advances localState and appends to pendingOps', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([op('a', 1)])
		expect(session.syncedState).toEqual([])
		expect(session.syncedOps).toEqual([])
	})

	it('accumulates multiple outgoing op batches', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		session = Client.processOutgoingOps(session, [op('b', 2)], reducer).session
		expect(session.localState).toEqual([1, 2])
		expect(session.pendingOps).toEqual([op('a', 1), op('b', 2)])
	})

	it('throws on empty ops', () => {
		let session = Client.initSession<Op, State>([])
		expect(() => Client.processOutgoingOps(session, [], reducer)).toThrow('No ops to process')
	})

	it('throws on duplicate opId within the batch', () => {
		let session = Client.initSession<Op, State>([])
		expect(() => Client.processOutgoingOps(session, [op('a', 1), op('a', 2)], reducer)).toThrow()
	})

	it('throws on opId already in pendingOps', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		expect(() => Client.processOutgoingOps(session, [op('a', 2)], reducer)).toThrow('Duplicate opId already in pendingOps: a')
	})
})

describe('processIncomingOps', () => {
	it('advances syncedState and appends to syncedOps', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processIncomingOps(session, [op('a', 1)], reducer).session
		expect(session.syncedState).toEqual([1])
		expect(session.syncedOps).toEqual([op('a', 1)])
	})

	it('throws on empty ops', () => {
		let session = Client.initSession<Op, State>([])
		expect(() => Client.processIncomingOps(session, [], reducer)).toThrow('No ops to process')
	})

	it('throws on duplicate opId within the batch', () => {
		let session = Client.initSession<Op, State>([])
		expect(() => Client.processIncomingOps(session, [op('a', 1), op('a', 2)], reducer)).toThrow()
	})

	it('throws on opId already in syncedOps', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processIncomingOps(session, [op('a', 1)], reducer).session
		expect(() => Client.processIncomingOps(session, [op('a', 2)], reducer)).toThrow('Duplicate opId already in syncedOps: a')
	})

	it('reconciles localState when no pending ops exist', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processIncomingOps(session, [op('a', 1)], reducer).session
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([])
	})
})

describe('optimistic update and reconciliation', () => {
	it('reconciles after pending op is confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		expect(session.localState).toEqual([1])

		session = Client.processIncomingOps(session, [op('a', 1)], reducer).session
		expect(session.syncedState).toEqual([1])
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([])
	})

	it('does not reconcile until all pending ops are confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		session = Client.processOutgoingOps(session, [op('b', 2)], reducer).session

		// Server confirms only 'a' — 'b' still pending, so pendingOps is unchanged (no partial clearing)
		session = Client.processIncomingOps(session, [op('a', 1)], reducer).session
		expect(session.pendingOps).toEqual([op('a', 1), op('b', 2)])
		expect(session.localState).toEqual([1, 2]) // optimistic view unchanged
		expect(session.syncedState).toEqual([1])

		// Server confirms 'b' — now fully caught up
		session = Client.processIncomingOps(session, [op('b', 2)], reducer).session
		expect(session.pendingOps).toEqual([])
		expect(session.localState).toEqual([1, 2])
		expect(session.syncedState).toEqual([1, 2])
	})

	it('keeps localState optimistic while other clients ops arrive', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer).session

		// Another client's op arrives — localState should NOT update yet
		session = Client.processIncomingOps(session, [op('theirs', 99)], reducer).session
		expect(session.localState).toEqual([10]) // still optimistic
		expect(session.syncedState).toEqual([99])
		expect(session.pendingOps).toEqual([op('mine', 10)])
	})

	it('snaps localState to syncedState (including other clients ops) once all pending are confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer).session

		// Other client op arrives, then ours is confirmed
		session = Client.processIncomingOps(session, [op('theirs', 99)], reducer).session
		session = Client.processIncomingOps(session, [op('mine', 10)], reducer).session

		expect(session.syncedState).toEqual([99, 10])
		expect(session.localState).toEqual([99, 10]) // snapped to server order
		expect(session.pendingOps).toEqual([])
	})

	it('confirms multiple pending ops in a single server batch', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1), op('b', 2)], reducer).session

		session = Client.processIncomingOps(session, [op('a', 1), op('b', 2)], reducer).session
		expect(session.pendingOps).toEqual([])
		expect(session.localState).toEqual([1, 2])
	})

	it('localState continues to track syncedState when there are no pending ops', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processIncomingOps(session, [op('a', 1)], reducer).session
		session = Client.processIncomingOps(session, [op('b', 2)], reducer).session
		expect(session.localState).toEqual([1, 2])
		expect(session.syncedState).toEqual([1, 2])
	})
})

describe('processAckedOps', () => {
	it('advances syncedState by replaying the acked pending op', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		session = Client.processAckedOps(session, ['a'], reducer).session
		expect(session.syncedState).toEqual([1])
		expect(session.syncedOps).toEqual([op('a', 1)])
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([])
	})

	it('preserves localState identity when the ack matches the optimistic state', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		const optimisticLocalState = session.localState
		session = Client.processAckedOps(session, ['a'], reducer).session
		expect(session.localState).toBe(optimisticLocalState)
	})

	it('does not reconcile until all pending ops are confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		session = Client.processOutgoingOps(session, [op('b', 2)], reducer).session
		const optimisticLocalState = session.localState

		session = Client.processAckedOps(session, ['a'], reducer).session
		expect(session.pendingOps).toEqual([op('b', 2)])
		expect(session.syncedState).toEqual([1])
		expect(session.localState).toBe(optimisticLocalState) // optimistic view untouched

		session = Client.processAckedOps(session, ['b'], reducer).session
		expect(session.pendingOps).toEqual([])
		expect(session.syncedState).toEqual([1, 2])
		expect(session.localState).toBe(optimisticLocalState) // caught up + deep-equal -- reference preserved
	})

	it('snaps localState to server order when another clients op interleaved', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer).session
		session = Client.processIncomingOps(session, [op('theirs', 99)], reducer).session
		const optimisticLocalState = session.localState

		session = Client.processAckedOps(session, ['mine'], reducer).session
		expect(session.syncedState).toEqual([99, 10])
		expect(session.localState).toEqual([99, 10])
		expect(session.localState).not.toBe(optimisticLocalState) // diverged -- must be replaced
		expect(session.pendingOps).toEqual([])
	})

	it('throws on empty ops', () => {
		let session = Client.initSession<Op, State>([])
		expect(() => Client.processAckedOps(session, [], reducer)).toThrow('No ops to process')
	})

	it('throws when the acked op is not pending', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		expect(() => Client.processAckedOps(session, ['b'], reducer)).toThrow('Acked ops not in pendingOps: b')
	})
})

describe('processAcks', () => {
	it('acks pending ops and returns them', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer).session
		const res = Client.processAcks(session, ['a'], reducer)
		expect(res.session.syncedState).toEqual([1])
		expect(res.session.pendingOps).toEqual([])
		expect(res.ackedOps).toEqual([op('a', 1)])
		expect(res.unknownOpIds).toEqual([])
	})

	it('skips ops an init snapshot already incorporated, keeping session identity', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer).session
		// snapshot taken after the server applied our op -- processInit drops it from pendingOps
		session = Client.processInit(session, [10], [op('mine', 10)], reducer)

		const res = Client.processAcks(session, ['mine'], reducer)
		expect(res.session).toBe(session)
		expect(res.ackedOps).toEqual([])
		expect(res.unknownOpIds).toEqual([])
	})

	it('reports ids in neither pendingOps nor syncedOps as unknown', () => {
		let session = Client.initSession<Op, State>([])
		const res = Client.processAcks(session, ['ghost'], reducer)
		expect(res.session).toBe(session)
		expect(res.unknownOpIds).toEqual(['ghost'])
	})

	it('acks the pending subset of a mixed batch', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1), op('b', 2)], reducer).session
		// init incorporated 'a' but raced ahead of 'b'
		session = Client.processInit(session, [1], [op('a', 1)], reducer)

		const res = Client.processAcks(session, ['a', 'b', 'ghost'], reducer)
		expect(res.session.syncedState).toEqual([1, 2])
		expect(res.session.pendingOps).toEqual([])
		expect(res.ackedOps).toEqual([op('b', 2)])
		expect(res.unknownOpIds).toEqual(['ghost'])
	})
})

describe('processInit', () => {
	it('adopts the snapshot when nothing is pending', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processInit(session, [1, 2], [op('a', 1), op('b', 2)], reducer)
		expect(session.syncedState).toEqual([1, 2])
		expect(session.localState).toEqual([1, 2])
		expect(session.syncedOps).toEqual([op('a', 1), op('b', 2)])
		expect(session.pendingOps).toEqual([])
	})

	it('rebases in-flight pending ops the snapshot does not include', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer).session

		// init snapshot from a reconnect that raced our dispatch
		session = Client.processInit(session, [1], [op('a', 1)], reducer)
		expect(session.syncedState).toEqual([1])
		expect(session.localState).toEqual([1, 10]) // pending op reapplied on top of the snapshot
		expect(session.pendingOps).toEqual([op('mine', 10)])

		// the ack that follows still resolves
		session = Client.processAckedOps(session, ['mine'], reducer).session
		expect(session.syncedState).toEqual([1, 10])
		expect(session.localState).toEqual([1, 10])
		expect(session.pendingOps).toEqual([])
	})

	it('drops pending ops the snapshot already includes', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer).session

		// snapshot was taken after the server applied our op -- no ack will follow
		session = Client.processInit(session, [10], [op('mine', 10)], reducer)
		expect(session.syncedState).toEqual([10])
		expect(session.localState).toEqual([10])
		expect(session.pendingOps).toEqual([])
	})
})

describe('Server.initSession', () => {
	it('initializes with provided state and empty ops', () => {
		let session = Server.initSession<Op, State>([1, 2])
		expect(session.state).toEqual([1, 2])
		expect(session.ops).toEqual([])
	})
})

describe('Server.applyOps', () => {
	it('advances state and appends ops', () => {
		let session = Server.initSession<Op, State>([])
		session = Server.applyOps(session, [op('a', 1)], reducer).session
		expect(session.state).toEqual([1])
		expect(session.ops).toEqual([op('a', 1)])
	})

	it('accumulates across multiple calls', () => {
		let session = Server.initSession<Op, State>([])
		session = Server.applyOps(session, [op('a', 1)], reducer).session
		session = Server.applyOps(session, [op('b', 2)], reducer).session
		expect(session.state).toEqual([1, 2])
		expect(session.ops).toEqual([op('a', 1), op('b', 2)])
	})

	it('throws on duplicate opId within the batch', () => {
		let session = Server.initSession<Op, State>([])
		expect(() => Server.applyOps(session, [op('a', 1), op('a', 2)], reducer)).toThrow()
	})

	it('throws on opId already in session', () => {
		let session = Server.initSession<Op, State>([])
		session = Server.applyOps(session, [op('a', 1)], reducer).session
		expect(() => Server.applyOps(session, [op('a', 2)], reducer)).toThrow('Duplicate opId already in session: a')
	})
})

describe('Server.resetSession', () => {
	it('replaces state and clears ops', () => {
		let session = Server.initSession<Op, State>([])
		session = Server.applyOps(session, [op('a', 1), op('b', 2)], reducer).session
		session = Server.resetSession(session, [99])
		expect(session.state).toEqual([99])
		expect(session.ops).toEqual([])
	})
})

describe('RejectedError', () => {
	type Rejection = { code: 'would-empty' }
	// throws to reject any batch that would drive the state length <= 0 against its base, carrying a
	// typed payload; otherwise appends. produces no side effects.
	const gatedReducer: Reducer<Op, State> = (state, ops) => {
		if (ops.some(op => state.length + op.value <= 0)) throw new RejectedError<Rejection>({ code: 'would-empty' })
		return [[...state, ...ops.map(op => op.value)], []]
	}

	it('drops a client-authored op the reducer rejects and returns the typed rejection', () => {
		const session = Client.initSession<Op, State>([1])
		const res = Client.processOutgoingOps(session, [op('a', -5)], gatedReducer)
		expect(res.rejected).toBe(true)
		if (!res.rejected) throw new Error('expected rejection')
		expect(res.session).toBe(session) // session unchanged: op dropped, never sent
		expect(res.session.pendingOps).toEqual([]) // never queued
		expect(res.session.localState).toEqual([1]) // no optimistic change
		expect(res.error).toBeInstanceOf(RejectedError)
		expect((res.error.data as Rejection).code).toBe('would-empty') // reactable typed data
	})

	it('applies and queues a client-authored op the reducer accepts', () => {
		const session = Client.initSession<Op, State>([1])
		const res = Client.processOutgoingOps(session, [op('a', 2)], gatedReducer)
		expect(res.rejected).toBe(false)
		if (res.rejected) throw new Error('expected accept')
		expect(res.session.localState).toEqual([1, 2])
		expect(res.session.pendingOps).toEqual([op('a', 2)])
	})

	it('server keeps a rejected op in history as a state no-op and returns the rejection', () => {
		const session = Server.initSession<Op, State>([1])
		const baseState = session.state
		const res = Server.applyOps(session, [op('a', -5)], gatedReducer)
		expect(res.rejected).toBe(true)
		if (!res.rejected) throw new Error('expected rejection')
		expect(res.session.state).toBe(baseState) // no state change, same reference
		expect(res.session.ops).toEqual([op('a', -5)]) // still recorded so it broadcasts/acks coherently
		expect((res.error.data as Rejection).code).toBe('would-empty')
	})

	it('leaves syncedState untouched on an incoming rejected op but still records it', () => {
		let session = Client.initSession<Op, State>([1])
		const base = session.syncedState
		session = Client.processIncomingOps(session, [op('a', -5)], gatedReducer).session
		expect(session.syncedState).toBe(base)
		expect(session.syncedOps).toEqual([op('a', -5)])
	})

	it('keeps an in-flight pending op when rebasing onto a snapshot it rejects against', () => {
		// author an op that is accepted against the current local base ([10, 20]) and stays pending
		let session = Client.initSession<Op, State>([10, 20])
		session = Client.processOutgoingOps(session, [op('mine', -1)], gatedReducer).session
		expect(session.pendingOps).toEqual([op('mine', -1)])

		// a reconnect snapshot ([] , no ops) races the ack; replaying 'mine' onto [] rejects, but the
		// op must be kept queued so its ack still resolves rather than being orphaned
		session = Client.processInit(session, [], [], gatedReducer)
		expect(session.syncedState).toEqual([])
		expect(session.localState).toEqual([]) // rebased op rejected -> no optimistic change
		expect(session.pendingOps).toEqual([op('mine', -1)]) // still queued
	})

	it('returns side effects from an accepted batch but only on the non-rejected branch', () => {
		type SE = { code: string }
		// produces a side effect per op, then rejects if any value is negative
		const effectReducer: Reducer<Op, State, SE> = (state, ops) => {
			const ses = ops.map((o): SE => ({ code: `applied-${o.opId}` }))
			if (ops.some(o => o.value < 0)) throw new RejectedError<Rejection>({ code: 'would-empty' })
			return [[...state, ...ops.map(o => o.value)], ses]
		}
		const session = Server.initSession<Op, State>([])

		const accepted = Server.applyOps(session, [op('a', 1)], effectReducer)
		expect(accepted.rejected).toBe(false)
		if (accepted.rejected) throw new Error('expected accept')
		expect(accepted.sideEffects).toEqual([{ code: 'applied-a' }]) // accepted -> side effects returned

		const rejectedRes = Server.applyOps(accepted.session, [op('b', -1)], effectReducer)
		expect(rejectedRes.rejected).toBe(true) // rejected branch has no `sideEffects` field at all
		expect(rejectedRes.session.ops.map(o => o.opId)).toEqual(['a', 'b']) // op still recorded
	})
})
