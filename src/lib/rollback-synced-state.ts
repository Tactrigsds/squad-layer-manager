import * as Arr from '@/lib/array'

type OpId = string
type BaseOp = {
	opId: OpId
}

export type Reducer<O extends BaseOp, S> = (state: S, ops: O[], prevOps: O[]) => S

export namespace Server {
	export type Session<O extends BaseOp, S> = {
		state: S
		ops: O[]
	}

	export function initSession<O extends BaseOp, S>(state: S): Session<O, S> {
		return { state, ops: [] }
	}

	export function applyOps<O extends BaseOp, S>(session: Session<O, S>, ops: O[], reducer: Reducer<O, S>): Session<O, S> {
		if (ops.length === 0) throw new Error('No ops to apply')
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in ops')
		const existingIds = new Set(session.ops.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingIds.has(id)) throw new Error(`Duplicate opId already in session: ${id}`)
		}
		return {
			state: reducer(session.state, ops, session.ops),
			ops: [...session.ops, ...ops],
		}
	}

	export function resetSession<O extends BaseOp, S>(_session: Session<O, S>, state: S): Session<O, S> {
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

	export function initSession<O extends BaseOp, S>(state: S): Session<O, S> {
		return {
			syncedOps: [],
			syncedState: state,
			localState: state,
			pendingOps: [],
		} as Session<O, S>
	}

	export function processIncomingOps<O extends BaseOp, S>(session: Session<O, S>, ops: O[], reducer: Reducer<O, S>): Session<O, S> {
		if (ops.length === 0) throw new Error('No ops to process')
		const incomingIds = ops.map(op => op.opId)
		const incomingIdSet = new Set(incomingIds)
		if (incomingIdSet.size !== incomingIds.length) throw new Error('Duplicate opIds in incoming server ops')
		const existingSyncedIds = new Set(session.syncedOps.map(op => op.opId))
		for (const id of incomingIds) {
			if (existingSyncedIds.has(id)) throw new Error(`Duplicate opId already in syncedOps: ${id}`)
		}

		const prevSyncedOps = session.syncedOps
		const newSyncedState = reducer(session.syncedState, ops, prevSyncedOps)
		const newSyncedOps = [...prevSyncedOps, ...ops]

		const newSyncedOpIds = newSyncedOps.map(op => op.opId)
		const pendingOpIds = session.pendingOps.map(op => op.opId)

		// wait for client to be completely caught up before rolling back. In other words we don't try to reconcile diverging histories until the synced history is fully caught up to the local history
		if (Arr.isSubset(newSyncedOpIds, pendingOpIds)) {
			return {
				syncedState: newSyncedState,
				syncedOps: newSyncedOps,
				localState: newSyncedState,
				pendingOps: [],
			}
		}

		return {
			...session,
			syncedState: newSyncedState,
			syncedOps: newSyncedOps,
		}
	}

	export function localOps<O extends BaseOp, S>(session: Session<O, S>): O[] {
		return [...session.syncedOps, ...session.pendingOps]
	}

	export function processOutgoingOps<O extends BaseOp, S>(session: Session<O, S>, ops: O[], reducer: Reducer<O, S>): Session<O, S> {
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
			localState: reducer(session.localState, ops, prevLocalOps),
			pendingOps: [...session.pendingOps, ...ops],
		}
	}
}
