import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

import { assertNever } from '@/lib/type-guards'

import type { AppLauncher, AppLaunchSpec } from '../harness/app-fixture'

// The two ways to run the app under load, both of them the production build.
//
// `bundle` spawns dist-server/main-instrumented.js exactly as `pnpm server:prod` does. It is the artifact the
// image ships, so the code being profiled is the deployed code, and it costs a rebuild rather than an image
// build to iterate on.
//
// `docker` runs the image's `runtime` stage, which adds what the container does to the process and nothing
// else: jemalloc via LD_PRELOAD, the memory ceiling, and node's own heap limit. Those change the shape of a
// memory profile enough that a leak hunt is worth running here (see the Dockerfile's note on RSS ratcheting
// under glibc).

export const TARGET_KINDS = ['bundle', 'docker'] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

export type Target = {
	kind: TargetKind
	// merged into the fixture's environment
	env: Record<string, string>
	// null for `bundle`, which uses the fixture's own child-process launcher
	launch: AppLauncher | null
	inspectUrl: string
	// how to map the profile's frame urls back onto this machine's checkout
	rewriteUrlPrefix?: { from: string; to: string }
	describe: string
}

export const IMAGE_TAG = 'slm-load:latest'
// what the Dockerfile's WORKDIR makes every path in a frame url relative to
const CONTAINER_APP_DIR = '/app'

export type TargetOptions = {
	repoRoot: string
	inspectPort: number
	// what docker-compose.yaml gives the deployed app, replicated so the profile sees production's gc pressure
	maxOldSpaceMb?: number
	memoryLimit?: string
	// skip `docker build` and use whatever IMAGE_TAG already points at
	skipBuild?: boolean
}

export function createTarget(kind: TargetKind, opts: TargetOptions): Target {
	switch (kind) {
		case 'bundle':
			return bundleTarget(opts)
		case 'docker':
			return dockerTarget(opts)
		default:
			return assertNever(kind)
	}
}

// NODE_ENV stays `test` rather than `production`. They are the same server: fastify serves the built client
// identically for both by design (see the switch in fastify.server.ts), and the remaining difference is one
// client-side flag. `production` is not reachable anyway, because it refuses to boot alongside
// QUERY_PARAM_AUTH_BYPASS -- and the DEMO escape hatch that lifts that also short-circuits every rbac check
// and spawns demo worlds, which is a worse lie than the flag.
function commonEnv(opts: TargetOptions): Record<string, string> {
	return {
		NODE_OPTIONS: `--inspect=127.0.0.1:${opts.inspectPort} --max-old-space-size=${opts.maxOldSpaceMb ?? 1024}`,
	}
}

function bundleTarget(opts: TargetOptions): Target {
	const entry = path.join(opts.repoRoot, 'dist-server/main-instrumented.js')
	if (!fs.existsSync(entry)) {
		throw new Error(`${entry} does not exist -- build it with \`pnpm run build:prod\` before running a load test`)
	}
	// app-fixture's serverCommand reads this off the runner's own environment, which is how it decides to spawn
	// a bundle rather than transpile the sources through tsx
	process.env.SLM_TEST_SERVER_ENTRY = entry

	return {
		kind: 'bundle',
		env: commonEnv(opts),
		launch: null,
		inspectUrl: `http://127.0.0.1:${opts.inspectPort}`,
		describe: `production bundle (${path.relative(opts.repoRoot, entry)})`,
	}
}

function dockerTarget(opts: TargetOptions): Target {
	return {
		kind: 'docker',
		env: {
			...commonEnv(opts),
			// the container binds inside its own namespace; with host networking that is this machine's loopback
			HOST: '127.0.0.1',
		},
		launch: dockerLauncher(opts),
		inspectUrl: `http://127.0.0.1:${opts.inspectPort}`,
		rewriteUrlPrefix: { from: `file://${CONTAINER_APP_DIR}/`, to: `file://${opts.repoRoot}/` },
		describe: `production image (${IMAGE_TAG})`,
	}
}

function assertDockerReachable() {
	const res = childProcess.spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
	if (res.status === 0) return
	throw new Error(
		`the docker daemon is not reachable, so the image cannot be run: ${(res.stderr || res.stdout || '').trim()}\n` +
			'start it (`sudo systemctl start docker`) or run against the bundle instead (drop --target docker).',
	)
}

function buildImage(repoRoot: string) {
	const gitSha = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim() ?? 'unknown'
	const gitBranch =
		childProcess.spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim() ?? 'unknown'
	const res = childProcess.spawnSync(
		'docker',
		['build', '--target', 'runtime', '--build-arg', `GIT_SHA=${gitSha}`, '--build-arg', `GIT_BRANCH=${gitBranch}`, '-t', IMAGE_TAG, '.'],
		{ cwd: repoRoot, stdio: 'inherit' },
	)
	if (res.status !== 0) throw new Error(`\`docker build\` failed with code ${res.status}`)
}

// Runs the image with the container's own network namespace dropped (`--network host`), which is what lets the
// app inside reach the emulator's RCON and the BattleMetrics stub on this machine's loopback, and lets the
// browsers and profiler reach it back, without any address rewriting on either side. Linux only, which is the
// same constraint the rest of the dev tooling already carries.
function dockerLauncher(opts: TargetOptions): AppLauncher {
	const containerName = `slm-load-${process.pid}`
	let child: childProcess.ChildProcess | null = null
	let exited: Promise<number | null> = Promise.resolve(null)
	let exitCode: number | null = null

	return {
		start: async (spec: AppLaunchSpec) => {
			assertDockerReachable()
			if (!opts.skipBuild) buildImage(spec.repoRoot)

			const out = fs.openSync(spec.logFile, 'a')
			const args = [
				'run',
				'--rm',
				'--name',
				containerName,
				'--network',
				'host',
				'--memory',
				opts.memoryLimit ?? '2g',
				// The db, the emulated server's SquadGame.log and the Admins.cfg, at the paths already written into
				// the settings the app is about to read. Mounting the fixture's directory at the same path inside the
				// container is what keeps those settings true for both targets.
				'-v',
				`${spec.tmpDir}:${spec.tmpDir}`,
				...containerEnvArgs(spec.env),
				IMAGE_TAG,
			]
			child = childProcess.spawn('docker', args, { stdio: ['ignore', out, out] })
			exited = new Promise((resolve) =>
				child!.once('exit', (code) => {
					exitCode = code
					resolve(code)
				}),
			)
		},
		stop: async () => {
			if (!child || exitCode !== null) return
			// `docker stop` rather than killing the client: the container is what has to receive the signal, and
			// the client exiting would leave it running with the fixture's ports still held.
			childProcess.spawnSync('docker', ['stop', '--timeout', '10', containerName], { stdio: 'ignore' })
			await exited
		},
		exitCode: () => exitCode,
	}
}

// Only what the fixture set, never the whole environment: PATH, HOME and NODE_ENV belong to the container, and
// passing this machine's would break the image in ways that look like app failures.
function containerEnvArgs(env: Record<string, string>): string[] {
	return Object.entries(env)
		.filter(([key, value]) => process.env[key] !== value)
		.flatMap(([key, value]) => ['-e', `${key}=${value}`])
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.once('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port
			srv.close(() => resolve(port))
		})
	})
}
