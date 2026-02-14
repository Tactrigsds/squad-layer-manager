import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as AR from '@/app-routes'
import * as Arr from '@/lib/array'
import { type CleanupTasks, distinctDeepEquals, runCleanup, toAsyncGenerator, traceTag, withAbortSignal } from '@/lib/async'
import { AsyncResource } from '@/lib/async-resource'
import * as DH from '@/lib/display-helpers'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Gen from '@/lib/generator'
import { withAcquired } from '@/lib/nodejs-reentrant-mutexes'
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
import type * as LL from '@/models/layer-list.models'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Commands from '@/systems/commands.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SharedLayerList from '@/systems/shared-layer-list.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
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

	historyConflictsResolved$: Rx.BehaviorSubject<boolean>

	serverRolling$: Rx.BehaviorSubject<number | null>

	// when set this intercepts team updates that are intended to generate synthetic events. handling code must account for the absent synthetic events
	teamUpdateInterceptor: Rx.Subject<SM.Teams> | null
	teamUpdateInterceptorMtx: MutexInterface

	// ephemeral state that isn't persisted to the database, as compared to SS.ServerState which is
	state: EphemeralState

	savingEventsMtx: Mutex

	// TODO we should slim down the context we provide here so that we're just transmitting span & logging info, and leave the listener to construct everything else
	event$: Rx.Subject<[C.Db & C.ServerSlice, SM.Events.Event[]]>
} & SquadRcon.SquadRcon

type EphemeralState = {
	roundWinner: SM.SquadOutcomeTeam | null
	roundLoser: SM.SquadOutcomeTeam | null
	roundEndState: {
		winner: string | null
		layer: string
	} | null

	// chainID -> values
	joinRequests: Map<number, SM.PlayerIds.IdQuery>
	kickingPlayerEvents: Map<number, SM.LogEvents.KickingPlayer>

	// ids of players currently connected to the server. players are considered "connected" once PLAYER_CONNECTED has fired (or is scheduled to be fired in this microtask)
	connected: SM.PlayerIds.Type[]
	pendingEventState: PendingEvents.State

	createdSquads: SM.Squad[]

	// constains mostly events from the current match. however don't assume this and filter for the current match whenever accessing
	eventBuffer: SM.Events.Event[]
	// if null, we haven't saved yet in this instantiation of the server
	lastSavedEventId: number | null

	destroyed: boolean

	nextSetLayerId: L.LayerId | null
	chat: CHAT.ChatState

	cleanupId: number | null
}

