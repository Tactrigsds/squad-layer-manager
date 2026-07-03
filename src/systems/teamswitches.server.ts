import * as Schema from '$root/drizzle/schema.ts'
import * as Arr from '@/lib/array'
import { sleep, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { withThrown, withThrownAsync } from '@/lib/error'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import { destrNullable } from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import { WARNS } from '@/messages'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswitches.models'
import * as UP from '@/models/user-presence'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UserPresence from '@/systems/user-presence.server'
import { E_TIMEOUT, Mutex, MutexInterface, withTimeout } from 'async-mutex'
import * as E from 'drizzle-orm'
import * as Rx from 'rxjs'
import { z } from 'zod'

export const module = initModule('teamswitches')

let log!: CS.Logger

async function resolveSourceName(
	ctx: C.Db,
	source: TSW.Teamswitch['source'],
	players?: { ids: SM.PlayerIds.Schema }[],
): Promise<string> {
	if (source.discordId) {
		const [user] = await ctx.db()
			.select({ name: Schema.users.nickname, username: Schema.users.username })
			.from(Schema.users)
			.where(E.eq(Schema.users.discordId, source.discordId))
		return (user?.name || user?.username) ?? 'Admin'
	}
	if (source.steamId && players) {
		const player = players.find(p => p.ids.steam === source.steamId)
		return player?.ids.usernameNoTag ?? player?.ids.username ?? 'Admin'
	}
	return 'Admin'
}

type Session = RbSyncState.Server.Session<TSW.Op, TSW.State, TSW.SideEffect>

export type TeamswitchContext = {
	session: Session
	// outgoing operations
	op$: IsolatedSubject<TSW.Op[]>
	dispatchMtx: MutexInterface
	teamswitchExecutedAt: number | null
	haveReadSavedSwitchesFromDb: boolean
}
export function setup() {
	log = module.getLogger()
}

export function initContext(ctx: C.SquadServer & C.Db & C.ServerSliceCleanup) {
	const serverId = ctx.serverId
	const context: TeamswitchContext = {
		session: RbSyncState.Server.initSession(TSW.initState(), {}),
		op$: new IsolatedSubject<TSW.Op[]>(),
		dispatchMtx: new Mutex(),
		teamswitchExecutedAt: null,
		haveReadSavedSwitchesFromDb: false,
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
							opId: TSW.createOpId(),
							code: 'teamswitch-execution-completed',
						})
					} else {
						ops.push({
							opId: TSW.createOpId(),
							code: 'teamswitch-execution-failed',
							reason: 'not-all-players-switched',
							playerIds: Array.from(missingPlayers),
						})
					}
				}
				const ops: TSW.Op[] = []
				if (e.type === 'PLAYER_CONNECTED') {
					if (e.player.teamId === null) return
					const team = MH.getNormedTeamId(e.player.teamId, match.ordinal)
					ops.push({
						opId: TSW.createOpId(),
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
						opId: TSW.createOpId(),
						code: 'reset-players',
						players,
					})
					tryEndSwitching()
					restoreSavedBlock: if (!ctx.teamswitches.haveReadSavedSwitchesFromDb) {
						ctx.teamswitches.haveReadSavedSwitchesFromDb = true
						const serverState = await SquadServer.getServerState(ctx)
						if (!serverState.teamswitches) break restoreSavedBlock
						const { matchHistoryEntryId, switches } = serverState.teamswitches
						if (matchHistoryEntryId === match.historyEntryId) {
							ops.push({
								opId: TSW.createOpId(),
								code: 'init-saved-teamswitches',
								switches,
							})
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
				await dispatchOp(ctx, { opId: TSW.createOpId(), code: 'execute-teamswitches' })
			}),
		).subscribe(),
	)

	return context
}

function getState(ctx: C.Teamswitch) {
	return ctx.teamswitches.session.state
}

function buildFactionLines(
	playerIds: SM.PlayerId[],
	switches: TSW.TeamswitchCollection,
	players: { ids: SM.PlayerIds.Schema }[],
	layer: { Faction_1: string; Faction_2: string } | null | undefined,
	ordinal: number,
): string[] {
	const groups = new Map<MH.NormedTeamId, { faction: string; names: string[] }>()
	for (const playerId of playerIds) {
		const toTeam = switches.get(playerId)?.toTeam
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
		const obs = SquadServer.sliceCtx$(context.wsClientId, input.serverId).pipe(
			withAbortSignal(signal!),
			Rx.switchMap((ctx) => {
				if (!ctx) return Rx.EMPTY
				const init: TSW.UpdateForClient = {
					code: 'init',
					state: ctx.teamswitches.session.state,
					ops: ctx.teamswitches.session.ops,
				}
				return ctx.teamswitches.op$.pipe(Rx.map((ops): TSW.UpdateForClient => ({ code: 'op', ops })), Rx.startWith(init))
			}),
		)
		yield* toAsyncGenerator(obs)
	}),

	// TODO we need to filter errors back to the client that might have occured while handling side-effects
	dispatchOp: orpcBase.meta({ type: 'mutation' }).input(z.object({ serverId: z.string(), op: TSW.OpSchema })).handler(
		async ({ context, input: { serverId, op: input } }) => {
			const ctx = SquadServer.resolveSliceCtx(context, serverId)
			const source = 'source' in input ? input.source : undefined
			if (!source?.discordId || source.discordId !== ctx.user.discordId) {
				return { code: 'err:invalid-source' as const }
			}
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			await dispatchOp(ctx, input)
		},
	),
}

