import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as PerfHooks from 'node:perf_hooks'
import * as V8 from 'node:v8'

import * as Prom from '@/lib/promise-utils'
import * as ZodUtils from '@/lib/zod-utils'
import * as CS from '@/models/context-shared.models'
import type * as PendingEvents from '@/models/pending-events.models'
import * as SM from '@/models/squad.models'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import * as WorkerThreads from '@/server/worker-threads'
import * as Announcements from '@/systems/announcements.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as EventArchive from '@/systems/event-archive.server'
import * as LayerEngine from '@/systems/layer-engine.server'
import * as MatchLayers from '@/systems/match-layers.server'
import * as PluginsSys from '@/systems/plugins.server'
import * as SquadServer from '@/systems/squad-server.server'

/**
 * A unix socket for operating the running app from inside its own container, where there is no session to
 * authenticate and no browser to click. Deployment uses it to load a plugin it just copied in:
 *
 *   docker exec slm-app-prod pnpm plugins:reload --expect seed-roller
 *
 * A socket rather than a port or a signal: it answers, so a deploy can fail on a plugin that did not come
 * back up, which neither of the others can tell it. The file is 0600, so reaching it means being root in the
 * container or the user SLM itself runs as -- which is why the commands here take no identity and check none.
 *
 * Deployment also warns the app's users before restarting it:
 *
 *   docker exec slm-app-prod pnpm announce "SLM restarts in {countdown:2m} to update" --expires 5m
 *
 * One request per connection: a JSON line in, a JSON line back, close.
 */

const module = initModule('control-socket')
let log!: CS.Logger

type Request = { command: string; args?: Record<string, unknown> }
type Response = { code: string; [key: string]: unknown }

const envBuilder = Env.getEnvBuilder({ ...Env.groups.plugins })
const archiveEnvBuilder = Env.getEnvBuilder({ ...Env.groups.backups })

const DEFAULT_ANNOUNCEMENT_DURATION = '15m'
const MAX_ANNOUNCEMENT_DURATION_MS = 24 * 60 * 60 * 1000

let eventLoopDelay: PerfHooks.IntervalHistogram | null = null
let eventLoopUtilization = PerfHooks.performance.eventLoopUtilization()

const SYNC_ROSTER_TIMEOUT_MS = 15_000
const QUEUE_SETTLED_TIMEOUT_MS = 15_000

// Whether the pipeline is synced, has processed this poll, and holds its roster. The roster alone is not enough: it
// matches before a poll that only moved the tickets is processed, and mid-roll the pipeline keeps the pre-roll roster.
function rosterApplied(state: PendingEvents.State, teams: { players: SM.Player[]; polledAt: number }) {
	if (state.syncState.type !== 'synced') return false
	if (state.teamsPolledThrough === null || state.teamsPolledThrough < teams.polledAt) return false
	return teams.players.every((player) => {
		const id = SM.PlayerIds.getPlayerId(player.ids)
		if (player.teamId === null) return state.unassignedPlayers.has(id)
		const held = state.currTeams?.players.get(id)
		return held !== undefined && held.teamId === player.teamId && held.squadId === player.squadId
	})
}

async function queueSettled(ctx: NonNullable<ReturnType<typeof managedServerCtx>>) {
	// the pipeline publishes what a pass produced before it releases this lock
	using _lock = await Prom.acquireInBlock(ctx.server.processEventsMtx, { signal: ctx.signal })
	const queue = ctx.layerQueue.session.state
	return (
		// null until the first RCON_CONNECTED, whose pass reports the next layer the server already held
		ctx.server.eventState.isFirstConnection !== null &&
		ctx.layerQueue.mapSetsAwaitingSync === 0 &&
		!queue.requestingGeneratedQueueItem &&
		!queue.saving
	)
}

function managedServerCtx(serverId: string) {
	try {
		return SquadServer.resolveCtx(SquadServer.getBaseCtx(), serverId)
	} catch {
		return null
	}
}