namespace EphemeralState {
	export function init(): EphemeralState {
		return {
			roundEndState: null,
			roundLoser: null,
			roundWinner: null,
			joinRequests: new Map(),
			kickingPlayerEvents: new Map(),
			pendingEventState: PendingEvents.init(),
			connected: [],
			createdSquads: [],
			eventBuffer: [],
			lastSavedEventId: null,
			nextSetLayerId: null,
			destroyed: false,
			cleanupId: null,
			chat: CHAT.getInitialChatState(),
		}
	}
}

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
		const matchEnded$ = ctx.server.event$.pipe(Rx.concatMap(([_, e]) => e), Rx.filter(e => e.type === 'ROUND_ENDED'), Rx.endWith(null))
		const result$ = Rx.firstValueFrom(Rx.race(matchEnded$, Rx.timer(5_000).pipe(Rx.map(() => 'timeout' as const))))

		SquadRcon.endMatch(ctx)

		const result = await result$
		if (result === 'timeout') {
			return { code: 'err:timeout' as const, message: 'Failed to end match: operation timed out' }
		}
		if (result === null) {
			return { code: 'err:unknown' as const, message: 'Failed to end match: unknown error' }
		}
		if (result.type === 'ROUND_ENDED') {
			return { code: 'ok' as const, message: 'Match ended successfully' }
		}
		assertNever(result.type)
	}),

	watchChatEvents: orpcBase.input(z.object({ lastEventId: z.number().optional(), serverId: z.string() })).handler(
		async function*({ context, signal, input }) {
			const obs: Rx.Observable<(SM.Events.Event | CHAT.LifecycleEvent)[]> = selectedServerCtx$(
				context,
			)
				.pipe(
					Rx.switchMap(ctx => {
						async function getInitialEvents() {
							const sync: CHAT.SyncedEvent = {
								type: 'SYNCED' as const,
								time: Date.now(),
								matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
							}

							let allEvents: SM.Events.Event[] = ctx.server.state.eventBuffer
							let events: (SM.Events.Event | CHAT.LifecycleEvent)[] = []

							if (input.lastEventId === undefined || ctx.serverId !== input.serverId) {
								events.push({
									type: 'INIT',
									time: Date.now(),
									serverId: ctx.serverId,
								})
								events.push(...allEvents)
								events.push(sync)
							} else {
								let lastEventIndex = allEvents.findIndex(e => e.id === input!.lastEventId!)

								// let the client know that we are reconnecting from their last known event id
								events.push({ type: 'CHAT_RECONNECTED', resumedEventId: lastEventIndex === -1 ? null : input!.lastEventId! })
								// if last event was not found it'll be -1, which works nicely here because we just need to resend all events
								events.push(...allEvents.slice(lastEventIndex + 1))
								events.push(sync)
							}

							return Arr.paged(events, 512)
						}
						const initial$ = ctx.server.historyConflictsResolved$
							.pipe(
								Rx.filter(resolved => resolved),
								Rx.first(),
								Rx.concatMap(getInitialEvents),
								Rx.concatAll(),
							)

						const upcoming$ = ctx.server.event$.pipe(Rx.map(([_, events]): SM.Events.Event[] => events))

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
		},
	),

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
	log = module.getLogger()
	const ctx = getBaseCtx()

	globalState = {
		slices: new Map(),
		selectedServers: new Map(),
		selectedServerUpdate$: new Rx.Subject(),
		serverEventIdCounter: undefined!,
		squadIdCounter: undefined!,
	}
	const ops: Promise<void>[] = []

	const lastEventRes = await ctx.db().select({ id: Schema.serverEvents.id }).from(Schema.serverEvents).orderBy(
		E.desc(Schema.serverEvents.id),
	).limit(1)
	// driver sometimes returns strings so just to be safe
	const nextEventId = lastEventRes.length > 0 ? Number(lastEventRes[0].id) + 1 : 0
	globalState.serverEventIdCounter = Gen.counter(nextEventId)

	const lastSquadRes = await ctx.db().select({ id: Schema.squads.id }).from(Schema.squads).orderBy(
		E.desc(Schema.squads.id),
	).limit(1)
	const nextSquadId = lastSquadRes.length > 0 ? Number(lastSquadRes[0].id) + 1 : 0
	globalState.squadIdCounter = Gen.counter(nextSquadId)

	for (const serverConfig of CONFIG.servers) {
		if (!serverConfig.enabled) continue
		const settingsFromConfig = {
			connections: serverConfig.connections,
			adminListSources: serverConfig.adminListSources!,
			adminIdentifyingPermissions: serverConfig.adminIdentifyingPermissions,
		}
		ops.push((async function loadServerConfig() {
			const serverState = await DB.runTransaction(ctx, async () => {
				let [server] = await ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, serverConfig.id)).for('update')
				if (!server) {
					log.info(`Server ${serverConfig.id} not found, creating new`)
					server = {
						id: serverConfig.id,
						displayName: serverConfig.displayName,
						settings: SS.ServerSettingsSchema.parse(settingsFromConfig),
						layerQueue: [],
						layerQueueSeqId: 0,
					}
					await ctx.db().insert(Schema.servers).values(superjsonify(Schema.servers, server))
				} else {
					server = unsuperjsonify(Schema.servers, server) as typeof server
					log.info(`Server ${serverConfig.id} found, ensuring settings are up-to-date`)

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
						await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, server)).where(E.eq(Schema.servers.id, serverConfig.id))
					} else {
						log.info(`Server ${serverConfig.id} settings are up-to-date`)
					}
				}

				return server as SS.ServerState
			})

			if (!serverState) throw new Error(`Server ${serverConfig.id} was unable to be configured`)
			await setupSlice(ctx, serverState)
			log.info(`Server ${serverConfig.id} setup complete`)
		})())
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

	const server: SquadServer = {
		layersStatusExt$,

		postRollEventsSub: null,

		historyConflictsResolved$: new Rx.BehaviorSubject(false),

		serverRolling$: new Rx.BehaviorSubject(null as number | null),
		teamUpdateInterceptor: null,
		teamUpdateInterceptorMtx: new Mutex(),

		event$: new Rx.Subject(),
		state: EphemeralState.init(),
		savingEventsMtx: new Mutex(),

		...SquadRcon.initSquadRcon({ ...ctx, rcon, adminList, serverId }, cleanup),
	}

	cleanup.push(
		() => server.postRollEventsSub,
		server.historyConflictsResolved$,
		server.serverRolling$,
		server.event$,
		server.savingEventsMtx,
		server.teamUpdateInterceptorMtx,
		() => server.teamUpdateInterceptor,
	)

	const slice: C.ServerSlice = {
		...CS.init(),
		serverId,

		rcon,
		server,

		matchHistory: MatchHistory.initMatchHistoryContext(cleanup),

		layerQueue: LayerQueue.initLayerQueueContext(cleanup),
		sharedList: SharedLayerList.getDefaultState(serverState),
		vote: Vote.initVoteContext(cleanup),

		adminList,
		cleanup: cleanup,
	}
	globalState.slices.set(serverId, slice)

	// -------- load saved events --------
	await loadSavedEvents({ ...ctx, server, serverId })

	// -------- keep event buffer state up-to-date --------
	server.event$.subscribe(([ctx, events]) => {
		for (const event of events) {
			try {
				CHAT.handleEvent(ctx.server.state.chat, event)
			} catch (error) {
				log.error('Error handling event: %s %d', event.type, event.id, error)
			}
			log.debug('emitted event: %s %d', event.type, event.id)
		}
		ctx.server.state.eventBuffer.push(...events)
	})

	// -------- process log events --------
	//
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

	void (async () => {
		for await (const [event, err] of SM.LogEvents.parse(toAsyncGenerator(chunk$))) {
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			if (err) {
				log.error(err)
				continue
			}
			if (!event) continue
			await processLogEvent(ctx, event)
		}
	})()

	// -------- process rcon events --------
	server.rconEvent$
		.pipe(
			C.durableSub('on-rcon-event', { module, levels: { event: 'trace' } }, async ([_ctx, event]) => {
				const ctx = DB.addPooledDb(resolveSliceCtx(_ctx, serverId))
				if (!ctx.server.historyConflictsResolved$.value) {
					log.warn('History conflicts not resolved, ignoring RCON event %s', event.type)
					return { code: 'err:history-conflicts-not-resolved' as const }
				}
				return await processRconEvent(ctx, event)
			}),
		).subscribe()

	setupListenForTeamChanges({ ...ctx, rcon, serverId, server, adminList })

	setupResolveHistoryConflicts({ ...ctx, rcon, serverId })

	{
		// -------- periodically save events  --------
		const saveEventSub = Rx.interval(10_000).pipe(
			C.durableSub('save-events-interval', { module, root: true, taskScheduling: 'exhaust' }, async () => {
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				if (!ctx.server.historyConflictsResolved$.value) return
				return saveEvents(ctx)
			}),
		).subscribe()

		// -------- save remaining events on cleanup  --------
		cleanup.push(async () => {
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			saveEventSub.unsubscribe()
			await saveEvents(ctx)
		})
	}

	void LayerQueue.setupInstance({ ...ctx, ...slice })
	SharedLayerList.setupInstance({ ...ctx, ...slice })
	Battlemetrics.setupSquadServerInstance({ ...ctx, ...slice })
	void adminList.get(slice)

	server.state.cleanupId = CleanupSys.register(async () => {
		const ctx = resolveSliceCtx(getBaseCtx(), serverId)
		await destroyServer(ctx)
	})
	log.info('Initialized server %s', serverId)
}

