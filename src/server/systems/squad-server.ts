import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as AR from '@/app-routes'
import * as Arr from '@/lib/array'
import { AsyncResource, type CleanupTasks, distinctDeepEquals, runCleanup, toAsyncGenerator, traceTag, withAbortSignal } from '@/lib/async'
import * as DH from '@/lib/display-helpers'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Gen from '@/lib/generator'
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
import * as LL from '@/models/layer-list.models'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import orpcBase from '@/server/orpc-base'
import * as Commands from '@/server/systems/commands'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as MatchHistory from '@/server/systems/match-history.ts'
import * as Rbac from '@/server/systems/rbac'
import * as SharedLayerList from '@/server/systems/shared-layer-list'
import * as SquadRcon from '@/server/systems/squad-rcon'
import * as Vote from '@/server/systems/vote'
import * as Otel from '@opentelemetry/api'
import * as Orpc from '@orpc/server'
import { Mutex, withTimeout } from 'async-mutex'
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
	serverEventIdCounter: Generator<number, never, unknown>

	debug__ticketOutcome?: { team1: number; team2: number }
}

export let globalState!: State
export type SquadServer = {
	layersStatusExt$: Rx.Observable<SM.LayersStatusResExt>

	postRollEventsSub: Rx.Subscription | null

	historyConflictsResolved$: Rx.BehaviorSubject<boolean>

	serverRolling$: Rx.BehaviorSubject<number | null>

	sftpReader: SftpTail

	// ephemeral state that isn't persisted to the database, as compared to SS.ServerState which is
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

		// constains mostly events from the current match. however don't assume this and filter for the current match whenever accessing
		eventBuffer: SM.Events.Event[]
		// if null, we haven't saved yet in this instantiation of the server
		lastSavedEventId: number | null

		destroyed: boolean

		nextSetLayerId: L.LayerId | null

		cleanupId: number | null
	}

	savingEventsMtx: Mutex

	// intermediate event so that initNewGameHandling's behaviour is downstream from event$
	beforeNewGame$: Rx.Subject<[CS.Log & C.Db & C.ServerSlice, SM.LogEvents.NewGame]>

	// TODO we should slim down the context we provide here so that we're just transmitting span & logging info, and leave the listener to construct everything else
	event$: Rx.Subject<[CS.Log & C.Db & C.ServerSlice, SM.Events.Event[]]>
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
			await SquadRcon.broadcast(ctx, Messages.BROADCASTS.matchEnded(ctx.user))
			return { code: 'ok' as const, message: 'Match ended successfully' }
		}
		assertNever(result.type)
	}),

	watchChatEvents: orpcBase.input(z.object({ lastEventId: z.number().optional() }).optional()).handler(
		async function*({ context, signal, input }) {
			const obs: Rx.Observable<(SM.Events.Event | CHAT.SyncedEvent | CHAT.ReconnectedEvent)[]> = selectedServerCtx$(context)
				.pipe(
					Rx.switchMap(ctx => {
						async function getInitialEvents() {
							const sync: CHAT.SyncedEvent = {
								type: 'SYNCED' as const,
								time: Date.now(),
								matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
							}

							let allEvents: SM.Events.Event[] = ctx.server.state.eventBuffer
							let events: (SM.Events.Event | CHAT.SyncedEvent | CHAT.ReconnectedEvent)[] = []

							if (input?.lastEventId === undefined) {
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

						const upcoming$ = ctx.server.event$.pipe(Rx.map(([_, events]): (SM.Events.Event | CHAT.SyncedEvent)[] => events))

						return Rx.concat(initial$, upcoming$).pipe(
							// orpc will break without this
							Rx.observeOn(Rx.asyncScheduler),
						)
					}),
					Rx.tap({
						error: (err) => {
							context.log.error(err, 'Error in watchChatEvents')
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
	const ctx = getBaseCtx()

	globalState = {
		slices: new Map(),
		selectedServers: new Map(),
		selectedServerUpdate$: new Rx.Subject(),
		serverEventIdCounter: undefined!,
	}
	const ops: Promise<void>[] = []

	const lastEventRes = await ctx.db().select({ id: Schema.serverEvents.id }).from(Schema.serverEvents).orderBy(
		E.desc(Schema.serverEvents.id),
	).limit(1)
	// driver sometimes returns strings so just to be safe
	const nextId = lastEventRes.length > 0 ? Number(lastEventRes[0].id) + 1 : 0
	globalState.serverEventIdCounter = Gen.counter(nextId)

	for (const serverConfig of CONFIG.servers) {
		const settingsFromConfig = {
			connections: serverConfig.connections,
			adminListSources: serverConfig.adminListSources!,
			adminIdentifyingPermissions: serverConfig.adminIdentifyingPermissions,
			timeBetweenMatches: serverConfig.timeBetweenMatches,
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

async function initServer(ctx: CS.Log & C.Db, serverState: SS.ServerState) {
	const serverId = serverState.id
	const settings = serverState.settings
	const cleanup: CleanupTasks = []

	const rcon = new Rcon({ serverId, settings: settings.connections.rcon })
	rcon.ensureConnected(ctx)
	cleanup.push(() => rcon.disconnect({ log: baseLogger }))

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
	cleanup.push(() => adminList.dispose())

	const sftpReader = new SftpTail(ctx, {
		filePath: settings.connections!.sftp.logFile,
		host: settings.connections!.sftp.host,
		port: settings.connections!.sftp.port,
		username: settings.connections!.sftp.username,
		password: settings.connections!.sftp.password,
		pollInterval: CONFIG.squadServer.sftpPollInterval,
		reconnectInterval: CONFIG.squadServer.sftpReconnectInterval,
	})
	cleanup.push(() => sftpReader.disconnect())
	sftpReader.watch()

	const server: SquadServer = {
		layersStatusExt$,

		postRollEventsSub: null,

		historyConflictsResolved$: new Rx.BehaviorSubject(true),

		serverRolling$: new Rx.BehaviorSubject(null as number | null),

		sftpReader,
		beforeNewGame$: new Rx.Subject(),
		event$: new Rx.Subject(),
		state: {
			roundEndState: null,
			roundLoser: null,
			roundWinner: null,
			joinRequests: new Map(),
			connected: [],
			createdSquads: [],
			eventBuffer: [],
			lastSavedEventId: null,
			nextSetLayerId: null,
			destroyed: false,
			cleanupId: null,
		},
		savingEventsMtx: new Mutex(),

		...SquadRcon.initSquadRcon({ ...ctx, rcon, adminList, serverId }, cleanup),
	}

	cleanup.push(
		() => server.postRollEventsSub,
		server.historyConflictsResolved$,
		server.serverRolling$,
		server.beforeNewGame$,
		server.event$,
		server.savingEventsMtx,
	)

	// -------- load saved events --------
	await (async () => {
		const lastMatchIdQuery = ctx.db().select({ id: Schema.matchHistory.id }).from(Schema.matchHistory).orderBy(
			E.desc(Schema.matchHistory.ordinal),
		).limit(1).as('lastMatchId')

		const rowsRaw = await ctx.db().select({ event: Schema.serverEvents }).from(Schema.serverEvents)
			.innerJoin(
				lastMatchIdQuery,
				E.eq(Schema.serverEvents.matchId, lastMatchIdQuery.id),
			).orderBy(E.asc(Schema.serverEvents.id))
		const events = rowsRaw.map(r => fromEventRow(r.event))
		server.state.lastSavedEventId = events[events.length - 1]?.id ?? null
		server.state.eventBuffer.push(...events)
	})()

	let previouslyConnected = false
	// -------- make sure history and chat state is up to date once an rcon connection is established --------
	rcon.connected$.pipe(
		traceTag('resolvingHistoryConflicts'),
		C.durableSub('squad-server:resolve-history-conflicts', { tracer, ctx, eventLogLevel: 'info' }, async (connected) => {
			const ctx = { ...getBaseCtx(), ...slice }
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
			ctx.log.info('rcon connection established, match history is synced')

			const [playersRes, squadsRes] = await Promise.all([
				server.playerList.get({ ...ctx, rcon }, { ttl: 500 }),
				server.squadList.get({ ...ctx, rcon }, { ttl: 500 }),
			])

			if (playersRes.code !== 'ok' || squadsRes.code !== 'ok') return
			resetPlayerAndSquadState(ctx, playersRes.players, squadsRes.squads)

			let events: SM.Events.Event[] = []
			const base = {
				time: Date.now(),
				matchId: currentMatch.historyEntryId,
				state: {
					players: playersRes.players,
					squads: squadsRes.squads,
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
	server.rconEvent$
		.pipe(
			C.durableSub('squad-server:on-rcon-event', { tracer, eventLogLevel: 'trace', ctx }, async ([_ctx, event]) => {
				const ctx = DB.addPooledDb(resolveSliceCtx(_ctx, serverId))
				if (!ctx.server.historyConflictsResolved$.value) {
					ctx.log.warn('History conflicts not resolved, ignoring RCON event %s', event.type)
					return { code: 'err:history-conflicts-not-resolved' as const }
				}
				ctx.log.info(event, 'Received RCON Event: %s', event.type)
				const res = await processRconEvent(ctx, event)
				if (res.code !== 'ok') return res
				ctx.server.event$.next([ctx, [res.event]])
				return { code: 'ok' as const }
			}),
		).subscribe()

	// -------- create synthetic events based on state changes on the server --------
	const timeBetweenMatches = settings.timeBetweenMatches

	server.historyConflictsResolved$
		.pipe(
			traceTag('listenForSyntheticEvents'),
			Rx.switchMap((resolved) => resolved ? server.playerList.observe({ ...ctx, rcon, adminList, serverId }) : Rx.EMPTY),
			// only listen while server isn't rolling
			Rx.concatMap(async res => {
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				const match = await MatchHistory.getCurrentMatch(ctx)
				return res.code === 'ok' ? Rx.of({ players: res.players, match, time: Date.now() }) : Rx.EMPTY
			}),
			Rx.concatAll(),
			// pair with the previous state so we can generate synthetic events by looking for changes
			Rx.pairwise(),
			// capture event time before we're potentially waiting for server to roll
			Rx.map(
				([prev, next]) => {
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)

					if (prev.match.historyEntryId !== next.match.historyEntryId) {
						return []
					}

					// const timeDiff = next.time - prev.time
					//

					if (next.match.status === 'post-game') {
						const expectedNewGameTime = next.match.endTime.getTime() + timeBetweenMatches

						// This isn't super principled but basically we  want to avoid processing synthetic events close to the new game event, because they'll be thrown away anyway and they can cause issues
						if (expectedNewGameTime < next.time + 5_000) {
							ctx.log.debug('Skipping generation of synthetic events due to being close to new game')
							return
						}
					}

					ctx.log.debug('Generating synthetic events')
					return [...generateSyntheticEvents(ctx, prev.players, next.players, next.time, next.match.historyEntryId)]
				},
			),
		).subscribe({
			error: err => {
				ctx.log.error(err, 'Player list subscription error')
			},
			complete: () => {
				ctx.log.warn('Player list subscription completed')
			},
			next: events => {
				if (!events) return
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				if (events.length === 0) {
					ctx.log.debug('No synthetic events generated')
					return
				}
				server.event$.next([ctx, events])
				ctx.log.info('done generating synthetic events')
			},
		})

	// -------- keep event buffer state up-to-date --------
	server.event$.subscribe(([ctx, events]) => {
		for (const event of events) {
			ctx.log.info(event, 'emitted event: %s', event.type)
		}
		ctx.server.state.eventBuffer.push(...events)
	})

	{
		// -------- periodically save events  --------
		const saveEventSub = Rx.interval(10_000).pipe(Rx.exhaustMap(async () => {
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			if (!ctx.server.historyConflictsResolved$.value) return
			return saveEvents(ctx)
		})).subscribe()

		// -------- save remaining events on cleanup  --------
		cleanup.push(async () => {
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			saveEventSub.unsubscribe()
			await saveEvents(ctx)
		})
	}

	const slice: C.ServerSlice = {
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
	void LayerQueue.init({ ...ctx, ...slice })
	SharedLayerList.init({ ...ctx, ...slice })
	void adminList.get({ ...ctx, ...slice })

	server.state.cleanupId = CleanupSys.register(async () => {
		const ctx = resolveSliceCtx(getBaseCtx(), serverId)
		await destroyServer(ctx)
	})
	ctx.log.info('Initialized server %s', serverId)
}

export async function destroyServer(ctx: C.ServerSlice & CS.Log) {
	if (ctx.server.state.destroyed) return
	ctx.server.state.destroyed = true
	const cleanupId = ctx.server.state.cleanupId
	if (cleanupId !== null) CleanupSys.unregister(cleanupId)
	await runCleanup(ctx, ctx.cleanup)
	// we're not dealing with mutexes yet Sadge
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
	if (!slice) throw new Orpc.ORPCError('BAD_REQUEST', { message: 'Server slice not found: ' + serverId })
	return {
		...ctx,
		...slice,
	}
}

function getBaseCtx() {
	return DB.addPooledDb({ log: baseLogger })
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
	ctx: CS.Log & C.Db & C.ServerSlice,
	logEvent: SM.LogEvents.Event,
) {
	// for when we want to fetch data from rcon that's more likely to have been updated after the event in question. very crude, could be improved
	const deferOpts = {
		ttl: CONFIG.squadServer.sftpPollInterval / 4,
		timeout: CONFIG.squadServer.sftpPollInterval * 2,
	}
	const match = await MatchHistory.getCurrentMatch(ctx)
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
				winner: logEvent.winner,
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
			server.state.roundEndState = null
			const res = await MatchHistory.finalizeCurrentMatch(ctx, statusRes.data.currentLayer.id, winner, loser, new Date(logEvent.time))
			if (res.code !== 'ok') return res

			const event: SM.Events.RoundEnded = {
				type: 'ROUND_ENDED',
				id: eventId(),
				...base,
			}

			return { code: 'ok' as const, event }
		}

		case 'MAP_SET': {
			const layer = L.parseRawLayerText(`${logEvent.nextLayer} ${logEvent.nextFactions ?? ''}`.trim())
			if (!layer) {
				throw new Error(`Failed to parse layer text: ${logEvent.nextLayer} ${logEvent.nextFactions ?? ''}`)
			}
			server.state.nextSetLayerId = layer.id
			const event: SM.Events.MapSet = {
				type: 'MAP_SET',
				id: eventId(),
				...base,
				layerId: layer.id,
			}
			return { code: 'ok' as const, event }
		}

		case 'NEW_GAME': {
			if (logEvent.layerClassname === 'TransitionMap') {
				return
			}
			try {
				server.serverRolling$.next(logEvent.time)

				// get these ASAP
				const squadListPromise = server.squadList.get(ctx, { ttl: 300 })
				const playerListPromise = server.playerList.get(ctx, { ttl: 300 })
				let newLayerId = server.state.nextSetLayerId
				if (newLayerId === null) {
					ctx.log.error(`next layer ID was not set`)
					return
				}
				ctx.log.info('creating new game with layer %s', DH.displayLayer(newLayerId))

				const { match } = await DB.runTransaction(ctx, async (ctx) => {
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
				})

				const [squadsRes, playersRes] = await Promise.all([squadListPromise, playerListPromise])
				let squads: SM.Squad[]
				let players: SM.Player[]
				if (squadsRes.code !== 'ok' || playersRes.code !== 'ok') {
					ctx.log.error(`Failed to fetch squads or players: ${squadsRes.code} ${playersRes.code}`)
					squads = []
					players = []
				} else {
					squads = squadsRes.squads
					players = playersRes.players
				}

				resetPlayerAndSquadState(ctx, players, squads)

				const event: SM.Events.NewGame = {
					type: 'NEW_GAME',
					id: eventId(),
					layerId: newLayerId,
					source: 'new-game-detected',
					state: { squads, players },
					...base,
					matchId: match.historyEntryId,
				}
				return { code: 'ok' as const, event }
			} finally {
				server.serverRolling$.next(null)
			}
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
					id: eventId(),
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
					id: eventId(),
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
					id: eventId(),
					type: 'ADMIN_BROADCAST',
					message: logEvent.message,
					from: logEvent.from,
					...base,
				} satisfies SM.Events.AdminBroadcast,
			}
		}

		case 'PLAYER_DIED': {
			// Look up the victim player to get their full IDs
			const victimPlayerRes = await SquadRcon.getPlayer(ctx, { username: logEvent.victimName })
			if (victimPlayerRes.code !== 'ok') {
				ctx.log.debug(`Victim player ${logEvent.victimName} not found for PLAYER_DIED event`)
				return
			}

			// Look up the attacker player to get their full IDs
			const attackerPlayerRes = await SquadRcon.getPlayer(ctx, logEvent.attackerIds)
			if (attackerPlayerRes.code !== 'ok') {
				ctx.log.debug(`Attacker player ${SM.PlayerIds.prettyPrint(logEvent.attackerIds)} not found for PLAYER_DIED event`)
				return
			}

			return {
				code: 'ok' as const,
				event: {
					id: eventId(),
					type: 'PLAYER_DIED',
					victimIds: victimPlayerRes.player.ids,
					attackerIds: attackerPlayerRes.player.ids,
					damage: logEvent.damage,
					weapon: logEvent.weapon,
					...base,
				} satisfies SM.Events.PlayerDied,
			}
		}

		case 'PLAYER_WOUNDED': {
			// Look up the victim player to get their full IDs
			const victimPlayerRes = await SquadRcon.getPlayer(ctx, { username: logEvent.victimName })
			if (victimPlayerRes.code !== 'ok') {
				ctx.log.debug(`Victim player ${logEvent.victimName} not found for PLAYER_WOUNDED event`)
				return
			}

			// Look up the attacker player to get their full IDs
			const attackerPlayerRes = await SquadRcon.getPlayer(ctx, logEvent.attackerIds)
			if (attackerPlayerRes.code !== 'ok') {
				ctx.log.debug(`Attacker player ${SM.PlayerIds.prettyPrint(logEvent.attackerIds)} not found for PLAYER_WOUNDED event`)
				return
			}

			// Determine variant based on victim and attacker relationship
			let variant: SM.Events.PlayerWoundedVariant
			if (SM.PlayerIds.match(victimPlayerRes.player.ids, attackerPlayerRes.player.ids)) {
				variant = 'suicide'
			} else if (victimPlayerRes.player.teamId !== null && victimPlayerRes.player.teamId === attackerPlayerRes.player.teamId) {
				variant = 'teamkill'
			} else {
				variant = 'normal'
			}

			return {
				code: 'ok' as const,
				event: {
					id: eventId(),
					type: 'PLAYER_WOUNDED',
					victimIds: victimPlayerRes.player.ids,
					attackerIds: attackerPlayerRes.player.ids,
					damage: logEvent.damage,
					weapon: logEvent.weapon,
					variant,
					...base,
				} satisfies SM.Events.PlayerWounded,
			}
		}

		default:
			assertNever(logEvent)
	}
}

export async function processRconEvent(ctx: C.ServerSlice & CS.Log & C.Db, event: SM.RconEvents.Event) {
	const match = await MatchHistory.getCurrentMatch(ctx)
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
				Vote.handleVote(ctx, event)
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
					id: eventId(),
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

			ctx.server.state.createdSquads.push({ teamId, squadId: event.squadId, creatorIds: event.creatorIds })

			return {
				code: 'ok' as const,
				event: {
					type: 'SQUAD_CREATED',
					id: eventId(),
					teamId,
					squadId: event.squadId,
					creatorIds: event.creatorIds,
					squadName: event.squadName,

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
					id: eventId(),
					...event,
					...base,
				} satisfies SM.Events.Event,
			}
	}
}

function* generateSyntheticEvents(
	ctx: C.ServerSlice & CS.Log & C.Db,
	prevPlayers: SM.Player[],
	players: SM.Player[],
	time: number,
	matchId: number,
): Generator<SM.Events.Event> {
	const base = { time, matchId }

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
				id: eventId(),
				player,
				...base,
			} satisfies SM.Events.PlayerConnected
			continue
		}

		if (!SM.Squads.idsEqual(prev, player) && prev.squadId !== null && prev.teamId !== null) {
			yield {
				type: 'PLAYER_LEFT_SQUAD',
				id: eventId(),
				playerIds: player.ids,
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
				playerIds: player.ids,
				...base,
			} satisfies SM.Events.PlayerChangedTeam
		}

		if (player.squadId !== null && player.teamId !== null && player.squadId === prev.squadId && player.isLeader && !prev.isLeader) {
			yield {
				type: 'PLAYER_PROMOTED_TO_LEADER',
				squadId: player.squadId,
				id: eventId(),
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
				id: eventId(),
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
					id: eventId(),
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
			id: eventId(),
			type: 'SQUAD_DISBANDED',
			squadId: prevSquad.squadId,
			teamId: prevSquad.teamId,
			...base,
		} satisfies SM.Events.SquadDisbanded
	}
}

export async function getServerState(ctx: C.Db & CS.Log & C.ServerId) {
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

// TODO Zod?
export function fromEventRow(row: SchemaModels.ServerEvent): SM.Events.Event {
	return {
		...(superjson.deserialize(row.data as any, { inPlace: true }) as any),
		id: row.id,
		type: row.type,
		time: row.time.getTime(),
		matchId: row.type === 'NEW_GAME' ? row.matchId : undefined,
	}
}

export const saveEvents = C.spanOp(
	'squad-server:save-events',
	{ tracer, mutexes: (ctx) => ctx.server.savingEventsMtx },
	async (ctx: C.SquadServer & CS.Log & C.Db) => {
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
			ctx.log.info('No events to save')
			return
		}

		const rows: SchemaModels.NewServerEvent[] = events.map(e => {
			const { id, type, time, matchId, ...rest } = e
			return ({
				id,
				type,
				time: new Date(time),
				matchId: matchId,
				data: superjson.serialize(rest),
			})
		})

		try {
			await ctx.db({ redactParams: true }).insert(Schema.serverEvents).values(rows)
		} catch (error) {
			ctx.log.error('Failed to save events', error)
		}
		ctx.log.info('saved %d events [%d:%d]', events.length, events[0].id, events[events.length - 1].id)
		state.lastSavedEventId = events[events.length - 1].id
	},
)

function resetPlayerAndSquadState(ctx: C.SquadServer, players: SM.Player[], squads: SM.Squad[]) {
	const server = ctx.server

	server.state.connected = []
	for (const player of players) {
		server.state.connected.push(player.ids)
	}
	server.state.createdSquads = []
	for (const squad of squads) {
		server.state.createdSquads.push({ teamId: squad.teamId, squadId: squad.squadId, creatorIds: squad.creatorIds })
	}
}

function eventId() {
	return globalState.serverEventIdCounter.next().value
}
