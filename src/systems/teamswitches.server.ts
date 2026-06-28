import * as Arr from '@/lib/array'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as MapUtils from '@/lib/map'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import { WARNS } from '@/messages'
import * as CS from '@/models/context-shared'
import * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import * as SM from '@/models/squad.models'
import * as Teamswitches from '@/models/teamswitches.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as MatchHistory from '@/systems/match-history.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import { Mutex, MutexInterface } from 'async-mutex'
import { z } from 'zod'

import * as Rx from 'rxjs'

export const module = initModule('teamswitches')

let log!: CS.Logger

type Session = RbSyncState.Server.Session<Teamswitches.Op, Teamswitches.State, Teamswitches.SideEffect>

export type TeamswitchContext = {
	session: Session
	// outgoing operations
	op$: IsolatedSubject<Teamswitches.Op[]>
	dispatchMtx: MutexInterface
}
export function setup() {
	log = module.getLogger()
}

export function initContext(ctx: C.SquadServer & C.ServerSliceCleanup) {
	const context: TeamswitchContext = {
		session: RbSyncState.Server.initSession(Teamswitches.initState(), {}),
		op$: new IsolatedSubject<Teamswitches.Op[]>(),
		dispatchMtx: new Mutex(),
	}
	ctx.cleanup.push(context.op$, context.dispatchMtx)

	// sync with team updates
	ctx.cleanup.push(
		ctx.server.event$.pipe(
			Rx.filter(([ctx, e]) => Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type)),
			C.durableSub('onTeamsModified', { module }, async ([ctx, e]) => {
				const match = (await MatchHistory.getMatchById(ctx, e.matchId))!
				if (!Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type)) return
				const ops: Teamswitches.Op[] = []
				if (e.type === 'PLAYER_CONNECTED') {
					if (e.player.teamId === null) return
					const team = MH.getNormedTeamId(e.player.teamId, match.ordinal)
					ops.push({
						opId: Teamswitches.createOpId(),
						code: 'player-joined',
						playerId: SM.PlayerIds.getPlayerId(e.player.ids),
						team,
					})
				} else if (e.type === 'NEW_GAME' || e.type === 'RESET') {
					const players = new Map<string, MH.NormedTeamId>()
					for (const p of e.state.players) {
						if (p.teamId == null) throw new Error(`Player ${SM.PlayerIds.getPlayerId(p.ids)} has no teamId`)
						players.set(SM.PlayerIds.getPlayerId(p.ids), MH.getNormedTeamId(p.teamId, match.ordinal))
					}
					ops.push({
						opId: Teamswitches.createOpId(),
						code: 'reset-players',
						players,
					})
				} else if (e.type === 'PLAYER_CHANGED_TEAM') {
					if (e.newTeamId == null) return
					const team = MH.getNormedTeamId(e.newTeamId, match.ordinal)

					ops.push({
						opId: Teamswitches.createOpId(),
						code: 'player-changed-team',
						playerId: e.player,
						toTeam: team,
					})
				} else if (e.type === 'PLAYER_DISCONNECTED') {
					ops.push({
						opId: Teamswitches.createOpId(),
						code: 'player-left',
						playerId: e.player,
					})
				} else {
					assertNever(e.type)
				}

				await dispatchOp(ctx, ...ops)
			}),
		).subscribe(),
	)

	// schedule teamswitches on map roll
	ctx.cleanup.push(
		ctx.server.event$.pipe(
			Rx.filter(([ctx, e]) => e.type === 'NEW_GAME'),
			Rx.switchMap((arg) => Rx.timer(2000).pipe(Rx.map(() => arg))),
			C.durableSub('performTeamswitches', { module }, async ([ctx]) => {
				await dispatchOp(ctx, { opId: Teamswitches.createOpId(), code: 'execute-teamswitches' })
			}),
		).subscribe(),
	)

	return context
}

