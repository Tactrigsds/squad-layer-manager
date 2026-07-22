import * as Arr from '@/lib/array'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as UP from '@/models/user-presence'
import type * as USR from '@/models/users.models'
import * as C from '@/server/context'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as SettingsSys from '@/systems/settings.server'
import * as WSSessionSys from '@/systems/ws-session.server'
import * as Rx from 'rxjs'
import { z } from 'zod'

// the two shared drafts a client can hold an editing session on
export type DraftScope = 'queue' | 'layer-requests'

// a dispatched batch on its way to the watchUpdates streams. a rejected batch changed nothing and is routed
// to the originating client alone, so it can drop its optimistic copies -- no other client hears about it.
// `echoToSource` sends the originator the full ops instead of an ack, for when the server corrected them
// and its copies are no longer what the client replayed optimistically
export type DispatchedOps = { ops: UP.Op[]; sourceWsClientId?: string; echoToSource?: boolean; rejection?: UP.Rejection }

export type UserPresenceContext = {
	userPresence: {
		session: ODSM.Server.Session<UP.Op, UP.State>
		op$: IsolatedSubject<DispatchedOps>
		abandoned$: IsolatedSubject<{ serverId: string; scope: DraftScope }>
	}
}

let globalUserPresence: UserPresenceContext['userPresence']

// pending "interrupted -> disconnected" timers, keyed by wsClientId so they can be superseded when the
// same id is reclaimed or closes again (see setup)
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>()
function clearPendingDisconnect(wsClientId: string) {
	const timer = pendingDisconnects.get(wsClientId)
	if (timer === undefined) return
	clearTimeout(timer)
	pendingDisconnects.delete(wsClientId)
}

const module = initModule('user-presence')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export const orpcRouter = {
	watchUpdates: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context, signal }) {
		const initial: UP.PresenceUpdate = {
			code: 'init',
			state: Obj.deepClone(globalUserPresence.session.state),
			ops: Obj.deepClone(globalUserPresence.session.ops),
		}
		const update$ = globalUserPresence.op$.pipe(
			Rx.map(({ ops, sourceWsClientId, echoToSource, rejection }): UP.PresenceUpdate | null => {
				// the originator already has the ops in its pending set -- ack (or reject) with just the ids
				const isOriginator = sourceWsClientId !== undefined && sourceWsClientId === context.wsClientId
				const opIds = ops.map(op => op.opId)
				if (rejection) return isOriginator ? { code: 'rejected', opIds, reason: rejection.code } : null
				if (isOriginator && !echoToSource) return { code: 'ack', opIds }
				return { code: 'op', ops }
			}),
			Rx.filter((update): update is UP.PresenceUpdate => update !== null),
			Rx.startWith(initial),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(update$)
	}),

	dispatchOp: orpcBase
		.meta({ type: 'mutation', logLevel: 'debug' })
		.input(z.array(UP.OpSchema))
		.handler(async ({ context: ctx, input: clientOps }) => {
			const ops: UP.Op[] = []
			let opsRewritten = false
			for (const rawOp of clientOps) {
				if (!Arr.includesEnum(UP.CLIENT_OP_CODE.options, rawOp.code)) {
					return { code: 'invalid-op:non-client' as const, msg: 'Tried to use non-client op code: ' + rawOp.code }
				}
				let op = rawOp as UP.ClientOp
				if (op.clientId !== ctx.wsClientId) {
					return {
						code: 'err:invalid-op:different-client' as const,
						msg: 'Tried to update presence for different client: ' + op.clientId + ' vs ' + ctx.wsClientId,
					}
				}

				if (op.userId !== ctx.user.discordId) {
					return {
						code: 'err:invalid-op:different-user' as const,
						msg: 'Tried to update presence for different user: ' + op.userId + ' vs ' + ctx.user.discordId,
					}
				}

				// some clients have fucked up clocks and stamp the op in the future, so we correct it here. the opId is
				// kept so the originator can still recognize its own op in the echo below and drop the pending copy
				if (op.time > Date.now()) {
					op = { ...op, time: Date.now() }
					opsRewritten = true
				}

				ops.push(op)
			}

			// ack-by-id has the originator replay its own pending copies, which only works if the server applied
			// them verbatim -- if we rewrote any op, echo the corrected ops to the originator too
			dispatchOp(ops, { sourceWsClientId: ctx.wsClientId, echoToSource: opsRewritten }).catch((error) => log.error(error))
			return { code: 'ok' as const }
		}),
}

const DRAFT_SCOPES = ['queue', 'layer-requests'] as const

// clients (not users) holding an editing session, counted per server for each shared draft
type EditorCounts = Record<DraftScope, Map<string, number>>
function countEditingClients(state: UP.State): EditorCounts {
	const counts: EditorCounts = { 'queue': new Map(), 'layer-requests': new Map() }
	for (const client of state.presence.values()) {
		const activity = client.activityState
		if (!activity) continue
		const serverId = activity.opts.serverId
		const bump = (scope: DraftScope) => counts[scope].set(serverId, (counts[scope].get(serverId) ?? 0) + 1)
		if (UP.Trans.editingQueue(serverId).match(activity)) bump('queue')
		if (UP.Trans.editingLayerRequests(serverId).match(activity)) bump('layer-requests')
	}
	return counts
}