export async function destroyServer(ctx: C.ServerSlice) {
	if (ctx.server.state.destroyed) return
	ctx.server.state.destroyed = true
	const cleanupId = ctx.server.state.cleanupId
	if (cleanupId !== null) CleanupSys.unregister(cleanupId)
	await runCleanup({ ...CS.init(), ...ctx, log }, ctx.cleanup)
	// we're not dealing with mutexes yet Sadge
	globalState.slices.delete(ctx.serverId)
	for (const [wsClientId, serverId] of Array.from(globalState.selectedServers.entries())) {
		if (ctx.serverId === serverId) globalState.selectedServers.delete(wsClientId)
	}
}

function setupResolveHistoryConflicts(ctx: C.ServerId & C.Rcon) {
	let previouslyConnected = false
	// -------- make sure history and chat state is up to date once an rcon connection is established --------
	ctx.rcon.connected$.pipe(
		Rx.map(connected => [resolveSliceCtx(getBaseCtx(), ctx.serverId), connected] as const),
		C.durableSub('resolve-history-conflicts', {
			module,
			levels: { event: 'info' },
			mutexes: ([ctx]) => [ctx.matchHistory.mtx],
		}, async ([ctx, connected]) => {
			const server = ctx.server
			if (!connected) {
				if (server.historyConflictsResolved$.value) {
					server.historyConflictsResolved$.next(false)
					const currentMatch = await MatchHistory.getCurrentMatch(ctx)
					const event: SM.Events.RconDisconnected = {
						type: 'RCON_DISCONNECTED',
						id: eventId(),
						time: Date.now(),
						matchId: currentMatch.historyEntryId,
					}
					ctx.server.event$.next([ctx, [event]])
				}
				return
			}

			const statusRes = await server.layersStatus.get(ctx, { ttl: 500 })
			if (statusRes.code === 'err:rcon') return Rx.EMPTY
			const firstConnection = !previouslyConnected
			previouslyConnected = true
			const { currentMatch, pushedNewMatch } = await MatchHistory.syncWithCurrentLayer(ctx, statusRes.data.currentLayer)
			log.info('rcon connection established, match history is synced')

			const teams = await interceptTeamsUpdate(ctx)
			resetTeamState(ctx, teams)

			let events: SM.Events.Event[] = []
			const base = {
				time: Date.now(),
				matchId: currentMatch.historyEntryId,
				state: {
					players: teams.players,
					squads: teams.squads,
				},
			}

			events.push({
				type: 'RCON_CONNECTED',
				id: eventId(),
				reconnected: !firstConnection,
				...base,
			})

			if (pushedNewMatch) {
				events.push({
					type: 'NEW_GAME',
					id: eventId(),
					layerId: currentMatch.layerId,
					source: firstConnection ? 'slm-started' : 'rcon-reconnected',
					...base,
				})
			} else {
				events.push({
					id: eventId(),
					type: 'RESET',
					source: firstConnection ? 'slm-started' : 'rcon-reconnected',
					...base,
				})
			}

			const layersStatusRes = await server.layersStatus.get(ctx)
			if (layersStatusRes.code === 'ok' && layersStatusRes.data.nextLayer) {
				server.state.nextSetLayerId = layersStatusRes.data.nextLayer.id
				const serverState = await getServerState(ctx)
				await LayerQueue.syncNextLayerInPlace(ctx, serverState)
			}
			server.event$.next([ctx, events])
			server.historyConflictsResolved$.next(true)
		}),
	).subscribe()
}

