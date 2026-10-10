// Boots, restarts and tears down managed servers. setupManagedServer wires one server's RCON, log tail, event
// pipeline and per-server systems together, and registers the cleanup that destroyServer runs.

import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import * as Timers from 'node:timers/promises'

import * as Schema from '$root/drizzle/schema'
import * as Cleanup from '@/lib/cleanup'
import { FileTail } from '@/lib/file-tail'
import { isolateCb, TracedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as Prom from '@/lib/promise-utils'
import Rcon, { DirectSocketTransport } from '@/lib/rcon/core-rcon'
import * as Rx from '@/lib/rxjs'
import { SftpTail } from '@/lib/sftp-tail'
import { assertNever } from '@/lib/type-guards'
import * as I18n from '@/messages/i18n'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models.ts'
import * as CS from '@/models/context-shared.models'
import * as LL from '@/models/layer-list.models'
import * as L from '@/models/layer.models'
import * as MH from '@/models/match-history.models'
import * as ATTRS from '@/models/otel-attrs.models'
import * as PendingEvents from '@/models/pending-events.models'
import * as Activity from '@/models/player-activity.models'
import * as SE from '@/models/server-events.models'
import type * as SS from '@/models/server-state.models'
import * as SLL from '@/models/shared-layer-list.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as AdminList from '@/systems/adminlist.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as CommandPrompts from '@/systems/command-prompts.server'
import * as Commands from '@/systems/commands.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as PluginsSys from '@/systems/plugins.server'
import * as Sandbox from '@/systems/sandbox.server'
import * as ServerAgent from '@/systems/server-agent.server'
import * as ServerConsole from '@/systems/server-console.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServerIngest from '@/systems/squad-server-ingest.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as SwitchRequests from '@/systems/switch-requests.server'
import * as Teamswaps from '@/systems/teamswaps.server'
import * as Timeouts from '@/systems/timeouts.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'

const module = initModule('squad-server')

const meter = Otel.metrics.getMeter('squad-server')

const logLineCounter = meter.createCounter(ATTRS.SquadLogs.LINES, {
	description: 'Squad log lines ingested, by server and log source',
})

const logIoCounter = meter.createCounter(ATTRS.SquadLogs.IO, {
	description: 'Bytes of squad log data ingested, by server and log source',
	unit: 'By',
})

const logEventCounter = meter.createCounter(ATTRS.SquadLogs.EVENTS, {
	description: 'Squad log events successfully parsed out of the log stream, by server and log source',
})

const logLagHistogram = meter.createHistogram(ATTRS.SquadLogs.LAG, {
	description:
		'Log delivery lag (receive time minus log timestamp, incl. clock skew): the per-second worst-case samples the lead-time tuner acts on, by server and log source',
	unit: 'ms',
	advice: {
		// sized around the tuner's operating range: floor 250ms, ceiling 10s, with the 45s stale cutoff as tail
		explicitBucketBoundaries: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 45000],
	},
})

export async function setup() {
	await SquadServer.init()
	// Settings.setup() has already loaded the registry by this point (see main.ts); boot a managed server for every server that should have one
	await Promise.all(Settings.listServerEntries().map((entry) => ensureRunning(entry.id)))
}

// Serializes every transition of a managed server between running and not, so that no two of setup, teardown and restart can
// interleave and observe each other's half-applied state. Per-server, so unrelated servers never wait on each other.
//
// The mutex is not reentrant, so the *Locked functions below are the composable pieces: anything already holding the lock must
// call those, and only the exported entry points may take it. Acquiring it twice in one call stack self-deadlocks.
function withLifecycleLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
	let mtx = SquadServer.globalState.lifecycleMtxs.get(serverId)
	if (!mtx) {
		mtx = new Mutex()
		SquadServer.globalState.lifecycleMtxs.set(serverId, mtx)
	}
	return mtx.runExclusive(fn)
}

// boots a managed server for the given server if it's enabled, not broken, and doesn't already have one running
export async function ensureRunning(serverId: string) {
	await withLifecycleLock(serverId, () => ensureRunningLocked(serverId))
}

async function ensureRunningLocked(serverId: string) {
	if (SquadServer.globalState.managedServers.has(serverId)) return
	const entry = Settings.getServerEntry(serverId)
	if (!entry || !entry.enabled || entry.broken) return
	const ctx = SquadServer.getBaseCtx()
	const serverState = await SquadServer.getServerState({ ...ctx, serverId })
	await setupManagedServer(ctx, serverState)
	SquadServer.log.info(`Server ${serverId} setup complete`)
}

// tears down a server's managed server if one is running. No-op otherwise.
async function destroyIfRunningLocked(serverId: string) {
	const managedServer = SquadServer.globalState.managedServers.get(serverId)
	if (!managedServer) return false
	await destroyServer({ ...SquadServer.getBaseCtx(), ...managedServer })
	return true
}

