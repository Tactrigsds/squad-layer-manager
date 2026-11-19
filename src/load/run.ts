import * as fs from 'node:fs'
import * as path from 'node:path'

import { makePlayer } from '../emulator'
import * as Clients from './clients'
import * as Instance from './instance'
import * as Memory from './memory'
import { Sampler } from './sampler'
import { Recorder } from './stats'
import { poolPlayerName, WorldDriver } from './world-driver'

// One load run against one set of limits: boot, fill the servers, open the clients, sample until the duration is up
// or the app dies, and report.

export type RunOptions = {
	dir: string
	servers: number
	players: number
	viewers: number
	editors: number
	historians: number
	durationMs: number
	warmupMs: number
	intensity: number
	chatPerMinute: number
	matchDurationMs: number
	populationPool: number
	limits: Instance.Limits
	db?: string
	otelEndpoint?: string
	appEnv: Record<string, string>
	sampleIntervalMs: number
	// summarize a heap snapshot of the main thread at the end of the run. Writing one freezes the app for seconds and
	// can double its heap, so it is taken last.
	heapSnapshot: boolean
	log: (line: string) => void
}

// Degradation thresholds a step down in limits is judged against. The event loop figure is the one users feel
// first, as every rpc and stream waits on it; ingest lag past a few seconds delays the feed and in-game commands.
export const THRESHOLDS = { eventLoopDelayP99Ms: 100, ingestLagP95Ms: 5_000, rpcP95Ms: 1_000 }

const ADMINS_PER_SERVER = 8

export async function run(opts: RunOptions) {
	const roles: Clients.Role[] = [
		...Array<Clients.Role>(opts.editors).fill('editor'),
		...Array<Clients.Role>(opts.historians).fill('historian'),
		...Array<Clients.Role>(opts.viewers).fill('viewer'),
	]
	const users = roles.map((_, i) => ({ discordId: 900000000000100000n + BigInt(i), username: `load-user-${i}` }))
	const serverIds = Array.from({ length: opts.servers }, (_, i) => Instance.serverIdAt(i))

	opts.log(`booting ${opts.servers} server(s), ${users.length} client(s), limits ${JSON.stringify(opts.limits)}`)
	const inst = await Instance.start({
		dir: opts.dir,
		servers: opts.servers,
		users,
		adminSteamIds: (i) =>
			Array.from({ length: ADMINS_PER_SERVER }, (_, j) => makePlayer({ name: poolPlayerName(serverIds[i], j) }, serverIds[i]).steam),
		limits: opts.limits,
		db: opts.db,
		otelEndpoint: opts.otelEndpoint,
		appEnv: opts.appEnv,
	})

	let died: { code: number | null; signal: NodeJS.Signals | null } | null = null
	void inst.exited.then((e) => (died = e))

	const recorder = new Recorder()
	const drivers = inst.emulators.map(
		(emu, i) =>
			new WorldDriver(emu, {
				players: opts.players,
				intensity: opts.intensity,
				populationPool: opts.populationPool,
				matchDurationMs: opts.matchDurationMs,
				chatPerMinute: opts.chatPerMinute,
				salt: serverIds[i],
			}),
	)
	const clients = roles.map(
		(role, i) =>
			new Clients.LoadClient({ appUrl: inst.appUrl, user: users[i], role, serverId: serverIds[i % serverIds.length], recorder }),
	)
	const sampler = new Sampler(inst)

	try {
		await waitForServers(inst)
		for (const d of drivers) d.start()
		await sampler.start(opts.sampleIntervalMs)
		// opened a few at a time, as tabs are, rather than in one burst
		for (const c of clients) {
			await c.open().catch((err) => {
				recorder.error('client:open')
				opts.log(`client ${c.user.username} failed to open: ${err instanceof Error ? err.message : String(err)}`)
			})
		}
		const startedAt = Date.now()
		const until = startedAt + opts.durationMs
		let atWarmup: Memory.Breakdown | null = null
		while (Date.now() < until && !died) {
			if (!atWarmup && Date.now() >= startedAt + opts.warmupMs) atWarmup = await Memory.breakdown(inst).catch(() => null)
			await new Promise((r) => setTimeout(r, 5_000))
			const last = sampler.samples.at(-1)
			if (last) {
				opts.log(
					`t+${Math.round((Date.now() - startedAt) / 1000)}s cpu ${last.cpuCores.toFixed(2)} rss ${last.rssMb.toFixed(0)}MB ` +
						`elp99 ${last.eventLoopDelayP99Ms?.toFixed(1) ?? '-'}ms lag ${last.ingestLagMs.map((l) => (l === null ? '-' : `${(l / 1000).toFixed(1)}s`)).join('/')}`,
				)
			}
		}
		const atEnd = died ? null : await Memory.breakdown(inst).catch(() => null)
		if (atEnd) opts.log(`memory at end:\n${formatBreakdown(atEnd)}`)
		const heap = !died && opts.heapSnapshot ? await heapSummary(inst, opts.log) : null
		const report = {
			options: { ...opts, log: undefined },
			startedAt: new Date(startedAt).toISOString(),
			endedEarly: died,
			resources: sampler.summary(startedAt + opts.warmupMs),
			peaks: sampler.summary(startedAt),
			latencies: recorder.summary(),
			streamMessages: clients.reduce((n, c) => n + c.streamMessages, 0),
			emitted: drivers.map((d) => Object.fromEntries(d.counts)),
			dbBytes: dbSize(inst.dbPath),
			memory: { atWarmup, atEnd, heap },
		}
		return { ...report, verdict: judge(report) }
	} finally {
		for (const c of clients) c.close()
		for (const d of drivers) d.stop()
		sampler.stop()
		await inst.dispose()
	}
}