export async function getFullServerState(ctx: C.Db & C.LayerQueue) {
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

async function fetchLayersStatusExt(ctx: C.SquadServer & C.Rcon & C.MatchHistory) {
	const statusRes = await ctx.server.layersStatus.get(ctx)
	if (statusRes.code !== 'ok') return statusRes
	return buildServerStatusRes(statusRes.data, await MatchHistory.getCurrentMatch(ctx))
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
	const servers = CONFIG.servers.filter(s => s.enabled && globalState.slices.has(s.id)).toSorted((a, b) => {
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
		if (!servers.some(s => s.id === serverId)) {
			serverId = servers[0].id
		}
	} else {
		serverId = servers[0].id
	}

	if (!defaultServerId || serverId !== defaultServerId) {
		res.cookie(AR.COOKIE_KEY.enum['default-server-id'], serverId, { ...AR.COOKIE_DEFAULTS, httpOnly: false })
	}

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
	if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server slice not found: ' + serverId })
	return {
		...ctx,
		...slice,
	}
}

function getBaseCtx() {
	return DB.addPooledDb(CS.init())
}

export function selectedServerCtx$<Ctx extends C.WSSession>({ wsClientId }: Ctx) {
	return globalState.selectedServerUpdate$.pipe(
		Rx.concatMap(s => s.wsClientId === wsClientId ? Rx.of(s.serverId) : Rx.EMPTY),
		Rx.startWith(globalState.selectedServers.get(wsClientId)!),
		Rx.map(serverId => resolveSliceCtx({ ...getBaseCtx(), ...(WsSessionSys.wsSessions.get(wsClientId)!) }, serverId)),
	)
}

/**
 * Performs state tracking and event consolidation for squad log events.
 */
const processLogEvent = C.spanOp('processLogEvent', { module, levels: { event: 'trace' } }, async (
	ctx: C.Db & C.ServerSlice,
	logEvent: SM.LogEvents.Event,
) => {
	const match = await MatchHistory.getCurrentMatch(ctx)
	const base = {
		time: logEvent.time,
		matchId: match.historyEntryId,
	}
	let event: SM.Events.Event | null = null

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
			return
		}

		case 'ROUND_TEAM_OUTCOME': {
			server.state.roundEndState = {
				winner: logEvent.winner,
				layer: logEvent.layer,
			}
			return
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
			server.state.roundEndState = null
			const res = await MatchHistory.finalizeCurrentMatch(ctx, statusRes.data.currentLayer.id, winner, loser, new Date(logEvent.time))
			if (res.code !== 'ok') return res

			event = {
				type: 'ROUND_ENDED',
				id: eventId(),
				...base,
			}
			break
		}

		case 'MAP_SET': {
			const layer = L.parseRawLayerText(`${logEvent.nextLayer} ${logEvent.nextFactions ?? ''}`.trim())
			if (!layer) {
				throw new Error(`Failed to parse layer text: ${logEvent.nextLayer} ${logEvent.nextFactions ?? ''}`)
			}
			server.state.nextSetLayerId = layer.id
			event = {
				type: 'MAP_SET',
				id: eventId(),
				...base,
				layerId: layer.id,
			}
			break
		}

		case 'NEW_GAME': {
			if (logEvent.layerClassname === 'TransitionMap') {
				return
			}
			try {
				server.serverRolling$.next(logEvent.time)

				// get these ASAP
				let newLayerId = server.state.nextSetLayerId
				if (newLayerId === null) {
					log.error(`next layer ID was not set`)
					return
				}
				log.info('creating new game with layer %s', DH.displayLayer(newLayerId))

				const teamsResPromise = interceptTeamsUpdate(ctx)
				const { match } = await withAcquired(
					() => [ctx.matchHistory.mtx, ctx.server.savingEventsMtx],
					() =>
						DB.runTransaction(ctx, async (ctx) => {
							const serverState = await getServerState(ctx)
							const nextLqItem = serverState.layerQueue[0]

							let currentMatchLqItem: LL.Item | undefined
							const newServerState = Obj.deepClone(serverState)
							if (nextLqItem && L.areLayersCompatible(nextLqItem.layerId, newLayerId)) {
								currentMatchLqItem = newServerState.layerQueue.shift()
							}
							const { match } = await MatchHistory.addNewCurrentMatch(
								ctx,
								MH.getNewMatchHistoryEntry({
									layerId: newLayerId,
									serverId: ctx.serverId,
									startTime: new Date(logEvent.time),
									lqItem: currentMatchLqItem,
								}),
							)

							await LayerQueue.syncNextLayerInPlace(ctx, newServerState, { skipDbWrite: true })
							await Vote.syncVoteStateWithQueueStateInPlace(ctx, serverState.layerQueue, newServerState.layerQueue)
							await updateServerState(ctx, newServerState, { type: 'system', event: 'server-roll' })
							LayerQueue.schedulePostRollTasks(ctx, match.layerId)
							return { match }
						}),
				)()
				const teamsRes = await teamsResPromise
				event = {
					type: 'NEW_GAME',
					id: eventId(),
					layerId: newLayerId,
					source: 'new-game-detected',
					state: { squads: teamsRes.squads, players: teamsRes.players },
					...base,
					matchId: match.historyEntryId,
				}
			} finally {
				server.serverRolling$.next(null)
			}
			break
		}

		case 'PLAYER_CONNECTED': {
			server.state.joinRequests.set(logEvent.chainID, logEvent.playerIds)
			return
		}

		// TODO PLAYER_JOIN_FAILED?
		case 'PLAYER_JOIN_SUCCEEDED': {
			const joinedPlayerIdQuery = server.state.joinRequests.get(logEvent.chainID)
			if (!joinedPlayerIdQuery) return
			server.state.joinRequests.delete(logEvent.chainID)

			PendingEvents.addConnecting(server.state.pendingEventState, {
				type: 'PLAYER_CONNECTED',
				player: joinedPlayerIdQuery,
				time: logEvent.time,
				matchId: match.historyEntryId,
			})

			const events = Array.from(PendingEvents.processPendingEvents(server.state.pendingEventState))
			if (events.length > 1) throw new Error('Multiple events, this should not be possible')
			if (events.length === 0) return
			event = events[0]
			break
		}

		case 'PLAYER_DISCONNECTED': {
			const player = PendingEvents.addDisconnecting(server.state.pendingEventState, logEvent)
			if (!player) return
			// we don't need to process the pending events here

			event = {
				id: eventId(),
				type: 'PLAYER_DISCONNECTED',
				player: SM.PlayerIds.getPlayerId(player.ids),
				...base,
			}
			break
		}

		case 'ADMIN_BROADCAST': {
			event = {
				id: eventId(),
				type: 'ADMIN_BROADCAST',
				message: logEvent.message,
				from: logEvent.from,
				...base,
			}
			break
		}

		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED': {
			PendingEvents.addWoundedOrDied(server.state.pendingEventState, { ...logEvent, matchId: match.historyEntryId })
			const events = Array.from(PendingEvents.processPendingEvents(server.state.pendingEventState))
			if (events.length > 1) throw new Error('Multiple events, this should not be possible')
			if (events.length === 0) return
			event = events[0]
			break
		}

		case 'KICKING_PLAYER': {
			server.state.kickingPlayerEvents.set(logEvent.chainID, logEvent)
			return
		}

		case 'PLAYER_KICKED': {
			const kickingEvent = server.state.kickingPlayerEvents.get(logEvent.chainID)
			server.state.kickingPlayerEvents.delete(logEvent.chainID)

			event = {
				id: eventId(),
				type: 'PLAYER_KICKED',
				player: SM.PlayerIds.getPlayerId(logEvent.playerIds),
				reason: kickingEvent?.reason,
				...base,
			}
			break
		}

		default:
			assertNever(logEvent)
	}

	if (event) {
		server.event$.next([ctx, [event]])
	}
})

