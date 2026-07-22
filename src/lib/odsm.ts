// ODSM: Optimistic Distributed State Machine. A shared reducer-driven pseudo state machine that runs
// independently on the server and each client: clients apply ops optimistically and reconcile
// against the server's authoritative replay, while the server is just one more replica whose
// history is the one everyone else converges to.
import * as Arr from '@/lib/array'
import * as Obj from '@/lib/object'

export type OpId = string
export type BaseOp = {
	opId: OpId
}

// thrown by a reducer to reject the batch of ops it was handed. the batch produces no state change,
// and the typed `data` payload describes why -- callers surface it and react (show it to the user,
// return it to an rpc caller, log it). a rejected batch never enters a timeline: a client-authored
// batch is dropped before it is queued or sent, and a batch the server rejects touches neither its
// state nor its history, so no replica ever sees it -- the originating client is told instead, and
// drops its optimistic copy via dropPendingOps. because the same op is replayed against several base
// states (optimistic local, synced, server), a batch can be rejected against one and applied against
// another. ops passed together are dependent, so rejection is all-or-nothing for the batch.
export class RejectedError<T = unknown> extends Error {
	readonly data: T
	constructor(data: T, options?: ErrorOptions & { message?: string }) {
		super(options?.message ?? 'operation rejected', options)
		this.name = 'RejectedError'
		this.data = data
	}
}

type SideEffectBase = {
	// this doesn't necessarily have to align with opcode
	code: string
} | undefined

namespace OpHistory {
	// once the history reaches this size, we will always retain the last MAX_GUARANTEED ops. the rest may be discarded
	const MAX_GUARANTEED = 50
	const MAX_OVERFLOW = 25
	const MAX_LENGTH = MAX_GUARANTEED + MAX_OVERFLOW

	export function concat<O extends BaseOp>(history: O[], newOps: O[]): O[] {
		return truncate([...history, ...newOps])
	}

	export function truncate<O extends BaseOp>(history: O[]): O[] {
		if (history.length <= MAX_LENGTH) return history
		return history.slice(-MAX_GUARANTEED)
	}
}

// a helper callback a reducer can use internally to accumulate its side effects
export type OnSideEffect<SE extends SideEffectBase> = (sideEffect: SE) => void

// a reducer returns the next state paired with the side effects it produced. it must not perform side
// effects itself -- the caller decides what to do with them, and only ever sees them on a non-rejected
// result (see Applied). to reject a batch, throw RejectedError.
export type Reducer<O extends BaseOp, S, SE extends SideEffectBase = undefined> = (
	state: S,
	ops: O[],
	prevOps: O[],
) => readonly [state: S, sideEffects: SE[]]

// result of applying a batch of ops. side effects are only reachable on the non-rejected branch: a
// rejected batch changed no state and its accumulated side effects are discarded. the session is
// present on both branches, but on the rejected branch it is the caller's session unchanged.
export type Applied<Sess, SE extends SideEffectBase> =
	| { rejected: false; session: Sess; sideEffects: SE[] }
	| { rejected: true; session: Sess; error: RejectedError }

type ReduceResult<S, SE extends SideEffectBase> =
	| { rejected: true; error: RejectedError }
	| { rejected: false; state: S; sideEffects: SE[] }

// runs a reducer, catching RejectedError and otherwise returning the next state and the side effects
// it produced (the caller decides whether to deliver them)
function runReducer<O extends BaseOp, S, SE extends SideEffectBase>(
	reducer: Reducer<O, S, SE>,
	state: S,
	ops: O[],
	prevOps: O[],
): ReduceResult<S, SE> {
	let next: readonly [S, SE[]]
	try {
		next = reducer(state, ops, prevOps)
	} catch (error) {
		if (error instanceof RejectedError) return { rejected: true, error }
		throw error
	}
	const [nextState, sideEffects] = next
	return { rejected: false, state: nextState, sideEffects }
}

