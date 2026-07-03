import { describe, expect, it } from 'vitest'

import { Client, type Reducer, Server } from './rollback-synced-state'

type Op = { opId: string; value: number }
type State = number[]

// Reducer simply appends each op's value to the state array
const reducer: Reducer<Op, State> = (state, ops) => [...state, ...ops.map(op => op.value)]

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
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([op('a', 1)])
		expect(session.syncedState).toEqual([])
		expect(session.syncedOps).toEqual([])
	})

	it('accumulates multiple outgoing op batches', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		session = Client.processOutgoingOps(session, [op('b', 2)], reducer)
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
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		expect(() => Client.processOutgoingOps(session, [op('a', 2)], reducer)).toThrow('Duplicate opId already in pendingOps: a')
	})
})

describe('processIncomingOps', () => {
	it('advances syncedState and appends to syncedOps', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processIncomingOps(session, [op('a', 1)], reducer)
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
		session = Client.processIncomingOps(session, [op('a', 1)], reducer)
		expect(() => Client.processIncomingOps(session, [op('a', 2)], reducer)).toThrow('Duplicate opId already in syncedOps: a')
	})

	it('reconciles localState when no pending ops exist', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processIncomingOps(session, [op('a', 1)], reducer)
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([])
	})
})

describe('optimistic update and reconciliation', () => {
	it('reconciles after pending op is confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		expect(session.localState).toEqual([1])

		session = Client.processIncomingOps(session, [op('a', 1)], reducer)
		expect(session.syncedState).toEqual([1])
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([])
	})

	it('does not reconcile until all pending ops are confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		session = Client.processOutgoingOps(session, [op('b', 2)], reducer)

		// Server confirms only 'a' — 'b' still pending, so pendingOps is unchanged (no partial clearing)
		session = Client.processIncomingOps(session, [op('a', 1)], reducer)
		expect(session.pendingOps).toEqual([op('a', 1), op('b', 2)])
		expect(session.localState).toEqual([1, 2]) // optimistic view unchanged
		expect(session.syncedState).toEqual([1])

		// Server confirms 'b' — now fully caught up
		session = Client.processIncomingOps(session, [op('b', 2)], reducer)
		expect(session.pendingOps).toEqual([])
		expect(session.localState).toEqual([1, 2])
		expect(session.syncedState).toEqual([1, 2])
	})

	it('keeps localState optimistic while other clients ops arrive', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer)

		// Another client's op arrives — localState should NOT update yet
		session = Client.processIncomingOps(session, [op('theirs', 99)], reducer)
		expect(session.localState).toEqual([10]) // still optimistic
		expect(session.syncedState).toEqual([99])
		expect(session.pendingOps).toEqual([op('mine', 10)])
	})

	it('snaps localState to syncedState (including other clients ops) once all pending are confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer)

		// Other client op arrives, then ours is confirmed
		session = Client.processIncomingOps(session, [op('theirs', 99)], reducer)
		session = Client.processIncomingOps(session, [op('mine', 10)], reducer)

		expect(session.syncedState).toEqual([99, 10])
		expect(session.localState).toEqual([99, 10]) // snapped to server order
		expect(session.pendingOps).toEqual([])
	})

	it('confirms multiple pending ops in a single server batch', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1), op('b', 2)], reducer)

		session = Client.processIncomingOps(session, [op('a', 1), op('b', 2)], reducer)
		expect(session.pendingOps).toEqual([])
		expect(session.localState).toEqual([1, 2])
	})

	it('localState continues to track syncedState when there are no pending ops', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processIncomingOps(session, [op('a', 1)], reducer)
		session = Client.processIncomingOps(session, [op('b', 2)], reducer)
		expect(session.localState).toEqual([1, 2])
		expect(session.syncedState).toEqual([1, 2])
	})
})

