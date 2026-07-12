import * as Arr from '@/lib/array'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as UP from '@/models/user-presence'
import * as C from '@/server/context'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as SettingsSys from '@/systems/settings.server'
import * as WSSessionSys from '@/systems/ws-session.server'
import * as Rx from 'rxjs'
import { z } from 'zod'

export type UserPresenceContext = {
	userPresence: {
		session: ODSM.Server.Session<UP.Op, UP.State>
		op$: IsolatedSubject<{ ops: UP.Op[]; sourceWsClientId?: string }>
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
			// the originator already has the ops in its pending set -- ack with just the ids
			Rx.map(({ ops, sourceWsClientId }): UP.PresenceUpdate =>
				sourceWsClientId !== undefined && sourceWsClientId === context.wsClientId
					? { code: 'ack', opIds: ops.map(op => op.opId) }
					: { code: 'op', ops }
			),
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

				// there some clients where the op time is in the future because their clocks are fucked up, so we need to update it to the current time.
				// We need to create a new opId as well so that the client and server don't fall out of sync
				if (op.time > Date.now()) {
					op = {
						...op,
						time: Date.now(),
						opId: UP.createOpId(),
					}
					opsRewritten = true
				}

				ops.push(op)
			}

			// ack-by-id has the originator replay its own pending copies, which only works if the server
			// applied them verbatim -- if we rewrote any op, fall back to echoing the full ops
			dispatchOp(ops, opsRewritten ? undefined : { sourceWsClientId: ctx.wsClientId }).catch((error) => log.error(error))
			return { code: 'ok' as const }
		}),
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{ module, extraText: (ops) => ops.map(o => o.code + (o.code === 'update-activity' ? ` (${o.update.code})` : '')).join(',') },
	async (ops: UP.Op[], opts?: { sourceWsClientId?: string }) => {
		const applied = ODSM.Server.applyOps(globalUserPresence.session, ops, UP.reducer)
		globalUserPresence.session = applied.session
		globalUserPresence.op$.next({ ops, sourceWsClientId: opts?.sourceWsClientId })
		if (applied.rejected) {
			const rejection = applied.error.data as UP.Rejection
			if (rejection.code === 'op-error') log.error(rejection.error, 'presence op errored')
			return
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
// Called at connection time (see createOrpcSessionBase): if this user has a client whose socket was
// interrupted, hand the new connection that same wsClientId so its held activity and locks carry over
// untouched, and mark it live again. Returns the reclaimed id, or undefined to mint a fresh one.
export function reclaimInterruptedClientId(userId: bigint): string | undefined {
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
	// the reconnecting socket owns this id now; cancel the pending disconnect and mark it live
	clearPendingDisconnect(reclaimedId)
	dispatchOp([{ code: 'connection-restored', clientId: reclaimedId, opId: UP.createOpId(), time: Date.now() }])
		.catch((error) => log.error(error))
	return reclaimedId
}

export function dispatchEndAllTeamswitchEditing() {
	dispatchOp([{
		code: 'broadcast-activity-update',
		opId: UP.createOpId(),
		time: Date.now(),
		update: { code: 'clear-editing-teamswitches' },
	}]).catch((error) => log.error(error))
}

export function dispatchEndAllLayerQueueEditing() {
	dispatchOp([{
		code: 'sll:end-all-editing',
		opId: UP.createOpId(),
		time: Date.now(),
	}]).catch((error) => log.error(error))
}

export function setup() {
	log = module.getLogger()

	globalUserPresence = {
		session: ODSM.Server.initSession(UP.initState()),
		op$: new IsolatedSubject<{ ops: UP.Op[]; sourceWsClientId?: string }>(),
	}
	CleanupSys.register(() => globalUserPresence.op$.complete())

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