// tears down and re-creates a server's managed server, picking up the latest settings from the DB. If the server isn't currently
// running (disabled, broken, or not yet started), this just ensures it's running per the usual rules -- it never force-starts it.
export async function restartIfRunning(serverId: string) {
	await withLifecycleLock(serverId, async () => {
		if (await destroyIfRunningLocked(serverId)) {
			SquadServer.log.info(`Server ${serverId} torn down for restart`)
		}
		await ensureRunningLocked(serverId)
	})
}

// lets destroyServer cancel a managed server's in-flight work before its cleanup tasks run
const abortControllers = new Map<string, AbortController>()

async function setupManagedServer(ctx: C.Db & CS.AbortSignal, serverState: SS.ServerState) {
	const serverId = serverState.id
	const settings = serverState.settings
	const cleanup: Cleanup.Tasks = []

	const abort = new AbortController()
	abortControllers.set(serverId, abort)
	// aborts when the managed server is destroyed or the process shuts down
	const signal = Prom.anySignal(ctx.signal, abort.signal)!
	ctx = { ...ctx, signal }

	// the emulator has to be listening before anything can dial it, and it owns its own (ephemeral) port
	if (Sandbox.isSandbox(settings.connections)) await Sandbox.ensureInstance(serverId, settings.connections)

	ServerConsole.recordSlm(serverId, 'info', `Starting server, reaching it over ${settings.connections.type}`)

	// local/sftp dial RCON directly; server-agent tunnels it through the agent (the agent holds the password).
	// sandbox dials the in-process emulator over loopback, so the real packet framing still runs.
	const rconTransport =
		settings.connections.type === 'server-agent'
			? ServerAgent.rconTransportFor(serverId)
			: new DirectSocketTransport(settings.connections.type === 'sandbox' ? Sandbox.connectionFor(serverId) : settings.connections.rcon)
	const rcon = new Rcon({
		serverId,
		transport: rconTransport,
		onTraffic: (dir, body, reqId) => ServerConsole.record(serverId, { type: 'rcon', dir, body, reqId, time: Date.now() }),
		onStatus: (level, message, detail) => ServerConsole.recordSlm(serverId, level, message, detail),
	})
	rcon.ensureConnected()
	cleanup.push(() => rcon.disconnect())
	cleanup.push(() => ServerConsole.recordSlm(serverId, 'info', 'Server stopped'))
	cleanup.push(() => CommandPrompts.disposeFor(serverId))

	// a resource that keeps failing after retries means the managed server can't do its job -- tear the managed server down instead of
	// letting the error escalate to an unhandled rejection and crash the process.
	//
	// Takes the lifecycle lock, which is safe only because AsyncResource discards this callback's return rather than awaiting it:
	// nothing holding the lock ever waits on us, so there is no cycle. If the resource dies mid-setup we simply queue behind
	// setupManagedServer and tear down the managed server it just finished building.
	const destroyAfterFatalError = async (err: unknown) => {
		SquadServer.log.error(err, `Server ${serverId}: async resource failed permanently, tearing the server down`)
		ServerConsole.recordSlm(serverId, 'error', 'A connection failed permanently, stopping the server', err)
		try {
			await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
		} catch (destroyErr) {
			SquadServer.log.error(destroyErr, `Server ${serverId}: failed to tear the server down after fatal resource error`)
		}
	}
	const onResourceFatalError = (err: unknown) => void destroyAfterFatalError(err)

	// How long a logged line can take to reach us. A polled source can be a whole poll behind; a pushed one is near-live.
	const logDeliveryMs =
		settings.connections.type === 'sftp'
			? settings.connections.sftp.pollInterval
			: settings.connections.type === 'local'
				? Settings.GLOBAL_SETTINGS.logFilePollInterval
				: settings.connections.type === 'server-agent'
					? 500
					: // in-process: a log line is delivered in the same tick the world writes it
						settings.connections.type === 'sandbox'
						? 0
						: assertNever(settings.connections)

	// Long enough to survive a tick split across two deliveries, and short enough to stay inside the window below,
	// so a poll doesn't give up waiting for the log while the parser is still holding a tick.
	const logIdleFlushMs = Math.max(logDeliveryMs * 1.5, 100)

	const event$: SQS.Ctx.Payload['event$'] = new TracedSubject({ ...CS.init(), serverId })
	const ingest: SquadServerIngest.EventIngest = {
		serverId,
		event$,
		db: { ...SquadServer.getBaseCtx(), log: SquadServer.log },
		writes: null,
		unpublished: [],
	}

	const eventState: PendingEvents.State = PendingEvents.init({
		counters: {
			squadId: SquadServer.globalState.squadIdCounter,
		},
		currentMatch: 'PENDING',
		log: SquadServer.log,
		hooks: {
			onNewGameDuringRoll: SquadServerIngest.publishingFirst(ingest, onNewGameDuringRoll(serverId)),
			onNewGameDuringSync: SquadServerIngest.publishingFirst(ingest, onNewGameDuringSync(serverId)),
			createEvent: (event) => SquadServerIngest.ingestEvent(ingest, event),
			// Every caller resolves what the server is doing right now, at a moment the cached value is still the
			// outgoing match's. observe() replays whatever is cached as its first emission whatever ttl it is asked
			// for, so this has to be a get that refuses the cache outright.
			fetchLayersStatus: SquadServerIngest.publishingFirst(ingest, async () => {
				const ctx = SquadServer.resolveCtx(SquadServer.getBaseCtx(), serverId)
				const res = await ctx.squadRcon.layersStatus.get(ctx, { ttl: 0 })
				return res.code === 'ok' ? res.data : null
			}),
			skipDestroyedOnTrainingLayers: () => serverSettings.settings.skipDestroyedOnTrainingLayers,
			fetchUsernamesNoTag: async (players) => {
				const ctx = SquadServer.resolveCtx(SquadServer.getBaseCtx(), serverId)
				const rows = await ctx
					.db()
					.select({ eosId: Schema.players.eosId, username: Schema.players.username, usernameNoTag: Schema.players.usernameNoTag })
					.from(Schema.players)
					.where(
						E.and(
							E.inArray(
								Schema.players.eosId,
								players.map((p) => p.eos),
							),
							E.isNotNull(Schema.players.usernameNoTag),
						),
					)
				const usernames = new Map(players.map((p) => [p.eos, p.username]))
				const res = new Map<SM.PlayerId, string>()
				for (const row of rows) {
					if (row.usernameNoTag && usernames.get(row.eosId) === row.username) res.set(row.eosId, row.usernameNoTag)
				}
				return res
			},
		},
		// how far a non-log event may lead the log stream before we stop waiting for the log to catch up:
		// one delivery, and the parser's wait for the tick it is accumulating to go quiet. A static prior only:
		// once measured log lag warms up, LogLagTuner retunes it (clock skew makes any static value drift).
		minSafeLogLeadTimeForOtherEvents: logDeliveryMs + logIdleFlushMs,
	})

	const server: SQS.Ctx.Payload = {
		postRollEventsSub: null,

		serverRolling$: new Rx.BehaviorSubject(null as number | null),
		tickRate$: new Rx.BehaviorSubject(null as number | null),
		serverInfo$: new Rx.BehaviorSubject(null as SM.ServerInfo | null),

		event$,
		appEvent$: new TracedSubject({ ...CS.init(), serverId }),
		processEventsMtx: new Mutex(),

		eventState: eventState,

		chatInterpolatedState: CHAT.getInitialInterpolatedState(),
		activity: Activity.init(),
		emittedEvents: [],
		emittedAppEvents: [],
		destroyed: false,
		cleanupId: null,
	}
	SquadServerIngest.ingestByServer.set(server, ingest)

	const squadRcon = SquadRcon.initSquadRcon({ ...ctx, rcon, serverId }, cleanup, { onFatalError: onResourceFatalError })

	cleanup.push(
		() => server.postRollEventsSub,
		server.serverRolling$,
		server.tickRate$,
		server.serverInfo$,
		server.event$,
		server.appEvent$,
		server.processEventsMtx,
	)

	// hoisted so the translator can follow the server's locale setting, whose payload is mutated in place
	const serverSettings = Settings.initServerPayload({ ...ctx, cleanup, serverId }, serverState)

	const managedServer: C.ManagedServer = {
		...CS.init(),
		serverId,
		signal,
		tr: I18n.liveTranslator(() => serverSettings.settings.locale),

		rcon,
		squadRcon,
		server,

		matchHistory: MatchHistory.initMatchHistoryContext(server.event$, cleanup),
		matchEventsCache: MatchEventsCache.initMatchEventsCacheContext(),

		teamswaps: Teamswaps.initContext({
			...ctx,
			serverId,
			cleanup,
			rcon,
			squadRcon,
			server,
		}),
		switchRequests: SwitchRequests.initContext({
			...ctx,
			serverId,
			cleanup,
			rcon,
			squadRcon,
			server,
		}),
		layerQueue: LayerQueue.initPayload({ ...ctx, cleanup, serverId }, serverState),
		serverSettings,
		vote: Vote.initVoteContext(cleanup),

		cleanup: cleanup,
	}

	SquadServer.globalState.managedServers.set(serverId, managedServer)
	SquadServer.globalState.lifecycleUpdate$.next(serverId)

	// -------- load saved events --------
	await MatchHistory.initState({
		...ctx,
		serverId,
		signal,
		matchHistory: managedServer.matchHistory,
		matchEventsCache: managedServer.matchEventsCache,
	})
	await loadSavedEvents({ ...ctx, rcon, squadRcon, server, serverId })

	// // -------- watch events --------
	server.event$.subscribe(([, event]) => {
		try {
			CHAT.interpolateEvent(server.chatInterpolatedState, event)
			Activity.note(server.activity, event)
		} catch (error) {
			SquadServer.log.error(error, 'Error handling event: %s %d', event.type, event.id)
		}
		if (SquadServer.log.isLevelEnabled('debug')) {
			SquadServer.log.debug(
				'emitted event: %s %s',
				event.type,
				JSON.stringify(['NEW_GAME', 'RESET'].includes(event.type) ? Obj.omit(event as any, ['state']) : event),
			)
		}
		server.emittedEvents.push(event)
	})

	server.event$
		.pipe(
			Rx.filter(([_, event]) => event.type === 'PLAYER_DETAILS_CHANGED' && !!event.newUsername),
			Instr.durableSub('onPlayerNameChanged', { module }, async ([evtCtx, event], signal) => {
				if (event.type !== 'PLAYER_DETAILS_CHANGED' || !event.newUsername) {
					return
				}
				const ctx = SquadServer.eventCtx(evtCtx, signal)
				await ctx
					.db()
					.update(Schema.players)
					.set({
						username: event.newUsername,
						// still valid if only the tag changed
						usernameNoTag: sql`CASE WHEN substr(${event.newUsername}, -length(${Schema.players.usernameNoTag})) = ${Schema.players.usernameNoTag} THEN ${Schema.players.usernameNoTag} END`,
					})
					.where(E.eq(Schema.players.eosId, event.player))
			}),
		)
		.subscribe()

	// The Squad server re-reads its Admins.cfg on every new game, so refetch at the same moment rather than waiting out
	// the hourly TTL: from the roll onwards the file's current contents are what the server enforces in-game, and SLM
	// answering permission checks from an older copy disagrees with it for up to an hour.
	server.event$.pipe(Rx.filter(([, event]) => event.type === 'NEW_GAME')).subscribe(() => AdminList.invalidateAll(ctx))

	// kick-timeout enforcement: fresh connects and full roster reseeds. PLAYER_RECONCILED (roster backfill of an
	// already-present player) is deliberately excluded. RESET fires on every roll, doubling as a periodic sweep.
	server.event$
		.pipe(
			Rx.filter(([_, event]) => event.type === 'PLAYER_CONNECTED' || event.type === 'RESET'),
			Instr.durableSub('onPlayerConnectedEnforceTimeouts', { module }, async ([evtCtx, event], signal) => {
				const playerIds =
					event.type === 'PLAYER_CONNECTED'
						? [SM.PlayerIds.getPlayerId(event.player.ids)]
						: event.type === 'RESET'
							? (SE.eventRoster(event)?.players.map((p) => SM.PlayerIds.getPlayerId(p.ids)) ?? [])
							: []
				if (playerIds.length === 0) return
				await Timeouts.enforceTimeouts(SquadServer.eventCtx(evtCtx, signal), playerIds)
			}),
		)
		.subscribe() // -------- process log events --------
	const logStreamAc = new AbortController()
	cleanup.push(logStreamAc)
	void Instr.spanOp('processLogEvents', { module }, async (_: unknown) => {
		let chunk$: Rx.Observable<string>
		if (settings.connections.type === 'sftp') {
			const sftp = settings.connections.sftp
			const sftpReader = new SftpTail({
				filePath: sftp.logFile,
				host: sftp.host,
				port: sftp.port,
				username: sftp.username,
				password: sftp.password,
				pollInterval: sftp.pollInterval,
				reconnectInterval: sftp.reconnectInterval,
				maxReconnectAttempts: sftp.maxReconnectAttempts,
				// reconnection attempts exhausted: tear the managed server down rather than letting the error crash the process
				onFatalError: onResourceFatalError,
				onStatus: (level, message, detail) => ServerConsole.recordSlm(serverId, level, message, detail),
				parentModule: module,
			})
			cleanup.push(() => sftpReader.unwatch())
			sftpReader.watch()

			chunk$ = Rx.fromEvent(sftpReader, 'chunk').pipe(Rx.map((...args) => args[0] as string))
		} else if (settings.connections.type === 'local') {
			const fileReader = new FileTail({
				filePath: settings.connections.logFile,
				pollInterval: Settings.GLOBAL_SETTINGS.logFilePollInterval,
				onFatalError: onResourceFatalError,
				onStatus: (level, message, detail) => ServerConsole.recordSlm(serverId, level, message, detail),
				parentModule: module,
			})
			cleanup.push(() => fileReader.unwatch())
			fileReader.watch()

			chunk$ = Rx.fromEvent(fileReader, 'chunk').pipe(Rx.map((...args) => args[0] as string))
		} else if (settings.connections.type === 'server-agent') {
			chunk$ = ServerAgent.streamFor(serverId)
		} else if (settings.connections.type === 'sandbox') {
			// straight from the world, with no file in between. The instance outlives this subscription, so the
			// unsubscribe has to detach the listener or a managed server restart would leave the old one writing into a dead stream.
			chunk$ = new Rx.Observable<string>((subscriber) => {
				const instance = Sandbox.getInstance(serverId)
				if (!instance) {
					subscriber.error(new Error(`sandbox ${serverId} has no running emulator`))
					return
				}
				return instance.emu.onLogLine((line) => subscriber.next(line + '\n'))
			})
		} else {
			assertNever(settings.connections)
		}

		// Counted on the way in, at the one point every log source (sftp poll, local file tail,
		// server-agent push) funnels through, so the numbers mean the same thing whichever a server uses. A
		// chunk is not line-aligned, so lines are counted by newline rather than by split length: a
		// chunk that splits a line in half would otherwise count it twice.
		const logSource = settings.connections.type satisfies ATTRS.SquadLogs.Source
		const countedChunk$ = chunk$.pipe(
			Rx.tap((chunk) => {
				// the console tails the same point the counters do, so it shows what was actually ingested rather
				// than what a particular source happened to produce
				ServerConsole.recordLogChunk(serverId, chunk, Date.now())
				const attrs = { [ATTRS.SquadServer.ID]: serverId, [ATTRS.SquadLogs.SOURCE]: logSource }
				logIoCounter.add(Buffer.byteLength(chunk, 'utf8'), attrs)
				let lines = 0
				for (let i = 0; i < chunk.length; i++) {
					if (chunk[i] === '\n') lines++
				}
				if (lines > 0) logLineCounter.add(lines, attrs)
			}),
		)

		const errors: Error[] = []
		let eventsSinceYield = 0
		for await (const parsed of SM.LogEvents.parseLogStreamBatches(
			Rx.Ext.toAsyncGenerator(countedChunk$.pipe(Rx.Ext.withAbortSignal(logStreamAc.signal))),
			errors,
			{
				onTickRate: (rate) => server.tickRate$.next(rate),
				// a tick is otherwise only closed by the next one, which on a quiet server can be a long time
				idleFlushMs: logIdleFlushMs,
			},
		)) {
			if (logStreamAc.signal.aborted) break
			const ctx = SquadServer.resolveCtx(SquadServer.getBaseCtx(), serverId)
			for (const error of errors) {
				SquadServer.log.error(error)
				// a line SLM could not parse is usually the game's log format having moved, which shows up to an admin
				// as SLM quietly missing events rather than as anything being wrong
				ServerConsole.recordSlm(serverId, 'warn', 'Could not parse a log line', error)
			}
			errors.splice(0, errors.length)

			const now = Date.now()
			const steps: (() => void)[] = []
			for (const event of parsed) {
				// a line that failed to parse, already reported above
				if (!event) continue
				logEventCounter.add(1, { [ATTRS.SquadServer.ID]: serverId, [ATTRS.SquadLogs.SOURCE]: logSource })
				const lagSampleMs = PendingEvents.LogLagTuner.observe(ctx.server.eventState, event.time, now)
				if (lagSampleMs !== null) {
					// clock skew can push a lag negative; the tuner keeps the sign, the metric clamps to stay a valid histogram value
					logLagHistogram.record(Math.max(0, lagSampleMs), {
						[ATTRS.SquadServer.ID]: serverId,
						[ATTRS.SquadLogs.SOURCE]: logSource,
					})
				}
				steps.push(() => PendingEvents.onLogEvent(ctx.server.eventState, event))
			}

			// a burst is persisted in slices, yielding between them so rcon, websockets and other servers are not
			// starved for the whole of it
			for (let i = 0; i < steps.length; i += SquadServerIngest.LOG_EVENTS_PER_SLICE) {
				if (eventsSinceYield >= SquadServerIngest.LOG_EVENTS_PER_SLICE) {
					eventsSinceYield = 0
					await Timers.setImmediate()
					if (logStreamAc.signal.aborted) return
				}
				const slice = steps.slice(i, i + SquadServerIngest.LOG_EVENTS_PER_SLICE)
				eventsSinceYield += slice.length
				await SquadServerIngest.collectEvents(ctx, ...slice)
			}
		}
	})({ ...ctx, server })

	cleanup.push(
		rcon.connected$
			.pipe(
				Instr.durableSub('onRconConnectStatusChange', { module }, async (connected, signal) => {
					const ctx = SquadServer.resolveCtx(CS.addSignal(SquadServer.getBaseCtx(), signal), serverId)
					const time = Date.now()
					let layerStatus: SM.LayerStatusRes | undefined
					let layersData: SM.LayersStatus | undefined
					if (connected) {
						Users.invalidatePendingSteamLinkCodes()
						layerStatus = await ctx.squadRcon.layersStatus.get({ ...ctx, rcon })
						if (layerStatus.code !== 'ok') return layerStatus
						layersData = layerStatus.data
					}
					await SquadServerIngest.collectEvents({ ...ctx, server }, () => {
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
				}),
			)
			.subscribe(),
	)

	// -------- process rcon events --------
	cleanup.push(
		squadRcon.rconEvent$
			.pipe(
				Instr.durableSub(
					'onRconEvent',
					{ module, taskScheduling: 'parallel', levels: { event: 'trace' } },
					async ([_ctx, event], signal) => {
						const ctx = CS.initDeferred(DB.addPooledDb(SquadServer.resolveCtx(CS.addSignal({ ..._ctx }, signal), serverId)))
						try {
							const opts: Promise<void>[] = []
							if (event.type === 'CHAT_MESSAGE') {
								ServerConsole.record(serverId, {
									type: 'command',
									player: event.playerIds.username ?? 'unknown',
									channel: event.channelType,
									message: event.message,
									time: event.time,
								})
								if (Settings.GLOBAL_SETTINGS.allowedPrefixes.some(({ prefix }) => event.message.startsWith(prefix))) {
									opts.push(
										Commands.handleCommand(ctx, event).then((res) => {
											if (res && res?.code !== 'ok') SquadServer.log.error(res)
										}),
									)
								} else if (CommandPrompts.capturesAnswer(serverId, SM.PlayerIds.getPlayerId(event.playerIds), event)) {
									// a number this player was just asked for outranks the same number as a vote: the prompt was
									// solicited from them seconds ago and clears itself either way (see command-prompts.server)
									opts.push(
										Commands.handleChoiceAnswer(ctx, event).then((res) => {
											if (res && res?.code !== 'ok') SquadServer.log.error(res)
										}),
									)
								} else if (event.message.trim().match(/^\d+$/) && ctx.vote.state?.code === 'in-progress') {
									opts.push(Vote.handleVote(ctx, event))
								}
							}
							await Promise.all(opts)
						} catch (err) {
							SquadServer.log.error(err)
						}

						await SquadServerIngest.collectEvents(ctx, () => {
							PendingEvents.onRconEvent(ctx.server.eventState, event)
						})

						// drain best-effort side work (e.g. vote-cast warns) scheduled by the handlers above, so it
						// finishes inside this task's lifetime and signal instead of leaking as a floating promise
						for (const err of await CS.awaitDeferred(ctx)) SquadServer.log.error(err)
					},
				),
			)
			.subscribe(),
	)

	cleanup.push(
		squadRcon.teams
			.observe({ ...managedServer, ...ctx })
			.pipe(
				Instr.durableSub('onTeamsPolled', { module, numTaskRetries: 0, levels: { event: 'debug' } }, async (teamsRes, signal) => {
					if (teamsRes.code !== 'ok') return teamsRes
					const receivedAt = Date.now()
					const ctx = SquadServer.resolveCtx(CS.addSignal(SquadServer.getBaseCtx(), signal), serverId)
					await SquadServerIngest.collectEvents(ctx, () => {
						PendingEvents.onTeamsPolled(
							server.eventState,
							{ players: teamsRes.players, squads: teamsRes.squads },
							receivedAt,
							teamsRes.polledAt,
						)
					})
				}),
			)
			.subscribe(),
	)

	cleanup.push(
		squadRcon.serverInfo
			.observe({ ...managedServer, ...ctx })
			.subscribe((res) => server.serverInfo$.next(res.code === 'ok' ? res.data : null)),
	)

	void LayerQueue.setupInstance({ ...ctx, ...managedServer })
	Teamswaps.setupInstance({ ...ctx, ...managedServer })
	// A sandbox's players are fabricated, so their eos ids belong to nobody. BattleMetrics is a real, org-wide
	// outbound service: looking them up would spam it with garbage and any flag or note written while looking at
	// the sandbox would land on the live org. It is left off entirely rather than stubbed.
	if (!Sandbox.isSandbox(settings.connections)) Battlemetrics.setupSquadServerInstance({ ...ctx, ...managedServer })
	PluginsSys.setupServerInstances(managedServer)

	server.cleanupId = CleanupSys.register(async () => {
		await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
	})
	SquadServer.log.info('Initialized server %s', serverId)
	// Not awaited. The warn needs the roster, and against an unreachable server the roster fetch retries for about
	// 15s, which the boot would otherwise spend holding this server's lifecycle lock and serving no requests.
	if (Settings.GLOBAL_SETTINGS.warnOnSlmStart) {
		const warnCtx = { ...ctx, ...managedServer }
		void (async () => {
			const restartedBy = AppEventsSys.restartInfo
				? await Users.resolveDisplayName(warnCtx, AppEventsSys.restartInfo.userId, 'someone')
				: undefined
			await SquadRcon.warnAllAdmins(warnCtx, SS_Msgs.slmStarted(restartedBy))
		})().catch((err) => {
			if (!Prom.isAbortError(err)) SquadServer.log.error(err, 'Server %s: warning admins that SLM started failed', serverId)
		})
	}
}

// Must be called with the server's lifecycle lock held (see withLifecycleLock) -- it is the unlocked primitive, and callers reach it
// through destroyIfRunningLocked. Taking the lock here instead would self-deadlock the callers that already hold it.
const destroyServer = Instr.spanOp('destroyServer', { module, levels: { event: 'info' } }, async (ctx: C.ManagedServer) => {
	if (ctx.server.destroyed) return
	SquadServer.log.info(`destroying managed server ${ctx.serverId}`)
	ctx.server.destroyed = true
	abortControllers.get(ctx.serverId)?.abort(new DOMException('managed server destroyed', 'AbortError'))
	abortControllers.delete(ctx.serverId)
	const cleanupId = ctx.server.cleanupId
	if (cleanupId !== null) CleanupSys.unregister(cleanupId)
	await Cleanup.runCleanup({ ...CS.init(), ...ctx, log: SquadServer.log }, ctx.cleanup)
	SquadServer.globalState.managedServers.delete(ctx.serverId)
	SquadServer.globalState.lifecycleUpdate$.next(ctx.serverId)
})

// registry data (identity/enabled/default/broken) lives in settings.server.ts; this only orchestrates the live managed server around it
export async function enableServer(serverId: string) {
	const ctx = SquadServer.getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, true)
	if (res.code !== 'ok') return res
	await ensureRunning(serverId)
	SquadServer.log.info('Server %s enabled', serverId)
	return { code: 'ok' as const }
}

export async function disableServer(serverId: string) {
	const ctx = SquadServer.getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, false)
	if (res.code !== 'ok') return res

	await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
	// the emulator deliberately outlives a managed server restart, but not the server being switched off
	Sandbox.disposeInstance(serverId)
	SquadServer.log.info('Server %s disabled', serverId)
	return { code: 'ok' as const }
}

