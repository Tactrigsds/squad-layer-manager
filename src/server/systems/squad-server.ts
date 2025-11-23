import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes'
import { AsyncResource, distinctDeepEquals, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as DH from '@/lib/display-helpers'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { matchLog } from '@/lib/log-parsing'
import * as Obj from '@/lib/object'
import type { DecodedPacket } from '@/lib/rcon/core-rcon'
import Rcon from '@/lib/rcon/core-rcon'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import { SftpTail, type SftpTailOptions } from '@/lib/sftp-tail'
import { SquadEventEmitter } from '@/lib/squad-log-parser/squad-event-emitter.ts'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import { HumanTime } from '@/lib/zod'
import * as Messages from '@/messages.ts'
import type * as BAL from '@/models/balance-triggers.models'
import * as CHAT from '@/models/chat.models.ts'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import type * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import orpcBase from '@/server/orpc-base'
import * as Commands from '@/server/systems/commands'
import * as LayerQueue from '@/server/systems/layer-queue.ts'
import * as MatchHistory from '@/server/systems/match-history.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as SharedLayerList from '@/server/systems/shared-layer-list.server'
import * as SquadRcon from '@/server/systems/squad-rcon'
import * as Otel from '@opentelemetry/api'
import * as Orpc from '@orpc/server'
import { Mutex } from 'async-mutex'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { baseLogger } from '../logger'

const tracer = Otel.trace.getTracer('squad-server')

type State = {
	slices: Map<string, C.ServerSlice>
	// wsClientId => server id
	selectedServers: Map<string, string>
	selectedServerUpdate$: Rx.Subject<{ wsClientId: string; serverId: string }>
	debug__ticketOutcome?: SM.Events.DebugTicketOutcome
}

export let state!: State
export type SquadServer = {
	layersStatusExt$: Rx.Observable<SM.LayersStatusResExt>

	adminList: AsyncResource<SM.AdminList, CS.Log & C.Rcon>

	postRollEventsSub: Rx.Subscription | null

	historyConflictsResolved$: Promise<unknown>

	serverRolling$: Rx.BehaviorSubject<boolean>

	sftpReader: SftpTail
	state: {
		roundWinner: SM.SquadOutcomeTeam | null
		roundLoser: SM.SquadOutcomeTeam | null
		roundEndState: {
			winner: string | null
			layer: string
		} | null
	}
	eventBuffer: SM.Events.Event[]
	event$: Rx.Subject<SM.Events.Event>
	// chat: {
	// 	// users: Map<string, UserStatus>
	// 	buffer: CHAT.Event[]
	// }
} & SquadRcon.SquadRconContext

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<CS.Log>
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>

export async function setup() {
	const ctx = getBaseCtx()

	state = {
		slices: new Map(),
		selectedServers: new Map(),
		selectedServerUpdate$: new Rx.Subject(),
	}
	const ops: Promise<void>[] = []

	for (const serverConfig of CONFIG.servers) {
		ops.push((async function initServer() {
			const serverState = await DB.runTransaction(ctx, async () => {
				let [server] = await ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, serverConfig.id)).for('update')
				server = unsuperjsonify(Schema.servers, server) as typeof server
				if (!server) {
					ctx.log.info(`Server ${serverConfig.id} not found, creating new`)
					server = {
						id: serverConfig.id,
						displayName: serverConfig.displayName,
						settings: SS.ServerSettingsSchema.parse({ connections: serverConfig.connections }),
						layerQueue: [],
						layerQueueSeqId: 0,
						lastRoll: null,
					}
					await ctx.db().insert(Schema.servers).values(superjsonify(Schema.servers, server))
				} else {
					ctx.log.info(`Server ${serverConfig.id} found, ensuring settings are up-to-date`)

					let update = false
					if (server.displayName !== serverConfig.displayName) {
						update = true
						server.displayName = serverConfig.displayName
					}
					const oldSettings = server.settings
					server.settings = SS.ServerSettingsSchema.parse({ ...(oldSettings as object), connections: serverConfig.connections })

					if (!Obj.deepEqual(server.settings, oldSettings)) update = true
					if (update) {
						ctx.log.info(`Server ${serverConfig.id} settings updated`)
						await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, server)).where(E.eq(Schema.servers.id, serverConfig.id))
					} else {
						ctx.log.info(`Server ${serverConfig.id} settings are up-to-date`)
					}
				}

				return server as SS.ServerState
			})

			if (!serverState) throw new Error(`Server ${serverConfig.id} was unable to be configured`)
			await instantiateServer(ctx, serverState)
		})())
	}

	await Promise.all(ops)
}

