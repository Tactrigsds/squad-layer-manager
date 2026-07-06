import * as Arr from '@/lib/array'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import type * as CS from '@/models/context-shared'
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
			log.debug('op outcome', se.op, se.success)
		}
	},
)
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

	// wsClientIds are generated per-connection, so a closed socket's id never comes back -- no reconnect check needed
	const disconnectSub = WSSessionSys.disconnect$.pipe(
		Rx.delay(UP.DISCONNECT_TIMEOUT),
		C.durableSub('user-presence:disconnect-timeout', { module, taskScheduling: 'parallel' }, async (ctx) => {
			if (!globalUserPresence.session.state.presence.has(ctx.wsClientId)) return
			await dispatchOp([{ code: 'disconnected-timeout', clientId: ctx.wsClientId, opId: UP.createOpId(), time: Date.now() }])
		}),
	).subscribe()
	CleanupSys.register(() => disconnectSub.unsubscribe())

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