// pairs an already-built session with the rejection/side-effect outcome of the reducer run
function tag<Sess, S, SE extends SideEffectBase>(session: Sess, reduced: ReduceResult<S, SE>): Applied<Sess, SE> {
	if (reduced.rejected) return { rejected: true, session, error: reduced.error }
	return { rejected: false, session, sideEffects: reduced.sideEffects }
}

export namespace Server {
	export type Session<O extends BaseOp, S> = {
		state: S
		ops: O[]
	}

	export function initSession<O extends BaseOp, S>(state: S): Session<O, S> {
		return { state, ops: [] }
	}

	// applies ops on the authoritative server. a rejected batch is discarded whole: neither state nor
	// history moves, so it is never broadcast and late joiners never see it. the dispatcher reports the
	// rejection to the originating client (which drops its optimistic copy) and nobody else.
	export function applyOps<O extends BaseOp, S, SE extends SideEffectBase = undefined>(
		session: Session<O, S>,
		ops: O[],
		reducer: Reducer<O, S, SE>,
	): Applied<Session<O, S>, SE> {
		if (ops.length === 0) return { rejected: false, session, sideEffects: [] }
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in ops')
		const existingIds = new Set(session.ops.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingIds.has(id)) throw new Error(`Duplicate opId already in session: ${id}`)
		}
		const reduced = runReducer(reducer, session.state, ops, session.ops)
		if (reduced.rejected) return tag(session, reduced)
		return tag({ state: reduced.state, ops: OpHistory.concat(session.ops, ops) }, reduced)
	}

	export function resetSession<O extends BaseOp, S>(
		_session: Session<O, S>,
		state: S,
	): Session<O, S> {
		return { state, ops: [] }
	}
}

export namespace Client {
	export type Session<O extends BaseOp, S> = {
		syncedState: S
		syncedOps: O[]
		localState: S
		pendingOps: O[]
	}

	export function initSession<O extends BaseOp, S>(
		state: S,
		opts?: { ops?: O[] },
	): Session<O, S> {
		return {
			syncedOps: opts?.ops ?? [],
			syncedState: state,
			localState: state,
			pendingOps: [],
		}
	}

