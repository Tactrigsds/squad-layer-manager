import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as Paths from '$root/paths'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { createBrowserFleet } from './browser'
import { createIngameActor } from './ingame'
import { Recorder, rng, sleep } from './metrics'
import { Profiler, summarizeMemory } from './profiler'
import { ADMIN_PLAYER, fixtureOptions, SCENARIOS, viewerUsers } from './scenario'
import { createSyntheticFleet } from './synthetic'
import { createTarget, freePort, IMAGE_TAG, TARGET_KINDS, type TargetKind } from './target'

// Drives the production build under a realistic mix of in-game and dashboard load, and writes everything a
// performance question needs answering with: a cpu profile, a sampling heap profile, heap snapshots, an
// rss/event-loop timeseries, the server's own log, and the latency of every action the actors took.
//
// `pnpm load --help` lists the flags. Nothing here is a test: it asserts nothing and fails only if the app
// does, because what it produces is evidence to read rather than a pass or a fail.

const args = parseArgs({
	options: {
		scenario: { type: 'string', default: 'busy-server' },
		target: { type: 'string', default: 'bundle' },
		// overrides for a scenario's own numbers, for narrowing in on something
		duration: { type: 'string' },
		players: { type: 'string' },
		browsers: { type: 'string' },
		synthetic: { type: 'string' },
		out: { type: 'string' },
		seed: { type: 'string', default: '1' },
		headed: { type: 'boolean', default: false },
		'profile-browsers': { type: 'boolean', default: false },
		'skip-build': { type: 'boolean', default: false },
		// export telemetry to the collector from docker-compose.yaml, as a deployment does. Off by default
		// because it needs that stack up, and on it is itself a load worth knowing about.
		otel: { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
	allowPositionals: false,
})

if (args.values.help) {
	console.log(usage())
	process.exit(0)
}

const scenario = { ...SCENARIOS[args.values.scenario ?? ''] }
if (!scenario.name) {
	console.error(`unknown scenario '${args.values.scenario}'. try one of: ${Object.keys(SCENARIOS).join(', ')}`)
	process.exit(2)
}
const targetKind = args.values.target as TargetKind
if (!TARGET_KINDS.includes(targetKind)) {
	console.error(`unknown target '${args.values.target}'. try one of: ${TARGET_KINDS.join(', ')}`)
	process.exit(2)
}

if (args.values.duration) scenario.durationMs = parseDuration(args.values.duration)
if (args.values.players) scenario.players = Number(args.values.players)
if (args.values.browsers) scenario.browsers = Number(args.values.browsers)
if (args.values.synthetic) scenario.synthetic = Number(args.values.synthetic)

const startedAt = new Date()
const outDir = args.values.out ?? path.join(Paths.PROJECT_ROOT, 'test-results/load', `${scenario.name}-${targetKind}-${stamp(startedAt)}`)
fs.mkdirSync(outDir, { recursive: true })

const recorder = new Recorder()
const dice = rng(Number(args.values.seed))
const inspectPort = await freePort()
const target = createTarget(targetKind, {
	repoRoot: Paths.PROJECT_ROOT,
	inspectPort,
	skipBuild: args.values['skip-build'],
})

const viewers = viewerUsers(scenario.synthetic + scenario.browsers)
// The in-game admin has to be known before the app boots, because Admins.cfg is read once and cached for an
// hour. Derived from the name, so this is decidable here.
const { steamIdForName } = await import('../../src/emulator/world')
const adminSteamId = steamIdForName(ADMIN_PLAYER)

console.log(`load: ${scenario.name} against the ${target.describe}`)
console.log(`  ${scenario.description}`)
console.log(
	`  ${scenario.players} players, ${scenario.browsers} browsers, ${scenario.synthetic} synthetic clients, ` +
		`${fmtDuration(scenario.warmupMs)} warmup + ${fmtDuration(scenario.durationMs)} measured`,
)
console.log(`  artifacts -> ${outDir}\n`)

const app: AppFixture = await createAppFixture({
	...fixtureOptions(scenario, viewers, adminSteamId),
	label: `load:${scenario.name}`,
	launch: target.launch ?? undefined,
	otel: args.values.otel ? {} : undefined,
	env: { ...target.env, ...(args.values.otel ? { OTEL_ENABLED: 'true' } : {}) },
})

const controller = new AbortController()
const profiler = new Profiler({
	inspectUrl: target.inspectUrl,
	outDir,
	rewriteUrlPrefix: target.rewriteUrlPrefix,
})

const ingame = createIngameActor({
	app,
	recorder,
	rng: dice,
	signal: controller.signal,
	players: scenario.players,
	adminName: ADMIN_PLAYER,
	actionIntervalMs: scenario.ingameActionIntervalMs,
	rollIntervalMs: scenario.rollIntervalMs,
})
const synthetic = createSyntheticFleet({
	app,
	recorder,
	rng: dice,
	signal: controller.signal,
	users: viewers.slice(scenario.browsers),
	pollIntervalMs: scenario.syntheticPollIntervalMs,
})
const browsers = createBrowserFleet({
	app,
	recorder,
	rng: dice,
	signal: controller.signal,
	users: viewers.slice(0, scenario.browsers),
	journeyIntervalMs: scenario.browserJourneyIntervalMs,
	headless: !args.values.headed,
	profile: args.values['profile-browsers'],
	outDir,
})

// Tearing down a fleet of live subscriptions is inherently noisy: oRPC rejects whatever each socket was
// carrying, and nothing is awaiting those promises by then (see the note in test/harness/orpc-client.ts).
// Recording them beats the default, which is to kill the runner in the middle of writing its artifacts.
process.on('unhandledRejection', (reason) => {
	recorder.fail('unhandled-rejection', reason)
})

let interrupted = false
process.on('SIGINT', () => {
	if (interrupted) process.exit(130)
	interrupted = true
	console.log('\ninterrupted -- stopping the load and writing what has been collected so far')
	controller.abort()
})

const artifacts: string[] = []
try {
	step('populating the server')
	await ingame.populate()
	await app.waitForRosterSync({ timeoutMs: 60_000 })

	step('connecting clients')
	await synthetic.connect()
	await browsers.open()

	// The actors run for warmup + duration; only the profile is delayed. Starting them after the profile would
	// put the whole ramp -- first render, first subscription of every stream, the layer artifact load -- into
	// the profile, and that is boot cost rather than the steady state being looked for.
	const load = Promise.all([ingame.run(), synthetic.run(), browsers.run()])

	step(`warming up for ${fmtDuration(scenario.warmupMs)}`)
	await sleep(scenario.warmupMs, controller.signal)

	step('starting the profile')
	await profiler.connect()
	// the opening snapshot before the samplers, so the rss baseline is taken on the far side of the ratchet
	// taking one causes (see Profiler.start)
	artifacts.push(await profiler.takeHeapSnapshot('heap-start'))
	await profiler.start()

	// Snapshots beyond the two boundaries are spread through the run: what is retained halfway is what
	// separates a leak from a cache that fills and stops.
	const midpoints = Math.max(0, scenario.heapSnapshots - 2)
	const slice = scenario.durationMs / (midpoints + 1)
	for (let i = 0; i < midpoints && !controller.signal.aborted; i++) {
		await sleep(slice, controller.signal)
		step(`heap snapshot ${i + 1} of ${midpoints}`)
		artifacts.push(await profiler.takeHeapSnapshot(`heap-mid-${i + 1}`))
	}
	step(`under load for ${fmtDuration(slice)}`)
	await sleep(slice, controller.signal)

	step('stopping the load')
	controller.abort()
	await load

	step('collecting profiles')
	artifacts.push(await profiler.takeHeapSnapshot('heap-end'))
	artifacts.push(...(await profiler.stop()))
	profiler.close()
	await browsers.close()
	artifacts.push(...browsers.artifacts)
} catch (err) {
	// Printed here rather than left to the runtime: the finally below writes the artifacts, and an exception
	// escaping past it would be reported as whatever teardown tripped over next instead of what actually failed.
	console.error('\nthe load run failed:', err)
	recorder.fail('run', err)
} finally {
	controller.abort()
	// before dispose: the fixture's temp directory, and the app log in it, is deleted with the fixture
	artifacts.push(copyServerLog(app, outDir))
	await app.dispose().catch(() => {})
	// after dispose, never before: the app going down is what takes these connections with it
	synthetic.close()
	artifacts.push(writeSummary())
}

console.log(`\nwrote ${artifacts.length} artifacts to ${outDir}`)
process.exit(0)

function step(message: string) {
	console.log(`[${fmtDuration(Date.now() - startedAt.getTime())}] ${message}`)
}

function copyServerLog(fixture: AppFixture, dir: string): string {
	const dest = path.join(dir, 'server.log')
	fs.copyFileSync(fixture.logFile, dest)
	return dest
}

function writeSummary(): string {
	// every sample is already inside the measured window: the profiler is not started until the warmup is over
	const memory = summarizeMemory(profiler.samples)
	const actions = recorder.summary()
	const summary = {
		scenario,
		target: { kind: targetKind, describe: target.describe, image: targetKind === 'docker' ? IMAGE_TAG : undefined },
		startedAt: startedAt.toISOString(),
		seed: Number(args.values.seed),
		syntheticStreamMessages: synthetic.messagesReceived(),
		memory,
		actions,
		failures: recorder.failures,
	}
	fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, '\t') + '\n')

	const lines = [
		`# load: ${scenario.name} (${target.describe})`,
		'',
		`${scenario.description}`,
		'',
		`- started ${startedAt.toISOString()}, seed ${args.values.seed}`,
		`- ${scenario.players} players, ${scenario.browsers} browsers, ${scenario.synthetic} synthetic clients`,
		`- ${synthetic.messagesReceived()} stream messages delivered to the synthetic fleet`,
		'',
		'## memory',
		'',
		memory
			? [
					`| | start | end | peak |`,
					`| --- | --- | --- | --- |`,
					`| rss (mb) | ${memory.rssStartMb} | ${memory.rssEndMb} | ${memory.rssPeakMb} |`,
					`| heap used (mb) | ${memory.heapUsedStartMb} | ${memory.heapUsedEndMb} | ${memory.heapUsedPeakMb} |`,
					'',
					`heap grew ${memory.heapGrowthMb}mb over the measured window. ` +
						`event loop delay peaked at p99 ${memory.eventLoopP99MaxMs}ms, max ${memory.eventLoopMaxMs}ms. ` +
						`active handles ${memory.activeHandlesStart} -> ${memory.activeHandlesEnd}.`,
				].join('\n')
			: '(no samples collected)',
		'',
		'## actions',
		'',
		'| action | count | errors | p50 | p95 | p99 | max |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		...actions.map((a) => `| ${a.action} | ${a.count} | ${a.errors} | ${a.p50Ms} | ${a.p95Ms} | ${a.p99Ms} | ${a.maxMs} |`),
	]
	if (recorder.failures.length > 0) {
		lines.push('', '## failures', '', ...recorder.failures.slice(0, 20).map((f) => `- \`${f.action}\`: ${f.message}`))
	}
	const file = path.join(outDir, 'summary.md')
	fs.writeFileSync(file, lines.join('\n') + '\n')
	console.log('\n' + lines.join('\n'))
	return file
}