async function heapSummary(inst: Instance.Instance, log: (line: string) => void) {
	const res = await inst.control('heap-snapshot')
	if (res.code !== 'ok' || typeof res.path !== 'string') return null
	try {
		const summary = Memory.summarizeHeapSnapshot(res.path)
		log(
			`main heap by constructor (${summary.totalMb}MB):\n${summary.top.map((e) => `  ${e.mb.toString().padStart(8)}MB  ${e.count.toString().padStart(9)}  ${e.name}`).join('\n')}`,
		)
		return summary
	} finally {
		fs.rmSync(res.path, { force: true })
	}
}

export function formatBreakdown(b: Memory.Breakdown) {
	const row = (label: string, value: number) => `  ${label.padEnd(28)}${value.toFixed(1).padStart(9)}MB`
	return [
		row('rss', b.rssMb),
		row(' anonymous', b.anonymousMb),
		...Object.entries(b.owners).map(([k, v]) => row(`   ${k}`, v)),
		row(' file-backed', b.fileBackedMb),
		...Object.entries(b.mappings)
			.filter(([k]) => k !== 'anonymous' && k !== 'malloc heap')
			.map(([k, v]) => row(`   ${k}`, v.rssMb - v.anonymousMb)),
		...b.workers.map((w) => row(`worker ${w.name} heap`, w.heapMb)),
	].join('\n')
}

async function waitForServers(inst: Instance.Instance) {
	for (const serverId of inst.serverIds) {
		const deadline = Date.now() + 120_000
		while ((await inst.control('ingest-status', { serverId }).catch((): Record<string, unknown> => ({}))).rconConnected !== true) {
			if (Date.now() > deadline) throw new Error(`${serverId} never connected; see ${inst.logFile}`)
			await new Promise((r) => setTimeout(r, 500))
		}
	}
}

function dbSize(dbPath: string) {
	return ['', '-wal'].reduce((n, s) => n + (fs.existsSync(dbPath + s) ? fs.statSync(dbPath + s).size : 0), 0)
}

type Report = {
	endedEarly: { code: number | null; signal: NodeJS.Signals | null } | null
	resources: ReturnType<Sampler['summary']>
	latencies: ReturnType<Recorder['summary']>
}

export function judge(report: Report) {
	const reasons: string[] = []
	if (report.endedEarly) reasons.push(`the app exited (${JSON.stringify(report.endedEarly)})`)
	if (report.resources.oomKills > 0) reasons.push(`${report.resources.oomKills} oom kill(s)`)
	const elp99 = report.resources.eventLoopDelayP99Ms.p95
	if (elp99 !== null && elp99 > THRESHOLDS.eventLoopDelayP99Ms) reasons.push(`event loop delay p99 reached ${elp99}ms`)
	const lag = report.resources.ingestLagMs.p95
	if (lag !== null && lag > THRESHOLDS.ingestLagP95Ms) reasons.push(`ingest lag p95 ${lag}ms`)
	for (const [name, s] of Object.entries(report.latencies)) {
		if (name.startsWith('first:') || name === 'http:layer-data') continue
		if (s.p95 !== null && s.p95 > THRESHOLDS.rpcP95Ms) reasons.push(`${name} p95 ${s.p95}ms`)
	}
	return { degraded: reasons.length > 0, reasons }
}

export function writeReport(file: string, report: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(
		file,
		JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
	)
}