describe('processAckedOps', () => {
	it('advances syncedState by replaying the acked pending op', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		session = Client.processAckedOps(session, ['a'], reducer)
		expect(session.syncedState).toEqual([1])
		expect(session.syncedOps).toEqual([op('a', 1)])
		expect(session.localState).toEqual([1])
		expect(session.pendingOps).toEqual([])
	})

	it('preserves localState identity when the ack matches the optimistic state', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		const optimisticLocalState = session.localState
		session = Client.processAckedOps(session, ['a'], reducer)
		expect(session.localState).toBe(optimisticLocalState)
	})

	it('does not reconcile until all pending ops are confirmed', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		session = Client.processOutgoingOps(session, [op('b', 2)], reducer)
		const optimisticLocalState = session.localState

		session = Client.processAckedOps(session, ['a'], reducer)
		expect(session.pendingOps).toEqual([op('b', 2)])
		expect(session.syncedState).toEqual([1])
		expect(session.localState).toBe(optimisticLocalState) // optimistic view untouched

		session = Client.processAckedOps(session, ['b'], reducer)
		expect(session.pendingOps).toEqual([])
		expect(session.syncedState).toEqual([1, 2])
		expect(session.localState).toBe(optimisticLocalState) // caught up + deep-equal -- reference preserved
	})

	it('snaps localState to server order when another clients op interleaved', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer)
		session = Client.processIncomingOps(session, [op('theirs', 99)], reducer)
		const optimisticLocalState = session.localState

		session = Client.processAckedOps(session, ['mine'], reducer)
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
		session = Client.processOutgoingOps(session, [op('a', 1)], reducer)
		expect(() => Client.processAckedOps(session, ['b'], reducer)).toThrow('Acked ops not in pendingOps: b')
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
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer)

		// init snapshot from a reconnect that raced our dispatch
		session = Client.processInit(session, [1], [op('a', 1)], reducer)
		expect(session.syncedState).toEqual([1])
		expect(session.localState).toEqual([1, 10]) // pending op reapplied on top of the snapshot
		expect(session.pendingOps).toEqual([op('mine', 10)])

		// the ack that follows still resolves
		session = Client.processAckedOps(session, ['mine'], reducer)
		expect(session.syncedState).toEqual([1, 10])
		expect(session.localState).toEqual([1, 10])
		expect(session.pendingOps).toEqual([])
	})

	it('drops pending ops the snapshot already includes', () => {
		let session = Client.initSession<Op, State>([])
		session = Client.processOutgoingOps(session, [op('mine', 10)], reducer)

		// snapshot was taken after the server applied our op -- no ack will follow
		session = Client.processInit(session, [10], [op('mine', 10)], reducer)
		expect(session.syncedState).toEqual([10])
		expect(session.localState).toEqual([10])
		expect(session.pendingOps).toEqual([])
	})

	it('preserves onSideEffect from the previous session', () => {
		const sideEffects: undefined[] = []
		let session = Client.initSession<Op, State>([], { onSideEffect: se => sideEffects.push(se) })
		const onSideEffect = session.onSideEffect
		session = Client.processInit(session, [], [], reducer)
		expect(session.onSideEffect).toBe(onSideEffect)
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
		session = Server.applyOps(session, [op('a', 1)], reducer)
		expect(session.state).toEqual([1])
		expect(session.ops).toEqual([op('a', 1)])
	})

	it('accumulates across multiple calls', () => {
		let session = Server.initSession<Op, State>([])
		session = Server.applyOps(session, [op('a', 1)], reducer)
		session = Server.applyOps(session, [op('b', 2)], reducer)
		expect(session.state).toEqual([1, 2])
		expect(session.ops).toEqual([op('a', 1), op('b', 2)])
	})

	it('throws on duplicate opId within the batch', () => {
		let session = Server.initSession<Op, State>([])
		expect(() => Server.applyOps(session, [op('a', 1), op('a', 2)], reducer)).toThrow()
	})

	it('throws on opId already in session', () => {
		let session = Server.initSession<Op, State>([])
		session = Server.applyOps(session, [op('a', 1)], reducer)
		expect(() => Server.applyOps(session, [op('a', 2)], reducer)).toThrow('Duplicate opId already in session: a')
	})
})

describe('Server.resetSession', () => {
	it('replaces state and clears ops', () => {
		let session = Server.initSession<Op, State>([])
		session = Server.applyOps(session, [op('a', 1), op('b', 2)], reducer)
		session = Server.resetSession(session, [99])
		expect(session.state).toEqual([99])
		expect(session.ops).toEqual([])
	})
})