	// re-initializes the session from a fresh server snapshot while preserving locally-dispatched
	// ops that are still in flight -- an init can race the client's own dispatches (e.g. a stream
	// (re)connect while a dispatch is on the wire), and discarding them would orphan the acks that
	// follow. pending ops the snapshot already includes are dropped; the rest are rebased onto the
	// new state. rebasing is optimistic, so it emits no side effects.
	export function processInit<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S>,
		state: S,
		ops: O[],
		reducer: Reducer<O, S, SE>,
	): Session<O, S> {
		const syncedIds = new Set(ops.map(op => op.opId))
		const pendingOps = session.pendingOps.filter(op => !syncedIds.has(op.opId))
		const next = initSession<O, S>(state, { ops })
		if (pendingOps.length === 0) return next
		return rebasePendingOps(next, pendingOps, reducer)
	}

	export function processIncomingOps<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S>,
		ops: O[],
		reducer: Reducer<O, S, SE>,
	): Applied<Session<O, S>, SE> {
		if (ops.length === 0) throw new Error('No ops to process')
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in incoming server ops')
		const existingSyncedIds = new Set(session.syncedOps.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingSyncedIds.has(id)) throw new Error(`Duplicate opId already in syncedOps: ${id}`)
		}

		const prevSyncedOps = session.syncedOps
		// the server only broadcasts what it accepted, so a rejection here means this replica has diverged
		// from the authoritative one. the ops still enter history so op ids stay aligned, but synced state is
		// left untouched and the caller reports the divergence
		const reduced = runReducer(reducer, session.syncedState, ops, prevSyncedOps)
		const newSyncedState = reduced.rejected ? session.syncedState : reduced.state
		const newSyncedOps = [...prevSyncedOps, ...ops]

		const newSyncedOpIds = newSyncedOps.map(op => op.opId)
		const pendingOpIds = session.pendingOps.map(op => op.opId)
		const truncatedNewSyncedOps = OpHistory.truncate(newSyncedOps)

		// wait for client to be completely caught up before rolling back. In other words we don't try to reconcile diverging histories until the synced history is fully caught up to the local history
		const newSession: Session<O, S> = Arr.isSubset(newSyncedOpIds, pendingOpIds)
			? {
				syncedState: newSyncedState,
				syncedOps: truncatedNewSyncedOps,
				localState: newSyncedState,
				pendingOps: [],
			}
			: {
				...session,
				syncedState: newSyncedState,
				syncedOps: truncatedNewSyncedOps,
			}
		return tag(newSession, reduced)
	}

	// processes server acks for ops this client dispatched. the server only sends back opIds for the
	// originator's own ops -- since ops are fully deterministic, we advance the synced history by
	// replaying our own pending copies instead of receiving them over the wire again. an ack means the
	// server accepted the op, so a rejection replaying it is divergence (see processIncomingOps)
	export function processAckedOps<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S>,
		opIds: OpId[],
		reducer: Reducer<O, S, SE>,
	): Applied<Session<O, S>, SE> {
		if (opIds.length === 0) throw new Error('No ops to process')
		const ackedIdSet = new Set(opIds)
		if (ackedIdSet.size !== opIds.length) throw new Error('Duplicate opIds in acked ops')
		const ackedOps = session.pendingOps.filter(op => ackedIdSet.has(op.opId))
		if (ackedOps.length !== opIds.length) {
			const missing = opIds.filter(id => !session.pendingOps.some(op => op.opId === id))
			throw new Error(`Acked ops not in pendingOps: ${missing.join(', ')}`)
		}

		const reduced = runReducer(reducer, session.syncedState, ackedOps, session.syncedOps)
		const newSyncedState = reduced.rejected ? session.syncedState : reduced.state
		const newSyncedOps = OpHistory.concat(session.syncedOps, ackedOps)
		const pendingOps = session.pendingOps.filter(op => !ackedIdSet.has(op.opId))

		// same policy as processIncomingOps: don't reconcile diverging histories until the synced
		// history has fully caught up to the local history
		const newSession: Session<O, S> = pendingOps.length > 0
			? { ...session, syncedState: newSyncedState, syncedOps: newSyncedOps, pendingOps }
			: {
				syncedState: newSyncedState,
				syncedOps: newSyncedOps,
				// deterministic replay means the canonical state normally equals the optimistic state we're
				// already displaying -- keep the existing reference then, so downstream identity guards
				// (derived store props, query dep keys) don't fire for a no-op update
				localState: Obj.deepEqual(newSyncedState, session.localState) ? session.localState : newSyncedState,
				pendingOps: [],
			}
		return tag(newSession, reduced)
	}

	// tolerant wrapper over processAckedOps: around reconnects an ack can straddle an init snapshot
	// that already incorporated some of the acked ops (processInit drops those from pendingOps) --
	// those ids are skipped instead of throwing, and the rest of the batch is still acked. ids in
	// neither pendingOps nor syncedOps indicate a genuine protocol problem and are returned as
	// unknownOpIds for the caller to report
	export function processAcks<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S>,
		opIds: OpId[],
		reducer: Reducer<O, S, SE>,
	): Applied<Session<O, S>, SE> & { ackedOps: O[]; unknownOpIds: OpId[] } {
		const pendingIds = new Set(session.pendingOps.map(op => op.opId))
		const syncedIds = new Set(session.syncedOps.map(op => op.opId))
		const unknownOpIds = opIds.filter(id => !pendingIds.has(id) && !syncedIds.has(id))
		const pendingAckedIds = opIds.filter(id => pendingIds.has(id))
		if (pendingAckedIds.length === 0) return { rejected: false, session, sideEffects: [], ackedOps: [], unknownOpIds }
		const pendingAckedIdSet = new Set(pendingAckedIds)
		const ackedOps = session.pendingOps.filter(op => pendingAckedIdSet.has(op.opId))
		const applied = processAckedOps(session, pendingAckedIds, reducer)
		if (applied.rejected) return { rejected: true, session: applied.session, error: applied.error, ackedOps, unknownOpIds }
		return { rejected: false, session: applied.session, sideEffects: applied.sideEffects, ackedOps, unknownOpIds }
	}

	// drops ops the server refused (a `rejected` message, permission denied, a dispatch that never landed) and
	// replays what is left of the local timeline. a pending op that is never acked is not merely a lost edit: until
	// pendingOps drains, processIncomingOps/processAckedOps refuse to adopt the synced state, so every later
	// server update -- including the saves that clear mutation state -- stops reaching localState entirely.
	export function dropPendingOps<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S>,
		opIds: OpId[],
		reducer: Reducer<O, S, SE>,
	): Session<O, S> {
		const droppedIds = new Set(opIds)
		const pendingOps = session.pendingOps.filter(op => !droppedIds.has(op.opId))
		if (pendingOps.length === session.pendingOps.length) return session
		if (pendingOps.length === 0) return { ...session, localState: session.syncedState, pendingOps }
		const reduced = runReducer(reducer, session.syncedState, pendingOps, session.syncedOps)
		return {
			...session,
			localState: reduced.rejected ? session.syncedState : reduced.state,
			pendingOps,
		}
	}

	export function localOps<O extends BaseOp, S>(session: Session<O, S>): O[] {
		return [...session.syncedOps, ...session.pendingOps]
	}

	// shared validation for ops entering the local (client) timeline
	function assertOutgoing<O extends BaseOp, S>(session: Session<O, S>, ops: O[]): void {
		if (ops.length === 0) throw new Error('No ops to process')
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in incoming client ops')
		const existingPendingIds = new Set(session.pendingOps.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingPendingIds.has(id)) throw new Error(`Duplicate opId already in pendingOps: ${id}`)
		}
	}

	// replays already-in-flight pending ops onto the local timeline, coalescing a rejected batch to a
	// state no-op but KEEPING the ops queued. used by processInit when rebasing pending ops onto a
	// fresh snapshot: the client already authored and sent those ops and is awaiting their acks, so a
	// transient rejection against the snapshot base must not discard them. optimistic -> no side effects.
	function rebasePendingOps<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S>,
		ops: O[],
		reducer: Reducer<O, S, SE>,
	): Session<O, S> {
		assertOutgoing(session, ops)
		const prevLocalOps = [...session.syncedOps, ...session.pendingOps]
		const reduced = runReducer(reducer, session.localState, ops, prevLocalOps)
		return {
			...session,
			localState: reduced.rejected ? session.localState : reduced.state,
			pendingOps: OpHistory.concat(session.pendingOps, ops),
		}
	}

	// the client authors brand-new ops. unlike ops that arrive over the wire (kept in history even when
	// they reduce to a no-op), a batch the reducer REJECTS against the current local state is dropped
	// entirely: not applied, not queued, and not sent -- the `error` is returned so the dispatcher can
	// react (surface it to the user, log it) and skip the network send. this keeps client-authored
	// no-op ops out of every history. an accepted batch is applied optimistically and queued to send.
	// the optimistic apply produces no side effects (they fire when the op lands on the synced timeline),
	// so there are no side effects to return here.
	export function processOutgoingOps<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S>,
		ops: O[],
		reducer: Reducer<O, S, SE>,
	): { rejected: false; session: Session<O, S> } | { rejected: true; session: Session<O, S>; error: RejectedError } {
		assertOutgoing(session, ops)
		const prevLocalOps = [...session.syncedOps, ...session.pendingOps]
		const reduced = runReducer(reducer, session.localState, ops, prevLocalOps)
		if (reduced.rejected) return { rejected: true, session, error: reduced.error }
		return {
			rejected: false,
			session: {
				...session,
				localState: reduced.state,
				pendingOps: OpHistory.concat(session.pendingOps, ops),
			},
		}
	}
}
