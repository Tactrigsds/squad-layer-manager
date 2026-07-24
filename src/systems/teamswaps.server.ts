import * as Arr from '@/lib/array'
import { isAbortError, sleep, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { withThrownAsync } from '@/lib/error'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as MapUtils from '@/lib/map'
import * as ATTRS from '@/models/otel-attrs'

import * as ODSM from '@/lib/odsm'
import { assertNever } from '@/lib/type-guards'
import { WARNS } from '@/messages'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswaps.models'

import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UserPresenceSys from '@/systems/user-presence.server'
import * as Users from '@/systems/users.server'

import { Mutex } from 'async-mutex'
import type { MutexInterface } from 'async-mutex'
import * as Rx from 'rxjs'
import { z } from 'zod'

export const module = initModule('teamswaps')

let log!: CS.Logger

// The side effect used to be logged as-is, which flattened its whole payload into attributes: a
// `save` carries two full TeamswapCollections, so every save wrote a key per swap per collection.
// Only the identifying, bounded fields belong on the record; the payload itself is already in op$.
function sideEffectAttrs(se: TSW.SideEffect): Record<string, unknown> {
	const attrs: Record<string, unknown> = { [ATTRS.Teamswap.SIDE_EFFECT]: se.code }
	switch (se.code) {
		case 'op-outcome':
			attrs[ATTRS.Teamswap.OP_CODE] = se.op.code
			attrs[ATTRS.Teamswap.OP_ID] = se.op.opId
			attrs[ATTRS.Teamswap.OP_SUCCESS] = se.success
			break
		case 'notify-upcoming-teamswaps':
		case 'notify-teamswaps-cancelled':
			attrs[ATTRS.Teamswap.PLAYER_COUNT] = se.players.length
			break
		case 'execute-teamswaps':
			attrs[ATTRS.Teamswap.OP_ID] = se.opId
			attrs[ATTRS.Teamswap.SWAP_COUNT] = se.swaps.size
			break
		case 'teamswaps-executed':
			attrs[ATTRS.Teamswap.SWAP_COUNT] = se.swapCount
			break
		case 'teamswap-execution-failed':
			attrs[ATTRS.Teamswap.FAILURE_REASON] = se.reason
			if (se.playerIds) attrs[ATTRS.Teamswap.PLAYER_COUNT] = se.playerIds.length
			break
		case 'save':
			attrs[ATTRS.Teamswap.SWAP_COUNT] = se.swaps.size
			break
		case 'end-all-teamswap-editing':
			break
		default:
			assertNever(se)
	}
	return attrs
}

async function resolveSourceName(
	ctx: C.Db,
	source: TSW.Teamswap['source'],
	players?: { ids: SM.PlayerIds.Schema }[],
): Promise<string> {
	if (source.discordId) {
		return await Users.resolveDisplayName(ctx, source.discordId, 'Admin')
	}
	if (source.steamId && players) {
		const player = players.find(p => p.ids.steam === source.steamId)
		return player?.ids.usernameNoTag ?? player?.ids.username ?? 'Admin'
	}
	return 'Admin'
}

type Session = ODSM.Server.Session<TSW.Op, TSW.State>

type Dispatched = ODSM.Server.Dispatched<TSW.Op, TSW.Rejection>

export type TeamswapContext = {
	session: Session
	// outgoing operations
	op$: IsolatedSubject<Dispatched>
	dispatchMtx: MutexInterface
	teamswapExecutedAt: number | null
	haveReadSavedSwapsFromDb: boolean
}
export function setup() {
	log = module.getLogger()
}

export function initContext(ctx: C.SquadServer & C.Db & C.ServerSliceCleanup) {
	const context: TeamswapContext = {
		session: ODSM.Server.initSession(TSW.initState()),
		op$: new IsolatedSubject<Dispatched>(),
		dispatchMtx: new Mutex(),
		teamswapExecutedAt: null,
		haveReadSavedSwapsFromDb: false,
	}
	ctx.cleanup.push(context.op$, context.dispatchMtx)

	// sync with team updates
	ctx.cleanup.push(
		ctx.server.event$.pipe(
			Rx.filter(([ctx, e]) => Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type) || e.type === 'TEAMS_POLLED_UPDATE'),
			C.durableSub('onTeamsModified', { module }, async ([_ctx, e], signal) => {
				const ctx = { ..._ctx, signal }
				const match = (await MatchHistory.getMatchById(ctx, e.matchId))!
				if (!Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type) && e.type !== 'TEAMS_POLLED_UPDATE') return
				// the fast path for completing an execution: the teams poll usually observes the swapped players before
				// watchExecution's first check. it only ever completes -- a player who hasn't swapped yet may still be
				// about to (or may be about to be re-fired at), so failing the execution is watchExecution's call alone.
				function tryEndSwapping() {
					const players = SquadServer.getCurrTeams(ctx)?.players
					const state = getState(ctx)
					const executedAt = ctx.teamswaps.teamswapExecutedAt
					if (!players || !state.swapping || executedAt === null) return
					// buffer event time to deal with potential latency
					if (executedAt >= e.time) return

					for (const [playerId, { toTeam }] of state.pendingSwaps.entries()) {
						const player = SM.PlayerIds.find(players, p => p.ids, playerId)
						if (!player || player.teamId === null) continue
						if (MH.getNormedTeamId(player.teamId, match.ordinal) !== toTeam) return
					}

					ctx.teamswaps.teamswapExecutedAt = null
					ops.push({
						opId: TSW.createOpId(),
						code: 'teamswap-execution-completed',
					})
				}
				const ops: TSW.Op[] = []
				// PLAYER_RECONCILED is a roster backfill but still means the player is present on a team, so it is
				// tracked as a join here just like PLAYER_CONNECTED.
				if (e.type === 'PLAYER_CONNECTED' || e.type === 'PLAYER_RECONCILED') {
					if (e.player.teamId === null) return
					const team = MH.getNormedTeamId(e.player.teamId, match.ordinal)
					ops.push({
						opId: TSW.createOpId(),
						code: 'player-joined',
						playerId: SM.PlayerIds.getPlayerId(e.player.ids),
						team,
					})
				} else if (e.type === 'NEW_GAME' || e.type === 'RESET') {
					// A roster-less NEW_GAME is just the match-boundary marker; the roster (and thus reset-players)
					// arrives on the following RESET. Only act on the roster-bearing event.
					const roster = SE.eventRoster(e)
					if (roster) {
						const players = new Map<string, MH.NormedTeamId>()
						for (const p of roster.players) {
							if (p.teamId == null) throw new Error(`Player ${SM.PlayerIds.getPlayerId(p.ids)} has no teamId`)
							players.set(SM.PlayerIds.getPlayerId(p.ids), MH.getNormedTeamId(p.teamId, match.ordinal))
						}
						ops.push({
							opId: TSW.createOpId(),
							code: 'reset-players',
							players,
						})
						tryEndSwapping()
						restoreSavedBlock: if (!ctx.teamswaps.haveReadSavedSwapsFromDb) {
							ctx.teamswaps.haveReadSavedSwapsFromDb = true
							const serverState = await SquadServer.getServerState(ctx)
							if (!serverState.teamswaps) break restoreSavedBlock
							const { matchHistoryEntryId, swaps } = serverState.teamswaps
							if (matchHistoryEntryId === match.historyEntryId) {
								ops.push({
									opId: TSW.createOpId(),
									code: 'init-saved-teamswaps',
									swaps,
								})
							}
						}
					}
				} else if (e.type === 'PLAYER_CHANGED_TEAM') {
					if (e.newTeamId == null) return
					const team = MH.getNormedTeamId(e.newTeamId, match.ordinal)

					ops.push({
						opId: TSW.createOpId(),
						code: 'player-changed-team',
						playerId: e.player,
						toTeam: team,
					})
				} else if (e.type === 'PLAYER_DISCONNECTED') {
					ops.push({
						opId: TSW.createOpId(),
						code: 'player-left',
						playerId: e.player,
					})
				} else if (e.type === 'TEAMS_POLLED_UPDATE') {
					tryEndSwapping()
				} else {
					assertNever(e.type)
				}

				if (ops.length > 0) {
					await dispatchOp(ctx, ops)
				}
			}),
		).subscribe(),
	)

	// Schedule teamswaps on map roll. NEW_GAME is a roster-less boundary that precedes the roster, so this waits
	// before executing, to give the new match's teams a chance to land and the swaps to be applied against faithful
	// team data. taskScheduling 'switch' aborts a pending wait if another match boundary arrives first.
	//
	// Only a NEW_GAME that is actually a roll may execute: a 'slm-started' one fires this delay on boot, which is
	// long enough to swallow swaps saved moments later and execute them against the still-current match.
	ctx.cleanup.push(
		ctx.server.event$.pipe(
			Rx.filter(([, e]) => e.type === 'NEW_GAME' && SE.newGameIsRoll(e.source)),
			Rx.delay(2000),
			C.durableSub('performTeamswaps', { module, taskScheduling: 'switch' }, async ([ctx], signal) => {
				await dispatchOp({ ...ctx, signal }, [{ opId: TSW.createOpId(), code: 'execute-teamswaps' }])
			}),
		).subscribe(),
	)

	return context
}