async function handle(req: Request): Promise<Response> {
	switch (req.command) {
		case 'reload-plugins': {
			const ctx = DB.withDb({ ...CS.init(), log })
			await PluginsSys.reloadPackages(ctx)
			return {
				code: 'ok',
				plugins: PluginsSys.listRuntimeInfo().map((p) => ({ id: p.id, enabled: p.enabled, status: p.status, error: p.error })),
			}
		}
		// forces a compaction pass rather than waiting for the next scheduled one -- for after EVENT_ARCHIVE_WINDOW
		// is changed, or before taking a backup of a database that has just caught up on a long backlog
		case 'compact-events': {
			const ctx = DB.withDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
			const env = archiveEnvBuilder()
			const res = await EventArchive.compactAgedMatches(ctx, {
				window: env.EVENT_ARCHIVE_WINDOW,
				minHotMatches: env.EVENT_ARCHIVE_MIN_HOT_MATCHES,
			})
			return { code: 'ok', ...res }
		}
		// re-resolves matches whose layer the engine could not place. Normally driven by a layer artifact
		// changing; forced here for the pass that follows an out-of-band artifact swap
		case 'reconcile-layers': {
			const ctx = DB.withDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
			const res = await MatchLayers.reconcileMatchLayers(ctx)
			return { code: 'ok', ...(res ?? { skipped: 'already reconciled against this layer artifact' }) }
		}
		// warns web users and in-game admins, e.g. ahead of a restart
		case 'announce': {
			const message = typeof req.args?.message === 'string' ? req.args.message.trim() : ''
			if (!message) return { code: 'err:invalid-args', message: 'a message is required' }
			const expires = req.args?.expires ?? DEFAULT_ANNOUNCEMENT_DURATION
			const durationMs = typeof expires === 'string' ? ZodUtils.tryParseHumanTimeToken(expires) : undefined
			// setTimeout overflows past ~24.8 days
			if (!durationMs || durationMs > MAX_ANNOUNCEMENT_DURATION_MS) {
				return {
					code: 'err:invalid-args',
					message: `--expires must be a duration like 10m, up to 24h (got ${JSON.stringify(expires)})`,
				}
			}
			const ctx = DB.withDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
			const res = await Announcements.announce(ctx, message, durationMs)
			return { code: 'ok', expiresAt: res.announcement.expiresAt, warned: res.warned, failed: res.failed }
		}
		case 'clear-announcement':
			return { code: 'ok', cleared: Announcements.clear() }
		// fetches a server's player list now rather than at its next poll, and answers once the event pipeline holds every
		// player in it on the team and in the squad it reports. Players who left are not waited on: the pipeline drops
		// one only after several polls without them.
		case 'sync-roster': {
			const serverId = typeof req.args?.serverId === 'string' ? req.args.serverId : ''
			const ctx = managedServerCtx(serverId)
			if (!ctx) return { code: 'err:server-not-loaded', serverId }
			ctx.squadRcon.teams.invalidate(ctx)
			const teams = await ctx.squadRcon.teams.get(ctx)
			if (teams.code !== 'ok') return teams
			const deadline = Date.now() + SYNC_ROSTER_TIMEOUT_MS
			while (!rosterApplied(ctx.server.eventState, teams)) {
				if (Date.now() > deadline) return { code: 'err:timeout', message: 'the event pipeline did not take up the roster' }
				await Prom.sleep(50, ctx.signal)
			}
			return { code: 'ok', players: teams.players.length }
		}
		// answers once a server's queue has caught up with what its event pipeline has reported: the pipeline has taken
		// up its first rcon connection, every MAP_SET it published has been reconciled with the queue head, and no
		// generated layer or save is pending. Until then the queue can still change under an edit, as it does when the
		// app adopts the next layer the server held when the app connected. Rcon need not be up now.
		case 'queue-settled': {
			const serverId = typeof req.args?.serverId === 'string' ? req.args.serverId : ''
			const ctx = managedServerCtx(serverId)
			if (!ctx) return { code: 'err:server-not-loaded', serverId }
			const deadline = Date.now() + QUEUE_SETTLED_TIMEOUT_MS
			while (!(await queueSettled(ctx))) {
				if (Date.now() > deadline) return { code: 'err:timeout', message: 'the queue did not settle' }
				await Prom.sleep(50, ctx.signal)
			}
			return { code: 'ok' }
		}
		// how far a server's event pipeline has read its log, as the time of the newest log event it has taken up, and
		// whether its rcon is connected
		case 'ingest-status': {
			const serverId = typeof req.args?.serverId === 'string' ? req.args.serverId : ''
			const ctx = managedServerCtx(serverId)
			if (!ctx) return { code: 'err:server-not-loaded', serverId }
			return {
				code: 'ok',
				lastLogEventTime: ctx.server.eventState.lastKnownLogEventTime,
				rconConnected: ctx.rcon.connected,
				syncState: ctx.server.eventState.syncState.type,
				rolling: ctx.server.serverRolling$.value !== null,
				nextLayerSyncState: ctx.layerQueue.nextLayerSyncState$.value.code,
				updatesDisabled: ctx.serverSettings.settings.updatesToSquadServerDisabled ?? null,
			}
		}
		// process figures for the load harness (src/load), covering the time since the previous call. The first call
		// starts the event loop delay histogram and so reports none.
		case 'runtime-stats': {
			if (!eventLoopDelay) {
				// 1ms resolution, as the load harness judges the p99 in milliseconds
				eventLoopDelay = PerfHooks.monitorEventLoopDelay({ resolution: 1 })
				eventLoopDelay.enable()
			}
			const delay = eventLoopDelay
			const serverIds = Array.isArray(req.args?.serverIds)
				? (req.args.serverIds as unknown[]).filter((id) => typeof id === 'string')
				: []
			const nsToMs = (v: number) => (Number.isFinite(v) ? v / 1e6 : null)
			const elu = PerfHooks.performance.eventLoopUtilization(eventLoopUtilization)
			eventLoopUtilization = PerfHooks.performance.eventLoopUtilization()
			const res = {
				code: 'ok',
				eventLoopDelayMs: {
					p50: nsToMs(delay.percentile(50)),
					p99: nsToMs(delay.percentile(99)),
					max: nsToMs(delay.max),
					count: delay.count,
				},
				eventLoopUtilization: elu.utilization,
				memory: process.memoryUsage(),
				// microseconds since boot, across every thread
				cpuUsage: process.cpuUsage(),
				servers: serverIds.map((serverId) => {
					const ctx = managedServerCtx(serverId)
					return {
						serverId,
						lastLogEventTime: ctx?.server.eventState.lastKnownLogEventTime ?? null,
						rconConnected: ctx?.rcon.connected ?? false,
					}
				}),
			}
			delay.reset()
			return res
		}
		// what the process holds, by owner, for the load harness's memory breakdown. RSS that none of these cover is native
		// allocation: sqlite's page caches, libuv, and the allocators' own overhead.
		case 'memory-breakdown': {
			const conn = DB.withDb(CS.init()).db.driver
			const pragma = (name: string) => conn.pragma(name, { simple: true }) as number
			return {
				code: 'ok',
				memory: process.memoryUsage(),
				heap: V8.getHeapStatistics(),
				heapSpaces: V8.getHeapSpaceStatistics(),
				workers: await WorkerThreads.heapStatistics(),
				layerEngineBytes: LayerEngine.peekEngine()?.memoryBytes ?? null,
				// cache_size is in pages when positive and in KiB when negative
				sqlite: { cacheSize: pragma('cache_size'), pageSize: pragma('page_size'), mmapSize: pragma('mmap_size') },
			}
		}
		// Writes a snapshot of the main thread's heap to the system temp directory and answers with its path. The heap is
		// frozen while it is written, for seconds on a large one, so this is for a load run and never production.
		case 'heap-snapshot': {
			const file = path.join(os.tmpdir(), `slm-${process.pid}-${Date.now()}.heapsnapshot`)
			return { code: 'ok', path: V8.writeHeapSnapshot(file) }
		}
		default:
			return { code: 'err:unknown-command', command: req.command }
	}
}