async function instantiateServer(ctx: CS.Log & C.Db & C.Mutexes, serverState: SS.ServerState) {
	const layersStatus: SquadServer['layersStatus'] = new AsyncResource('serverStatus', (ctx) => SquadRcon.getLayerStatus(ctx), {
		defaultTTL: 5000,
	})

	const serverId = serverState.id
	const settings = serverState.settings

	const rcon = new Rcon({ serverId: serverId, settings: settings.connections!.rcon })

	const layersStatusExt$: SquadServer['layersStatusExt$'] = getLayersStatusExt$(serverId)

	const adminListTTL = HumanTime.parse('1h')
	const adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })

	const sub = new Rx.Subscription()

	const rconEvent$: Rx.Observable<SM.RconEvents.Event> = Rx.fromEvent(rcon, 'server').pipe(
		Rx.concatMap((_pkt): Rx.Observable<SM.RconEvents.Event> => {
			const pkt = _pkt as DecodedPacket
			const ctx = getBaseCtx()
			for (const matcher of SM.RCON_EVENT_MATCHERS) {
				const [event, err] = matchLog(pkt.body, matcher)
				if (err) {
					ctx.log.error(err, `Error matching event, `, (err as any)?.message)
					return Rx.EMPTY
				}
				if (event) return Rx.of(event)
			}
			return Rx.EMPTY
		}),
		Rx.share(),
	)
	const sftpReader = new SftpTail(ctx, {
		filePath: settings.connections!.sftp.logFile,
		host: settings.connections!.sftp.host,
		port: settings.connections!.sftp.port,
		username: settings.connections!.sftp.username,
		password: settings.connections!.sftp.password,
		pollInterval: CONFIG.squadServer.sftpPollInterval,
		reconnectInterval: CONFIG.squadServer.sftpReconnectInterval,
	})

	sftpReader.watch()

	const server: SquadServer = {
		layersStatusExt$,
		...SquadRcon.initSquadRcon(ctx, serverId, settings.connections!.rcon, sub),

		adminList,
		postRollEventsSub: null,

		historyConflictsResolved$: Rx.firstValueFrom(rcon.connected$.pipe(
			Rx.tap({
				subscribe: () => {
					ctx.log.info('trying to resolve potential current match conflict, waiting for rcon connection...')
				},
			}),
			Rx.concatMap(async (connected) => {
				if (!connected) return Rx.EMPTY
				const ctx = { ...getBaseCtx(), ...slice }

				const statusRes = await layersStatus.get(ctx)
				if (statusRes.code === 'err:rcon') return Rx.EMPTY
				await MatchHistory.resolvePotentialCurrentLayerConflict(ctx, statusRes.data.currentLayer)
				ctx.log.info('rcon connection established, current layer synced with match history')
				return Rx.of(1)
			}),
			Rx.concatAll(),
			Rx.retry(5),
		)),

		serverRolling$: new Rx.BehaviorSubject<boolean>(false),

		sftpReader,
		eventBuffer: [],
		event$: new Rx.Subject(),
	}

	server.sftpReader.on(
		'line',
		C.spanOp('squad-log-event-emitter:on-line-parsed', { tracer, eventLogLevel: 'trace', root: true }, async (line: string) => {
			const ctx = C.pushOtelCtx(C.initLocks(resolveSliceCtx(getBaseCtx(), serverId)))
			for (const matcher of SM.LogEvents.EventMatchers) {
				try {
					const [matched, error] = matchLog(line, matcher)
					if (!matched) continue
					if (error) {
						return {
							code: 'err:failed-to-parse-log-line' as const,
							error,
						}
					}
					const event = processServerLogEvent(ctx, matched)
					if (event) {
						ctx.log.info(event, 'Emitting Squad Event: %s', event.type)
						ctx.server.event$.next([ctx, event])
					}
					return { code: 'ok' as const }
				} catch (error) {
					C.recordGenericError(error)
				}
			}
		}),
	)

	const slice: C.ServerSlice = {
		serverId,

		server,
		rcon,

		matchHistory: MatchHistory.initMatchHistoryContext(),

		layerQueue: LayerQueue.initLayerQueueContext(),

		vote: {
			autostartVoteSub: null,
			voteEndTask: null,
			state: null,
			mtx: new Mutex(),

			update$: new Rx.Subject<V.VoteStateUpdate>(),
		},
		serverSliceSub: sub,
		sharedList: SharedLayerList.getDefaultState(serverState),
	}

	rcon.ensureConnected(ctx)

	state.slices.set(serverId, slice)

	sub.add(
		slice.matchHistory.update$.pipe(Rx.startWith(0)).subscribe(() => {
			const ctx = { ...getBaseCtx(), ...slice }
			const currentMatch = MatchHistory.getCurrentMatch(ctx)
			if (!currentMatch) return
			ctx.log.info('active match id: %s, status: %s', currentMatch.historyEntryId, currentMatch.status)
		}),
	)

	sub.add(
		rconEvent$.pipe(
			C.durableSub(
				'squad-server:handle-rcon-event',
				{ tracer, ctx, eventLogLevel: 'trace', taskScheduling: 'parallel', root: true },
				async (event) => {
					const ctx = C.initLocks(resolveSliceCtx(getBaseCtx(), serverId))
					if (event.type === 'CHAT_MESSAGE' && event.message.startsWith(CONFIG.commandPrefix)) {
						await Commands.handleCommand(ctx, event)
					} else if (event.type === 'CHAT_MESSAGE' && event.message.trim().match(/^\d+$/)) {
						LayerQueue.handleVote(ctx, event)
					}
				},
			),
		).subscribe(),
	)

	sub.add(
		slice.server.logEmitter.event$.pipe(
			Rx.filter(([_, e]) => ['NEW_GAME', 'ROUND_ENDED'].includes(e.type)),
			C.durableSub(
				'squad-server:handle-squad-game-event',
				{ tracer, ctx, eventLogLevel: 'info' },
				async ([_ctx, event]) => {
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)
					switch (event.type) {
						case 'NEW_GAME': {
							// we don't do anything in here right now -- that's all handled separately in some more complicated logic
							break
						}
						case 'ROUND_ENDED': {
							const statusRes = await ctx.server.layersStatus.get(ctx, { ttl: 0 })
							if (statusRes.code !== 'ok') return statusRes
							// -------- use debug ticketOutcome if one was set --------
							if (state.debug__ticketOutcome) {
								let winner: SM.TeamId | null
								let loser: SM.TeamId | null
								if (state.debug__ticketOutcome.team1 === state.debug__ticketOutcome.team2) {
									winner = null
									loser = null
								} else {
									winner = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 > 0 ? 1 : 2
									loser = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 < 0 ? 1 : 2
								}
								const partial = L.toLayer(statusRes.data.currentLayer)
								const teams: SM.SquadOutcomeTeam[] = [
									{
										faction: partial.Faction_1!,
										unit: partial.Unit_1!,
										team: 1,
										tickets: state.debug__ticketOutcome.team1,
									},
									{
										faction: partial.Faction_2!,
										unit: partial.Unit_2!,
										team: 2,
										tickets: state.debug__ticketOutcome.team2,
									},
								]
								const winnerTeam = teams.find(t => t?.team && t.team === winner) ?? null
								const loserTeam = teams.find(t => t?.team && t.team === loser) ?? null
								event = {
									...event,
									loser: loserTeam,
									winner: winnerTeam,
								}
								delete state.debug__ticketOutcome
							}
							const res = await MatchHistory.finalizeCurrentMatch(ctx, statusRes.data.currentLayer.id, event)
							return res
						}

							// default:
							// 	assertNever(event)
					}
				},
			),
		).subscribe(),
	)

	await MatchHistory.loadState({ ...ctx, ...slice })
	await LayerQueue.init({ ...ctx, ...slice })
	SharedLayerList.init({ ...ctx, ...slice })
	initNewGameHandling({ ...ctx, ...slice })
}