export async function deleteServer(serverId: string) {
	const ctx = SquadServer.getBaseCtx()
	await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
	Sandbox.disposeInstance(serverId)
	return await Settings.deleteServerEntry(ctx, serverId)
}

const loadSavedEvents = Instr.spanOp('loadSavedEvents', { module }, async (ctx: SQS.Ctx & C.Db) => {
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
	server.emittedEvents = SE.fromEventRows(
		{ ...ctx, log: SquadServer.log },
		rowsRaw.map((r) => r.event),
	)

	const appEventRows = lastMatch
		? await ctx
				.db()
				.select()
				.from(Schema.appEvents)
				.where(E.eq(Schema.appEvents.matchId, lastMatch.id))
				.orderBy(E.asc(Schema.appEvents.time))
		: []
	// this buffer is the feed, so it has to hold what the live path would have pushed -- not every row the audit
	// log kept. Without the isFeedVisible filter an audit-only event (a queue-driven MAP_SET) reappears as its own
	// feed entry after a restart, duplicating the QUEUE_UPDATED it was folded into.
	server.emittedAppEvents = appEventRows
		.map((r) => AppEvents.fromRow(r))
		.filter((e): e is AppEvents.AppEvent => e !== null && AppEvents.isFeedVisible(e))
})

const onNewGameDuringSync =
	(serverId: string): PendingEvents.State['hooks']['onNewGameDuringSync'] =>
	async (currentLayerId, _time) => {
		const ctx = SquadServer.resolveCtx(SquadServer.getBaseCtx(), serverId)
		return Instr.spanOp(
			'onNewGameDuringSync',
			{
				module,
				// both, in the same order onNewGameDuringRoll takes them: the queue reconciliation below dispatches an
				// op, and taking updateLayerMtx after matchHistory.mtx in one place and before it in another deadlocks
				mutexes: () => [ctx.matchHistory.mtx, ctx.layerQueue.updateLayerMtx],
				levels: { event: 'info' },
			},
			async () => {
				const { currentMatch, pushedNewMatch } = await MatchHistory.syncWithCurrentLayer(ctx, currentLayerId)
				// We've just found the server on a layer we had no record of, so a roll happened while SLM wasn't
				// watching, and it consumed whatever SLM had set as next. The roll path shifts the queue when the head
				// is what started playing; this path never did, so a head that was already played stayed at the head
				// and went up as next a second time.
				//
				// Only once SLM has history for this server, though. On the first match it records there is no roll it
				// could have missed: the server is simply already running, and a head that happens to name the layer
				// it is running is a request to play that layer next, not evidence it has been played.
				//
				// Exact equality rather than compatibility: dropping someone's queued item is not recoverable, so a
				// head that merely could be what is playing stays put.
				if (pushedNewMatch && currentMatch.ordinal > 0) {
					const head = LayerQueue.getSavedQueue(ctx)[0]
					if (head?.layerId && L.layersEqual(head.layerId, currentLayerId)) {
						SquadServer.log.info('queue head %s is already playing; consuming it rather than queueing it again', head.layerId)
						await LayerQueue.dispatchOp(ctx, { op: 'shift-first-saved-layer', opId: SLL.createOpId() })
					}
				}
				return { match: currentMatch, isNewMatch: pushedNewMatch }
			},
		)()
	}

