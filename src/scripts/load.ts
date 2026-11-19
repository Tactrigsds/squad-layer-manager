import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as ZodUtils from '@/lib/zod-utils'
import * as Env from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'

import * as Instance from '../load/instance.ts'
import * as Profile from '../load/profile.ts'
import * as LoadRun from '../load/run.ts'

// Drives SLM with synthetic load and reports what it cost. docs/developers/load-testing.md describes the scenarios
// and how to read a report.
//
//   pnpm load --servers 3 --viewers 20 --duration 10m
//   pnpm load --servers 3 --viewers 20 --sweep-cpus 2,1.5,1,0.75,0.5 --memory 1024

// for this process, which reads the layer artifacts the way the test harness does. The app it spawns runs in production.
process.env.NODE_ENV ??= 'test'
Env.ensureEnvSetup()
// Seed.setup logs through a module logger
ensureLoggerSetup()

const args = parseArgs({
	options: {
		servers: { type: 'string', default: '1' },
		players: { type: 'string', default: '100' },
		viewers: { type: 'string', default: '4' },
		editors: { type: 'string', default: '1' },
		historians: { type: 'string', default: '1' },
		duration: { type: 'string', default: '10m' },
		warmup: { type: 'string', default: '1m' },
		intensity: { type: 'string', default: '1' },
		'chat-per-min': { type: 'string', default: String(Profile.DEFAULT_CHAT_PER_MINUTE) },
		'match-length': { type: 'string', default: '60m' },
		pool: { type: 'string', default: '1500' },
		cpus: { type: 'string' },
		memory: { type: 'string' },
		'sweep-cpus': { type: 'string' },
		'sweep-memory': { type: 'string' },
		db: { type: 'string' },
		dir: { type: 'string' },
		out: { type: 'string' },
		otel: { type: 'string' },
		'sample-interval': { type: 'string', default: '5s' },
		'heap-snapshot': { type: 'boolean', default: false },
		// KEY=VALUE, repeatable: set in the app's environment
		'app-env': { type: 'string', multiple: true, default: [] },
		'no-build': { type: 'boolean', default: false },
	},
	allowPositionals: false,
})
const v = args.values

function duration(name: string, value: string) {
	const ms = ZodUtils.tryParseHumanTimeToken(value)
	if (!ms) throw new Error(`--${name} must be a duration like 30s or 10m (got ${value})`)
	return ms
}
const num = (value: string | undefined) => (value === undefined ? undefined : Number(value))
const list = (value: string | undefined) => (value ? value.split(',').map(Number) : null)

function build(script: string, env?: Record<string, string>) {
	const res = childProcess.spawnSync('pnpm', ['run', script], { stdio: 'inherit', env: { ...process.env, ...env } })
	if (res.status !== 0) process.exit(res.status ?? 1)
}
if (!v['no-build'] || !fs.existsSync(Instance.SERVER_ENTRY)) {
	build('build:engine')
	build('build:server')
}
// A production server refuses to boot without the client bundle, and serves its precompressed assets as production
// does. The bundle's age does not matter here.
if (!fs.existsSync(Instance.CLIENT_INDEX) || !fs.existsSync(Instance.LANDING_CSS)) {
	build('build:client', { NODE_ENV: 'production' })
	build('build:landing-css')
	build('precompress:dist')
}

const baseDir = v.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'slm-load-'))
const sweepCpus = list(v['sweep-cpus'])
const sweepMemory = list(v['sweep-memory'])
if (sweepCpus && sweepMemory) throw new Error('sweep one limit at a time')
const steps: Instance.Limits[] = sweepCpus
	? sweepCpus.map((cpus) => ({ cpus, memoryMb: num(v.memory) }))
	: sweepMemory
		? sweepMemory.map((memoryMb) => ({ cpus: num(v.cpus), memoryMb }))
		: [{ cpus: num(v.cpus), memoryMb: num(v.memory) }]

// every step boots on the same database, so a step does not inherit the history the one before it wrote
let db = v.db
if (steps.length > 1 && !db) {
	console.error('a sweep needs --db, so each step starts from the same history')
	process.exit(1)
}
if (db) db = path.resolve(db)

const reports = []
for (const [i, limits] of steps.entries()) {
	const dir = path.join(baseDir, `step-${i + 1}`)
	const report = await LoadRun.run({
		dir,
		servers: Number(v.servers),
		players: Number(v.players),
		viewers: Number(v.viewers),
		editors: Number(v.editors),
		historians: Number(v.historians),
		durationMs: duration('duration', v.duration),
		warmupMs: duration('warmup', v.warmup),
		intensity: Number(v.intensity),
		chatPerMinute: Number(v['chat-per-min']),
		matchDurationMs: duration('match-length', v['match-length']),
		populationPool: Number(v.pool),
		limits,
		db,
		otelEndpoint: v.otel,
		appEnv: Object.fromEntries(
			v['app-env'].map((kv) => {
				const eq = kv.indexOf('=')
				if (eq <= 0) throw new Error(`--app-env takes KEY=VALUE (got ${kv})`)
				return [kv.slice(0, eq), kv.slice(eq + 1)]
			}),
		),
		sampleIntervalMs: duration('sample-interval', v['sample-interval']),
		heapSnapshot: v['heap-snapshot'],
		log: (line) => console.log(`[step ${i + 1}/${steps.length}] ${line}`),
	})
	reports.push(report)
	const r = report.resources
	console.log(
		`[step ${i + 1}/${steps.length}] ${JSON.stringify(limits)}: cpu p50 ${r.cpuCores.p50} p95 ${r.cpuCores.p95}, rss p95 ${r.rssMb.p95}MB, ` +
			`event loop p99 (p95 of samples) ${r.eventLoopDelayP99Ms.p95}ms, ingest lag p95 ${r.ingestLagMs.p95}ms -> ` +
			(report.verdict.degraded ? `DEGRADED: ${report.verdict.reasons.join('; ')}` : 'ok'),
	)
	// below the knee every further step only degrades more
	if (steps.length > 1 && report.verdict.degraded) break
}

const out = v.out ?? path.join(baseDir, 'report.json')
LoadRun.writeReport(out, steps.length > 1 ? { sweep: reports } : reports[0])
console.log(`report: ${out}`)
process.exit(0)