function parseDuration(value: string): number {
	const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
	if (!match) throw new Error(`could not read '${value}' as a duration -- try 30s, 5m, 1h`)
	const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 'm']!
	return Number(match[1]) * scale
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`
	return `${(ms / 60_000).toFixed(1)}m`
}

function stamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function usage(): string {
	return [
		'pnpm load [options]',
		'',
		'  --scenario <name>    ' + Object.keys(SCENARIOS).join(', ') + ' (default busy-server)',
		'  --target <kind>      ' + TARGET_KINDS.join(' | ') + ' (default bundle)',
		"  --duration <30s|5m>  override the scenario's measured window",
		'  --players <n>        override the in-game roster size',
		'  --browsers <n>       override the number of real browsers',
		'  --synthetic <n>      override the number of websocket-only clients',
		'  --seed <n>           the action mix is seeded, so runs are comparable (default 1)',
		'  --out <dir>          where artifacts go (default test-results/load/<scenario>-<target>-<time>)',
		'  --headed             show the browsers',
		'  --profile-browsers   also capture a cpu profile per browser page',
		'  --skip-build         with --target docker, run the existing image rather than rebuilding',
		'  --otel               export telemetry to the collector, as a deployment does',
		'',
		'the bundle target needs `pnpm run build:prod` first; the docker target builds its own image.',
	].join('\n')
}
