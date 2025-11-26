import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes'
import { AsyncResource, distinctDeepEquals, registerCleanup, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as DH from '@/lib/display-helpers'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { matchLog } from '@/lib/log-parsing'
import * as Obj from '@/lib/object'
import Rcon from '@/lib/rcon/core-rcon'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import { SftpTail } from '@/lib/sftp-tail'
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
	debug__ticketOutcome?: { team1: number; team2: number }
}

export let globalState!: State
export type SquadServer = {
	layersStatusExt$: Rx.Observable<SM.LayersStatusResExt>

	postRollEventsSub: Rx.Subscription | null

	historyConflictsResolved$: Promise<unknown>

	serverRolling$: Rx.BehaviorSubject<Date | null>

	sftpReader: SftpTail
	state: {
		roundWinner: SM.SquadOutcomeTeam | null
		roundLoser: SM.SquadOutcomeTeam | null
		roundEndState: {
			winner: string | null
			layer: string
		} | null

		// chainID -> playerids
		joinRequests: Map<number, SM.PlayerIds.IdQuery>

		// server version of chat state which can be replicated to users
		chat: CHAT.ChatState | null
	}

	// intermediate event so that initNewGameHandling's behaviour is downstream from event$
	beforeNewGame$: Rx.Subject<[CS.Log, SM.LogEvents.NewGame]>

	event$: Rx.Subject<[CS.Log & C.ServerSlice, SM.Events.Event]>
	chatSync$: Rx.Subject<[CS.Log, CHAT.SyncEvent]>
} & SquadRcon.SquadRcon

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<CS.Log>
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>

export async function setup() {
	const ctx = getBaseCtx()

	globalState = {
		slices: new Map(),
		selectedServers: new Map(),
		selectedServerUpdate$: new Rx.Subject(),
	}
	const ops: Promise<void>[] = []

	for (const serverConfig of CONFIG.servers) {
		ops.push((async function loadServerConfig() {
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
			await initServer(ctx, serverState)
		})())
	}

	await Promise.all(ops)
}