function getState(ctx: C.Teamswap) {
	return ctx.teamswaps.session.state
}

// how long to wait for a fired swap to show up in the teams before checking (a swap lands within a poll cycle)
const EXECUTION_VERIFY_DELAY_MS = 5_000
// including the dispatch handler's initial fire, so 2 re-fires
const MAX_EXECUTION_ATTEMPTS = 3
// backstop for an execution that neither lands nor errors: better to cancel the pending swaps and say so than
// to leave them pending forever
const EXECUTION_TIMEOUT_MS = 60_000

// the queued players who still aren't on their assigned team, read from the live teams. a player who left, or who
// has no team yet, can't be swapped and isn't counted as outstanding -- same rule onTeamsModified applies.
// null means the teams couldn't be read, which says nothing either way.
async function unswappedPlayers(
	ctx: C.SquadServer & C.Rcon & CS.AbortSignal,
	swaps: TSW.TeamswapCollection,
	ordinal: number,
): Promise<SM.PlayerId[] | null> {
	const teamsRes = await ctx.server.teams.get(ctx, { ttl: 0 })
	if (teamsRes.code === 'err:rcon') return null
	const unswapped: SM.PlayerId[] = []
	for (const [playerId, _swap] of swaps.entries()) {
		const player = SM.PlayerIds.find(teamsRes.players, p => p.ids, playerId)
		if (!player || player.teamId == null) continue
		if (MH.getNormedTeamId(player.teamId, ordinal) === _swap.toTeam) continue
		unswapped.push(playerId)
	}
	return unswapped
}