// -------- Init Interpretation/matching of current layer updates from the game server for the purposes of syncing it with the queue & match history --------
function initNewGameHandling(ctx: C.ServerSlice & CS.Log & C.Db & C.Mutexes) {
	const serverId = ctx.serverId
	const currentLayerChanged$ = ctx.server.layersStatus.observe(ctx)
		.pipe(
			Rx.concatMap(statusRes => statusRes.code === 'ok' ? Rx.of(statusRes.data.currentLayer) : Rx.EMPTY),
			Rx.pairwise(),
			Rx.filter(([prevLayer, currentLayer]) => prevLayer.id !== currentLayer.id),
			Rx.map(([_, currentLayer]) => currentLayer),
			// make sure the encapsulated state of this observable is stable for the pairing process below
			Rx.share(),
		)

	// if we have to handle multiple effects from NEW_GAME we may want to ensure the order in which those effects are processed instead of just reading straight from event$
	const newGame$ = ctx.server.logEmitter.event$.pipe(
		Rx.concatMap(([_, event]) => event.type === 'NEW_GAME' ? Rx.of(event) : Rx.EMPTY),
	)
	let triggerWait$ = Rx.merge(
		currentLayerChanged$.pipe(Rx.map((layer) => ['new-layer' as const, layer] as const)),
		newGame$.pipe(Rx.map((event) => ['new-game' as const, event] as const)),
	)

	// @ts-expect-error wait for the startup history reconiliation to complete before listening for new games
	triggerWait$ = Rx.concat(
		Rx.from(ctx.server.historyConflictsResolved$).pipe(Rx.filter(() => false)),
		triggerWait$,
	)

	// pair off detected new layers via RCON with NEW_GAME events from the logs (which we may receive in any order and within a fairly wide window), and handle them in a reasonably durable way
	ctx.serverSliceSub.add(
		triggerWait$
			.pipe(
				Rx.map(args => [resolveSliceCtx(getBaseCtx(), serverId), ...args] as const),
				C.durableSub('squad-server:handle-new-layer', {
					// exhaustMap means we ignore subsequent emissions until the current one is processed
					taskScheduling: 'exhaust',
					ctx,
					tracer,
				}, async ([ctx, triggerType, payload]) => {
					if (ctx.server.serverRolling$.value) {
						ctx.log.error('Server is rolling, skipping new game trigger. This should never happen')
						return Rx.EMPTY
					}
					try {
						ctx.server.serverRolling$.next(true)

						let newGameEvent: SM.Events.NewGame | undefined
						let newLayer: L.UnvalidatedLayer

						ctx.log.info('Handling new game trigger: %s', triggerType)

						// the timeout threshold we choose matters here -- since the UE5 upgrade squad servers have not been good at outputting RCON events during a map roll which can last a long time, which has lead to issues here in the past. The tolerences here need to be fairly loose for that reason.
						const timeoutThreshold = 40_000

						const timeout$ = Rx.timer(timeoutThreshold).pipe(
							Rx.map(() => 'timeout' as const),
						)
						// if we receive two NEW_GAME events or two new layers, that's a problem and we're just going to refuse to deal with it for now.
						const doubleEvent$ = triggerWait$.pipe(
							Rx.concatMap(([e]) => e === triggerType ? Rx.of('double-event' as const) : Rx.EMPTY),
						)
						if (triggerType === 'new-game') {
							newGameEvent = payload
							ctx.log.debug('Received NEW_GAME event, waiting for layer change')

							const out = await Rx.firstValueFrom(Rx.race(
								currentLayerChanged$,
								doubleEvent$,
								timeout$,
							))

							if (out === 'double-event') {
								ctx.log.error('Double event detected: %s', triggerType)
								return
							} else if (out === 'timeout') {
								ctx.log.warn('Timeout reached while waiting for %s, just trying whatever layer is set currently...', 'currentLayerChanged')
								const statusRes = await ctx.server.layersStatus.get(ctx)
								if (statusRes.code === 'err:rcon') {
									ctx.log.warn('RCON error while waiting for %s', 'currentLayerChanged')
									return
								}
								ctx.log.info('Found current layer %s', DH.displayLayer(statusRes.data.currentLayer))
								newLayer = statusRes.data.currentLayer
							} else {
								ctx.log.debug('Layer changed to %s', DH.displayLayer(out))
								newLayer = out
							}
						} else {
							newLayer = payload
							ctx.log.debug('Detected layer change to %s, waiting for NEW_GAME event', DH.displayLayer(newLayer))
							const out = await Rx.firstValueFrom(Rx.race(
								newGame$,
								doubleEvent$,
								timeout$,
							))

							if (out === 'double-event') {
								ctx.log.error('Double event detected: %s', triggerType)
								return
							} else if (out === 'timeout') {
								ctx.log.warn('Timeout reached while waiting for %s', 'NEW_GAME')
							} else {
								ctx.log.debug('Received NEW_GAME event')
								newGameEvent = out
							}
						}

						ctx.log.info('Processing new game with layer %s and event: %o', DH.displayLayer(newLayer), newGameEvent)
						await LayerQueue.handleNewGame(ctx, newLayer, newGameEvent)
					} finally {
						ctx.server.serverRolling$.next(false)
					}
				}),
			).subscribe(),
	)
}