async function initServer(ctx: CS.Log & C.Db & C.Mutexes, serverState: SS.ServerState) {
	const serverId = serverState.id
	const settings = serverState.settings
	const cleanupSub = new Rx.Subscription()

	const rcon = new Rcon({ serverId, settings: settings.connections.rcon })
	rcon.ensureConnected(ctx)
	registerCleanup(() => rcon.disconnect({ log: baseLogger }), cleanupSub)

	const layersStatusExt$: SquadServer['layersStatusExt$'] = getLayersStatusExt$(serverId)

	const adminListTTL = HumanTime.parse('1h')
	const adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })
	registerCleanup(() => adminList.dispose(), cleanupSub)

	const sftpReader = new SftpTail(ctx, {
		filePath: settings.connections!.sftp.logFile,
		host: settings.connections!.sftp.host,
		port: settings.connections!.sftp.port,
		username: settings.connections!.sftp.username,
		password: settings.connections!.sftp.password,
		pollInterval: CONFIG.squadServer.sftpPollInterval,
		reconnectInterval: CONFIG.squadServer.sftpReconnectInterval,
	})
	registerCleanup(() => sftpReader.disconnect(), cleanupSub)
	sftpReader.watch()

	const server: SquadServer = {
		layersStatusExt$,

		postRollEventsSub: null,

		historyConflictsResolved$: undefined!,

		serverRolling$: new Rx.BehaviorSubject(null as Date | null),

		sftpReader,
		beforeNewGame$: new Rx.Subject(),
		event$: new Rx.Subject(),
		chatSync$: new Rx.Subject(),
		state: {
			roundEndState: null,
			roundLoser: null,
			roundWinner: null,
			joinRequests: new Map(),
			chat: null,
		},

		...SquadRcon.initSquadRcon({ ...ctx, rcon, adminList }, cleanupSub),
	}

	registerCleanup(() => {
		server.serverRolling$.complete()
		server.beforeNewGame$.complete()
		server.event$.complete()
		server.chatSync$.complete()
	}, cleanupSub)

	server.historyConflictsResolved$ = Rx.firstValueFrom(rcon.connected$.pipe(
		Rx.tap({
			subscribe: () => {
				ctx.log.info('trying to resolve potential current match conflict, waiting for rcon connection...')
			},
		}),
		Rx.concatMap(async (connected) => {
			if (!connected) return Rx.EMPTY
			const ctx = { ...getBaseCtx(), ...slice }

			const statusRes = await server.layersStatus.get(ctx)
			if (statusRes.code === 'err:rcon') return Rx.EMPTY
			await MatchHistory.resolvePotentialCurrentLayerConflict(ctx, statusRes.data.currentLayer)
			ctx.log.info('rcon connection established, current layer synced with match history')

			// set up chat state
			const [playersRes, squadsRes] = await Promise.all([server.playerList.get({ ...ctx, rcon }), server.squadList.get({ ...ctx, rcon })])
			if (playersRes.code === 'ok' && squadsRes.code === 'ok') {
				ctx.server.state.chat = {
					eventBuffer: [],
					initialState: {
						players: playersRes.players,
						squads: squadsRes.squads,
					},
					interpolatedState: Obj.deepClone({
						players: playersRes.players,
						squads: squadsRes.squads,
					}),
					rawEventBuffer: [],
				}
				ctx.server.chatSync$.next([ctx, { type: 'INIT', state: ctx.server.state.chat }])
			}

			return Rx.of(1)
		}),
		Rx.concatAll(),
		Rx.retry(5),
	))

	server.sftpReader.on(
		'line',
		C.spanOp(
			'squad-server:on-log-event',
			{ tracer, eventLogLevel: 'debug' },
			async (line: string) => {
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				for (const matcher of SM.LogEvents.EventMatchers) {
					try {
						const [matched, error] = matchLog(line, matcher)
						if (error) {
							return {
								code: 'err:failed-to-parse-log-line' as const,
								error,
							}
						}
						if (!matched) continue
						ctx.log.debug('Parsed Log Line into %s, (%o)', matched.type, matched)
						const res = await processServerLogEvent(ctx, matched)
						if (!res) return
						if (res.code !== 'ok') return res
						const event = res.event
						ctx.log.info(event, 'Emitting Squad Event: %s', event.type)
						ctx.server.event$.next([ctx, event])
						return { code: 'ok' as const }
					} catch (error) {
						ctx.log.error(error, 'Error processing log event')
						C.recordGenericError(error)
					}
				}
			},
		),
	)

	// -------- process rcon events --------
	server.rconEvent$.pipe(
		C.durableSub('squad-server:on-rcon-event', { tracer, eventLogLevel: 'trace', ctx }, async ([_ctx, event]) => {
			const ctx = C.initMutexStore(DB.addPooledDb(resolveSliceCtx(_ctx, serverId)))
			ctx.log.info(event, 'Received RCON Event: %s', event.type)
			const res = await processRconEvent(ctx, event)
			if (res.code !== 'ok') return res

			ctx.server.event$.next([ctx, res.event])
			return { code: 'ok' as const }
		}),
	).subscribe()

	// TODO make use of this for more events (PLAYER_LEFT_SQUAD, SQUAD_DISBANDED, etc)
	// -------- watch for player updates --------
	// server.playerList.observe({ ...ctx, rcon })
	// 	.pipe(
	// 		Rx.concatMap(res => res.code === 'ok' ? Rx.of(res.players) : Rx.EMPTY),
	// 		Rx.pairwise(),
	// 	)
	// 	.subscribe(([prevPlayers, players]) => {
	// 		const upserted: SM.Player[] = []
	// 		const removed: SM.PlayerIds.Type[] = []
	// 		for (const player of players) {
	// 			const existing = SM.PlayerIds.find(prevPlayers, p => p.ids, player.ids)
	// 			if (!existing) {
	// 				upserted.push(player)
	// 				continue
	// 			}

	// 			if (!Obj.deepEqual(existing, player)) {
	// 				upserted.push(player)
	// 			}
	// 		}
	// 	})

	// -------- watch for squad updates --------
	// cleanupSub.add(
	// 	server.squadList.observe({ ...ctx, rcon })
	// 		.pipe(
	// 			Rx.concatMap(res => res.code === 'ok' ? Rx.of(res.squads) : Rx.EMPTY),
	// 			Rx.pairwise(),
	// 		)
	// 		.subscribe(([prevSquads, squads]) => {
	// 			const upserted: SM.Squad[] = []
	// 			const removed: SM.SquadId[] = []
	// 			for (const squad of squads) {
	// 				const existing = prevSquads.find(s => s.squadId === squad.squadId)
	// 				if (!existing) {
	// 					upserted.push(squad)
	// 					continue
	// 				}

	// 				if (!Obj.deepEqual(existing, squad)) {
	// 					upserted.push(squad)
	// 				}
	// 			}

	// 			// for (const prevSquad of prevSquads) {
	// 			// 	if (!squads.find(s => s.squadID === prevSquad.squadID)) {
	// 			// 		removed.push(prevSquad.squadID)
	// 			// 	}
	// 			// }
	// 			if (upserted.length === 0 && removed.length === 0) return
	// 			server.chatSync$.next([ctx, { type: 'SQUADS_UPDATE', upserted, removed }])
	// 		}),
	// )

	server.event$.subscribe(([ctx, event]) => {
		if (!server.state.chat) {
			ctx.log.error('Chat state not initialized')
			return
		}
		ctx.log.info(event, 'emitted event: %s', event.type)
		CHAT.handleEvent(server.state.chat, event)
	})

	const slice: C.ServerSlice = {
		serverId,

		rcon,
		server,

		matchHistory: MatchHistory.initMatchHistoryContext(),

		layerQueue: LayerQueue.initLayerQueueContext(),

		vote: {
			autostartVoteSub: null,
			voteEndTask: null,
			state: null,
			mtx: new Mutex(),

			update$: new Rx.Subject<V.VoteStateUpdate>(),
		},
		sharedList: SharedLayerList.getDefaultState(serverState),

		adminList,
		serverSliceSub: cleanupSub,
	}

	globalState.slices.set(serverId, slice)

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

	// TODO this is a complex situation for opentelemetry/span linking. revisit at some point

	// if we have to handle multiple effects from NEW_GAME we may want to ensure the order in which those effects are processed instead of just reading straight from event$

	let triggerWait$ = Rx.merge(
		currentLayerChanged$.pipe(Rx.map((layer) => ['new-layer' as const, layer] as const)),
		ctx.server.beforeNewGame$.pipe(Rx.map(([_, event]) => ['new-game' as const, event] as const)),
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
						const rollTime = triggerType === 'new-game' ? payload.time : new Date()
						ctx.server.serverRolling$.next(rollTime)

						let newGameEvent: SM.LogEvents.NewGame | undefined
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
								ctx.server.beforeNewGame$.pipe(Rx.map(([_, event]) => event)),
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

						// could inline handleNewGame here
						const res = await LayerQueue.handleNewGame(ctx, newLayer, newGameEvent)
						if (res.code !== 'ok') return

						ctx.server.event$.next([ctx, {
							type: 'NEW_GAME',
							time: newGameEvent?.time ?? new Date(),
							matchId: res.match.historyEntryId,
						}])
					} finally {
						ctx.server.serverRolling$.next(null)
					}
				}),
			).subscribe(),
	)
}