const orpcBase = getOrpcBase(module)
export const orpcRouter = {
	watchUpdates: orpcBase.handler(async function* watchOps({ context, signal }) {
		const obs = SquadServer.selectedServerCtx$(context).pipe(
			withAbortSignal(signal!),
			Rx.switchMap((ctx) => {
				const init: Teamswitches.UpdateForClient = {
					code: 'init',
					state: ctx.teamswitches.session.state,
					ops: ctx.teamswitches.session.ops,
				}
				return ctx.teamswitches.op$.pipe(Rx.map((ops): Teamswitches.UpdateForClient => ({ code: 'op', ops })), Rx.startWith(init))
			}),
		)
		yield* toAsyncGenerator(obs)
	}),

	// TODO we need to filter errors back to the client that might have occured while handling side-effects
	dispatchOp: orpcBase.meta({ type: 'mutation' }).input(Teamswitches.OpSchema).handler(async ({ context, input }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(context)
		await dispatchOp(ctx, input)
	}),

	switchNow: orpcBase.meta({ type: 'mutation' }).input(z.array(z.object({ playerId: SM.PlayerIdSchema, toTeam: MH.NormedTeamIdSchema })))
		.handler(async ({ context, input }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(context)
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			const teamsRes = await ctx.server.teams.get(ctx, { ttl: 300 })
			if (teamsRes.code !== 'ok') return teamsRes

			const toSwitch: SM.PlayerId[] = []
			for (const { playerId, toTeam } of input) {
				const player = SM.PlayerIds.find(teamsRes.players, p => p.ids, playerId)
				if (!player || player.teamId === null) continue
				const normedTeamId = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
				if (normedTeamId === toTeam) continue
				toSwitch.push(playerId)
			}

			if (toSwitch.length > 0) {
				void SquadRcon.switchPlayers(ctx, toSwitch)
				void SquadRcon.warnAll(ctx, toSwitch, WARNS.teamswitches.notifySwitchNow)
			}
			return { code: 'ok' as const }
		}),
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{ module, mutexes: (ctx) => ctx.teamswitches.dispatchMtx },
	async (ctx: C.Teamswitch & C.ServerSlice & C.Db, ...ops: Teamswitches.Op[]) => {
		const sideEffects: Teamswitches.SideEffect[] = []
		ctx.teamswitches.session = RbSyncState.Server.applyOps(ctx.teamswitches.session, ops, Teamswitches.reducer, {
			onSideEffect: (se) => sideEffects.push(se),
		})
		ctx.teamswitches.op$.next(ops)

		const opErrors = new Map<string, (Teamswitches.OpError | unknown)[]>()
		const addError = (opId: string, error: Teamswitches.OpError | unknown) => {
			const errors = MapUtils.defaultInsGet(opErrors, opId, [])
			errors.push(error)
			opErrors.set(opId, errors)
		}

		const nextOps: Teamswitches.Op[] = []
		for (const se of sideEffects) {
			try {
				switch (se.code) {
					case 'execute-teamswitches': {
						const res = await (async () => {
							// TODO get first valid team with timeout
							const currentMatch = await MatchHistory.getCurrentMatch(ctx)
							const teamsRes = await ctx.server.teams.get(ctx, { ttl: 300 })
							if (teamsRes.code === 'err:rcon') return teamsRes
							const toSwitch: SM.PlayerId[] = []
							for (const [playerId, _switch] of se.switches.entries()) {
								const player = SM.PlayerIds.find(teamsRes.players, p => p.ids, playerId)
								if (!player) continue
								if (player.teamId == null) throw new Error(`player ${playerId} has no teamId`)
								const playerNormedTeamId = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
								if (playerNormedTeamId === _switch.toTeam) continue
								toSwitch.push(playerId)
							}
							void SquadRcon.switchPlayers(ctx, toSwitch)
							void SquadRcon.warnAll(ctx, toSwitch, WARNS.teamswitches.notifyPlayerTeamswitchExecuted)
							nextOps.push({ code: 'teamswitches-executed', opId: Teamswitches.createOpId() })

							return { code: 'ok' as const }
						})()

						if (res.code !== 'ok') {
							log.error('error while executing teamswitches: %s', res.code)
							C.recordGenericError(res)
							C.setSpanStatus('error')
							const errors = MapUtils.defaultInsGet(opErrors, se.opId, [])
							errors.push(res)
						}

						break
					}

					case 'error': {
						const op = ops.find(op => op.opId === se.opId)
						if (se.error.code === 'err:unexpected') {
							log.error('op error while executing operation: %s op: %o', se.error.code, op)
							C.recordGenericError(se.error)
							C.setSpanStatus('error')
						} else {
							log.warn('op was not succesful: %s op: %o', se.error.code, op)
						}
						addError(se.opId, se.error)
						break
					}

					case 'save': {
						await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
							await SquadServer.updateServerState(ctx, { teamswitches: se.switches }, { type: 'system', event: 'teamswitches-saved' })
						})
						break
					}

					case 'notify-upcoming-teamswitches': {
						await SquadRcon.warnAll(ctx, se.players, WARNS.teamswitches.notifyPlayerOfUpcomingTeamswitch)
						break
					}

					case 'notify-teamswitches-cancelled': {
						await SquadRcon.warnAll(ctx, se.players, WARNS.teamswitches.notifyTeamswitchCancelled)
						break
					}

					default:
						assertNever(se)
				}
			} catch (_e) {
				const e = _e as any
				log.error('error processing side effects: %s', e?.message ?? e?.msg ?? e)
				C.recordGenericError(e)
				C.setSpanStatus('error')
			}
		}

		for (const op of nextOps) {
			const errors = await dispatchOp(ctx, op)
			MapUtils.assign(opErrors, errors)
		}

		return opErrors
	},
)

function resolveCtx(serverId: string) {
	return SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
}

function getBaseCtx() {
	return DB.addPooledDb(CS.init())
}