// Runs outside the dispatch mutex (holding it here would block every teamswap op for the duration, and would
// deadlock against the completion this is waiting for).
async function watchExecution(
	ctx: C.Teamswap & C.ServerSlice & C.Db,
	execution: {
		opId: string
		swaps: TSW.TeamswapCollection
		ordinal: number
		retry: boolean
		actor: AppEvents.Actor
	},
) {
	const deadline = Date.now() + EXECUTION_TIMEOUT_MS
	let attempts = 1
	while (true) {
		await sleep(EXECUTION_VERIFY_DELAY_MS, ctx.signal)
		// the execution resolved while we waited (onTeamsModified saw the swaps land), or a later one replaced it
		if (getState(ctx).swappingOpId !== execution.opId) return

		const unswapped = await unswappedPlayers(ctx, execution.swaps, execution.ordinal)
		// onTeamsModified may have completed it while we were querying
		if (getState(ctx).swappingOpId !== execution.opId) return
		if (unswapped?.length === 0) {
			await dispatchOp(ctx, [{ opId: TSW.createOpId(), code: 'teamswap-execution-completed' }])
			return
		}

		if (unswapped && execution.retry && attempts < MAX_EXECUTION_ATTEMPTS) {
			attempts++
			log.warn(
				'teamswap execution %s: %d swap(s) did not land, re-firing (attempt %d/%d)',
				execution.opId,
				unswapped.length,
				attempts,
				MAX_EXECUTION_ATTEMPTS,
			)
			// each re-fire is its own forced swap, so it arms its own attribution for the events it produces
			await SquadServer.forceTeamChangeAppEvent(ctx, unswapped, execution.actor)
			await SquadRcon.switchPlayers(ctx, unswapped)
			ctx.teamswaps.teamswapExecutedAt = Date.now()
			continue
		}

		// out of attempts (or not retrying and out of time): cancel the pending swaps rather than leave them
		// hanging, and report which players are still on the wrong team
		if (unswapped && (execution.retry || Date.now() >= deadline)) {
			log.error('teamswap execution %s failed: %d player(s) never swapped', execution.opId, unswapped.length)
			await dispatchOp(ctx, [{
				opId: TSW.createOpId(),
				code: 'teamswap-execution-failed',
				reason: 'not-all-players-swapped',
				playerIds: unswapped,
			}])
			return
		}

		// the teams never came back (rcon is down), so we can't say who did or didn't swap
		if (Date.now() >= deadline) {
			log.error('teamswap execution %s timed out', execution.opId)
			await dispatchOp(ctx, [{ opId: TSW.createOpId(), code: 'teamswap-execution-failed', reason: 'timeout' }])
			return
		}
	}
}