const dispatchOp = C.spanOp(
	'dispatchOp',
	{ module, mutexes: (ctx) => ctx.teamswitches.dispatchMtx, extraText: (ctx, ...ops) => ops.map(o => o.code).join(',') },
	async (ctx: C.Teamswitch & C.ServerSlice & C.Db, ...ops: TSW.Op[]) => {
		const sideEffects: TSW.SideEffect[] = []
		ctx.teamswitches.session = RbSyncState.Server.applyOps(ctx.teamswitches.session, ops, TSW.reducer, {
			onSideEffect: (se) => sideEffects.push(se),
		})
		ctx.teamswitches.op$.next(ops)

		const opErrors = new Map<string, (TSW.OpError | unknown)[]>()
		const addError = (opId: string, error: TSW.OpError | unknown) => {
			const errors = MapUtils.defaultInsGet(opErrors, opId, [])
			errors.push(error)
			opErrors.set(opId, errors)
		}

		const nextOps: TSW.Op[] = []
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
							const isManual = ops.find(o => o.opId === se.opId && (o as any).source) as
								| (TSW.Op & { source: TSW.Teamswitch['source'] })
								| undefined
							if (isManual) {
								sleep(500).then(() => SquadRcon.warnAll(ctx, toSwitch, WARNS.teamswitches.notifyManualSwitch))
							}
							await switched$
							ctx.teamswitches.teamswitchExecutedAt = Date.now()
							if (isManual) {
								const name = await resolveSourceName(ctx, isManual.source, teamsRes.players)
								const excludeSteamIds = isManual.source.steamId
									? new Set([isManual.source.steamId])
									: undefined
								const layerRes = L.parseLayerId(currentMatch.layerId)
								const layer = 'layer' in layerRes ? layerRes.layer : null
								const factionLines = toSwitch.length <= 8
									? buildFactionLines(toSwitch, se.switches, teamsRes.players, layer, currentMatch.ordinal)
									: undefined
								void SquadRcon.warnAllAdmins(
									ctx,
									{ msg: WARNS.teamswitches.notifyAdminManualSwitch(name, toSwitch.length, factionLines) },
									excludeSteamIds,
								)
							}

							await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
								await SquadServer.updateServerState(ctx, { teamswitches: null }, { type: 'system', event: 'teamswitches-saved' })
							})

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
								opId: TSW.createOpId(),
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
						const currentMatch = await MatchHistory.getCurrentMatch(ctx)
						const saved = se.switches.size > 0
							? { switches: se.switches, matchHistoryEntryId: currentMatch.historyEntryId }
							: null
						await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
							await SquadServer.updateServerState(ctx, { teamswitches: saved }, { type: 'system', event: 'teamswitches-saved' })
						})
						if (se.source) {
							const name = await resolveSourceName(ctx, se.source)
							const excludeSteamIds = se.source.steamId
								? new Set([se.source.steamId])
								: undefined
							const layerRes = L.parseLayerId(currentMatch.layerId)
							const layer = 'layer' in layerRes ? layerRes.layer : null
							const currPlayers = SquadServer.getCurrTeams(ctx)?.players ?? []
							const factionLines = se.switches.size <= 8
								? buildFactionLines(Array.from(se.switches.keys()), se.switches, currPlayers, layer, currentMatch.ordinal)
								: undefined
							void SquadRcon.warnAllAdmins(
								ctx,
								{ msg: WARNS.teamswitches.notifyAdminSwitchesSaved(name, se.switches.size, se.prevSaved.size, factionLines) },
								excludeSteamIds,
							)
						}
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

					case 'teamswitches-executed':
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
			const errors = await dispatchOp(ctx, op)
			MapUtils.assign(opErrors, errors)
		}

		return opErrors
	},
)

export async function dispatchRevertToSaved(ctx: C.Teamswitch & C.ServerSlice & C.Db) {
}

export async function dispatchClearSwitches(ctx: C.Teamswitch & C.ServerSlice & C.Db, source?: TSW.Teamswitch['source']) {
	const opId = TSW.createOpId()
	await dispatchOp(ctx, { opId, code: 'clear-teamswitches', save: true, source })
}

export async function dispatchSwitchNow(
	ctx: C.Teamswitch & C.ServerSlice & C.Db,
	switches: TSW.TeamswitchCollection,
	source: TSW.Teamswitch['source'],
) {
	const opId = TSW.createOpId()
	const errors = await dispatchOp(ctx, { opId, code: 'switch-now', switches, source })
	return errors.get(opId) ?? []
}

export async function dispatchSwitchNext(
	ctx: C.Teamswitch & C.ServerSlice & C.Db,
	switches: TSW.TeamswitchCollection,
) {
	const ops = Array.from(switches.entries()).map(([playerId, { toTeam, source }]) => ({
		opId: TSW.createOpId(),
		code: 'add-player-teamswitch' as const,
		playerId,
		toTeam,
		source,
		saved: true,
	}))
	const allErrors = await dispatchOp(ctx, ...ops)
	return ops.flatMap(op => allErrors.get(op.opId) ?? [])
}

function resolveCtx(serverId: string) {
	return SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
}

function getBaseCtx() {
	return DB.addPooledDb(CS.init())
}