export function destroyServer(ctx: C.ServerSlice & CS.Log) {
	ctx.serverSliceSub.unsubscribe()
	globalState.slices.delete(ctx.serverId)
	for (const [wsClientId, serverId] of Array.from(globalState.selectedServers.entries())) {
		if (ctx.serverId === serverId) globalState.selectedServers.delete(wsClientId)
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
		const ctx = { ...getBaseCtx(), ...globalState.slices.get(serverId)! }
		const sub = new Rx.Subscription()
		sub.add(
			ctx.server.layersStatus.observe(ctx).subscribe({
				next: async () => {
					s.next(await fetchLayersStatusExt(ctx))
				},
				error: (err) => s.error(err),

				// this is what causes the observable to be completed when a server is destroyed
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
		serverId = (globalState.slices.keys().next().value)!
	}

	if (defaultServerId && serverId === defaultServerId) return ctx
	const res = ctx.res.setCookie(AR.COOKIE_KEY.Values['default-server-id'], serverId)
	return {
		...ctx,
		res,
	}
}

export function resolveWsClientSliceCtx(ctx: C.OrpcBase) {
	let serverId = globalState.selectedServers.get(ctx.wsClientId)
	serverId ??= CONFIG.servers[0].id
	if (!serverId) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'No server selected' })
	const slice = globalState.slices.get(serverId)
	if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server slice not found' })
	return {
		...ctx,
		...slice,
	}
}

export function resolveSliceCtx<T extends object>(ctx: T, serverId: string) {
	const slice = globalState.slices.get(serverId)
	if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server slice not found' })
	return {
		...ctx,
		...slice,
	}
}

function getBaseCtx() {
	return C.initMutexStore(DB.addPooledDb({ log: baseLogger }))
}

export function selectedServerCtx$<Ctx extends C.WSSession>(ctx: Ctx) {
	return globalState.selectedServerUpdate$.pipe(
		Rx.concatMap(s => s.wsClientId === ctx.wsClientId ? Rx.of(s.serverId) : Rx.EMPTY),
		Rx.startWith(globalState.selectedServers.get(ctx.wsClientId)!),
		Rx.map(serverId => resolveSliceCtx(ctx, serverId)),
	)
}

/**
 * Performs state tracking and event consolidation for squad log events.
 */
async function processServerLogEvent(
	ctx: CS.Log & C.SquadServer & C.AdminList & C.MatchHistory & C.Db & C.Mutexes,
	logEvent: SM.LogEvents.Event,
) {
	// for when we want to fetch data from rcon that's more likely to have been updated after the event in question. very crude, could be improved
	const deferOpts = {
		ttl: CONFIG.squadServer.sftpPollInterval / 4,
		timeout: CONFIG.squadServer.sftpPollInterval * 2,
	}
	const match = MatchHistory.getCurrentMatch(ctx)
	const base = {
		time: logEvent.time,
		matchId: match.historyEntryId,
	}

	const server = ctx.server
	switch (logEvent.type) {
		case 'ROUND_DECIDED': {
			const prop = logEvent.action === 'won' ? 'roundWinner' : 'roundLoser'
			server.state[prop] = {
				faction: logEvent.faction,
				unit: logEvent.unit,
				team: logEvent.team,
				tickets: logEvent.tickets,
			}
			break
		}

		case 'ROUND_TEAM_OUTCOME': {
			server.state.roundEndState = {
				// ported from existing behavior from squadjs -- unsure why it exists though https://github.com/Tactrigsds/SquadJS/blob/psg/squad-server/log-parser/round-winner.js
				winner: server.state.roundEndState ? logEvent.winner : null,
				layer: logEvent.layer,
			}
			break
		}

		case 'ROUND_ENDED': {
			let loser: SM.SquadOutcomeTeam | null
			let winner: SM.SquadOutcomeTeam | null

			const statusRes = await ctx.server.layersStatus.get(ctx, { ttl: 0 })
			if (statusRes.code !== 'ok') return statusRes
			// -------- use debug ticketOutcome if one was set --------
			if (globalState.debug__ticketOutcome) {
				let winnerId: SM.TeamId | null
				let loserId: SM.TeamId | null
				if (globalState.debug__ticketOutcome.team1 === globalState.debug__ticketOutcome.team2) {
					winnerId = null
					loserId = null
				} else {
					winnerId = globalState.debug__ticketOutcome.team1 - globalState.debug__ticketOutcome.team2 > 0 ? 1 : 2
					loserId = globalState.debug__ticketOutcome.team1 - globalState.debug__ticketOutcome.team2 < 0 ? 1 : 2
				}
				const partial = L.toLayer(statusRes.data.currentLayer)
				const teams: SM.SquadOutcomeTeam[] = [
					{
						faction: partial.Faction_1!,
						unit: partial.Unit_1!,
						team: 1,
						tickets: globalState.debug__ticketOutcome.team1,
					},
					{
						faction: partial.Faction_2!,
						unit: partial.Unit_2!,
						team: 2,
						tickets: globalState.debug__ticketOutcome.team2,
					},
				]
				winner = teams.find(t => t?.team && t.team === winnerId) ?? null
				loser = teams.find(t => t?.team && t.team === loserId) ?? null
				delete globalState.debug__ticketOutcome
			} else {
				loser = server.state.roundLoser
				winner = server.state.roundWinner
			}
			server.state.roundWinner = null
			server.state.roundLoser = null
			const res = await MatchHistory.finalizeCurrentMatch(ctx, statusRes.data.currentLayer.id, winner, loser, logEvent.time)
			if (res.code !== 'ok') return res
			const event: SM.Events.RoundEnded = {
				type: 'ROUND_ENDED',
				...base,
			}
			return { code: 'ok' as const, event }
		}

		case 'NEW_GAME': {
			if (logEvent.layerClassname === 'TransitionMap') return
			server.beforeNewGame$.next([ctx, logEvent])
			return
		}

		case 'PLAYER_CONNECTED': {
			server.state.joinRequests.set(logEvent.chainID, logEvent.player)
			return
		}

		case 'PLAYER_JOIN_SUCCEEDED': {
			const joinedPlayerIdQuery = server.state.joinRequests.get(logEvent.chainID)
			if (!joinedPlayerIdQuery) return
			server.state.joinRequests.delete(logEvent.chainID)
			const player = await SquadRcon.getPlayerDeferred(ctx, joinedPlayerIdQuery, deferOpts)
			if (!player) {
				return { code: 'err:player-not-found' as const, message: `Player ${SM.PlayerIds.prettyPrint(joinedPlayerIdQuery)} not found` }
			}
			return {
				code: 'ok' as const,
				event: {
					type: 'PLAYER_CONNECTED',
					player,
					...base,
				} satisfies SM.Events.PlayerConnected,
			}
		}

		case 'PLAYER_DISCONNECTED': {
			// if (server.state.joinRequests)
			void (async () => {
				const res = await server.playerList.fetchedValue
				if (res?.code !== 'ok') return
				const players = res.players

				if (SM.PlayerIds.find(players, p => p.ids, logEvent.player)) {
					server.playerList.invalidate(ctx)
				}
			})()

			return {
				code: 'ok' as const,
				event: {
					type: 'PLAYER_DISCONNECTED',
					playerIds: logEvent.player,
					...base,
				} satisfies SM.Events.PlayerDisconnected,
			}
		}

		default:
			assertNever(logEvent)
	}
}

export async function processRconEvent(ctx: C.ServerSlice & CS.Log & C.Db & C.Mutexes, event: SM.RconEvents.Event) {
	// wait for server to not be rolling if the event occurred after we started rolling. we're doing this so we're less likely to miscategorize the events as belonging to the wrong match
	await Rx.firstValueFrom(ctx.server.serverRolling$.pipe(Rx.filter(rollTime => rollTime === null || rollTime > event.time)))

	const match = MatchHistory.getCurrentMatch(ctx)
	const matchId = match.historyEntryId

	// for when we want to fetch data from rcon that's more likely to have been updated after the event in question. very crude, could be improved
	const deferOpts = {
		ttl: CONFIG.squadServer.sftpPollInterval / 4,
		timeout: CONFIG.squadServer.sftpPollInterval * 2,
	}

	const base = {
		matchId,
		time: event.time,
	}

	// TODO could maybe parse the log version of some of these events for better continuity, specifically for the chat/event view
	switch (event.type) {
		case 'CHAT_MESSAGE': {
			if (event.message.startsWith(CONFIG.commandPrefix)) {
				await Commands.handleCommand(ctx, event)
			} else if (event.message.trim().match(/^\d+$/) && ctx.vote.state?.code === 'in-progress') {
				LayerQueue.handleVote(ctx, event)
			}

			let channel: SM.ChatChannel
			if (event.channelType === 'ChatAdmin' || event.channelType === 'ChatAll') {
				channel = { type: event.channelType }
			} else if (event.channelType === 'ChatTeam' || event.channelType === 'ChatSquad') {
				const res = await SquadRcon.getPlayer(ctx, event.playerIds)
				if (res.code !== 'ok') return res
				const player = res.player
				if (player.teamID === null) {
					return {
						code: 'err:chatting-player-not-in-team' as const,
						message: `player ${SM.PlayerIds.prettyPrint(player.ids)} is not in a team`,
					}
				}

				if (event.channelType === 'ChatTeam') {
					channel = { type: event.channelType, teamId: player.teamID }
				} else {
					if (player.squadID === null) {
						return {
							code: 'err:chatting-player-not-in-squad' as const,
							message: `player ${SM.PlayerIds.prettyPrint(player.ids)} is not in a squad`,
						}
					}
					channel = { type: event.channelType, teamId: player.teamID, squadId: player.squadID }
				}
			} else {
				assertNever(event.channelType)
			}

			return {
				code: 'ok' as const,
				event: {
					type: 'CHAT_MESSAGE',
					message: event.message,
					playerIds: event.playerIds,
					channel,
					...base,
				} satisfies SM.Events.ChatMessage,
			}
		}

		case 'SQUAD_CREATED': {
			const factionId = L.getFactionIdForFactionNameInexact(event.teamName)
			if (!factionId) {
				return {
					code: 'err:unable-to-resolve-faction-id' as const,
					message: `unable to resolve faction id for team name ${event.teamName}`,
				}
			}
			const layer = L.toLayer(match.layerId)

			let teamId: SM.TeamId
			if (layer.Faction_1 && layer.Faction_1 === factionId) {
				teamId = 1
			} else if (layer.Faction_2 && layer.Faction_2 === factionId) {
				teamId = 2
			} else {
				return {
					code: 'err:unable-to-resolve-team-id' as const,
					message: `unable to resolve team id for faction id ${factionId}`,
				}
			}

			const squad = await SquadRcon.getSquadDeferred(ctx, s => s.teamId === teamId && s.squadId === event.squadID, deferOpts)
			if (!squad) {
				return {
					code: 'err:unable-to-resolve-squad' as const,
					message: `unable to resolve squad for team id ${teamId} and squad id ${event.squadID}`,
				}
			}
			const creator = await SquadRcon.getPlayerDeferred(
				ctx,
				p => SM.PlayerIds.matches(p.ids, event.creatorIds) && p.isLeader && p.squadID !== null,
				deferOpts,
			)

			if (!creator) {
				return {
					code: 'err:unable-to-resolve-creator' as const,
					message: `unable to resolve creator for squad id ${event.squadID}`,
				}
			}

			// const res = await

			return {
				code: 'ok' as const,
				event: {
					type: 'SQUAD_CREATED',
					squad,
					creator,
					...base,
				} satisfies SM.Events.SquadCreated,
			}
		}

		case 'PLAYER_BANNED':
		case 'PLAYER_KICKED':
		case 'PLAYER_WARNED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA':
			return {
				code: 'ok' as const,
				event: {
					...event,
					...base,
				} satisfies SM.Events.Event,
			}
	}
}

export const orpcRouter = {
	setSelectedServer: orpcBase
		.input(z.string())
		.handler(async ({ context, input: serverId }) => {
			const slice = globalState.slices.get(serverId)
			if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server not found' })
			globalState.selectedServers.set(context.wsClientId, serverId)
			globalState.selectedServerUpdate$.next({ wsClientId: context.wsClientId, serverId })
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

	watchChatEvents: orpcBase.handler(async function*({ context, signal }) {
		const obs: Rx.Observable<SM.Events.Event | CHAT.SyncEvent> = selectedServerCtx$(context)
			.pipe(
				Rx.switchMap(ctx => {
					const init: CHAT.SyncEvent = {
						type: 'INIT',
						state: ctx.server.state.chat!,
					}
					return Rx.merge(
						Rx.of(init),
						ctx.server.event$.pipe(Rx.map(([_, event]) => event)),
						ctx.server.chatSync$.pipe(Rx.map(([_, event]) => event)),
					)
				}),
				withAbortSignal(signal!),
			)
		yield* toAsyncGenerator(obs)
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