export const processRconEvent = C.spanOp('processRconEvent', { module }, async (
	ctx: C.ServerSlice & C.Db,
	event: SM.RconEvents.Event,
) => {
	const match = await MatchHistory.getCurrentMatch(ctx)
	const matchId = match.historyEntryId

	// for when we want to fetch data from rcon that's more likely to have been updated after the event in question. very crude, could be improved

	const base = {
		matchId,
		time: event.time,
	}

	let emittedEvent: SM.Events.Event | null = null

	// TODO could maybe parse the log version of some of these events for better continuity, specifically for the chat/event view
	switch (event.type) {
		case 'CHAT_MESSAGE': {
			if (event.message.startsWith(CONFIG.commandPrefix)) {
				await Commands.handleCommand(ctx, event)
			} else if (event.message.trim().match(/^\d+$/) && ctx.vote.state?.code === 'in-progress') {
				await Vote.handleVote(ctx, event)
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

			emittedEvent = {
				type: 'CHAT_MESSAGE',
				id: eventId(),
				message: event.message,
				player: SM.PlayerIds.getPlayerId(event.playerIds),
				channel,
				...base,
			}
			break
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

			const squad: SM.Squad = {
				teamId,
				squadId: event.squadId,
				creator: SM.PlayerIds.getPlayerId(event.creatorIds),
				squadName: event.squadName,

				// will be updated later if incorrect
				locked: false,
			}
			ctx.server.state.createdSquads.push(squad)

			emittedEvent = {
				type: 'SQUAD_CREATED',
				id: eventId(),
				squad,

				...base,
			}
			break
		}

		case 'PLAYER_BANNED': {
			emittedEvent = {
				type: event.type,
				id: eventId(),
				interval: event.interval,
				player: SM.PlayerIds.getPlayerId(event.playerIds),
				...base,
			}
			break
		}
		case 'PLAYER_WARNED': {
			const player = SM.PlayerIds.find(ctx.server.state.pendingEventState.recentPlayers, p => p.ids, event.playerIds)
			if (!player) {
				console.error('Player not found in recentPlayers:', event.playerIds)
				return
			}
			emittedEvent = {
				type: event.type,
				id: eventId(),
				reason: event.reason,
				player: SM.PlayerIds.getPlayerId(player.ids),
				...base,
			}
			break
		}
		case 'POSSESSED_ADMIN_CAMERA': {
			emittedEvent = {
				type: event.type,
				id: eventId(),
				player: SM.PlayerIds.getPlayerId(event.playerIds),
				...base,
			}
			break
		}
		case 'UNPOSSESSED_ADMIN_CAMERA': {
			emittedEvent = {
				type: event.type,
				id: eventId(),
				player: SM.PlayerIds.getPlayerId(event.playerIds),
				...base,
			}
			break
		}
	}

	if (emittedEvent) {
		ctx.server.event$.next([ctx, [emittedEvent]])
		return { code: 'ok' as const }
	}
})

function setupListenForTeamChanges(ctx: CS.Ctx & C.SquadRcon & C.AdminList) {
	const serverId = ctx.serverId
	ctx.server.teams.observe(ctx)
		.pipe(
			traceTag('listenForTeamChanges'),
			// only listen while server isn't rolling
			Rx.concatMap(teams => teams.code === 'ok' ? Rx.of({ teams, time: Date.now() }) : Rx.EMPTY),
			// pair with the previous state so we can generate synthetic events by looking for changes
			Rx.pairwise(),
			// capture event time before we're potentially waiting for server to roll
			Rx.concatMap(
				async function*([prev, current]) {
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)
					const server = ctx.server

					let intercepted = false
					if (server.teamUpdateInterceptor) {
						log.info('intercepting team update')
						server.teamUpdateInterceptor.next(current.teams)
						intercepted = true
					}

					if (!server.historyConflictsResolved$.value) return

					const match = await MatchHistory.getCurrentMatch(ctx)

					PendingEvents.upsertRecentPlayers(server.state.pendingEventState, current.teams.players, match.ordinal)
					yield Array.from(PendingEvents.processPendingEvents(server.state.pendingEventState))

					if (intercepted) return

					log.debug('Generating synthetic events')
					yield Array.from(generateSyntheticEvents(ctx, prev.teams, current.teams, current.time, match.historyEntryId))
				},
			),
		).subscribe({
			error: err => {
				log.error(err, 'Player list subscription error')
			},
			complete: () => {
				log.warn('Player list subscription completed')
			},
			next: events => {
				if (!events) return
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				if (events.length === 0) {
					log.debug('No synthetic events generated')
					return
				}
				ctx.server.event$.next([ctx, events])
				log.info('done generating synthetic events')
			},
		})
}