// Records the roll and returns once the match row, the queue shift and any generation are committed. The writes of
// the new queue head to the game server are round trips, and the roll is reached from inside event processing, so
// running them here would stall every server event and every match history reader for their duration. They run
// after the roll has released its locks, serialized behind updateLayerMtx like any other write. The rolling flag
// stays up until they have finished, as it marks the window in which the server's next layer is SLM's to set.
const onNewGameDuringRoll =
	(serverId: string): PendingEvents.State['hooks']['onNewGameDuringRoll'] =>
	async (newLayerId, time) => {
		const ctx = SquadServer.resolveCtx(SquadServer.getBaseCtx(), serverId)
		ctx.server.serverRolling$.next(Date.now())
		let serverSyncs: (() => Promise<void>)[] = []
		try {
			const res = await recordRoll(ctx, newLayerId, time)
			serverSyncs = res.serverSyncs
			return { match: res.match, nextLayerId: res.nextLayerId }
		} finally {
			if (serverSyncs.length === 0) ctx.server.serverRolling$.next(null)
			// outside the roll's mutex context, so each sync takes updateLayerMtx for itself
			else isolateCb(() => void runServerSyncsAfterRoll(ctx, serverSyncs))
		}
	}

async function runServerSyncsAfterRoll(ctx: SQS.Ctx, serverSyncs: (() => Promise<void>)[]) {
	try {
		for (const sync of serverSyncs) await sync()
	} catch (err) {
		if (!Prom.isAbortError(err)) SquadServer.log.error(err, 'syncing the next layer after a roll failed')
	} finally {
		ctx.server.serverRolling$.next(null)
	}
}

