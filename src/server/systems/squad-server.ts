import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as AR from '@/app-routes'
import * as Arr from '@/lib/array'
import { AsyncResource, distinctDeepEquals, externBufferTime, registerCleanup as registerCleanupSub, toAsyncGenerator, traceTag, withAbortSignal } from '@/lib/async'
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
import type * as CHAT from '@/models/chat.models.ts'
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
import * as datefns from 'date-fns'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import { z } from 'zod'
import { baseLogger } from '../logger'
import * as CleanupSys from './cleanup'

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

		// ids of players currently connected to the server. players are considered "connected" once PLAYER_CONNECTED has fired (or is scheduled to be fired in this microtask)
		connected: SM.PlayerIds.Type[]

		createdSquads: (SM.Squads.Key & { creatorIds: SM.PlayerIds.Type })[]

		chatEventBuffer: CHAT.Event[]
	}

	// intermediate event so that initNewGameHandling's behaviour is downstream from event$
	beforeNewGame$: Rx.Subject<[CS.Log & C.Db & C.Mutexes & C.ServerSlice, SM.LogEvents.NewGame]>

	// TODO we should slim down the context we provide here so that we're just transmitting span & logging info, and leave the listener to construct everything else
	event$: Rx.Subject<[CS.Log & C.Db & C.Mutexes & C.ServerSlice, SM.Events.Event[]]>
	chatReset$: Rx.Subject<[CS.Log, CHAT.ResetEvent]>
} & SquadRcon.SquadRcon

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<CS.Log>
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>

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
		const obs: Rx.Observable<(CHAT.Event | CHAT.SyncedEvent)[]> = selectedServerCtx$(context)
			.pipe(
				Rx.switchMap(ctx => {
					function getInitialEvents() {
						// page so we don't block too long on serialization/deserialization
						const paged: Array<Array<CHAT.Event | CHAT.SyncedEvent>> = Arr.paged(ctx.server.state.chatEventBuffer, 512)
						if (paged.length === 0) return []
						const sync: CHAT.SyncedEvent = {
							type: 'SYNCED' as const,
							time: new Date(),
							matchId: MatchHistory.getCurrentMatch(ctx).historyEntryId,
						}
						paged[paged.length - 1].push(sync)
						return paged
					}
					const initial$ = Rx.from(ctx.server.historyConflictsResolved$)
						.pipe(Rx.concatMap(getInitialEvents))

					const upcoming$ = Rx.merge(
						ctx.server.event$.pipe(Rx.map(([_, events]): (CHAT.Event | CHAT.SyncedEvent)[] => events)),
						ctx.server.chatReset$.pipe(Rx.map(([_, event]): (CHAT.Event | CHAT.SyncedEvent)[] => [event])),
					)

					return Rx.concat(initial$, upcoming$).pipe(
						// orpc will break without this
						Rx.observeOn(Rx.asyncScheduler),
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

export async function setup() {
	const ctx = getBaseCtx()

	globalState = {
		slices: new Map(),
		selectedServers: new Map(),
		selectedServerUpdate$: new Rx.Subject(),
	}
	const ops: Promise<void>[] = []

	for (const serverConfig of CONFIG.servers) {
		const settingsFromConfig = {
			connections: serverConfig.connections,
			adminListSources: serverConfig.adminListSources!,
			adminIdentifyingPermissions: serverConfig.adminIdentifyingPermissions,
		}
		ops.push((async function loadServerConfig() {
			const serverState = await DB.runTransaction(ctx, async () => {
				let [server] = await ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, serverConfig.id)).for('update')
				if (!server) {
					ctx.log.info(`Server ${serverConfig.id} not found, creating new`)
					server = {
						id: serverConfig.id,
						displayName: serverConfig.displayName,
						settings: SS.ServerSettingsSchema.parse(settingsFromConfig),
						layerQueue: [],
						layerQueueSeqId: 0,
						lastRoll: null,
					}
					await ctx.db().insert(Schema.servers).values(superjsonify(Schema.servers, server))
				} else {
					server = unsuperjsonify(Schema.servers, server) as typeof server
					ctx.log.info(`Server ${serverConfig.id} found, ensuring settings are up-to-date`)

					let update = false
					if (server.displayName !== serverConfig.displayName) {
						update = true
						server.displayName = serverConfig.displayName
					}
					const oldSettings = server.settings
					server.settings = SS.ServerSettingsSchema.parse({
						...(oldSettings as object),
						...settingsFromConfig,
					})

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
	registerCleanupSub(() => rcon.disconnect({ log: baseLogger }), cleanupSub)

	const layersStatusExt$: SquadServer['layersStatusExt$'] = getLayersStatusExt$(serverId)

	const adminList = (() => {
		const adminListTTL = HumanTime.parse('1h')
		let serverSources: SM.AdminListSource[] = []
		for (const key of serverState.settings.adminListSources) {
			serverSources.push(CONFIG.adminListSources[key])
		}
		// we are duplicating fetches here if two servers have the same source, but shouldn't matter
		return new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, serverSources, settings.adminIdentifyingPermissions), {
			defaultTTL: adminListTTL,
		})
	})()
	registerCleanupSub(() => adminList.dispose(), cleanupSub)

	const sftpReader = new SftpTail(ctx, {
		filePath: settings.connections!.sftp.logFile,
		host: settings.connections!.sftp.host,
		port: settings.connections!.sftp.port,
		username: settings.connections!.sftp.username,
		password: settings.connections!.sftp.password,
		pollInterval: CONFIG.squadServer.sftpPollInterval,
		reconnectInterval: CONFIG.squadServer.sftpReconnectInterval,
	})
	registerCleanupSub(() => sftpReader.disconnect(), cleanupSub)
	sftpReader.watch()

	const server: SquadServer = {
		layersStatusExt$,

		postRollEventsSub: null,

		historyConflictsResolved$: undefined!,

		serverRolling$: new Rx.BehaviorSubject(null as Date | null),

		sftpReader,
		beforeNewGame$: new Rx.Subject(),
		event$: new Rx.Subject(),
		chatReset$: new Rx.Subject(),
		state: {
			roundEndState: null,
			roundLoser: null,
			roundWinner: null,
			joinRequests: new Map(),
			connected: [],
			createdSquads: [],
			chatEventBuffer: [],
		},

		...SquadRcon.initSquadRcon({ ...ctx, rcon, adminList, serverId }, cleanupSub),
	}

	registerCleanupSub(() => {
		server.serverRolling$.complete()
		server.beforeNewGame$.complete()
		server.event$.complete()
		server.chatReset$.complete()
	}, cleanupSub)

	// -------- load saved events --------
	const savedEventsLoaded$ = (async function loadSavedEvents() {
		const threeDaysAgo = datefns.subDays(new Date(), 3)
		const rowsRaw = await ctx.db().select({ data: Schema.serverEvents.data }).from(Schema.serverEvents).innerJoin(
			Schema.matchHistory,
			E.eq(Schema.matchHistory.id, Schema.serverEvents.matchId),
		)
			.where(E.and(
				E.eq(Schema.matchHistory.serverId, serverId),
				E.gte(Schema.serverEvents.time, threeDaysAgo),
			))

		const events = rowsRaw.map(row => superjson.deserialize(row.data as any) as CHAT.Event)

		const firstResetIdx = events.findIndex(event => event.type === 'RESET')
		server.state.chatEventBuffer = events.slice(firstResetIdx)
	})()

	let previouslyConnected = false
	// -------- make sure history and chat state is up to date once an rcon connection is established --------
	server.historyConflictsResolved$ = Rx.firstValueFrom(rcon.connected$.pipe(
		traceTag('resolvingHistoryConflicts'),
		Rx.tap({
			subscribe: () => {
				ctx.log.info('trying to resolve potential current match conflict, waiting for rcon connection...')
			},
		}),
		Rx.concatMap(C.spanOp('squad-server:resolve-history-conflicts', { tracer }, async (connected) => {
			if (!connected) return Rx.EMPTY
			const ctx = { ...getBaseCtx(), ...slice }

			const statusRes = await server.layersStatus.get(ctx)
			if (statusRes.code === 'err:rcon') return Rx.EMPTY
			const firstConnection = !previouslyConnected
			previouslyConnected = true
			await MatchHistory.resolvePotentialCurrentLayerConflict(ctx, statusRes.data.currentLayer)
			ctx.log.info('rcon connection established, match history is synced')

			// set up chat state
			const [playersRes, squadsRes] = await Promise.all([
				server.playerList.get({ ...ctx, rcon }),
				server.squadList.get({ ...ctx, rcon }),
			])
			await savedEventsLoaded$
			if (playersRes.code === 'ok' && squadsRes.code === 'ok') {
				for (const player of playersRes.players) {
					server.state.connected.push(player.ids)
				}
				for (const squad of squadsRes.squads) {
					server.state.createdSquads.push({ teamId: squad.teamId, squadId: squad.squadId, creatorIds: squad.creatorIds })
				}
				ctx.server.chatReset$.next([ctx, {
					type: 'RESET',
					time: new Date(),
					matchId: MatchHistory.getCurrentMatch(ctx).historyEntryId,
					reason: firstConnection ? 'slm-started' : 'rcon-reconnected',
					state: {
						players: playersRes.players,
						squads: squadsRes.squads,
					},
				}])
			}

			return Rx.of(1)
		})),
		Rx.concatAll(),
		Rx.retry({
			count: 5,
			delay: (error) => {
				ctx.log.error(error, 'Error resolving history conflicts, retrying...')
				return Rx.of(error)
			},
		}),
	))

	// -------- process log events --------
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
						ctx.server.event$.next([ctx, [event]])
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

			ctx.server.event$.next([ctx, [res.event]])
			return { code: 'ok' as const }
		}),
	).subscribe()

	// -------- create synthetic events based on state changes on the server --------
	server.playerList.observe({ ...ctx, rcon, adminList, serverId })
		.pipe(
			Rx.concatMap(res => res.code === 'ok' ? Rx.of(res.players) : Rx.EMPTY),
			// distinctDeepEquals(),
			Rx.pairwise(),
			// capture event time before potential buffering
			Rx.map(p => [...p, new Date()] as const),
			// TODO this may not be correct to do, revisit
			// buffer events while server is rolling
			// Rx.bufferWhen(() => server.serverRolling$.pipe(Rx.takeWhile(v => v !== null))),
			// Rx.concatAll(),
			Rx.map(
				// C.spanOp(
				// 	'squad-server:gen-synthetic-events',
				// 	{ tracer },
				([prev, next, time]) => {
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)
					ctx.log.debug('Generating synthetic events')
					return [...generateSyntheticEvents(ctx, prev, next, time)]
				},
				// ),
			),
		).subscribe({
			error: err => {
				ctx.log.error(err, 'Player list subscription error')
			},
			complete: () => {
				ctx.log.warn('Player list subscription completed')
			},
			next: events => {
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				if (events.length === 0) {
					ctx.log.debug('No synthetic events generated')
					return
				}
				server.event$.next([ctx, events])
				ctx.log.info('done generating synthetic events')
			},
		})

	// -------- keep chat buffer state up-to-date --------
	Rx.merge(server.event$, server.chatReset$).subscribe(([ctx, events]) => {
		for (const event of Array.isArray(events) ? events : [events]) {
			ctx.log.info(event, 'emitted event: %s', event.type)
			server.state.chatEventBuffer.push(event)
		}
	})

	{
		// -------- periodically save events  --------
		let eventBuffer: CHAT.Event[] = []
		const saveEventSub = Rx.merge(server.event$, server.chatReset$).pipe(
			Rx.concatMap(([_, e]) => Array.isArray(e) ? e : [e]),
			externBufferTime(5_000, eventBuffer),
			Rx.mergeMap((events) => {
				if (events.length === 0) return Rx.EMPTY
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				return saveEvents(ctx, events)
			}),
			Rx.retry(),
		).subscribe()

		// -------- save remaining events on shutdown  --------
		const cleanupId = CleanupSys.register(async () => {
			if (eventBuffer.length === 0) return
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			saveEventSub.unsubscribe()
			await saveEvents(ctx, eventBuffer)
		})

		// as soon as we have good reason to we should register destroyServer() instead, but that will need us to change our cleanup mechanism a little
		registerCleanupSub(() => CleanupSys.unregister(cleanupId), cleanupSub)
	}

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
	await server.historyConflictsResolved$
	await LayerQueue.init({ ...ctx, ...slice })
	SharedLayerList.init({ ...ctx, ...slice })
	initNewGameHandling({ ...ctx, ...slice })
	void adminList.get({ ...ctx, ...slice })
	ctx.log.info('Initialized server %s', serverId)
}

/**
 * Init Interpretation/matching of current layer updates from the game server for the purposes of syncing it with the queue & match history --------
 * TODO we could probably simplify this massively by just listening for the set layer evens in the logs lol
 */
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
		currentLayerChanged$.pipe(Rx.map((layer) => [resolveSliceCtx(getBaseCtx(), serverId), 'new-layer' as const, layer] as const)),
		ctx.server.beforeNewGame$.pipe(Rx.map(([ctx, event]) => [ctx, 'new-game' as const, event] as const)),
	)

	// @ts-expect-error wait for the startup history reconciliation to complete before listening for new games
	triggerWait$ = Rx.concat(
		Rx.from(ctx.server.historyConflictsResolved$).pipe(Rx.filter(() => false)),
		triggerWait$,
	)

	// pair off detected new layers via RCON with NEW_GAME events from the logs (which we may receive in any order and within a fairly wide window), and handle them in a reasonably durable way
	triggerWait$
		.pipe(
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
						Rx.concatMap(([_, e]) => e === triggerType ? Rx.of('double-event' as const) : Rx.EMPTY),
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

					ctx.server.event$.next([ctx, [{
						type: 'NEW_GAME',
						time: newGameEvent?.time ?? new Date(),
						matchId: res.match.historyEntryId,
					}]])
				} finally {
					ctx.server.serverRolling$.next(null)
				}
			}),
		).subscribe()
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
	ctx: CS.Log & C.Db & C.Mutexes & C.ServerSlice,
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

		// TODO PLAYER_JOIN_FAILED?
		case 'PLAYER_JOIN_SUCCEEDED': {
			const joinedPlayerIdQuery = server.state.joinRequests.get(logEvent.chainID)
			if (!joinedPlayerIdQuery) return
			server.state.joinRequests.delete(logEvent.chainID)
			const player = await SquadRcon.getPlayerDeferred(ctx, joinedPlayerIdQuery, deferOpts)
			if (!player) {
				return { code: 'err:player-not-found' as const, message: `Player ${SM.PlayerIds.prettyPrint(joinedPlayerIdQuery)} not found` }
			}
			const isAlreadyConnected = SM.PlayerIds.find(server.state.connected, player.ids)
			if (isAlreadyConnected) {
				ctx.log.debug(`Player ${SM.PlayerIds.prettyPrint(player.ids)} is already connected. this is expected.`)
				return
			}
			SM.PlayerIds.upsert(server.state.connected, player.ids)
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
			if (!SM.PlayerIds.find(server.state.connected, logEvent.playerIds)) return

			SM.PlayerIds.remove(server.state.connected, logEvent.playerIds)

			// invalidate playerList and wait for the result so that generateSyntheticEvents is able to run first
			await server.playerList.get(ctx, { ttl: 0 })

			return {
				code: 'ok' as const,
				event: {
					type: 'PLAYER_DISCONNECTED',
					playerIds: logEvent.playerIds,
					...base,
				} satisfies SM.Events.PlayerDisconnected,
			}
		}

		case 'ADMIN_BROADCAST': {
			return {
				code: 'ok' as const,
				event: {
					type: 'ADMIN_BROADCAST',
					message: logEvent.message,
					from: logEvent.from,
					...base,
				} satisfies SM.Events.AdminBroadcast,
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
				if (player.teamId === null) {
					return {
						code: 'err:chatting-player-not-in-team' as const,
						message: `player ${SM.PlayerIds.prettyPrint(player.ids)} is not in a team`,
					}
				}

				if (event.channelType === 'ChatTeam') {
					channel = { type: event.channelType, teamId: player.teamId }
				} else {
					if (player.squadId === null) {
						return {
							code: 'err:chatting-player-not-in-squad' as const,
							message: `player ${SM.PlayerIds.prettyPrint(player.ids)} is not in a squad`,
						}
					}
					channel = { type: event.channelType, teamId: player.teamId, squadId: player.squadId }
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

			// this is an rcon event so we can assume our cache is invalid
			const [squadRes, creatorRes] = await Promise.all([
				SquadRcon.getSquad(ctx, { squadId: event.squadId, teamId: teamId }, { ttl: 0 }),
				SquadRcon.getPlayer(ctx, event.creatorIds, { ttl: 0 }),
			])

			if (squadRes.code !== 'ok') {
				return {
					code: 'err:unable-to-resolve-squad' as const,
					message: `unable to resolve squad for team id ${teamId} and squad id ${event.squadId}`,
				}
			}

			if (creatorRes.code !== 'ok') {
				return {
					code: 'err:unable-to-resolve-creator' as const,
					reason: creatorRes.code,
				}
			}
			const squad = squadRes.squad
			const creator = creatorRes.player

			ctx.server.state.createdSquads.push({ teamId: squad.teamId, squadId: squad.squadId, creatorIds: squad.creatorIds })

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

function* generateSyntheticEvents(
	ctx: C.ServerSlice & CS.Log & C.Db & C.Mutexes,
	prevPlayers: SM.Player[],
	players: SM.Player[],
	time: Date,
): Generator<SM.Events.Event> {
	const base = { time, matchId: MatchHistory.getCurrentMatch(ctx).historyEntryId }

	const squads = SM.Players.groupIntoSquads(players)
	const prevSquads = SM.Players.groupIntoSquads(prevPlayers)

	for (const player of players) {
		const prev = SM.PlayerIds.find(prevPlayers, p => p.ids, player.ids)
		if (!prev) continue

		const playerConnected = !!SM.PlayerIds.find(ctx.server.state.connected, player.ids)
		if (!playerConnected) {
			// the event from the logs (PLAYER_JOIN_SUCCEEDED) has not come through yet, so we need to send it here instead.
			ctx.server.state.connected.push(player.ids)
			yield {
				type: 'PLAYER_CONNECTED',
				player,
				...base,
			} satisfies SM.Events.PlayerConnected
			continue
		}

		if (!SM.Squads.idsEqual(prev, player) && prev.squadId !== null && prev.teamId !== null) {
			yield {
				type: 'PLAYER_LEFT_SQUAD',
				playerIds: player.ids,
				teamId: prev.teamId,
				squadId: prev.squadId,
				...base,
			} satisfies SM.Events.PlayerLeftSquad
		}

		if (player.teamId !== prev.teamId) {
			yield {
				type: 'PLAYER_CHANGED_TEAM',
				newTeamId: player.teamId,
				playerIds: player.ids,
				...base,
			} satisfies SM.Events.PlayerChangedTeam
		}

		if (player.squadId !== null && player.teamId !== null && player.squadId === prev.squadId && player.isLeader && !prev.isLeader) {
			yield {
				type: 'PLAYER_PROMOTED_TO_LEADER',
				squadId: player.squadId,
				teamId: player.teamId,
				newLeaderIds: player.ids,
				...base,
			} satisfies SM.Events.PlayerPromotedToLeader
		}

		if (
			player.squadId !== null && player.teamId !== null && !SM.Squads.idsEqual(player, prev)
		) {
			const playerCreatedSquad = ctx.server.state.createdSquads.find(s =>
				SM.Squads.idsEqual(s, player) && SM.PlayerIds.match(player.ids, s.creatorIds)
			)
			const isNewSquad = !prevSquads.find(s => SM.Squads.idsEqual(s, player))
			// if we violently thrash squad creations/leaves then we can maybe break this but that's unlikely
			if (isNewSquad && playerCreatedSquad) continue

			yield {
				type: 'PLAYER_JOINED_SQUAD',
				playerIds: player.ids,
				teamId: player.teamId,
				squadId: player.squadId,
				...base,
			} satisfies SM.Events.PlayerJoinedSquad
		}

		{
			const details = Obj.selectProps(player, SM.PLAYER_DETAILS)
			const prevDetails = Obj.selectProps(prev, SM.PLAYER_DETAILS)
			if (!Obj.deepEqual(details, prevDetails)) {
				yield {
					type: 'PLAYER_DETAILS_CHANGED',
					playerIds: player.ids,
					details,
					...base,
				} satisfies SM.Events.PlayerDetailsChanged
			}
		}
	}

	for (const prevSquad of prevSquads) {
		if (squads.some(s => SM.Squads.idsEqual(s, prevSquad))) continue
		ctx.server.state.createdSquads = ctx.server.state.createdSquads.filter(s => !SM.Squads.idsEqual(s, prevSquad))
		yield {
			type: 'SQUAD_DISBANDED',
			squadId: prevSquad.squadId,
			teamId: prevSquad.teamId,
			...base,
		} satisfies SM.Events.SquadDisbanded
	}
}

const saveEvents = C.spanOp(
	'squad-server:save-events',
	{ tracer },
	async (ctx: C.ServerSlice & CS.Log & C.Db, events: CHAT.Event[]) => {
		if (events.length === 0) return
		const rows: SchemaModels.NewServerEvent[] = events.map(e => ({
			type: e.type,
			time: e.time,
			matchId: e.matchId,
			data: superjson.serialize(e),
		}))

		try {
			await ctx.db({ redactParams: true }).insert(Schema.serverEvents).values(rows)
		} catch (error) {
			console.error('Error saving events:', error)
		}
	},
)