export async function setup() {
	log = module.getLogger()
	const socketPath = envBuilder().CONTROL_SOCKET
	if (!socketPath) return

	// a socket file outlives an unclean exit, and binding over it fails with EADDRINUSE
	await fs.promises.mkdir(path.dirname(socketPath), { recursive: true })
	await fs.promises.rm(socketPath, { force: true })

	const server = net.createServer((socket) => {
		socket.setEncoding('utf8')
		let buffer = ''
		socket.on('data', (chunk: string) => {
			buffer += chunk
			const newline = buffer.indexOf('\n')
			if (newline === -1) return
			const line = buffer.slice(0, newline)
			buffer = ''
			void (async () => {
				let res: Response
				try {
					res = await handle(JSON.parse(line) as Request)
				} catch (err) {
					log.error(err, 'control command failed')
					res = { code: 'err:failed', message: err instanceof Error ? err.message : String(err) }
				}
				socket.end(JSON.stringify(res) + '\n')
			})()
		})
		socket.on('error', (err) => log.warn(err, 'control socket connection failed'))
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(socketPath, () => resolve())
	})
	// after listen: the path does not exist to chmod before it
	await fs.promises.chmod(socketPath, 0o600)
	CleanupSys.register(async () => {
		server.close()
		await fs.promises.rm(socketPath, { force: true })
	})
	log.info('control socket listening on %s', socketPath)
}