// a save or an explicit "finish editing" ends the session on purpose, and commits (or has nothing to commit)
// alongside it. Only an unannounced exit -- navigating off, disconnecting, timing out -- abandons the draft.
function endsEditingDeliberately(op: UP.Op) {
	if (op.code === 'sll:end-all-editing' || op.code === 'layer-requests:end-all-editing') return true
	return op.code === 'update-activity'
		&& (op.update.code === 'clear-editing-queue' || op.update.code === 'clear-editing-layer-requests')
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{ module, extraText: (ops) => ops.map(o => o.code + (o.code === 'update-activity' ? ` (${o.update.code})` : '')).join(',') },
	async (ops: UP.Op[], opts?: Omit<DispatchedOps, 'ops' | 'rejection'>) => {
		const editorsBefore = countEditingClients(globalUserPresence.session.state)
		const applied = ODSM.Server.applyOps(globalUserPresence.session, ops, UP.reducer)
		globalUserPresence.session = applied.session
		if (applied.rejected) {
			const rejection = applied.error.data as UP.Rejection
			globalUserPresence.op$.next({ ops, ...opts, rejection })
			if (rejection.code === 'op-error') log.error(rejection.error, 'presence op errored')
			return
		}
		globalUserPresence.op$.next({ ops, ...opts })
		if (!ops.some(endsEditingDeliberately)) {
			const editorsAfter = countEditingClients(globalUserPresence.session.state)
			for (const scope of DRAFT_SCOPES) {
				// only a server that had an editor can lose its last one, so iterating `before` covers it
				for (const serverId of editorsBefore[scope].keys()) {
					if ((editorsAfter[scope].get(serverId) ?? 0) > 0) continue
					globalUserPresence.abandoned$.next({ serverId, scope })
				}
			}
		}
		for (const se of applied.sideEffects) {
			// op-outcome is currently the only side effect
			// TODO handle start-editing and finish-editing on SLL side once that code is converted to use ODSM
			log.debug(
				{
					[ATTRS.UserPresence.OP_CODE]: se.op.code,
					[ATTRS.UserPresence.OP_ID]: se.op.opId,
					[ATTRS.UserPresence.OP_SUCCESS]: se.success,
				},
				'op outcome: %s',
				se.op.code,
			)
		}
	},
)
// Called at connection time (see createOrpcSessionBase): hand the new connection the wsClientId it is
// reconnecting into, so its held presence (activity + locks) carries over untouched and no ghost entry is
// left behind. Returns the reclaimed id, or undefined to mint a fresh one.
export function reclaimClientId(userId: bigint, priorClientId?: string): string | undefined {
	// The reconnecting client told us the id it last held. Reclaim that exact entry whether it is still
	// `connected` (its old socket half-open, close not yet detected -- the common reconnect case) or already
	// `connection-interrupted`, and evict any stale socket still parked on it. Scoped to this user's own ids.
	if (priorClientId !== undefined) {
		const presence = globalUserPresence.session.state.presence.get(priorClientId)
		if (presence && presence.userId === userId && presence.connectionState !== 'disconnected') {
			WSSessionSys.evictStaleSocket(priorClientId)
			return markReclaimed(priorClientId)
		}
	}

	// Fallback for a client that supplied no usable prior id: reclaim its most-recently-seen interrupted entry.
	let reclaimedId: string | undefined
	let bestSeen = -Infinity
	for (const [clientId, presence] of globalUserPresence.session.state.presence) {
		if (presence.userId !== userId) continue
		if (presence.connectionState !== 'connection-interrupted') continue
		const seen = presence.lastSeen ?? 0
		if (seen >= bestSeen) {
			bestSeen = seen
			reclaimedId = clientId
		}
	}
	if (reclaimedId === undefined) return undefined
	return markReclaimed(reclaimedId)
}

// the reconnecting socket owns this id now; cancel any pending disconnect and mark it live
function markReclaimed(clientId: string): string {
	clearPendingDisconnect(clientId)
	dispatchOp([{ code: 'connection-restored', clientId, opId: UP.createOpId(), time: Date.now() }])
		.catch((error) => log.error(error))
	return clientId
}

// the users currently editing the given server's layer queue, minus `exclude` (typically the user whose save is
// being processed). Snapshotted when a force save lands, so the QUEUE_UPDATED can name who it overrode.
export function getQueueEditors(serverId: string, exclude?: USR.UserId): USR.UserId[] {
	const editors = new Set<USR.UserId>()
	for (const client of globalUserPresence.session.state.presence.values()) {
		const activity = client.activityState
		if (!activity || !UP.Trans.editingQueue(serverId).match(activity)) continue
		if (exclude !== undefined && client.userId === exclude) continue
		editors.add(client.userId)
	}
	return [...editors]
}

// the shared drafts on this server whose last editing client went away without finishing. Whoever owns the
// draft is expected to discard it: nobody is left to commit it, and the next editor would inherit edits they
// never made.
export function editingAbandoned$(serverId: string): Rx.Observable<DraftScope> {
	return globalUserPresence.abandoned$.pipe(Rx.filter(e => e.serverId === serverId), Rx.map(e => e.scope))
}

