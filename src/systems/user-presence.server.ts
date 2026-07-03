import * as Arr from '@/lib/array'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as UP from '@/models/user-presence'
import * as C from '@/server/context'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as WSSessionSys from '@/systems/ws-session.server'
import * as Rx from 'rxjs'
import { z } from 'zod'

export type UserPresenceContext = {
	userPresence: {
		session: RbSyncState.Server.Session<UP.Op, UP.State, UP.SideEffects>
		op$: IsolatedSubject<UP.Op[]>
	}
}

let globalUserPresence: UserPresenceContext['userPresence']

const module = initModule('user-presence')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export const orpcRouter = {
	watchUpdates: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ signal }) {
		const initial: UP.PresenceUpdate = {
			code: 'init',
			state: Obj.deepClone(globalUserPresence.session.state),
			ops: Obj.deepClone(globalUserPresence.session.ops),
		}
		const update$ = globalUserPresence.op$.pipe(
			Rx.map((ops): UP.PresenceUpdate => ({ code: 'op', ops })),
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
				}

				ops.push(op)
			}

			dispatchOp(...ops)
			return { code: 'ok' as const }
		}),
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{ module, extraText: (...ops) => ops.map(o => o.code).join(',') },
	async (...ops: UP.Op[]) => {
		const sideEffects: UP.SideEffects[] = []
		function onSideEffect(se: UP.SideEffects) {
			sideEffects.push(se)
		}
		globalUserPresence.session = RbSyncState.Server.applyOps(globalUserPresence.session, ops, UP.reducer, { onSideEffect })
		globalUserPresence.op$.next(ops)
		for (const se of sideEffects) {
			switch (se.code) {
				case 'error':
					log.error(se.error)
					break
				case 'op-outcome': {
					log.debug('op outcome', se.op, se.success)

					// TODO handle start-editing and finish-editing on SLL side once that code is converted to use RbSyncState
					//
					// /if (op.code === '')
					break
				}
				default:
					assertNever(se)
			}
		}
	},
)
export function dispatchEndAllTeamswitchEditing() {
	dispatchOp({
		code: 'broadcast-activity-update',
		opId: UP.createOpId(),
		time: Date.now(),
		update: { code: 'clear-editing-teamswitches' },
	})
}

export function setup() {
	log = module.getLogger()

	globalUserPresence = {
		session: RbSyncState.Server.initSession(UP.initState(), {}),
		op$: new IsolatedSubject<UP.Op[]>(),
	}
	CleanupSys.register(() => globalUserPresence.op$.complete())

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
			await dispatchOp({ code: 'clean-stale-presence', clientIdsToRemove, opId: UP.createOpId(), time: Date.now() })
			log.info(`Cleaned ${clientIdsToRemove.length} stale presence sessions`)
			// no need to send these deletions to the client
		}),
	).subscribe()
	CleanupSys.register(() => cleanSub.unsubscribe())
}