export function destroyServer(ctx: C.ServerSlice & CS.Log) {
	ctx.serverSliceSub.unsubscribe()
	void ctx.server.logEmitter.disconnect()
	ctx.rcon.disconnect(ctx)
	ctx.matchHistory.update$.complete()

	state.slices.delete(ctx.serverId)
	for (const [wsClientId, serverId] of Array.from(state.selectedServers.entries())) {
		if (ctx.serverId === serverId) state.selectedServers.delete(wsClientId)
	}
}

export async function getFullServerState(ctx: C.Db & CS.Log & C.LayerQueue) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
	let serverRaw: any
	if (ctx.tx) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

function getLayersStatusExt$(
	serverId: string,
) {
	return new Rx.Observable<SM.LayersStatusResExt>(s => {
		const ctx = { ...getBaseCtx(), ...state.slices.get(serverId)! }
		const sub = new Rx.Subscription()
		sub.add(
			ctx.server.layersStatus.observe(ctx).subscribe({
				next: async () => {
					s.next(await fetchLayersStatusExt(ctx))
				},
				error: (err) => s.error(err),
				complete: () => s.complete(),
			}),
		)
		sub.add(ctx.matchHistory.update$.subscribe({
			next: async () => {
				s.next(await fetchLayersStatusExt(ctx))
			},
			error: (err) => s.error(err),
			complete: () => s.complete(),
		}))
		return () => sub.unsubscribe()
	}).pipe(distinctDeepEquals(), Rx.share())
}