export function dispatchEndAllTeamswapEditing(serverId: string) {
	dispatchOp([{
		code: 'teamswaps:end-all-editing',
		opId: UP.createOpId(),
		time: Date.now(),
		serverId,
	}]).catch((error) => log.error(error))
}

export function dispatchEndAllLayerRequestEditing(serverId: string) {
	dispatchOp([{
		code: 'layer-requests:end-all-editing',
		opId: UP.createOpId(),
		time: Date.now(),
		serverId,
	}]).catch((error) => log.error(error))
}

export function dispatchEndAllLayerQueueEditing(serverId: string) {
	dispatchOp([{
		code: 'sll:end-all-editing',
		opId: UP.createOpId(),
		time: Date.now(),
		serverId,
	}]).catch((error) => log.error(error))
}

export function setup() {
	log = module.getLogger()

	globalUserPresence = {
		session: ODSM.Server.initSession(UP.initState()),
		op$: new IsolatedSubject<DispatchedOps>(),
		abandoned$: new IsolatedSubject<{ serverId: string; scope: DraftScope }>(),
	}
	CleanupSys.register(() => {
		globalUserPresence.op$.complete()
		globalUserPresence.abandoned$.complete()
	})

	// keep the presence state's notion of enabled servers in sync with the registry; disabling/removing a server
	// dispatches an op that both updates the set and collapses any presence sitting on that server to null
	const enabledServersSub = SettingsSys.publicSettings$.pipe(
		Rx.map((settings) => settings.servers.filter((s) => s.enabled && !s.broken).map((s) => s.id)),
		Rx.distinctUntilChanged((a, b) => a.length === b.length && a.every((id) => b.includes(id))),
	).subscribe((serverIds) => {
		dispatchOp([{ code: 'set-enabled-servers', serverIds, opId: UP.createOpId(), time: Date.now() }])
			.catch((error) => log.error(error))
	})
	CleanupSys.register(() => enabledServersSub.unsubscribe())

	// On close, either the client cleanly left (drop it now) or the socket was interrupted (keep its
	// activity + locks so a reconnecting socket can reclaim this id, and show a spinner meanwhile). An
	// interrupted client that isn't reclaimed within DISCONNECT_TIMEOUT is gone for good. The timer is
	// tracked per id and superseded on each close/reclaim, since ids are reused across reconnects and a
	// disconnect->reconnect->disconnect flap must not let a stale timer disconnect a fresh interruption.
	const disconnectSub = WSSessionSys.disconnect$.subscribe(({ ctx, interrupted }) => {
		const wsClientId = ctx.wsClientId
		clearPendingDisconnect(wsClientId)
		if (!interrupted) {
			dispatchOp([{ code: 'client-disconnected', clientId: wsClientId, opId: UP.createOpId(), time: Date.now() }])
				.catch((error) => log.error(error))
			return
		}
		dispatchOp([{ code: 'connection-interrupted', clientId: wsClientId, opId: UP.createOpId(), time: Date.now() }])
			.catch((error) => log.error(error))
		const timer = setTimeout(() => {
			pendingDisconnects.delete(wsClientId)
			// reclaim flips it back to 'connected'; only disconnect if it's still interrupted
			const clientState = globalUserPresence.session.state.presence.get(wsClientId)
			if (clientState?.connectionState !== 'connection-interrupted') return
			dispatchOp([{ code: 'client-disconnected', clientId: wsClientId, opId: UP.createOpId(), time: Date.now() }])
				.catch((error) => log.error(error))
		}, UP.DISCONNECT_TIMEOUT)
		pendingDisconnects.set(wsClientId, timer)
	})
	CleanupSys.register(() => {
		disconnectSub.unsubscribe()
		for (const timer of pendingDisconnects.values()) clearTimeout(timer)
		pendingDisconnects.clear()
	})

	const cleanSub = Rx.interval(UP.DISPLAYED_AWAY_PRESENCE_WINDOW * 2).pipe(
		C.durableSub('user-presence:clean-presence', { module }, async () => {
			const clientIdsToRemove: string[] = []
			const presenceState = globalUserPresence.session.state.presence
			for (const [wsClientId, presence] of Array.from(presenceState.entries())) {
				// we don't want to remove presence instances that still might have an away indicator
				const pastDisconnectTimeout = presence.lastSeen === null || (Date.now() - presence.lastSeen) > UP.DISPLAYED_AWAY_PRESENCE_WINDOW
				if (!WSSessionSys.wsSessions.has(wsClientId) && pastDisconnectTimeout) {
					clientIdsToRemove.push(wsClientId)
				}
			}
			await dispatchOp([{ code: 'clean-stale-presence', clientIdsToRemove, opId: UP.createOpId(), time: Date.now() }])
			log.info(`Cleaned ${clientIdsToRemove.length} stale presence sessions`)
			// no need to send these deletions to the client
		}),
	).subscribe()
	CleanupSys.register(() => cleanSub.unsubscribe())
}