function* generateSyntheticEvents(
	ctx: C.ServerSlice & C.Db,
	prevTeams: SM.Teams,
	teams: SM.Teams,
	time: number,
	matchId: number,
): Generator<SM.Events.Event> {
	const base = { time, matchId }
	const { players, squads } = teams
	const { players: prevPlayers, squads: prevSquads } = prevTeams

	const squadGroups = SM.Players.groupIntoSquads(players)
	const prevSquadGroups = SM.Players.groupIntoSquads(prevPlayers)

	for (const player of players) {
		const prev = SM.PlayerIds.find(prevPlayers, p => p.ids, player.ids)
		if (!prev) continue

		if (!SM.Squads.idsEqual(prev, player) && prev.squadId !== null && prev.teamId !== null) {
			yield {
				type: 'PLAYER_LEFT_SQUAD',
				id: eventId(),
				player: SM.PlayerIds.getPlayerId(player.ids),
				teamId: prev.teamId,
				squadId: prev.squadId,
				...base,
			} satisfies SM.Events.PlayerLeftSquad
		}

		if (player.teamId !== prev.teamId) {
			yield {
				type: 'PLAYER_CHANGED_TEAM',
				id: eventId(),
				newTeamId: player.teamId,
				player: SM.PlayerIds.getPlayerId(player.ids),
				...base,
			} satisfies SM.Events.PlayerChangedTeam
		}

		if (player.squadId !== null && player.teamId !== null && SM.Squads.idsEqual(player, prev) && player.isLeader && !prev.isLeader) {
			yield {
				type: 'PLAYER_PROMOTED_TO_LEADER',
				squadId: player.squadId,
				id: eventId(),
				teamId: player.teamId,
				player: SM.PlayerIds.getPlayerId(player.ids),
				...base,
			} satisfies SM.Events.PlayerPromotedToLeader
		}

		if (
			player.squadId !== null && player.teamId !== null && !SM.Squads.idsEqual(player, prev)
		) {
			const squad = squads.find(s => SM.Squads.idsEqual(s, player))
			const isNewSquad = !prevSquads.find(s => SM.Squads.idsEqual(s, player))
			// if we violently thrash squad creations/leaves then we can maybe break this but that's unlikely
			if (isNewSquad && squad) {
				if (!ctx.server.state.createdSquads.find(s => SM.Squads.idsEqual(s, player))) {
					const event: SM.Events.SquadCreated = {
						type: 'SQUAD_CREATED',
						id: eventId(),
						squad,
						...base,
					}
					ctx.server.state.createdSquads.push(squad)

					yield event
				}
			} else {
				yield {
					type: 'PLAYER_JOINED_SQUAD',
					id: eventId(),
					player: SM.PlayerIds.getPlayerId(player.ids),
					teamId: player.teamId,
					squadId: player.squadId,
					...base,
				} satisfies SM.Events.PlayerJoinedSquad
			}
		}

		{
			const details = Obj.selectProps(player, SM.PLAYER_DETAILS)
			const prevDetails = Obj.selectProps(prev, SM.PLAYER_DETAILS)
			if (!Obj.deepEqual(details, prevDetails)) {
				yield {
					type: 'PLAYER_DETAILS_CHANGED',
					id: eventId(),
					player: SM.PlayerIds.getPlayerId(player.ids),
					details,
					...base,
				} satisfies SM.Events.PlayerDetailsChanged
			}
		}
	}

	for (const prevSquad of prevSquadGroups) {
		if (squadGroups.some(s => SM.Squads.idsEqual(s, prevSquad))) continue
		ctx.server.state.createdSquads = ctx.server.state.createdSquads.filter(s => !SM.Squads.idsEqual(s, prevSquad))
		yield {
			id: eventId(),
			type: 'SQUAD_DISBANDED',
			squadId: prevSquad.squadId,
			teamId: prevSquad.teamId,
			...base,
		} satisfies SM.Events.SquadDisbanded
	}

	for (const squad of squads) {
		const prevSquad = prevSquads.find(s => SM.Squads.idsEqual(s, squad))
		const createdSquad = ctx.server.state.createdSquads.find(s => SM.Squads.idsEqual(s, squad))
		if (!prevSquad || prevSquad.locked !== squad.locked && (!createdSquad || createdSquad.locked !== squad.locked)) {
			yield {
				id: eventId(),
				type: 'SQUAD_DETAILS_CHANGED',
				details: { locked: squad.locked },
				squadId: squad.squadId,
				teamId: squad.teamId,
				...base,
			} satisfies SM.Events.SquadDetailsChanged
		}
	}
}

export async function getServerState(ctx: C.Db & C.ServerId) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
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
	if (changes.layerQueueSeqId && changes.layerQueueSeqId !== serverState.layerQueueSeqId) {
		throw new Error('Invalid layer queue sequence ID')
	}
	if (!Obj.deepEqual(newServerState.layerQueue, serverState.layerQueue)) {
		newServerState.layerQueueSeqId = serverState.layerQueueSeqId + 1
	}
	await ctx.db().update(Schema.servers)
		.set(superjsonify(Schema.servers, { ...changes, layerQueueSeqId: newServerState.layerQueueSeqId }))
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const update: SS.LQStateUpdate = { state: newServerState, source }

	ctx.tx.unlockTasks.push(() => ctx.layerQueue.update$.next([update, { ...getBaseCtx(), serverId: ctx.serverId }]))
	return newServerState
}

const loadSavedEvents = C.spanOp('loadSavedEvents', { module }, async (ctx: C.SquadServer & C.Db) => {
	const server = ctx.server
	const [lastMatch] = await ctx.db().select({ id: Schema.matchHistory.id }).from(Schema.matchHistory).where(
		E.eq(Schema.matchHistory.serverId, ctx.serverId),
	).orderBy(
		E.desc(Schema.matchHistory.ordinal),
	).limit(1)

	const rowsRaw = lastMatch
		? await ctx.db().select({ event: Schema.serverEvents }).from(Schema.serverEvents).where(
			E.eq(Schema.serverEvents.matchId, lastMatch.id),
		)
			.orderBy(E.asc(Schema.serverEvents.id))
		: []
	const events = rowsRaw.map(r => SM.Events.fromEventRow(r.event))
	server.state.lastSavedEventId = events[events.length - 1]?.id ?? null
	server.state.eventBuffer = events
})