const recordRoll = Instr.spanOp(
	'onNewGameDuringRoll',
	{
		module,
		mutexes: (ctx) => [ctx.matchHistory.mtx, ctx.layerQueue.updateLayerMtx],
		levels: { event: 'info' },
	},
	async (ctx: C.ManagedServer & C.Db & CS.AbortSignal, newLayerId: L.LayerId, time: number) => {
		ctx.layerQueue.deferredServerSyncs = []
		try {
			const { match } = await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
				const nextLqItem = LayerQueue.getSavedQueue(ctx)[0]

				// A vote was running, so it picked this layer and the queue did not: SLM stood down when the vote
				// started and never set the head as next. Attributing the match to the head would also consume it
				// for a layer it had no part in choosing.
				const pickedByIngameVote = ctx.layerQueue.ingameVote$.getValue() !== null

				let currentMatchLqItem: LL.Item | undefined
				if (!pickedByIngameVote && nextLqItem && L.areLayersCompatible(nextLqItem.layerId, newLayerId)) {
					currentMatchLqItem = nextLqItem
				}
				// the new match must be recorded before the queue shift: emptying the queue triggers generation,
				// whose do-not-repeat lookback must see the layer that just started playing
				const { match } = await MatchHistory.addNewCurrentMatch(
					ctx,
					MH.getNewMatchHistoryEntry({
						layerId: newLayerId,
						serverId: ctx.serverId,
						startTime: new Date(time),
						lqItem: currentMatchLqItem,
						source: pickedByIngameVote ? { type: 'ingame-vote' } : undefined,
					}),
				)
				if (currentMatchLqItem) {
					await LayerQueue.dispatchOp(ctx, { op: 'shift-first-saved-layer', opId: SLL.createOpId() })
				}
				LayerQueue.schedulePostRollTasks(ctx, match.layerId)
				return { match }
			})
			// after the transaction, not inside it: emptying the queue defers generation to the transaction's
			// unlockTasks, which runTransaction awaits before resolving. Read any earlier and the queue is still empty.
			const nextLayerId = LL.getNextLayerId(LayerQueue.getSavedQueue(ctx))
			return { match, nextLayerId, serverSyncs: ctx.layerQueue.deferredServerSyncs }
		} finally {
			ctx.layerQueue.deferredServerSyncs = null
		}
	},
)