async function fetchLayersStatusExt(ctx: CS.Log & C.SquadServer & C.MatchHistory) {
	const statusRes = await ctx.server.layersStatus.get(ctx)
	if (statusRes.code !== 'ok') return statusRes
	return buildServerStatusRes(statusRes.data, MatchHistory.getCurrentMatch(ctx))
}

function buildServerStatusRes(rconStatus: SM.LayersStatus, currentMatch: MH.MatchDetails) {
	const res: SM.LayersStatusResExt = { code: 'ok' as const, data: { ...rconStatus } }
	if (currentMatch && L.areLayersCompatible(currentMatch.layerId, rconStatus.currentLayer)) {
		res.data.currentMatch = currentMatch
	}
	return res
}

// resolves a default server id for a request given the route and a previously stored default server id
export function manageDefaultServerIdForRequest<Ctx extends C.HttpRequest>(ctx: Ctx) {
	const defaultServerId = ctx.cookies['default-server-id']

	let serverId: string | undefined
	if (ctx.route?.id === AR.route('/servers/:id')) {
		serverId = ctx.route.params.id
	} else if (defaultServerId) {
		serverId = defaultServerId
	} else {
		serverId = (state.slices.keys().next().value)!
	}

	if (defaultServerId && serverId === defaultServerId) return ctx
	const res = ctx.res.setCookie(AR.COOKIE_KEY.Values['default-server-id'], serverId)
	return {
		...ctx,
		res,
	}
}

export function resolveWsClientSliceCtx(ctx: C.OrpcBase) {
	let serverId = state.selectedServers.get(ctx.wsClientId)
	serverId ??= CONFIG.servers[0].id
	if (!serverId) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'No server selected' })
	const slice = state.slices.get(serverId)
	if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server slice not found' })
	return {
		...ctx,
		...slice,
	}
}

export function resolveSliceCtx<T extends object>(ctx: T, serverId: string) {
	const slice = state.slices.get(serverId)
	if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server slice not found' })
	return {
		...ctx,
		...slice,
	}
}

function getBaseCtx() {
	return C.initLocks(DB.addPooledDb({ log: baseLogger }))
}

export function selectedServerCtx$<Ctx extends C.WSSession>(ctx: Ctx) {
	return state.selectedServerUpdate$.pipe(
		Rx.concatMap(s => s.wsClientId === ctx.wsClientId ? Rx.of(s.serverId) : Rx.EMPTY),
		Rx.startWith(state.selectedServers.get(ctx.wsClientId)!),
		Rx.map(serverId => resolveSliceCtx(ctx, serverId)),
	)
}

