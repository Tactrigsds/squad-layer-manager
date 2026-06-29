import * as Arr from '@/lib/array'
import { sleep, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { withThrown, withThrownAsync } from '@/lib/error'
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
import { E_TIMEOUT, Mutex, MutexInterface, withTimeout } from 'async-mutex'
import * as Rx from 'rxjs'

export const module = initModule('teamswitches')

const TEAMSWITCH_EXECUTION_TIMEOUT = 30_000

let log!: CS.Logger

type Session = RbSyncState.Server.Session<Teamswitches.Op, Teamswitches.State, Teamswitches.SideEffect>

export type TeamswitchContext = {
	session: Session
	// outgoing operations
	op$: IsolatedSubject<Teamswitches.Op[]>
	dispatchMtx: MutexInterface
	teamswitchExecutedAt: number | null
}
export function setup() {
	log = module.getLogger()
}

export function initContext(ctx: C.SquadServer & C.ServerSliceCleanup) {
	const context: TeamswitchContext = {
		session: RbSyncState.Server.initSession(Teamswitches.initState(), {}),
		op$: new IsolatedSubject<Teamswitches.Op[]>(),
		dispatchMtx: new Mutex(),
		teamswitchExecutedAt: null,
	}
	ctx.cleanup.push(context.op$, context.dispatchMtx)

	// sync with team updates
	ctx.cleanup.push(
		ctx.server.event$.pipe(
			Rx.filter(([ctx, e]) => Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type) || e.type === 'TEAMS_POLLED_UPDATE'),
			C.durableSub('onTeamsModified', { module }, async ([ctx, e]) => {
				const match = (await MatchHistory.getMatchById(ctx, e.matchId))!
				if (!Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type) && e.type !== 'TEAMS_POLLED_UPDATE') return
				function tryEndSwitching() {
					const players = SquadServer.getCurrTeams(ctx)?.players
					const state = getState(ctx)
					const executedAt = ctx.teamswitches.teamswitchExecutedAt
					if (!players || !state.switching || executedAt === null) return
					// buffer event time to deal with potential latency
					if (executedAt >= e.time) return

					const missingPlayers = new Set<SM.PlayerId>()
					for (const [playerId, { toTeam }] of state.pendingSwitches.entries()) {
						const player = SM.PlayerIds.find(players, p => p.ids, playerId)
						if (!player || player.teamId === null) continue
						const playerTeam = MH.getNormedTeamId(player.teamId, match.ordinal)
						if (playerTeam !== toTeam) {
							missingPlayers.add(playerId)
						}
					}

					ctx.teamswitches.teamswitchExecutedAt = null
					if (missingPlayers.size === 0) {
						ops.push({
							opId: Teamswitches.createOpId(),
							code: 'teamswitch-execution-completed',
						})
					} else {
						ops.push({
							opId: Teamswitches.createOpId(),
							code: 'teamswitch-execution-failed',
							reason: 'not-all-players-switched',
							playerIds: Array.from(missingPlayers),
						})
					}
				}
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
					tryEndSwitching()
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
				} else if (e.type === 'TEAMS_POLLED_UPDATE') {
					tryEndSwitching()
				} else {
					assertNever(e.type)
				}

				if (ops.length > 0) {
					await dispatchOp(ctx, ...ops)
				}
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

function getState(ctx: C.Teamswitch) {
	return ctx.teamswitches.session.state
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
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{ module, mutexes: (ctx) => ctx.teamswitches.dispatchMtx, extraText: (ctx, ...ops) => ops.map(o => o.code).join(',') },
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
			log.debug(se, 'side effect: %s', se.code)
			try {
				switch (se.code) {
					case 'execute-teamswitches': {
						const [res, thrownError] = await withThrownAsync(async () => {
							// TODO get first valid team with timeout
							const currentMatch = await MatchHistory.getCurrentMatch(ctx)
							const teamsRes = await ctx.server.teams.get(ctx, { ttl: 300 })
							if (teamsRes.code === 'err:rcon') return teamsRes
							log.info('players: %o', teamsRes.players)
							const toSwitch: SM.PlayerId[] = []
							for (const [playerId, _switch] of se.switches.entries()) {
								const player = SM.PlayerIds.find(teamsRes.players, p => p.ids, playerId)
								if (!player) continue
								if (player.teamId == null) throw new Error(`player ${playerId} has no teamId`)
								const playerNormedTeamId = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
								if (playerNormedTeamId === _switch.toTeam) continue
								toSwitch.push(playerId)
							}
							const switched$ = SquadRcon.switchPlayers(ctx, toSwitch)
							const isManual = ops.find(o => o.opId === se.opId && (o as any).source)
							if (isManual) {
								sleep(500).then(() => SquadRcon.warnAll(ctx, toSwitch, WARNS.teamswitches.notifyManualSwitch))
							}
							await switched$
							ctx.teamswitches.teamswitchExecutedAt = Date.now()
							return { code: 'ok' as const }
						})

						let message: string | undefined
						let finalError: unknown
						if (thrownError) {
							message = (thrownError as any)?.message ?? String(thrownError)
							finalError = thrownError
						} else if (res && res.code !== 'ok') {
							message = res.msg ?? res.code
							finalError = res
						}

						// if successful, no need to do anything here. we will wait for the next polling cycle and fire the event in `onTeamsModified`

						if (finalError) {
							nextOps.push({
								code: 'teamswitch-execution-failed',
								reason: 'error',
								message: message ?? String(finalError),
								opId: Teamswitches.createOpId(),
							})
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
				log.error('error processing side effects: %o', e?.message ?? e?.msg ?? e?.code ?? e)
				C.recordGenericError(e, true)
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
