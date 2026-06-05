import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as AR from '@/app-routes'
import * as Arr from '@/lib/array'
import { type CleanupTasks, distinctDeepEquals, runCleanup, switchMapWithSignal, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { AsyncResource } from '@/lib/async-resource'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Gen from '@/lib/generator'
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
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import * as SS from '@/models/server-state.models'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Commands from '@/systems/commands.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as TeamSwitchesSys from '@/systems/teamswitches.server'
import * as UserPresence from '@/systems/user-presence.server'
import * as Vote from '@/systems/vote.server'
import * as WsSessionSys from '@/systems/ws-session.server'
import * as Orpc from '@orpc/server'
import { Mutex, type MutexInterface } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import { z } from 'zod'

const module = initModule('squad-server')
let log!: CS.Logger
const envBuilder = Env.getEnvBuilder({ ...Env.groups.featureFlags })
let ENV!: ReturnType<typeof envBuilder>
const orpcBase = getOrpcBase(module)

type State = {
	slices: Map<string, C.ServerSlice>
	// wsClientId => server id
	selectedServers: Map<string, string>
	selectedServerUpdate$: Rx.Subject<{ wsClientId: string; serverId: string }>
	serverEventIdCounter: Generator<number, never, unknown>
	squadIdCounter: Generator<number, never, unknown>

	debug__ticketOutcome?: { team1: number; team2: number }
}

export let globalState!: State
export type SquadServer = {
	layersStatusExt$: Rx.Observable<SM.LayersStatusResExt>

	postRollEventsSub: Rx.Subscription | null

	serverRolling$: Rx.BehaviorSubject<number | null>

	// if null, we haven't saved yet in this instantiation of the server
	lastSavedEventId: number | null

	emittedEvents: SE.Event[]
	// TODO we should slim down the context we provide here so that we're just transmitting span & logging info, and leave the listener to construct everything else
	event$: Rx.Subject<[C.Db & C.ServerSlice, SE.Event]>
	eventState: PendingEvents.State

	chatState: CHAT.ChatState

	destroyed: boolean
	cleanupId: number | null

	processEventsMtx: MutexInterface
	savingEventsMtx: MutexInterface
} & SquadRcon.SquadRcon

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<C.OtelCtx>
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>

export const orpcRouter = {
	setSelectedServer: orpcBase
		.input(z.string())
		.handler(async ({ context, input: serverId }) => {
			const slice = globalState.slices.get(serverId)
			if (!slice) {
				throw new Orpc.ORPCError('BAD_REQUEST', {
					message: 'Server not found',
				})
			}
			globalState.selectedServers.set(context.wsClientId, serverId)
			globalState.selectedServerUpdate$.next({
				wsClientId: context.wsClientId,
				serverId,
			})
			return { code: 'ok' as const }
		}),

	watchLayersStatus: orpcBase.handler(async function*({ context, signal }) {
		const obs = selectedServerCtx$(context).pipe(
			withAbortSignal(signal!),
			switchMapWithSignal(async function*(ctx, signal) {
				{
					const currentMatch = await MatchHistory.getCurrentMatch(ctx)
					const nextLayerId = ctx.server.eventState.nextLayerId
					const status: SM.LayersStatusExt = {
						currentLayer: L.toLayer(currentMatch.layerId),
						nextLayer: nextLayerId ? L.toLayer(nextLayerId) : null,
						currentMatch,
					}
					yield status
				}
				const event$ = ctx.server.event$.pipe(withAbortSignal(signal))
				for await (const [ctx, event] of toAsyncGenerator(event$)) {
					if (!['NEW_GAME', 'MAP_SET', 'RESET'].includes(event.type)) continue
					const currentMatch = await MatchHistory.getCurrentMatch(ctx)
					const nextLayerId = ctx.server.eventState.nextLayerId
					const status: SM.LayersStatusExt = {
						currentLayer: L.toLayer(currentMatch.layerId),
						nextLayer: nextLayerId ? L.toLayer(nextLayerId) : null,
						currentMatch,
					}
					yield status
				}
			}),
			Rx.map((status): SM.LayersStatusResExt => ({ code: 'ok', data: status })),
		)
		yield* toAsyncGenerator(obs)
	}),

	watchServerRolling: orpcBase.handler(async function*({ context, signal }) {
		const obs = selectedServerCtx$(context).pipe(
			Rx.switchMap((ctx) => {
				return ctx.server.serverRolling$
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	watchServerInfo: orpcBase.handler(async function*({ context, signal }) {
		const obs = selectedServerCtx$(context).pipe(
			Rx.switchMap((ctx) => {
				return ctx.server.serverInfo.observe(ctx).pipe(distinctDeepEquals())
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	endMatch: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = resolveWsClientSliceCtx(_ctx)
		const deniedRes = await Rbac.tryDenyPermissionsForUser(
			ctx,
			RBAC.perm('squad-server:end-match'),
		)
		if (deniedRes) return deniedRes
		const matchEnded$ = ctx.server.event$.pipe(
			Rx.map(([_, e]) => e),
			Rx.filter((e) => e.type === 'ROUND_ENDED'),
			Rx.endWith(null),
		)
		const result$ = Rx.firstValueFrom(
			Rx.race(
				matchEnded$,
				Rx.timer(10_000).pipe(Rx.map(() => 'timeout' as const)),
			),
		)

		SquadRcon.endMatch(ctx)

		const result = await result$
		if (result === 'timeout') {
			return {
				code: 'err:timeout' as const,
				message: 'Failed to end match: operation timed out',
			}
		}
		if (result === null) {
			return {
				code: 'err:unknown' as const,
				message: 'Failed to end match: unknown error',
			}
		}
		if (result.type === 'ROUND_ENDED') {
			return { code: 'ok' as const, message: 'Match ended successfully' }
		}
		assertNever(result.type)
	}),

	watchChatEvents: orpcBase
		.input(
			z.object({ lastEventId: z.number().optional(), serverId: z.string() }),
		)
		.handler(async function*({ context, signal, input }) {
			const obs: Rx.Observable<(SE.Event | CHAT.LifecycleEvent)[]> = selectedServerCtx$(context).pipe(
				Rx.switchMap((ctx) => {
					async function getInitialEvents() {
						const sync: CHAT.SyncedEvent = {
							type: 'SYNCED' as const,
							time: Date.now(),
							matchId: (await MatchHistory.getCurrentMatch(ctx))
								.historyEntryId,
						}

						let allEvents: SE.Event[] = ctx.server.emittedEvents
						let events: (SE.Event | CHAT.LifecycleEvent)[] = []

						if (
							input.lastEventId === undefined
							|| ctx.serverId !== input.serverId
						) {
							events.push({
								type: 'INIT',
								time: Date.now(),
								serverId: ctx.serverId,
							})
							events.push(...allEvents)
							events.push(sync)
						} else {
							let lastEventIndex = allEvents.findIndex(
								(e) => e.id === input!.lastEventId!,
							)

							// let the client know that we are reconnecting from their last known event id
							events.push({
								type: 'CHAT_RECONNECTED',
								resumedEventId: lastEventIndex === -1 ? null : input!.lastEventId!,
							})
							// if last event was not found it'll be -1, which works nicely here because we just need to resend all events
							events.push(...allEvents.slice(lastEventIndex + 1))
							events.push(sync)
						}

						return Arr.paged(events, 512)
					}
					const initial$ = Rx.from(getInitialEvents()).pipe(Rx.concatAll())

					const upcoming$ = ctx.server.event$.pipe(
						Rx.map(([_, event]): SE.Event[] => [event]),
					)

					return Rx.concat(initial$, upcoming$).pipe(
						// orpc will break without this
						Rx.observeOn(Rx.asyncScheduler),
					)
				}),
				Rx.tap({
					error: (err) => {
						log.error(err, 'Error in watchChatEvents')
					},
				}),
				withAbortSignal(signal!),
			)
			yield* toAsyncGenerator(obs)
		}),

	toggleFogOfWar: orpcBase
		.input(z.object({ disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveWsClientSliceCtx(_ctx)
			const denyRes = await Rbac.tryDenyPermissionsForUser(
				ctx,
				RBAC.perm('squad-server:turn-fog-off'),
			)
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
	log = module.getLogger()
	ENV = envBuilder()
	const ctx = getBaseCtx()

	globalState = {
		slices: new Map(),
		selectedServers: new Map(),
		selectedServerUpdate$: new Rx.Subject(),
		serverEventIdCounter: undefined!,
		squadIdCounter: undefined!,
	}
	const ops: Promise<void>[] = []

	const lastEventRes = await ctx
		.db()
		.select({ id: Schema.serverEvents.id })
		.from(Schema.serverEvents)
		.orderBy(E.desc(Schema.serverEvents.id))
		.limit(1)
	// driver sometimes returns strings so just to be safe
	const nextEventId = lastEventRes.length > 0 ? Number(lastEventRes[0].id) + 1 : 0
	globalState.serverEventIdCounter = Gen.counter(nextEventId)

	const lastSquadRes = await ctx
		.db()
		.select({ id: Schema.squads.id })
		.from(Schema.squads)
		.orderBy(E.desc(Schema.squads.id))
		.limit(1)
	const nextSquadId = lastSquadRes.length > 0 ? Number(lastSquadRes[0].id) + 1 : 0
	globalState.squadIdCounter = Gen.counter(nextSquadId)

	for (const serverConfig of CONFIG.servers) {
		if (!serverConfig.enabled) continue
		const settingsFromConfig = {
			connections: serverConfig.connections,
			adminListSources: serverConfig.adminListSources!,
			adminIdentifyingPermissions: serverConfig.adminIdentifyingPermissions,
		}
		ops.push(
			(async function loadServerConfig() {
				const serverState = await DB.runTransaction(
					ctx,
					{ redactParams: true },
					async () => {
						let [server] = await ctx
							.db()
							.select()
							.from(Schema.servers)
							.where(E.eq(Schema.servers.id, serverConfig.id))
							.for('update')
						if (!server) {
							log.info(`Server ${serverConfig.id} not found, creating new`)
							server = {
								id: serverConfig.id,
								displayName: serverConfig.displayName,
								settings: SS.ServerSettingsSchema.parse(settingsFromConfig),
								layerQueue: [],
								teamswitches: new Map(),
							}
							await ctx
								.db({ redactParams: true })
								.insert(Schema.servers)
								.values(superjsonify(Schema.servers, server))
						} else {
							server = unsuperjsonify(Schema.servers, server) as typeof server
							log.info(
								`Server ${serverConfig.id} found, ensuring settings are up-to-date`,
							)

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
								log.info(`Server ${serverConfig.id} settings updated`)
								await ctx
									.db({ redactParams: true })
									.update(Schema.servers)
									.set(superjsonify(Schema.servers, server))
									.where(E.eq(Schema.servers.id, serverConfig.id))
							} else {
								log.info(`Server ${serverConfig.id} settings are up-to-date`)
							}
						}

						return server as SS.ServerState
					},
				)

				if (!serverState) {
					throw new Error(
						`Server ${serverConfig.id} was unable to be configured`,
					)
				}
				await setupSlice(ctx, serverState)
				log.info(`Server ${serverConfig.id} setup complete`)
			})(),
		)
	}

	await Promise.all(ops)
}

async function setupSlice(ctx: C.Db, serverState: SS.ServerState) {
	const serverId = serverState.id
	const settings = serverState.settings
	const cleanup: CleanupTasks = []

	const rcon = new Rcon({ serverId, settings: settings.connections.rcon })
	rcon.ensureConnected()
	cleanup.push(() => rcon.disconnect())

	const layersStatusExt$: SquadServer['layersStatusExt$'] = getLayersStatusExt$(serverId)

	const adminList = (() => {
		const adminListTTL = HumanTime.parse('1h')
		let serverSources: SM.AdminListSource[] = []
		for (const key of serverState.settings.adminListSources) {
			serverSources.push(CONFIG.adminListSources[key])
		}
		// we are duplicating fetches here if two servers have the same source, but shouldn't matter
		return new AsyncResource<SM.AdminList, CS.Ctx>(
			`${serverId}/adminLists`,
			(_ctx) => fetchAdminLists(serverSources, settings.adminIdentifyingPermissions),
			module,
			{
				defaultTTL: adminListTTL,
				retries: 3,
				retryDelay: 1000,
				log,
			},
		)
	})()
	cleanup.push(() => adminList.dispose())
	const eventState: PendingEvents.State = PendingEvents.init({
		counters: {
			eventId: globalState.serverEventIdCounter,
			squadId: globalState.squadIdCounter,
		},
		currentMatch: 'PENDING',
		log: log,
		hooks: {
			onNewGameDuringRoll: onNewGameDuringRoll(serverId),
			onNewGameDuringSync: onNewGameDuringSync(serverId),
			fetchLayersStatus: async () => {
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				const res = await ctx.server.layersStatus.get(ctx)
				if (res.code === 'ok') return res.data
				return null
			},
		},
	})

	const server: SquadServer = {
		layersStatusExt$,

		postRollEventsSub: null,

		serverRolling$: new Rx.BehaviorSubject(null as number | null),

		event$: new Rx.Subject(),
		processEventsMtx: new Mutex(),

		eventState: eventState,

		chatState: CHAT.getInitialChatState(),
		emittedEvents: [],
		lastSavedEventId: null,
		destroyed: false,
		cleanupId: null,

		savingEventsMtx: new Mutex(),

		...SquadRcon.initSquadRcon({ ...ctx, rcon, adminList, serverId }, cleanup),
	}

	cleanup.push(
		() => server.postRollEventsSub,
		server.serverRolling$,
		server.event$,
		server.savingEventsMtx,
		server.processEventsMtx,
	)

	const slice: C.ServerSlice = {
		...CS.init(),
		serverId,

		rcon,
		server,

		matchHistory: MatchHistory.initMatchHistoryContext(server.event$, cleanup),

		teamswitches: ENV.FF_TEAMSWITCH_SYSTEM
			? TeamSwitchesSys.initContext({
				...ctx,
				serverId,
				cleanup,
				server,
			})
			: (null as unknown as TeamSwitchesSys.TeamswitchContext),
		layerQueue: LayerQueue.initLayerQueueSlice({ ...ctx, cleanup, serverId }, serverState),
		userPresence: UserPresence.initUserPresenceContext({ ...ctx, cleanup, serverId }),
		vote: Vote.initVoteContext(cleanup),

		adminList,
		cleanup: cleanup,
	}

	globalState.slices.set(serverId, slice)

	// -------- load saved events --------
	await loadSavedEvents({ ...ctx, server, serverId })

	// // -------- watch events --------
	server.event$.subscribe(([ctx, event]) => {
		try {
			CHAT.handleEvent(ctx.server.chatState, event)
		} catch (error) {
			log.error('Error handling event: %s %d', event.type, event.id, error)
		}
		log.info(
			'emitted event: %s %s',
			event.type,
			JSON.stringify(
				['NEW_GAME', 'RESET'].includes(event.type)
					? Obj.omit(event as any, ['state'])
					: event,
			),
		)
		ctx.server.emittedEvents.push(event)
	})

	server.event$
		.pipe(
			Rx.filter(
				([_, event]) => event.type === 'PLAYER_DETAILS_CHANGED' && !!event.newUsername,
			),
			C.durableSub('onPlayerNameChanged', { module }, async ([ctx, event]) => {
				if (event.type !== 'PLAYER_DETAILS_CHANGED' || !event.newUsername) {
					return
				}
				await ctx
					.db()
					.update(Schema.players)
					.set({ username: event.newUsername })
					.where(E.eq(Schema.players.eosId, event.player))
			}),
		)
		.subscribe() // -------- process log events --------
	void C.spanOp('processLogEvents', { module }, async (_: unknown) => {
		let chunk$: Rx.Observable<string>
		if (settings.connections.logs.type === 'sftp') {
			const sftpReader = new SftpTail({
				filePath: settings.connections!.logs.logFile,
				host: settings.connections!.logs.host,
				port: settings.connections!.logs.port,
				username: settings.connections!.logs.username,
				password: settings.connections!.logs.password,
				pollInterval: CONFIG.squadServer.sftpPollInterval,
				reconnectInterval: CONFIG.squadServer.sftpReconnectInterval,
				parentModule: module,
			})
			cleanup.push(() => sftpReader.disconnect())
			sftpReader.watch()

			chunk$ = Rx.fromEvent(sftpReader, 'chunk').pipe(
				Rx.map((...args) => args[0] as string),
			)
		} else if (settings.connections.logs.type === 'log-receiver') {
			chunk$ = SquadLogsReceiver.event$.pipe(
				Rx.concatMap((event) => event.type === 'data' ? Rx.of(event.data) : Rx.EMPTY),
			)
		} else {
			assertNever(settings.connections.logs)
		}

		const errors: Error[] = []
		for await (
			const event of SM.LogEvents.parseLogStream(
				toAsyncGenerator(chunk$),
				errors,
			)
		) {
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			for (const error of errors) log.error(error)
			errors.splice(0, errors.length)

			if (!event) {
				log.warn('No log event to process')
				return
			}

			await collectEvents(ctx, () => {
				PendingEvents.onLogEvent(ctx.server.eventState, event)
			})
		}
	})({ ...ctx, server })

	rcon.connected$
		.pipe(
			C.durableSub(
				'onRconConnectStatusChange',
				{ module },
				async (connected) => {
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)
					const time = Date.now()
					let layerStatus: SM.LayersStatusResExt | undefined
					let layersData: SM.LayersStatusExt | undefined
					if (connected) {
						layerStatus = await ctx.server.layersStatus.get({ ...ctx, rcon })
						if (layerStatus.code !== 'ok') return layerStatus
						layersData = layerStatus.data
					}
					await collectEvents({ ...ctx, server }, () => {
						if (connected) {
							PendingEvents.onRconConnected(
								ctx.server.eventState,
								time,
								layersData!.nextLayer?.id ?? null,
								layersData!.currentLayer.id,
							)
						} else {
							PendingEvents.onRconDisconnected(ctx.server.eventState, time)
						}
					})
				},
			),
		)
		.subscribe()

	// -------- process rcon events --------
	server.rconEvent$
		.pipe(
			C.durableSub(
				'onRconEvent',
				{ module, taskScheduling: 'parallel', levels: { event: 'trace' } },
				async ([_ctx, event]) => {
					const ctx = DB.addPooledDb(resolveSliceCtx(_ctx, serverId))
					try {
						if (event.type === 'CHAT_MESSAGE') {
							if (event.message.startsWith(CONFIG.commandPrefix)) {
								void Commands.handleCommand(ctx, event).then((res) => {
									if (res?.code !== 'ok') log.error(res)
								})
							} else if (
								event.message.trim().match(/^\d+$/)
								&& ctx.vote.state?.code === 'in-progress'
							) {
								void Vote.handleVote(ctx, event)
							}
						}
					} catch (err) {
						log.error(err)
					}

					await collectEvents(ctx, () => {
						PendingEvents.onRconEvent(ctx.server.eventState, event)
					})
				},
			),
		)
		.subscribe()

	server.teams
		.observe({ ...slice, ...ctx })
		.pipe(
			C.durableSub(
				'onTeamsPolled',
				{ module, numTaskRetries: 0 },
				async (teamsRes) => {
					if (teamsRes.code !== 'ok') return teamsRes
					const time = Date.now()
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)
					await collectEvents(ctx, () => {
						PendingEvents.onTeamsPolled(
							server.eventState,
							{ players: teamsRes.players, squads: teamsRes.squads },
							time,
						)
					})
				},
			),
		)
		.subscribe()

	{
		// -------- periodically save events  --------
		const saveEventSub = Rx.interval(10_000)
			.pipe(
				Rx.filter(() => {
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)
					return ctx.server.emittedEvents.length > 0
						&& ctx.server.lastSavedEventId !== ctx.server.emittedEvents[ctx.server.emittedEvents.length - 1].id
				}),
				C.durableSub(
					'save-events-interval',
					{ module, root: true, taskScheduling: 'exhaust' },
					async () => {
						const ctx = resolveSliceCtx(getBaseCtx(), serverId)
						return saveEvents(ctx)
					},
				),
			)
			.subscribe()

		// -------- save remaining events on cleanup  --------
		cleanup.push(async () => {
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			saveEventSub.unsubscribe()
			await saveEvents(ctx)
		})
	}

	void LayerQueue.setupInstance({ ...ctx, ...slice })
	Battlemetrics.setupSquadServerInstance({ ...ctx, ...slice })
	void adminList.get(slice)

	server.cleanupId = CleanupSys.register(async () => {
		const ctx = resolveSliceCtx(getBaseCtx(), serverId)
		await destroyServer(ctx)
	})
	log.info('Initialized server %s', serverId)
}

export async function pushAttribution(ctx: C.SquadServer & C.Db, attribution: Omit<PendingEvents.Attribution, 'time'>) {
	await collectEvents(ctx, () => {
		PendingEvents.pushAttribution(ctx.server.eventState, attribution)
	})
}

export async function destroyServer(ctx: C.ServerSlice) {
	if (ctx.server.destroyed) return
	ctx.server.destroyed = true
	const cleanupId = ctx.server.cleanupId
	if (cleanupId !== null) CleanupSys.unregister(cleanupId)
	await runCleanup({ ...CS.init(), ...ctx, log }, ctx.cleanup)
	// we're not dealing with mutexes yet Sadge
	globalState.slices.delete(ctx.serverId)
	for (
		const [wsClientId, serverId] of Array.from(
			globalState.selectedServers.entries(),
		)
	) {
		if (ctx.serverId === serverId) {
			globalState.selectedServers.delete(wsClientId)
		}
	}
}

export async function getFullServerState(ctx: C.Db & C.LayerQueue) {
	const query = ctx
		.db()
		.select()
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	let serverRaw: any
	if (ctx.tx) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

async function collectEvents(
	ctx: C.SquadServer & C.Db,
	addEventsCb: () => void,
) {
	const release = await ctx.server.processEventsMtx.acquire()
	addEventsCb()
	try {
		for await (
			const event of PendingEvents.process(
				ctx.server.eventState,
				Date.now(),
			)
		) {
			ctx.server.event$.next([resolveSliceCtx(ctx, ctx.serverId), event])
		}
	} finally {
		release()
	}
}

function getLayersStatusExt$(serverId: string) {
	return new Rx.Observable<SM.LayersStatusResExt>((s) => {
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
		sub.add(
			ctx.matchHistory.update$.subscribe({
				next: async () => {
					s.next(await fetchLayersStatusExt(ctx))
				},
				error: (err) => s.error(err),
				complete: () => s.complete(),
			}),
		)
		return () => sub.unsubscribe()
	}).pipe(distinctDeepEquals(), Rx.share())
}

async function fetchLayersStatusExt(
	ctx: C.SquadServer & C.Rcon & C.MatchHistory,
) {
	const statusRes = await ctx.server.layersStatus.get(ctx)
	if (statusRes.code !== 'ok') return statusRes
	return buildServerStatusRes(
		statusRes.data,
		await MatchHistory.getCurrentMatch(ctx),
	)
}

function buildServerStatusRes(
	rconStatus: SM.LayersStatus,
	currentMatch: MH.MatchDetails,
) {
	const res: SM.LayersStatusResExt = {
		code: 'ok' as const,
		data: { ...rconStatus },
	}
	if (
		currentMatch
		&& L.areLayersCompatible(currentMatch.layerId, rconStatus.currentLayer)
	) {
		res.data.currentMatch = currentMatch
	}
	return res
}

// resolves a default server id for a request given the route and a previously stored default server id
export function manageDefaultServerIdForRequest<Ctx extends C.HttpRequest>(
	ctx: Ctx,
) {
	const servers = CONFIG.servers
		.filter((s) => s.enabled && globalState.slices.has(s.id))
		.toSorted((a, b) => {
			if (a.defaultServer !== b.defaultServer) return a.defaultServer ? -1 : 1
			return 0
		})

	if (servers.length === 0) throw new Error('No enabled servers found')

	const defaultServerId = ctx.cookies['default-server-id']
	const res = ctx.res
	let serverId: string | undefined
	if (ctx.route?.id === AR.route('/servers/:id')) {
		// we don't want to validate that this server exists because we want the client to render a 404
		serverId = ctx.route.params.id
	} else if (defaultServerId) {
		serverId = defaultServerId
		if (!servers.some((s) => s.id === serverId)) {
			serverId = servers[0].id
		}
	} else {
		serverId = servers[0].id
	}

	if (!defaultServerId || serverId !== defaultServerId) {
		res.cookie(AR.COOKIE_KEY.enum['default-server-id'], serverId, {
			...AR.COOKIE_DEFAULTS,
			httpOnly: false,
		})
	}

	return {
		...ctx,
		res,
	}
}

export function resolveWsClientSliceCtx(ctx: C.OrpcBase) {
	let serverId = globalState.selectedServers.get(ctx.wsClientId)
	serverId ??= CONFIG.servers[0].id
	if (!serverId) {
		throw new Orpc.ORPCError('BAD_REQUEST', { message: 'No server selected' })
	}
	const slice = globalState.slices.get(serverId)
	if (!slice) {
		throw new Orpc.ORPCError('BAD_REQUEST', {
			message: 'Server slice not found',
		})
	}
	return {
		...ctx,
		...slice,
	}
}

export function resolveSliceCtx<T extends object>(ctx: T, serverId: string) {
	const slice = globalState.slices.get(serverId)
	if (!slice) {
		throw new Orpc.ORPCError('BAD_REQUEST', {
			message: 'Server slice not found: ' + serverId,
		})
	}
	return {
		...ctx,
		...slice,
	}
}

function getBaseCtx() {
	return DB.addPooledDb(CS.init())
}

export function selectedServerCtx$<Ctx extends C.WSSession>({
	wsClientId,
}: Ctx) {
	return globalState.selectedServerUpdate$.pipe(
		Rx.concatMap((s) => s.wsClientId === wsClientId ? Rx.of(s.serverId) : Rx.EMPTY),
		Rx.startWith(globalState.selectedServers.get(wsClientId)!),
		Rx.map((serverId) =>
			resolveSliceCtx(
				{ ...getBaseCtx(), ...WsSessionSys.wsSessions.get(wsClientId)! },
				serverId,
			)
		),
	)
}

export async function getServerState(ctx: C.Db & C.ServerId) {
	const query = ctx
		.db()
		.select()
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	let serverRaw: any
	if (ctx.tx) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

export async function updateServerState(
	ctx: C.Db & C.Tx & C.LayerQueue,
	changes: Partial<SS.ServerState>,
	source: SS.LQStateUpdate['source'],
) {
	const serverState = await getServerState(ctx)
	const newServerState = { ...serverState, ...changes }
	await ctx
		.db({ redactParams: true })
		.update(Schema.servers)
		.set(
			superjsonify(Schema.servers, changes),
		)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const update: SS.LQStateUpdate = { state: newServerState, source }

	ctx.tx.unlockTasks.push(() =>
		ctx.layerQueue.update$.next([
			update,
			{ ...getBaseCtx(), serverId: ctx.serverId },
		])
	)
	return newServerState
}

const loadSavedEvents = C.spanOp(
	'loadSavedEvents',
	{ module },
	async (ctx: C.SquadServer & C.Db) => {
		const server = ctx.server
		const [lastMatch] = await ctx
			.db()
			.select({ id: Schema.matchHistory.id })
			.from(Schema.matchHistory)
			.where(E.eq(Schema.matchHistory.serverId, ctx.serverId))
			.orderBy(E.desc(Schema.matchHistory.ordinal))
			.limit(1)

		const rowsRaw = lastMatch
			? await ctx
				.db()
				.select({ event: Schema.serverEvents })
				.from(Schema.serverEvents)
				.where(E.eq(Schema.serverEvents.matchId, lastMatch.id))
				.orderBy(E.asc(Schema.serverEvents.id))
			: []
		const events = rowsRaw.map((r) => SE.fromEventRow(r.event))
		server.lastSavedEventId = events[events.length - 1]?.id ?? null
		server.emittedEvents = events
	},
)

let prevEvents: Set<number> = new Set()

export const saveEvents = C.spanOp(
	'saveEvents',
	{ module, mutexes: (ctx) => ctx.server.savingEventsMtx },
	async (ctx: C.SquadServer & C.Db) =>
		await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
			const server = ctx.server

			let events: SE.Event[] = []
			if (server.lastSavedEventId === null) {
				events = server.emittedEvents.slice()
			} else {
				const lastSavedIndex = server.emittedEvents.findIndex(
					(e) => e.id === server.lastSavedEventId,
				)
				if (lastSavedIndex === -1) {
					throw new Error(
						`CRITICAL: Unable to resolve last saved event ${server.lastSavedEventId}`,
					)
				}
				events = server.emittedEvents.slice(lastSavedIndex + 1)
			}
			for (const event of events) {
				if (prevEvents.has(event.id)) {
					throw new Error(
						`Duplicate event id: ${event.id} ${JSON.stringify(event)}`,
					)
				}
				prevEvents.add(event.id)
			}

			if (events.length === 0) {
				log.debug('No events to save')
				return
			}

			let eventRows: SchemaModels.NewServerEvent[] = []
			let playerRows: SchemaModels.NewPlayer[] = []
			let playerAssociationRows: SchemaModels.NewPlayerEventAssociation[] = []
			let squadRows: SchemaModels.NewSquad[] = []
			let squadAssociationRows: SchemaModels.NewSquadEventAssociation[] = []

			for (const event of events) {
				const persisted = Obj.omit(event, ['id', 'type', 'time', 'matchId'])
				eventRows.push({
					id: event.id,
					type: event.type,
					time: new Date(event.time),
					matchId: event.matchId,
					data: superjson.serialize(persisted),
				})

				for (const [player, assocType] of SE.iterAssocPlayers(event)) {
					let playerId: SM.PlayerId
					if (typeof player === 'object') {
						playerRows.push({
							steamId: player.ids.steam ? BigInt(player.ids.steam) : null,
							eosId: player.ids.eos,
							username: player.ids.username,
							epicId: player.ids.epic,
						})
						playerId = SM.PlayerIds.getPlayerId(player.ids)
					} else {
						playerId = player
					}
					playerAssociationRows.push({
						assocType: assocType,
						playerId,
						serverEventId: event.id,
					})
				}

				for (const squad of SE.iterAssocUniqueSquads(event)) {
					let uniqueSquadId: number
					if (typeof squad === 'object') {
						squadRows.push({
							id: squad.uniqueId,
							ingameSquadId: squad.squadId,
							name: squad.squadName,
							creatorId: squad.creator,
							teamId: squad.teamId,
						})
						uniqueSquadId = squad.uniqueId
					} else {
						uniqueSquadId = squad
					}
					squadAssociationRows.push({
						squadId: uniqueSquadId,
						serverEventId: event.id,
					})
				}
			}

			await ctx
				.db({ redactParams: true })
				.insert(Schema.serverEvents)
				.values(eventRows)
			server.lastSavedEventId = eventRows[eventRows.length - 1].id!

			if (playerRows.length > 0) {
				await ctx
					.db({ redactParams: true })
					.insert(Schema.players)
					.values(playerRows)
					.onDuplicateKeyUpdate({
						set: {
							steamId: sql`VALUES(steamId)`,
							eosId: sql`VALUES(eosId)`,
							username: sql`VALUES(username)`,
							modifiedAt: sql`IF(eosId != VALUES(eosId) OR username != VALUES(username) OR steamId != VALUES(steamId), NOW(), modifiedAt)`,
						},
					})
				playerRows = []
			}

			if (playerAssociationRows.length > 0) {
				const playersToLookup = [
					...new Set(
						playerAssociationRows
							.map((r) => r.playerId)
							.filter((r) => !playerRows.some((p) => p.eosId === r)),
					),
				]
				const existingPlayers = await ctx
					.db()
					.select({ eosId: Schema.players.eosId })
					.from(Schema.players)
					.where(E.inArray(Schema.players.eosId, playersToLookup))
				const existingIds = new Set(existingPlayers.map((p) => p.eosId))
				const validRows = playerAssociationRows.filter((r) => {
					if (!playersToLookup.includes(r.playerId)) return true
					if (existingIds.has(r.playerId)) return true
					log.error(
						'skipping playerEventAssociation for unknown player %s (event %d)',
						r.playerId,
						r.serverEventId,
					)
					return false
				})
				if (validRows.length > 0) {
					await ctx
						.db({ redactParams: true })
						.insert(Schema.playerEventAssociations)
						.values(validRows)
				}
			}

			if (squadRows.length > 0) {
				await ctx
					.db({ redactParams: true })
					.insert(Schema.squads)
					.values(squadRows)
					.onDuplicateKeyUpdate({
						set: {
							ingameSquadId: sql`VALUES(ingameSquadId)`,
							teamId: sql`VALUES(teamId)`,
							name: sql`VALUES(name)`,
							creatorId: sql`VALUES(creatorId)`,
						},
					})
			}
			if (squadAssociationRows.length > 0) {
				await ctx
					.db({ redactParams: true })
					.insert(Schema.squadEventAssociations)
					.values(squadAssociationRows)
			}
		}),
)

const onNewGameDuringSync = (serverId: string): PendingEvents.State['hooks']['onNewGameDuringSync'] => async (currentLayerId, _time) => {
	const ctx = resolveSliceCtx(getBaseCtx(), serverId)
	return C.spanOp(
		'onNewGameDuringSync',
		{
			module,
			mutexes: () => [ctx.matchHistory.mtx, ctx.server.savingEventsMtx],
			levels: { event: 'info' },
		},
		async () => {
			const { currentMatch, pushedNewMatch } = await MatchHistory.syncWithCurrentLayer(ctx, currentLayerId)
			return { match: currentMatch, isNewMatch: pushedNewMatch }
		},
	)()
}

const onNewGameDuringRoll = (serverId: string): PendingEvents.State['hooks']['onNewGameDuringRoll'] => async (newLayerId, time) => {
	const ctx = resolveSliceCtx(getBaseCtx(), serverId)
	return C.spanOp(
		'onNewGameDuringRoll',
		{
			module,
			mutexes: () => [ctx.matchHistory.mtx, ctx.server.savingEventsMtx, ctx.layerQueue.updateLayerMtx],
			levels: { event: 'info' },
		},
		async () =>
			await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
				ctx.server.serverRolling$.next(Date.now())
				try {
					const nextLqItem = LayerQueue.getSavedQueue(ctx)[0]

					let currentMatchLqItem: LL.Item | undefined
					if (
						nextLqItem
						&& L.areLayersCompatible(nextLqItem.layerId, newLayerId)
					) {
						await LayerQueue.dispatchOp(ctx, { op: 'shift-first-saved-layer', opId: SLL.createOpId() })
						currentMatchLqItem = nextLqItem
					}
					const { match } = await MatchHistory.addNewCurrentMatch(
						ctx,
						MH.getNewMatchHistoryEntry({
							layerId: newLayerId,
							serverId: ctx.serverId,
							startTime: new Date(time),
							lqItem: currentMatchLqItem,
						}),
					)
					LayerQueue.schedulePostRollTasks(ctx, match.layerId)
					const nextLayerId = LL.getNextLayerId(LayerQueue.getSavedQueue(ctx))
					return { match, nextLayerId }
				} finally {
					ctx.server.serverRolling$.next(null)
				}
			}),
	)()
}

export async function waitForSynced(ctx: C.SquadServer) {
	if (ctx.server.eventState.syncState.type === 'synced') return
	await Rx.firstValueFrom(
		ctx.server.event$.pipe(
			Rx.filter(
				([ctx, event]) => event.type === 'NEW_GAME' || event.type === 'RESET',
			),
		),
	)
}