function buildFactionLines(
	playerIds: SM.PlayerId[],
	swaps: TSW.TeamswapCollection,
	players: { ids: SM.PlayerIds.Schema }[],
	layer: { Faction_1: string; Faction_2: string } | null | undefined,
	ordinal: number,
): string[] {
	const groups = new Map<MH.NormedTeamId, { faction: string; names: string[] }>()
	for (const playerId of playerIds) {
		const toTeam = swaps.get(playerId)?.toTeam
		if (!toTeam) continue
		const player = SM.PlayerIds.find(players, p => p.ids, playerId)
		const playerName = player?.ids.usernameNoTag ?? player?.ids.username ?? playerId
		if (!groups.has(toTeam)) {
			const factionProp = MH.getTeamNormalizedFactionProp(ordinal, toTeam)
			groups.set(toTeam, { faction: layer?.[factionProp] ?? toTeam, names: [] })
		}
		groups.get(toTeam)!.names.push(playerName)
	}
	for (const group of groups.values()) group.names.sort((a, b) => a.localeCompare(b))
	return (['A', 'B'] as MH.NormedTeamId[])
		.filter(team => groups.has(team))
		.map(team => {
			const { faction, names } = groups.get(team)!
			return `to ${faction}: ${names.join(', ')}`
		})
}

