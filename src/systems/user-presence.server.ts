import * as Arr from '@/lib/array'
import { CleanupTasks, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import * as C from '@/server/context'
import * as Db from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Teamswitches from '@/systems/teamswitches.server'
import * as WSSessionSys from '@/systems/ws-session.server'
import * as Rx from 'rxjs'

export type UserPresenceContext = {
	userPresence: {
		session: RbSyncState.Server.Session<UP.Op, UP.State, UP.SideEffects>
		op$: IsolatedSubject<UP.Op[]>
	}
}

export function initUserPresenceContext(ctx: C.ServerSliceCleanup & C.ServerId): UserPresenceContext['userPresence'] {
	const serverId = ctx.serverId
	const sideEffectQueue$ = new IsolatedSubject<[C.ServerSlice, UP.SideEffects]>()
	ctx.cleanup.push(sideEffectQueue$)
	const context: UserPresenceContext['userPresence'] = {
		session: RbSyncState.Server.initSession(UP.initState(), {
			onSideEffect: se => {
				const ctx = resolveCtx(serverId)
				sideEffectQueue$.next([ctx, se])
			},
		}),
		op$: new IsolatedSubject<UP.Op[]>(),
	}
	ctx.cleanup.push(context.op$)
	sideEffectQueue$.pipe(C.durableSub('onSideEffect', { module }, (args) => onSideEffect(...args))).subscribe()

	return context
}

const module = initModule('user-presence')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

// export function sendPresenceUpdate(ctx: C.UserPresence, update: UP.PresenceBroadcast) {
// 	update = Obj.deepClone(update)
// 	ctx.userPresence.update$.next(update)
// }

export const orpcRouter = {
	watchUpdates: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context, signal }) {
		const updateForServer$ = SquadServer.selectedServerCtx$(context).pipe(
			Rx.switchMap(ctx => {
				const initial: UP.PresenceUpdate = {
					code: 'init',
					state: Obj.deepClone(ctx.userPresence.session.state),
					ops: Obj.deepClone(ctx.userPresence.session.ops),
				}
				return ctx.userPresence.op$.pipe(
					Rx.map((ops): UP.PresenceUpdate => ({ code: 'op', ops })),
					Rx.startWith(initial),
				)
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(updateForServer$)
	}),

	dispatchOp: orpcBase
		.meta({ type: 'mutation', logLevel: 'debug' })
		.input(UP.OpSchema)
		.handler(async ({ context: _ctx, input: _op }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
			if (!Arr.includesEnum(UP.CLIENT_OP_CODE.options, _op.code)) {
				return { code: 'invalid-op:non-client' as const, msg: 'Tried to use non-client op code: ' + _op.code }
			}
			let op = _op as UP.ClientOp
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

			dispatchOp(ctx, op)
			return { code: 'ok' as const }
		}),
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{ module, extraText: (ctx, ...ops) => ops.map(o => o.code).join(',') },
	async (ctx: C.UserPresence, ...ops: UP.Op[]) => {
		const sideEffects: UP.SideEffects[] = []
		function onSideEffect(se: UP.SideEffects) {
			sideEffects.push(se)
		}
		ctx.userPresence.session = RbSyncState.Server.applyOps(ctx.userPresence.session, ops, UP.reducer, { onSideEffect })
		ctx.userPresence.op$.next(ops)
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
export function dispatchEndAllTeamswitchEditing(ctx: C.UserPresence) {
	dispatchOp(ctx, {
		code: 'broadcast-activity-update',
		opId: UP.createOpId(),
		time: Date.now(),
		update: { code: 'clear-editing-teamswitches' },
	})
}

async function onSideEffect(ctx: C.UserPresence, effect: UP.SideEffects) {
}

function getBaseCtx() {
	return C.initMutexStore(Db.addPooledDb(CS.init()))
}

export function setup() {
	log = module.getLogger()

	const cleanSub = Rx.interval(UP.DISPLAYED_AWAY_PRESENCE_WINDOW * 2).pipe(
		Rx.map(() => getBaseCtx()),
		C.durableSub('user-presence:clean-presence', { module }, async (baseCtx) => {
			let numCleaned = 0
			for (const slice of SquadServer.globalState.slices.values()) {
				const ctx = { ...baseCtx, ...slice }
				const clientIdsToRemove: string[] = []
				const presenceState = ctx.userPresence.session.state.presence
				for (const [wsClientId, presence] of Array.from(presenceState.entries())) {
					// we don't want to remove presence instances that still might have an away indicator
					const pastDisconnectTimeout = presence.lastSeen === null || (Date.now() - presence.lastSeen) > UP.DISPLAYED_AWAY_PRESENCE_WINDOW
					if (
						!WSSessionSys.wsSessions.has(wsClientId) && pastDisconnectTimeout
					) {
						clientIdsToRemove.push(wsClientId)
					}
				}
				await dispatchOp(ctx, { code: 'clean-stale-presence', clientIdsToRemove, opId: UP.createOpId(), time: Date.now() })
				numCleaned += clientIdsToRemove.length
			}

			log.info(`Cleaned ${numCleaned} stale presence sessions`)
			// no need to send these deletions to the client
		}),
	).subscribe()
	CleanupSys.register(() => cleanSub.unsubscribe())
}

function resolveCtx(serverId: string) {
	return SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
}