export const saveEvents = C.spanOp(
	'saveEvents',
	{ module, mutexes: (ctx) => ctx.server.savingEventsMtx },
	async (ctx: C.SquadServer & C.Db) =>
		await DB.runTransaction(ctx, async (ctx) => {
			const state = ctx.server.state

			let events: SM.Events.Event[] = []
			if (state.lastSavedEventId === null) {
				events = state.eventBuffer.slice()
			} else {
				const lastSavedIndex = state.eventBuffer.findIndex(e => e.id === state.lastSavedEventId)
				if (lastSavedIndex === -1) throw new Error(`CRITICAL: Unable to resolve last saved event ${state.lastSavedEventId}`)
				events = state.eventBuffer.slice(lastSavedIndex + 1)
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

			for (const e of events) {
				const persisted = Obj.omit(e, ['id', 'type', 'time', 'matchId'])
				eventRows.push({
					id: e.id,
					type: e.type,
					time: new Date(e.time),
					matchId: e.matchId,
					data: superjson.serialize(persisted),
				})
				if (e.type === 'NEW_GAME' || e.type === 'RESET') {
					for (const player of e.state.players) {
						const playerId = BigInt(SM.PlayerIds.getPlayerId(player.ids))
						playerRows.push({
							steamId: playerId,
							eosId: player.ids.eos,
							username: player.ids.username,
						})
						playerAssociationRows.push({
							assocType: 'game-participant',
							playerId,
							serverEventId: e.id,
						})
					}

					for (const squad of e.state.squads) {
						const id = squadId()
						squadRows.push({
							id,
							ingameSquadId: squad.squadId,
							name: squad.squadName,
							teamId: squad.teamId,
							creatorId: BigInt(squad.creator),
						})
						squadAssociationRows.push({
							squadId: id,
							serverEventId: e.id,
						})
					}
				} else if (e.type === 'PLAYER_CONNECTED') {
					const playerId = BigInt(SM.PlayerIds.getPlayerId(e.player.ids))
					playerRows.push({
						steamId: playerId,
						eosId: e.player.ids.eos,
						username: e.player.ids.username,
					})
					const [assocType] = SM.Events.PLAYER_CONNECTED_META.playerAssocs
					playerAssociationRows.push({
						assocType,
						playerId,
						serverEventId: e.id,
					})
				} else {
					const meta = SM.Events.EVENT_META[e.type]
					for (const prop of meta.playerAssocs) {
						// @ts-expect-error idgaf
						if (prop in e && e[prop] !== undefined) {
							// @ts-expect-error idgaf
							const assocPlayerId = e[prop] as SM.PlayerId
							playerAssociationRows.push({ assocType: prop, playerId: BigInt(assocPlayerId), serverEventId: e.id })
						}
					}
				}

				if (e.type === 'SQUAD_CREATED') {
					const id = squadId()
					squadRows.push({
						id,
						ingameSquadId: e.squad.squadId,
						name: e.squad.squadName,
						teamId: e.squad.teamId,
						creatorId: BigInt(e.squad.creator),
					})
					squadAssociationRows.push({ serverEventId: e.id, squadId: id })
				}

				if ('PLAYER_LEFT_SQUAD' === e.type || 'SQUAD_DISBANDED' === e.type || 'SQUAD_DETAILS_CHANGED' === e.type) {
					// need to write all previous events here so that we get the correct squad pk when we search for it below, as the squad may have been disbanded and created by someone else in the events that we processed this batch.
					await flush()
					const [row] = await ctx.db().select({ squad: Schema.squads }).from(Schema.serverEvents).where(
						E.and(
							E.eq(Schema.serverEvents.matchId, e.matchId),
							E.eq(Schema.squads.ingameSquadId, e.squadId),
							E.eq(Schema.squads.teamId, e.teamId),
						),
					)
						.innerJoin(Schema.squadEventAssociations, E.eq(Schema.squadEventAssociations.serverEventId, Schema.serverEvents.id))
						.innerJoin(
							Schema.squads,
							E.and(
								E.eq(Schema.squadEventAssociations.squadId, Schema.squads.id),
							),
						)
						.orderBy(E.desc(Schema.serverEvents.time))
						.limit(1)

					if (row?.squad) {
						squadAssociationRows.push({ serverEventId: e.id, squadId: row.squad.id })
					}
				}
			}
			await flush()

			async function flush() {
				if (eventRows.length > 0) {
					await ctx.db({ redactParams: true }).insert(Schema.serverEvents).values(eventRows)
					state.lastSavedEventId = eventRows[eventRows.length - 1].id!
					eventRows = []
				}
				if (playerRows.length > 0) {
					await ctx.db({ redactParams: true })
						.insert(Schema.players)
						.values(playerRows)
						.onDuplicateKeyUpdate({
							set: {
								steamId: sql`VALUES(steamId)`,
								eosId: sql`VALUES(eosId)`,
								username: sql`VALUES(username)`,
								modifiedAt:
									sql`IF(eosId != VALUES(eosId) OR username != VALUES(username) OR steamId != VALUES(steamId), NOW(), modifiedAt)`,
							},
						})
					playerRows = []
				}
				if (playerAssociationRows.length > 0) {
					await ctx.db({ redactParams: true }).insert(Schema.playerEventAssociations).values(playerAssociationRows)
					playerAssociationRows = []
				}
				if (squadRows.length > 0) {
					await ctx.db({ redactParams: true }).insert(Schema.squads).values(squadRows)
					squadRows = []
				}
				if (squadAssociationRows.length > 0) {
					await ctx.db({ redactParams: true }).insert(Schema.squadEventAssociations).values(squadAssociationRows)
					squadAssociationRows = []
				}
				log.info('saved %d events [%d:%d]', events.length, events[0].id, events[events.length - 1].id)
			}
		}),
)

const interceptTeamsUpdate = C.spanOp('interceptTeamsUpdate', {
	module,
	mutexes: (ctx) => ctx.server.teamUpdateInterceptorMtx,
}, async (ctx: C.SquadServer) => {
	log.info('interceptTeamsUpdate started')
	const server = ctx.server
	let interceptor = new Rx.Subject<SM.Teams>()
	try {
		server.teamUpdateInterceptor = interceptor
		return await Rx.firstValueFrom(Rx.race(
			server.teamUpdateInterceptor.pipe(
				Rx.tap({
					next: (value) => {
						log.info('got value for interceptTeamsUpdate %o', value)
						server.teamUpdateInterceptor = null
					},
				}),
			),
			Rx.timer(20_000).pipe(Rx.map(() => {
				throw new Error('Timeout')
			})),
		)) as unknown as SM.Teams
	} finally {
		log.info('interceptTeamsUpdate completed')
		interceptor.complete()
		server.teamUpdateInterceptor = null
	}
})

namespace PendingEvents {
	type PendingConnectedEvent = Omit<SM.Events.PlayerConnected, 'player' | 'id'> & { player: SM.PlayerIds.IdQuery }
	type PendingPlayerWoundedOrDiedEvent = (SM.LogEvents.PlayerWounded | SM.LogEvents.PlayerDied) & { matchId: number }
	export type State = {
		events: {
			connecting: PendingConnectedEvent[]
			woundedOrDied: PendingPlayerWoundedOrDiedEvent[]
		}
		// players from the last =<2 matches
		recentPlayers: (SM.Player & { lastSeenMatchOrdinal: number })[]

		// players which have disconnected in the last =<2 matches
		disconnectedPlayers: SM.PlayerIds.Type[]
	}
	export function init(): State {
		return {
			events: {
				connecting: [],
				woundedOrDied: [],
			},
			recentPlayers: [],
			disconnectedPlayers: [],
		}
	}

	export function addConnecting(state: State, event: PendingConnectedEvent) {
		state.events.connecting.push(event)
		SM.PlayerIds.remove(state.disconnectedPlayers, event.player)
	}

	export function addWoundedOrDied(state: State, event: PendingPlayerWoundedOrDiedEvent) {
		state.events.woundedOrDied.push(event)
	}

	export function addDisconnecting(state: State, event: SM.LogEvents.PlayerDisconnected) {
		const player = SM.PlayerIds.find(state.recentPlayers, (p) => p.ids, event.playerIds)
		if (!player) return false
		if (SM.PlayerIds.find(state.disconnectedPlayers, player.ids)) return false
		state.disconnectedPlayers.push(player.ids)
		return player
	}

	export function upsertRecentPlayers(state: State, players: SM.Player[], matchOrdinal: number) {
		state.recentPlayers = state.recentPlayers.filter(p => matchOrdinal - p.lastSeenMatchOrdinal <= 2)
		for (const player of players) {
			SM.PlayerIds.upsert(state.recentPlayers, p => p.ids, { ...player, lastSeenMatchOrdinal: matchOrdinal })
		}
		state.disconnectedPlayers = state.disconnectedPlayers.filter(ids => SM.PlayerIds.find(state.recentPlayers, (p) => p.ids, ids))
	}

	export function* processPendingEvents(state: State) {
		{
			const toDelete = new Set<PendingConnectedEvent>()
			for (const event of state.events.connecting) {
				const playerRes = SM.PlayerIds.find(state.recentPlayers, (p) => p.ids, event.player)
				if (!playerRes) continue
				const { lastSeenMatchOrdinal: _, ...player } = playerRes
				toDelete.add(event)
				if (SM.PlayerIds.find(state.disconnectedPlayers, player.ids)) {
					continue
				}
				const processed: SM.Events.PlayerConnected = {
					id: eventId(),
					...event,
					player,
				}
				yield processed
			}

			state.events.connecting = state.events.connecting.filter((event) => !toDelete.has(event))
		}

		{
			let toDelete = new Set<PendingPlayerWoundedOrDiedEvent>()
			for (let i = 0; i < state.events.woundedOrDied.length; i++) {
				const event = state.events.woundedOrDied[i]
				const victimRes = SM.PlayerIds.find(state.recentPlayers, (p) => p.ids, event.victimIds)
				const attackerRes = SM.PlayerIds.find(state.recentPlayers, (p) => p.ids, event.attackerIds)
				if (!victimRes || !attackerRes) continue
				const { lastSeenMatchOrdinal: _, ...victim } = victimRes
				const { lastSeenMatchOrdinal: __, ...attacker } = attackerRes

				toDelete.add(event)
				let variant: SM.Events.PlayerWoundedOrDiedVariant
				if (SM.PlayerIds.match(victim.ids, attacker.ids)) {
					variant = 'suicide'
				} else if (victim.teamId !== null && victim.teamId === attacker.teamId) {
					variant = 'teamkill'
				} else {
					variant = 'normal'
				}
				const processed: SM.Events.PlayerDied | SM.Events.PlayerWounded = {
					id: eventId(),
					type: event.type,
					victim: SM.PlayerIds.getPlayerId(victim.ids),
					attacker: SM.PlayerIds.getPlayerId(attacker.ids),
					damage: event.damage,
					weapon: event.weapon,
					variant,
					time: event.time,
					matchId: event.matchId,
				}
				yield processed
			}
			state.events.woundedOrDied = state.events.woundedOrDied.filter((event) => !toDelete.has(event))
		}
	}
}

function resetTeamState(ctx: C.SquadServer, { players, squads }: SM.Teams) {
	const server = ctx.server

	server.state.connected = []
	for (const player of players) {
		server.state.connected.push(player.ids)
	}
	server.state.createdSquads = []
	for (const squad of squads) {
		server.state.createdSquads.push(squad)
	}
}

function eventId() {
	return globalState.serverEventIdCounter.next().value
}

function squadId() {
	return globalState.squadIdCounter.next().value
}
