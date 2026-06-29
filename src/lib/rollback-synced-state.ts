import * as Arr from '@/lib/array'

export type OpId = string
export type BaseOp = {
	opId: OpId
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

export type OnSideEffect<SE extends SideEffectBase> = (sideEffect: SE) => void

export type Reducer<O extends BaseOp, S, SE extends SideEffectBase = undefined> = (
	state: S,
	ops: O[],
	prevOps: O[],
	onSideEffect?: OnSideEffect<SE>,
) => S

export namespace Server {
	export type Session<O extends BaseOp, S, SE extends SideEffectBase = undefined> = {
		state: S
		ops: O[]
		onSideEffect?: OnSideEffect<SE>
	}

	export function initSession<O extends BaseOp, S, SE extends SideEffectBase = undefined>(
		state: S,
		opts?: { onSideEffect?: OnSideEffect<SE> },
	): Session<O, S, SE> {
		return { state, ops: [], onSideEffect: opts?.onSideEffect }
	}

	export function applyOps<O extends BaseOp, S, SE extends SideEffectBase = undefined>(
		session: Session<O, S, SE>,
		ops: O[],
		reducer: Reducer<O, S, SE>,
		opts?: { onSideEffect?: OnSideEffect<SE> },
	): Session<O, S, SE> {
		if (ops.length === 0) return session
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in ops')
		const existingIds = new Set(session.ops.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingIds.has(id)) throw new Error(`Duplicate opId already in session: ${id}`)
		}
		return {
			state: reducer(session.state, ops, session.ops, opts?.onSideEffect ?? session.onSideEffect),
			ops: OpHistory.concat(session.ops, ops),
		}
	}

	export function resetSession<O extends BaseOp, S, SE extends SideEffectBase = undefined>(
		_session: Session<O, S, SE>,
		state: S,
	): Session<O, S, SE> {
		return { state, ops: [] }
	}
}

export namespace Client {
	export type Session<O extends BaseOp, S, SE extends SideEffectBase = undefined> = {
		syncedState: S
		syncedOps: O[]
		localState: S
		pendingOps: O[]
		onSideEffect?: OnSideEffect<SE>
	}

	export function initSession<O extends BaseOp, S, SE extends SideEffectBase = undefined>(
		state: S,
		opts?: { onSideEffect?: OnSideEffect<SE>; ops?: O[] },
	): Session<O, S, SE> {
		return {
			syncedOps: opts?.ops ?? [],
			syncedState: state,
			localState: state,
			pendingOps: [],
			onSideEffect: opts?.onSideEffect,
		} as Session<O, S, SE>
	}

	export function processIncomingOps<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S, SE>,
		ops: O[],
		reducer: Reducer<O, S, SE>,
	): Session<O, S, SE> {
		if (ops.length === 0) throw new Error('No ops to process')
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in incoming server ops')
		const existingSyncedIds = new Set(session.syncedOps.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingSyncedIds.has(id)) throw new Error(`Duplicate opId already in syncedOps: ${id}`)
		}

		const prevSyncedOps = session.syncedOps
		const newSyncedState = reducer(session.syncedState, ops, prevSyncedOps, session.onSideEffect)
		const newSyncedOps = [...prevSyncedOps, ...ops]

		const newSyncedOpIds = newSyncedOps.map(op => op.opId)
		const pendingOpIds = session.pendingOps.map(op => op.opId)
		const truncatedNewSyncedOps = OpHistory.truncate(newSyncedOps)

		// wait for client to be completely caught up before rolling back. In other words we don't try to reconcile diverging histories until the synced history is fully caught up to the local history
		if (Arr.isSubset(newSyncedOpIds, pendingOpIds)) {
			return {
				syncedState: newSyncedState,
				syncedOps: truncatedNewSyncedOps,
				localState: newSyncedState,
				pendingOps: [],
			}
		}

		return {
			...session,
			syncedState: newSyncedState,
			syncedOps: truncatedNewSyncedOps,
		}
	}

	export function localOps<O extends BaseOp, S, SE extends SideEffectBase>(session: Session<O, S, SE>): O[] {
		return [...session.syncedOps, ...session.pendingOps]
	}

	export function processOutgoingOps<O extends BaseOp, S, SE extends SideEffectBase>(
		session: Session<O, S, SE>,
		ops: O[],
		reducer: Reducer<O, S, SE>,
	): Session<O, S, SE> {
		if (ops.length === 0) throw new Error('No ops to process')
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in incoming client ops')
		const existingPendingIds = new Set(session.pendingOps.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingPendingIds.has(id)) throw new Error(`Duplicate opId already in pendingOps: ${id}`)
		}

		const prevLocalOps = [...session.syncedOps, ...session.pendingOps]
		return {
			...session,
			localState: reducer(session.localState, ops, prevLocalOps /* no side effects until we're synced */),
			pendingOps: OpHistory.concat(session.pendingOps, ops),
		}
	}
}
