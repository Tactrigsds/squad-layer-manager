import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as AR from '@/app-routes'
import * as Arr from '@/lib/array'
import { acquireInBlock, anySignal, distinctDeepEquals, firstValueFrom, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { AsyncResource } from '@/lib/async-resource'
import * as Cleanup from '@/lib/cleanup'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Gen from '@/lib/generator'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object'
import Rcon from '@/lib/rcon/core-rcon'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import { SftpTail } from '@/lib/sftp-tail'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import { HumanTime } from '@/lib/zod'
import * as Messages from '@/messages.ts'
import * as AppEvents from '@/models/app-events.models'
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
import * as Settings from '@/systems/settings.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as TeamSwitchesSys from '@/systems/teamswitches.server'
import * as Vote from '@/systems/vote.server'
import * as WsSessionSys from '@/systems/ws-session.server'
import * as Orpc from '@orpc/server'
import { Mutex, type MutexInterface } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import { z } from 'zod'

const module = initModule('squad-server')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

type State = {
	slices: Map<string, C.ServerSlice>
	// emits a serverId whenever that server's slice is added to or removed from `slices`
	sliceLifecycleUpdate$: Rx.Subject<string>
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

	// SLM app (audit) events for this server, and the live channel that feeds them into the activity panel
	emittedAppEvents: AppEvents.AppEvent[]
	appEvent$: Rx.Subject<[C.Db & C.ServerSlice, AppEvents.AppEvent]>

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
	watchLayersStatus: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = sliceCtx$(context.wsClientId, input.serverId).pipe(
			withAbortSignal(signal!),
			Rx.switchMap((sliceCtx) => {
				if (!sliceCtx) {
					return Rx.of({ code: 'server-disabled' as const } satisfies SM.LayersStatusResExt)
				}
				return new Rx.Observable<SM.LayersStatusResExt>((subscriber) => {
					const ac = new AbortController()
					;(async () => {
						const currentMatch = await MatchHistory.getCurrentMatch(sliceCtx)
						const nextLayerId = sliceCtx.server.eventState.nextLayerId
						subscriber.next({
							code: 'ok',
							data: {
								currentLayer: L.toLayer(currentMatch.layerId),
								nextLayer: nextLayerId ? L.toLayer(nextLayerId) : null,
								currentMatch,
							},
						})
						const event$ = sliceCtx.server.event$.pipe(withAbortSignal(ac.signal))
						for await (const [ctx, event] of toAsyncGenerator(event$)) {
							if (!['NEW_GAME', 'MAP_SET', 'RESET'].includes(event.type)) continue
							const currentMatch = await MatchHistory.getCurrentMatch(ctx)
							const nextLayerId = ctx.server.eventState.nextLayerId
							subscriber.next({
								code: 'ok',
								data: {
									currentLayer: L.toLayer(currentMatch.layerId),
									nextLayer: nextLayerId ? L.toLayer(nextLayerId) : null,
									currentMatch,
								},
							})
						}
						subscriber.complete()
					})().catch((err) => subscriber.error(err))
					return () => ac.abort()
				})
			}),
		)
		yield* toAsyncGenerator(obs)
	}),

	watchServerRolling: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = sliceCtx$(context.wsClientId, input.serverId).pipe(
			Rx.switchMap((ctx) => {
				if (!ctx) return Rx.EMPTY
				return ctx.server.serverRolling$
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	watchServerInfo: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = sliceCtx$(context.wsClientId, input.serverId).pipe(
			Rx.switchMap((ctx) => {
				if (!ctx) return Rx.EMPTY
				return ctx.server.serverInfo.observe(ctx).pipe(distinctDeepEquals())
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	endMatch: orpcBase.input(z.object({ serverId: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctx = resolveSliceCtx(_ctx, input.serverId)
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
		const result$ = firstValueFrom(
			Rx.race(
				matchEnded$,
				Rx.timer(10_000).pipe(Rx.map(() => 'timeout' as const)),
			),
			ctx.signal,
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
		.meta({ logLevel: 'trace' })
		.input(
			z.object({ lastEventId: z.number().optional(), serverId: z.string() }),
		)
		.handler(async function*({ context, signal, input }) {
			const obs: Rx.Observable<(SE.Event | CHAT.AppFeedEvent | CHAT.LifecycleEvent)[]> = sliceCtx$(context.wsClientId, input.serverId).pipe(
				Rx.switchMap((_ctx) => {
					if (!_ctx) return Rx.EMPTY
					const ctx = _ctx
					async function getInitialEvents() {
						const sync: CHAT.SyncedEvent = {
							type: 'SYNCED' as const,
							time: Date.now(),
							matchId: (await MatchHistory.getCurrentMatch(ctx))
								.historyEntryId,
						}

						let allEvents: SE.Event[] = ctx.server.emittedEvents
						let events: (SE.Event | CHAT.AppFeedEvent | CHAT.LifecycleEvent)[] = []

						if (input.lastEventId === undefined) {
							events.push({
								type: 'INIT',
								time: Date.now(),
								serverId: ctx.serverId,
							})
							events.push(...mergeEventsByTime(allEvents, ctx.server.emittedAppEvents))
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
							events.push(
								...mergeEventsByTime(
									allEvents.slice(lastEventIndex + 1),
									ctx.server.emittedAppEvents.filter((a) => lastEventIndex === -1 || a.time >= allEvents[lastEventIndex].time),
								),
							)
							events.push(sync)
						}

						return Arr.paged(events, 512)
					}
					const initial$ = Rx.from(getInitialEvents()).pipe(Rx.concatAll())

					const upcoming$ = Rx.merge(
						ctx.server.event$.pipe(Rx.map(([_, e]): SE.Event | CHAT.AppFeedEvent => e)),
						ctx.server.appEvent$.pipe(Rx.map(([_, appEvent]): SE.Event | CHAT.AppFeedEvent => ({ type: 'APP_EVENT', appEvent }))),
					).pipe(
						Rx.map((event): (SE.Event | CHAT.AppFeedEvent)[] => [event]),
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
		.input(z.object({ serverId: z.string(), disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveSliceCtx(_ctx, input.serverId)
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

	warnPlayer: orpcBase
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema, reason: z.string().min(1) }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveSliceCtx(_ctx, input.serverId)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:warn-players'))
			if (denyRes) return denyRes
			await warnPlayers(ctx, [input.playerId], input.reason, { type: 'slm-user', userId: ctx.user.discordId })
			return { code: 'ok' as const }
		}),

	warnPlayers: orpcBase
		.input(z.object({ serverId: z.string(), playerIds: z.array(SM.PlayerIdSchema).min(1), reason: z.string().min(1) }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveSliceCtx(_ctx, input.serverId)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:warn-players'))
			if (denyRes) return denyRes
			await warnPlayers(ctx, input.playerIds, input.reason, { type: 'slm-user', userId: ctx.user.discordId })
			return { code: 'ok' as const }
		}),

	demoteCommander: orpcBase
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveSliceCtx(_ctx, input.serverId)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			await SquadRcon.demoteCommander(ctx, input.playerId)
			return { code: 'ok' as const }
		}),

	disbandSquad: orpcBase
		.input(z.object({ serverId: z.string(), teamId: SM.TeamIdSchema, squadId: z.number().int().positive() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveSliceCtx(_ctx, input.serverId)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			await SquadRcon.disbandSquad(ctx, input.teamId, input.squadId)
			return { code: 'ok' as const }
		}),

	removeFromSquad: orpcBase
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveSliceCtx(_ctx, input.serverId)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			await SquadRcon.removeFromSquad(ctx, input.playerId)
			return { code: 'ok' as const }
		}),

	renameSquad: orpcBase
		.input(z.object({ serverId: z.string(), teamId: SM.TeamIdSchema, squadId: z.number().int().positive() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = resolveSliceCtx(_ctx, input.serverId)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			await SquadRcon.adminRenameSquad(ctx, input.teamId, input.squadId)
			return { code: 'ok' as const }
		}),
}

export async function setup() {
	log = module.getLogger()
	const ctx = getBaseCtx()

	globalState = {
		slices: new Map(),
		sliceLifecycleUpdate$: new IsolatedSubject(),
		serverEventIdCounter: undefined!,
		squadIdCounter: undefined!,
	}

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

	// Settings.setup() has already loaded the registry by this point (see main.ts); boot a slice for every server that should have one
	await Promise.all(Settings.listServerEntries().map((entry) => ensureSliceRunning(entry.id)))
}

// boots a slice for the given server if it's enabled, not broken, and doesn't already have one running
export async function ensureSliceRunning(serverId: string) {
	if (globalState.slices.has(serverId)) return
	const entry = Settings.getServerEntry(serverId)
	if (!entry || !entry.enabled || entry.broken) return
	const ctx = getBaseCtx()
	const serverState = await getServerState({ ...ctx, serverId })
	await setupSlice(ctx, serverState)
	log.info(`Server ${serverId} setup complete`)
}

// tears down and re-creates the slice for a server, picking up the latest settings from the DB. If the server isn't currently
// running (disabled, broken, or not yet started), this just ensures it's running per the usual rules -- it never force-starts it.
export async function restartSliceIfRunning(serverId: string) {
	const ctx = getBaseCtx()
	const slice = globalState.slices.get(serverId)
	if (slice) {
		await destroyServer({ ...ctx, ...slice })
		log.info(`Server ${serverId} slice destroyed for restart`)
	}
	await ensureSliceRunning(serverId)
}

// forces the admin list resource to refetch (picking up the latest adminListSources/adminIdentifyingPermissions) without
// tearing down the rest of the slice. No-op if the server isn't currently running.
export function invalidateAdminList(serverId: string) {
	const slice = globalState.slices.get(serverId)
	if (!slice) return
	slice.adminList.invalidate(getBaseCtx())
}

// lets destroyServer cancel a slice's in-flight work before its cleanup tasks run
const sliceAbortControllers = new Map<string, AbortController>()

async function setupSlice(ctx: C.Db & CS.AbortSignal, serverState: SS.ServerState) {
	const serverId = serverState.id
	const settings = serverState.settings
	const cleanup: Cleanup.Tasks = []

	const sliceAbort = new AbortController()
	sliceAbortControllers.set(serverId, sliceAbort)
	// aborts when the slice is destroyed or the process shuts down
	const signal = anySignal(ctx.signal, sliceAbort.signal)!
	ctx = { ...ctx, signal }

	const rcon = new Rcon({ serverId, settings: settings.connections.rcon })
	rcon.ensureConnected()
	cleanup.push(() => rcon.disconnect())

	const layersStatusExt$: SquadServer['layersStatusExt$'] = getLayersStatusExt$(serverId)

	// a resource that keeps failing after retries means the slice can't do its job -- tear the slice down instead of
	// letting the error escalate to an unhandled rejection and crash the process
	const onResourceFatalError = async (err: unknown) => {
		log.error(err, `Server ${serverId}: async resource failed permanently, destroying slice`)
		const slice = globalState.slices.get(serverId)
		if (!slice) return
		try {
			await destroyServer({ ...getBaseCtx(), ...slice })
		} catch (destroyErr) {
			log.error(destroyErr, `Server ${serverId}: failed to destroy slice after fatal resource error`)
		}
	}

	const adminList = (() => {
		const adminListTTL = HumanTime.parse('1h')
		// read adminListSources/adminIdentifyingPermissions fresh on every fetch (rather than closing over the setup-time settings)
		// so that SquadServer.invalidateAdminList() picks up edits without needing a full slice restart
		return new AsyncResource<SM.AdminList, CS.Ctx & CS.AbortSignal>(
			`${serverId}/adminLists`,
			async (_ctx) => {
				const currentSettings = await Settings.getServerSettings(getBaseCtx(), serverId)
				const serverSources: SM.AdminListSource[] = []
				for (const key of currentSettings.adminListSources) {
					const source = Settings.GLOBAL_SETTINGS.adminListSources[key]
					if (source) serverSources.push(source)
					else log.warn(`Admin list source "${key}" not found in global settings`)
				}
				// we are duplicating fetches here if two servers have the same source, but shouldn't matter
				return fetchAdminLists(serverSources, currentSettings.adminIdentifyingPermissions, _ctx.signal)
			},
			module,
			{
				defaultTTL: adminListTTL,
				retries: 3,
				retryDelay: 1000,
				log,
				onFatalError: onResourceFatalError,
			},
		)
	})()
	cleanup.push(() => adminList.dispose())
	const logType = settings.connections.logs.type
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
		minSafeLogLeadTimeForOtherEvents: logType === 'sftp'
			? Settings.GLOBAL_SETTINGS.squadServer.sftpPollInterval * 2
			: logType === 'log-receiver'
			? 1000
			: assertNever(logType),
	})

	const server: SquadServer = {
		layersStatusExt$,

		postRollEventsSub: null,

		serverRolling$: new Rx.BehaviorSubject(null as number | null),

		event$: new IsolatedSubject(),
		appEvent$: new IsolatedSubject(),
		processEventsMtx: new Mutex(),

		eventState: eventState,

		chatState: CHAT.getInitialChatState(),
		emittedEvents: [],
		emittedAppEvents: [],
		lastSavedEventId: null,
		destroyed: false,
		cleanupId: null,

		savingEventsMtx: new Mutex(),

		...SquadRcon.initSquadRcon({ ...ctx, rcon, adminList, serverId }, cleanup, { onFatalError: onResourceFatalError }),
	}

	cleanup.push(
		() => server.postRollEventsSub,
		server.serverRolling$,
		server.event$,
		server.appEvent$,
		server.savingEventsMtx,
		server.processEventsMtx,
	)

	const slice: C.ServerSlice = {
		...CS.init(),
		serverId,
		signal,

		rcon,
		server,

		matchHistory: MatchHistory.initMatchHistoryContext(server.event$, cleanup),

		teamswitches: TeamSwitchesSys.initContext({
			...ctx,
			serverId,
			cleanup,
			server,
		}),
		layerQueue: LayerQueue.initLayerQueueSlice({ ...ctx, cleanup, serverId }, serverState),
		serverSettings: Settings.initServerSettingsSlice({ ...ctx, cleanup, serverId }, serverState),
		vote: Vote.initVoteContext(cleanup),

		adminList,
		cleanup: cleanup,
	}

	globalState.slices.set(serverId, slice)
	globalState.sliceLifecycleUpdate$.next(serverId)

	// -------- load saved events --------
	await loadSavedEvents({ ...ctx, server, serverId })

	// // -------- watch events --------
	server.event$.subscribe(([ctx, event]) => {
		try {
			CHAT.handleEvent(ctx.server.chatState, event)
		} catch (error) {
			log.error(error, 'Error handling event: %s %d', event.type, event.id)
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
	const logStreamAc = new AbortController()
	cleanup.push(logStreamAc)
	void C.spanOp('processLogEvents', { module }, async (_: unknown) => {
		let chunk$: Rx.Observable<string>
		if (settings.connections.logs.type === 'sftp') {
			const sftpReader = new SftpTail({
				filePath: settings.connections!.logs.logFile,
				host: settings.connections!.logs.host,
				port: settings.connections!.logs.port,
				username: settings.connections!.logs.username,
				password: settings.connections!.logs.password,
				pollInterval: Settings.GLOBAL_SETTINGS.squadServer.sftpPollInterval,
				reconnectInterval: Settings.GLOBAL_SETTINGS.squadServer.sftpReconnectInterval,
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
				toAsyncGenerator(chunk$.pipe(withAbortSignal(logStreamAc.signal))),
				errors,
			)
		) {
			if (logStreamAc.signal.aborted) break
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

	cleanup.push(
		rcon.connected$
			.pipe(
				C.durableSub(
					'onRconConnectStatusChange',
					{ module },
					async (connected, signal) => {
						const ctx = resolveSliceCtx(CS.addSignal(getBaseCtx(), signal), serverId)
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
			.subscribe(),
	)

	// -------- process rcon events --------
	cleanup.push(
		server.rconEvent$
			.pipe(
				C.durableSub(
					'onRconEvent',
					{ module, taskScheduling: 'parallel', levels: { event: 'trace' } },
					async ([_ctx, event], signal) => {
						const ctx = DB.addPooledDb(resolveSliceCtx(CS.addSignal({ ..._ctx }, signal), serverId))
						try {
							const opts: Promise<void>[] = []
							if (event.type === 'CHAT_MESSAGE') {
								if (event.message.startsWith(Settings.GLOBAL_SETTINGS.commandPrefix)) {
									opts.push(
										Commands.handleCommand(ctx, event).then((res) => {
											if (res?.code !== 'ok') log.error(res)
										}),
									)
								} else if (
									event.message.trim().match(/^\d+$/)
									&& ctx.vote.state?.code === 'in-progress'
								) {
									opts.push(Vote.handleVote(ctx, event))
								}
							}
							await Promise.all(opts)
						} catch (err) {
							log.error(err)
						}

						await collectEvents(ctx, () => {
							PendingEvents.onRconEvent(ctx.server.eventState, event)
						})
					},
				),
			)
			.subscribe(),
	)

	cleanup.push(
		server.teams
			.observe({ ...slice, ...ctx })
			.pipe(
				C.durableSub(
					'onTeamsPolled',
					{ module, numTaskRetries: 0, levels: { event: 'debug' } },
					async (teamsRes, signal) => {
						if (teamsRes.code !== 'ok') return teamsRes
						const time = Date.now()
						const ctx = resolveSliceCtx(CS.addSignal(getBaseCtx(), signal), serverId)
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
			.subscribe(),
	)

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
	if (Settings.GLOBAL_SETTINGS.warnOnSlmStart) {
		await SquadRcon.warnAllAdmins({ ...ctx, ...slice }, Messages.WARNS.slmStarted)
	}
}

export async function pushAttribution(ctx: C.SquadServer & C.Db & CS.AbortSignal, attribution: Omit<PendingEvents.Attribution, 'time'>) {
	await collectEvents(ctx, () => {
		PendingEvents.pushAttribution(ctx.server.eventState, attribution)
	})
}

// persists an SLM app (audit) event and streams it into this server's activity feed. Persist happens before
// the push (and before any server event that links to it via appEventId is later saved), satisfying the FK.
export async function emitAppEvent(ctx: C.SquadServer & C.Db & CS.AbortSignal, appEvent: AppEvents.AppEvent) {
	await ctx.db().insert(Schema.appEvents).values(AppEvents.toRow(appEvent))
	ctx.server.emittedAppEvents.push(appEvent)
	ctx.server.appEvent$.next([resolveSliceCtx(ctx, ctx.serverId), appEvent])
}

// warns players through an app event: creates the PLAYER_WARNED app event (so the feed can aggregate the
// resulting warns under one entry), arms the pending-events machine to attribute each landing PLAYER_WARNED server
// event to it, then issues the warns. Emit (persist) precedes arming and the warns so the app event exists before
// any server event referencing it is saved.
export async function warnPlayers(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	targets: SM.PlayerId[],
	reason: string,
	actor: AppEvents.Actor,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerWarned>({
		type: 'PLAYER_WARNED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		message: reason,
		targets,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.expectWarn(ctx.server.eventState, { playerId: target, reason, source })
		}
	})
	await SquadRcon.warnAll(ctx, targets, reason)
}

// interleaves server events and app events by time for the activity feed. app events sort before server events on
// ties (placed first + stable sort) so a warn's aggregating app event is already in the client buffer when its
// collapsed server events arrive. app events are wrapped for the wire (see CHAT.AppFeedEvent).
function mergeEventsByTime(serverEvents: SE.Event[], appEvents: AppEvents.AppEvent[]): (SE.Event | CHAT.AppFeedEvent)[] {
	const wrapped: CHAT.AppFeedEvent[] = appEvents.map((appEvent) => ({ type: 'APP_EVENT', appEvent }))
	const timeOf = (e: SE.Event | CHAT.AppFeedEvent) => e.type === 'APP_EVENT' ? e.appEvent.time : e.time
	return [...wrapped, ...serverEvents].sort((a, b) => timeOf(a) - timeOf(b))
}

export async function destroyServer(ctx: C.ServerSlice) {
	if (ctx.server.destroyed) return
	ctx.server.destroyed = true
	sliceAbortControllers.get(ctx.serverId)?.abort(new DOMException('server slice destroyed', 'AbortError'))
	sliceAbortControllers.delete(ctx.serverId)
	const cleanupId = ctx.server.cleanupId
	if (cleanupId !== null) CleanupSys.unregister(cleanupId)
	await Cleanup.runCleanup({ ...CS.init(), ...ctx, log }, ctx.cleanup)
	// we're not dealing with mutexes yet Sadge
	globalState.slices.delete(ctx.serverId)
	globalState.sliceLifecycleUpdate$.next(ctx.serverId)
}

export async function getFullServerState(ctx: C.Db & C.LayerQueue) {
	const query = ctx
		.db()
		.select()
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

export function getCurrTeams(ctx: C.SquadServer) {
	return ctx.server.eventState.currTeams
}

async function collectEvents(
	ctx: C.SquadServer & C.Db & CS.AbortSignal,
	addEventsCb: () => void,
) {
	using _lock = await acquireInBlock(ctx.server.processEventsMtx, { signal: ctx.signal })
	addEventsCb()
	for await (
		const event of PendingEvents.process(
			ctx.server.eventState,
			Date.now(),
		)
	) {
		ctx.server.event$.next([resolveSliceCtx(ctx, ctx.serverId), event])
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
	ctx: C.SquadServer & C.Rcon & C.MatchHistory & CS.AbortSignal,
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
	const servers = Settings.listServerEntries()
		.filter((s) => s.enabled && globalState.slices.has(s.id))
		.toSorted((a, b) => {
			if (a.defaultServer !== b.defaultServer) return a.defaultServer ? -1 : 1
			return 0
		})

	const res = ctx.res

	if (servers.length === 0) {
		// Clear any stale server cookie so the client doesn't try to connect to a disabled server
		if (ctx.cookies['default-server-id']) {
			res.clearCookie(AR.COOKIE_KEY.enum['default-server-id'], AR.COOKIE_DEFAULTS)
		}
		return { ...ctx, res }
	}

	const defaultServerId = ctx.cookies['default-server-id']
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

export function resolveSliceCtx<T extends object>(ctx: T, serverId: string) {
	const slice = globalState.slices.get(serverId)
	if (!slice) {
		throw new Orpc.ORPCError('BAD_REQUEST', {
			message: 'Server slice not found: ' + serverId,
		})
	}
	// cancel when either the caller (e.g. the originating request) or the slice is done. the slice signal
	// already covers process shutdown, so don't allocate a composite for base ctxs on the hot event path
	const callerSignal = (ctx as Partial<CS.AbortSignal>).signal
	const signal = callerSignal === CleanupSys.shutdownSignal ? slice.signal : anySignal(callerSignal, slice.signal)!
	return {
		...ctx,
		...slice,
		signal,
	}
}

// like selectedServerCtx$, but keyed by an explicit serverId instead of a wsClientId's session selection
export function sliceCtx$(wsClientId: string, serverId: string) {
	return globalState.sliceLifecycleUpdate$.pipe(
		Rx.filter((id) => id === serverId),
		Rx.startWith(serverId),
		Rx.map(() => {
			const slice = globalState.slices.get(serverId)
			if (!slice) return null
			return { ...getBaseCtx(), ...WsSessionSys.wsSessions.get(wsClientId)!, ...slice }
		}),
	)
}

function getBaseCtx() {
	return DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
}

// registry data (identity/enabled/default/broken) lives in settings.server.ts; this only orchestrates the live slice around it
export async function enableServer(serverId: string) {
	const ctx = getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, true)
	if (res.code !== 'ok') return res
	await ensureSliceRunning(serverId)
	log.info('Server %s enabled', serverId)
	return { code: 'ok' as const }
}

export async function disableServer(serverId: string) {
	const ctx = getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, false)
	if (res.code !== 'ok') return res

	const slice = globalState.slices.get(serverId)
	if (slice) {
		await destroyServer({ ...ctx, ...slice })
	}
	log.info('Server %s disabled', serverId)
	return { code: 'ok' as const }
}

export async function deleteServer(serverId: string) {
	const ctx = getBaseCtx()
	const slice = globalState.slices.get(serverId)
	if (slice) {
		await destroyServer({ ...ctx, ...slice })
	}
	return await Settings.deleteServerEntry(ctx, serverId)
}

export async function getServerState(ctx: C.Db & C.ServerId) {
	const query = ctx
		.db()
		.select()
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

// settings changes go through Settings.updateServerSettings instead — that's the one source of truth for reading/writing/broadcasting settings
export async function updateServerState(
	ctx: C.Db & C.Tx & C.LayerQueue,
	changes: Partial<Omit<SS.ServerState, 'settings'>>,
	source: SS.LQStateUpdate['source'],
) {
	const serverState = await getServerState(ctx)
	const newServerState = { ...serverState, ...changes }
	await ctx
		.db()
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

		const appEventRows = lastMatch
			? await ctx
				.db()
				.select()
				.from(Schema.appEvents)
				.where(E.eq(Schema.appEvents.matchId, lastMatch.id))
				.orderBy(E.asc(Schema.appEvents.time))
			: []
		server.emittedAppEvents = appEventRows.map((r) => AppEvents.fromRow(r))
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
				// queryable projection of source when it links to an app event
				const source = (event as { source?: { type: string; id?: string } }).source
				eventRows.push({
					id: event.id,
					type: event.type,
					time: new Date(event.time),
					matchId: event.matchId,
					appEventId: source?.type === 'event' ? source.id! : null,
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
					.onConflictDoUpdate({
						target: Schema.players.eosId,
						set: {
							steamId: sql`excluded.steamId`,
							username: sql`excluded.username`,
							modifiedAt: new Date(),
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
						.onConflictDoNothing({
							target: [
								Schema.playerEventAssociations.serverEventId,
								Schema.playerEventAssociations.playerId,
								Schema.playerEventAssociations.assocType,
							],
						})
				}
			}

			if (squadRows.length > 0) {
				await ctx
					.db({ redactParams: true })
					.insert(Schema.squads)
					.values(squadRows)
					.onConflictDoUpdate({
						target: Schema.squads.id,
						set: {
							ingameSquadId: sql`excluded.ingameSquadId`,
							teamId: sql`excluded.teamId`,
							name: sql`excluded.name`,
							creatorId: sql`excluded.creatorId`,
						},
					})
			}
			if (squadAssociationRows.length > 0) {
				await ctx
					.db({ redactParams: true })
					.insert(Schema.squadEventAssociations)
					.values(squadAssociationRows)
					.onConflictDoNothing({
						target: [Schema.squadEventAssociations.serverEventId, Schema.squadEventAssociations.squadId],
					})
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

export async function waitForSynced(ctx: C.SquadServer & CS.AbortSignal) {
	if (ctx.server.eventState.syncState.type === 'synced') return
	await firstValueFrom(
		ctx.server.event$.pipe(
			Rx.filter(
				([ctx, event]) => event.type === 'NEW_GAME' || event.type === 'RESET',
			),
		),
		ctx.signal,
	)
}