const orpcBase = getOrpcBase(module)
export const orpcRouter = {
	watchUpdates: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function* watchOps(
		{ context, signal, input },
	) {
		const obs = SquadServer.sliceStream$(context.wsClientId, input.serverId, (ctx) => {
			const init: TSW.UpdateForClient = {
				code: 'init',
				state: ctx.teamswaps.session.state,
				ops: ctx.teamswaps.session.ops,
			}
			return ctx.teamswaps.op$.pipe(
				Rx.map(dispatched => ODSM.Server.toClientUpdate(dispatched, context.wsClientId)),
				Rx.filter((update): update is NonNullable<typeof update> => update !== null),
				Rx.startWith(init),
			)
		}).pipe(withAbortSignal(signal!))
		yield* toAsyncGenerator(obs)
	}),

	// TODO we need to filter errors back to the client that might have occured while handling side-effects
	dispatchOp: orpcBase.meta({ type: 'mutation' }).input(z.object({ serverId: z.string(), op: TSW.OpSchema })).handler(
		async ({ context, input: { serverId, op: input } }) => {
			const ctxRes = SquadServer.trySliceCtx(context, serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const source = 'source' in input ? input.source : undefined
			if (!source?.discordId || source.discordId !== ctx.user.discordId) {
				return { code: 'err:invalid-source' as const }
			}
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			await dispatchOp(ctx, [input], { sourceWsClientId: context.wsClientId })
		},
	),
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{
		module,
		mutexes: (ctx) => ctx.teamswaps.dispatchMtx,
		attrs: (ctx, ops) => ({ [ATTRS.Teamswap.OP_CODES]: ops.map(o => o.code).join(',') }),
		extraText: (ctx, ops) => ops.map(o => o.code).join(','),
	},
	async (ctx: C.Teamswap & C.ServerSlice & C.Db, ops: TSW.Op[], opts?: { sourceWsClientId?: string }) => {
		const applied = ODSM.Server.applyOps(ctx.teamswaps.session, ops, TSW.reducer)
		ctx.teamswaps.session = applied.session

		const opErrors = new Map<string, unknown[]>()
		const addError = (opId: string, error: unknown) => {
			const errors = MapUtils.defaultInsGet(opErrors, opId, [])
			errors.push(error)
			opErrors.set(opId, errors)
		}

		// a rejected batch failed (or was a no-op) and produced no side effects. surface a real op
		// failure to the rpc caller via opErrors and log it; a 'noop' rejection has nothing to report
		if (applied.rejected) {
			const rejection = applied.error.data as TSW.Rejection
			ctx.teamswaps.op$.next({ ops, sourceWsClientId: opts?.sourceWsClientId, rejection })
			if (rejection.code !== 'noop') {
				if (rejection.code === 'err:unexpected') {
					log.error('op error while executing operation: %s op: %o', rejection.code, rejection.op)
					C.recordGenericError(rejection)
					C.setSpanStatus('error')
				} else {
					log.warn('op was not succesful: %s op: %o', rejection.code, rejection.op)
				}
				addError(rejection.op.opId, rejection)
			}
			return opErrors
		}
		ctx.teamswaps.op$.next({ ops, sourceWsClientId: opts?.sourceWsClientId })

		const nextOps: TSW.Op[] = []
		for (const se of applied.sideEffects) {
			log.debug(sideEffectAttrs(se), 'side effect: %s', se.code)
			try {
				switch (se.code) {
					case 'execute-teamswaps': {
						const [res, thrownError] = await withThrownAsync(async () => {
							// The scheduled (map-roll) trigger waits for the roster to settle before dispatching, so in the
							// common path no target is team-less here. As a safety net for other dispatch paths (e.g. a manual
							// swap issued mid-staging), skip a team-less target rather than throwing: we can't faithfully
							// place a player who has no team yet, and a later poll's PLAYER_CHANGED_TEAM will reconcile them.
							const currentMatch = await MatchHistory.getCurrentMatch(ctx)
							const teamsRes = await ctx.server.teams.get(ctx, { ttl: 300 })
							if (teamsRes.code === 'err:rcon') return teamsRes
							log.info('players: %o', teamsRes.players)
							const toSwap: SM.PlayerId[] = []
							for (const [playerId, _swap] of se.swaps.entries()) {
								const player = SM.PlayerIds.find(teamsRes.players, p => p.ids, playerId)
								if (!player) continue
								if (player.teamId == null) {
									log.warn('skipping teamswap for team-less (unsettled) player %s', playerId)
									continue
								}
								const playerNormedTeamId = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
								if (playerNormedTeamId === _swap.toTeam) continue
								toSwap.push(playerId)
							}
							const manualOp = ops.find(o => o.opId === se.opId && (o as any).source) as
								| (TSW.Op & { source: TSW.Teamswap['source'] })
								| undefined
							// every target may already be on its destination team, in which case there's nothing to
							// announce to anyone
							const isManual = manualOp && toSwap.length > 0 ? manualOp : undefined
							// attribute the resulting PLAYER_CHANGED_TEAM events to whoever triggered the swap
							await SquadServer.forceTeamChangeAppEvent(ctx, toSwap, SquadServer.actorFromUser(ctx, manualOp?.source))
							const swapped$ = SquadRcon.switchPlayers(ctx, toSwap)
							if (isManual) {
								// notifications should outlive this dispatch, so bind them to the shutdown signal rather than the task signal
								const notifyCtx = { ...ctx, signal: CleanupSys.shutdownSignal }
								sleep(500, notifyCtx.signal)
									.then(() => SquadRcon.warnAll(notifyCtx, toSwap, WARNS.teamswaps.notifyManualSwap))
									.catch((error) => {
										if (!isAbortError(error)) log.error(error)
									})
							}
							await swapped$
							ctx.teamswaps.teamswapExecutedAt = Date.now()
							// nothing else guarantees this execution ever resolves: pendingSwaps only clears once a
							// team-modifying event lets onTeamsModified observe the players on their new teams, and a swap
							// that silently did nothing (the roster wasn't settled yet, so the rcon call was a no-op)
							// produces no such event. the watcher checks the live teams instead.
							watchExecution({ ...ctx, signal: CleanupSys.shutdownSignal }, {
								opId: se.opId,
								swaps: se.swaps,
								ordinal: currentMatch.ordinal,
								// only the map roll fires early enough for a retry to be the right answer. a manual swap
								// that didn't land is reported, not re-issued behind the admin's back
								retry: !manualOp,
								actor: SquadServer.actorFromUser(ctx, manualOp?.source),
							}).catch((error) => {
								if (!isAbortError(error)) log.error(error)
							})
							if (isManual) {
								const name = await resolveSourceName(ctx, isManual.source, teamsRes.players)
								const excludeSteamIds = isManual.source.steamId
									? new Set([isManual.source.steamId])
									: undefined
								const layerRes = L.parseLayerId(currentMatch.layerId)
								const layer = 'layer' in layerRes ? layerRes.layer : null
								const factionLines = toSwap.length <= 8
									? buildFactionLines(toSwap, se.swaps, teamsRes.players, layer, currentMatch.ordinal)
									: undefined
								SquadRcon.warnAllAdmins(
									{ ...ctx, signal: CleanupSys.shutdownSignal },
									{ msg: WARNS.teamswaps.notifyAdminManualSwap(name, toSwap.length, factionLines) },
									excludeSteamIds,
								).catch((error) => {
									if (!isAbortError(error)) log.error(error)
								})
							}

							await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
								await SquadServer.updateServerState(ctx, { teamswaps: null }, { type: 'system', event: 'teamswaps-saved' })
							})

							return { code: 'ok' as const }
						})

						const toMessage = (error: unknown) =>
							error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)

						let message: string | undefined
						let finalError: unknown
						if (thrownError) {
							message = (thrownError as any)?.message ?? toMessage(thrownError)
							finalError = thrownError
						} else if (res && res.code !== 'ok') {
							message = res.msg ?? res.code
							finalError = res
						}

						// if successful, no need to do anything here. we will wait for the next polling cycle and fire the event in `onTeamsModified`

						if (finalError) {
							nextOps.push({
								code: 'teamswap-execution-failed',
								reason: 'error',
								message: message ?? toMessage(finalError),
								opId: TSW.createOpId(),
							})
						}

						break
					}

					case 'save': {
						const currentMatch = await MatchHistory.getCurrentMatch(ctx)
						const saved = se.swaps.size > 0
							? { swaps: se.swaps, matchHistoryEntryId: currentMatch.historyEntryId }
							: null
						await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
							await SquadServer.updateServerState(ctx, { teamswaps: saved }, { type: 'system', event: 'teamswaps-saved' })
						})

						// an immediate swap is already recorded as a TEAM_CHANGE_FORCED; the queue losing that player is
						// a consequence of it, not a second action to log. a save that moved nothing (the collection is
						// rebuilt even when the delete matched nothing) is not an update anyone needs to see either
						const teamswapsUpdated = AppEvents.create<AppEvents.TeamswapsUpdated>({
							type: 'TEAMSWAPS_UPDATED',
							actor: SquadServer.actorFromUser(ctx, se.source),
							serverId: ctx.serverId,
							matchId: currentMatch.historyEntryId,
							causeId: null,
							trigger: se.trigger,
							prevSwaps: se.prevSaved,
							swaps: se.swaps,
						})
						if (se.trigger !== 'swapped-now' && AppEvents.summarizeTeamswapChanges(teamswapsUpdated).length > 0) {
							await SquadServer.emitAppEvent(ctx, teamswapsUpdated)
						}

						// only an edit to the queue is announced as one. an execution empties the saved swaps too, but it
						// has its own admin warn (notifyAdminManualSwap) and would otherwise report itself as a clear
						if (se.source && se.trigger === 'user-edit') {
							const name = await resolveSourceName(ctx, se.source)
							const excludeSteamIds = se.source.steamId
								? new Set([se.source.steamId])
								: undefined
							const layerRes = L.parseLayerId(currentMatch.layerId)
							const layer = 'layer' in layerRes ? layerRes.layer : null
							const currPlayers = SquadServer.getCurrTeams(ctx)?.players ?? []
							const factionLines = se.swaps.size <= 8
								? buildFactionLines(Array.from(se.swaps.keys()), se.swaps, currPlayers, layer, currentMatch.ordinal)
								: undefined
							const { added, removed } = TSW.getTeamswapChanges(se.swaps, se.prevSaved)
							// notification should outlive this dispatch, so bind it to the shutdown signal rather than the task signal
							SquadRcon.warnAllAdmins(
								{ ...ctx, signal: CleanupSys.shutdownSignal },
								{
									msg: WARNS.teamswaps.notifyAdminSwapsSaved(name, se.swaps.size, added.length, removed.length, factionLines),
								},
								excludeSteamIds,
							).catch((error) => {
								if (!isAbortError(error)) log.error(error)
							})
						}
						break
					}

					case 'notify-upcoming-teamswaps': {
						await SquadRcon.warnAll(ctx, se.players, WARNS.teamswaps.notifyPlayerOfUpcomingTeamswap)
						break
					}

					case 'notify-teamswaps-cancelled': {
						await SquadRcon.warnAll(ctx, se.players, WARNS.teamswaps.notifyTeamswapCancelled)
						break
					}

					case 'teamswap-execution-failed': {
						log.error(
							'teamswap execution failed (%s): %s',
							se.reason,
							se.message ?? (se.playerIds ? `${se.playerIds.length} player(s) never swapped` : ''),
						)
						C.setSpanStatus('error')
						break
					}

					case 'end-all-teamswap-editing': {
						UserPresenceSys.dispatchEndAllTeamswapEditing(ctx.serverId)
						break
					}

					case 'teamswaps-executed':
					case 'op-outcome':
						break

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
			const errors = await dispatchOp(ctx, [op])
			MapUtils.assign(opErrors, errors)
		}

		return opErrors
	},
)