/**
 * Performs state tracking and event consolidation for squad log events.
 * @param ctx The context of the log event.
 * @param logEvt The log event to process.
 * @returns an event if one should be emitted
 */
function processServerLogEvent(ctx: CS.Log & C.SquadServer, logEvt: SM.LogEvents.Event): SM.Events.Event | undefined {
	const server = ctx.server
	switch (logEvt.type) {
		case 'ROUND_DECIDED': {
			const prop = logEvt.action === 'won' ? 'roundWinner' : 'roundLoser'
			server.state[prop] = {
				faction: logEvt.faction,
				unit: logEvt.unit,
				team: logEvt.team,
				tickets: logEvt.tickets,
			}
			break
		}

		// TODO: might be able to remove that case and backing code
		case 'ROUND_TEAM_OUTCOME': {
			server.state.roundEndState = {
				// ported from existing behavior from squadjs -- unsure why it exists though https://github.com/Tactrigsds/SquadJS/blob/psg/squad-server/log-parser/round-winner.js
				winner: server.state.roundEndState ? logEvt.winner : null,
				layer: logEvt.layer,
			}
			break
		}

		case 'ROUND_ENDED': {
			const event: SM.Events.RoundEnded = {
				type: 'ROUND_ENDED',
				time: logEvt.time,
				loser: server.state.roundLoser,
				winner: server.state.roundWinner,
			}
			server.state.roundLoser = null
			server.state.roundWinner = null
			return event
		}

		case 'NEW_GAME': {
			if (logEvt.layerClassname === 'TransitionMap') return
			return logEvt satisfies SM.LogEvents.NewGame
		}

		default:
			assertNever(logEvt)
	}
}

export function processServerRconEvent(ctx: CS.Log & C.SquadServer, logEvt: SM.RconEvents.Event) {
	const server = ctx.server
}

export const orpcRouter = {
	setSelectedServer: orpcBase
		.input(z.string())
		.handler(async ({ context, input: serverId }) => {
			const slice = state.slices.get(serverId)
			if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server not found' })
			state.selectedServers.set(context.wsClientId, serverId)
			state.selectedServerUpdate$.next({ wsClientId: context.wsClientId, serverId })
			return { code: 'ok' as const }
		}),

	watchLayersStatus: orpcBase.handler(async function*({ context, signal }) {
		const obs = selectedServerCtx$(context)
			.pipe(
				Rx.switchMap(ctx => {
					return Rx.concat(fetchLayersStatusExt(ctx), ctx.server.layersStatusExt$)
				}),
				withAbortSignal(signal!),
			)
		yield* toAsyncGenerator(obs)
	}),

	watchServerRolling: orpcBase.handler(async function*({ context, signal }) {
		const obs = selectedServerCtx$(context)
			.pipe(
				Rx.switchMap(ctx => {
					return ctx.server.serverRolling$
				}),
				withAbortSignal(signal!),
			)
		yield* toAsyncGenerator(obs)
	}),

	watchServerInfo: orpcBase.handler(async function*({ context, signal }) {
		const obs = selectedServerCtx$(context)
			.pipe(
				Rx.switchMap(ctx => {
					return ctx.server.serverInfo.observe(ctx).pipe(
						distinctDeepEquals(),
					)
				}),
				withAbortSignal(signal!),
			)
		yield* toAsyncGenerator(obs)
	}),

	endMatch: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = resolveWsClientSliceCtx(_ctx)
		const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:end-match'))
		if (deniedRes) return deniedRes
		SquadRcon.endMatch(ctx)
		await SquadRcon.warnAllAdmins(ctx, Messages.BROADCASTS.matchEnded(ctx.user))
		return { code: 'ok' as const }
	}),

	toggleFogOfWar: orpcBase
		.input(z.object({ disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveWsClientSliceCtx(_ctx)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:turn-fog-off'))
			if (denyRes) return denyRes
			const serverStatusRes = await ctx.server.layersStatus.get(ctx)
			if (serverStatusRes.code !== 'ok') return serverStatusRes
			await SquadRcon.setFogOfWar(ctx, input.disabled ? 'off' : 'on')
			if (input.disabled) {
				await SquadRcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
			}
			return { code: 'ok' as const }
		}),
}