export async function dispatchRevertToSaved(ctx: C.Teamswap & C.ServerSlice & C.Db) {
}

export async function dispatchClearSwaps(ctx: C.Teamswap & C.ServerSlice & C.Db, source?: TSW.Teamswap['source']) {
	const opId = TSW.createOpId()
	const errors = await dispatchOp(ctx, [{ opId, code: 'clear-teamswaps', save: true, source }])
	return errors.get(opId) ?? []
}

export async function dispatchSwapNow(
	ctx: C.Teamswap & C.ServerSlice & C.Db,
	swaps: TSW.TeamswapCollection,
	source: TSW.Teamswap['source'],
) {
	const opId = TSW.createOpId()
	const errors = await dispatchOp(ctx, [{ opId, code: 'swap-now', swaps, source }])
	return errors.get(opId) ?? []
}

export async function dispatchSwapNext(
	ctx: C.Teamswap & C.ServerSlice & C.Db,
	swaps: TSW.TeamswapCollection,
) {
	// dispatch each add on its own -- a batch is all-or-nothing (a rejection discards the whole batch),
	// so batching would let one already-marked player block swapping everyone else
	const errors: unknown[] = []
	for (const [playerId, { toTeam, source }] of swaps.entries()) {
		const opErrors = await dispatchOp(ctx, [{
			opId: TSW.createOpId(),
			code: 'add-player-teamswap',
			playerId,
			toTeam,
			source,
			saved: true,
		}])
		for (const errs of opErrors.values()) errors.push(...errs)
	}
	return errors
}
