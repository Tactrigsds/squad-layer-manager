import * as ChildProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as Prom from '@/lib/promise-utils'
import { assertNever } from '@/lib/type-guards'

import * as ControlEnv from './env.ts'
import * as Log from './log.ts'
import * as Registry from './registry.ts'
import * as Secrets from './secrets.ts'

// One child process per running instance. The child is the same server bundle a self-hosted SLM runs; everything
// that makes it a demo is in the environment built below, so nothing here has a copy of the app in it.

// A start that has not answered by now is not going to; the instance is marked broken rather than left occupying
// a slot the proxy will keep waiting on.
const HEALTH_TIMEOUT_MS = 90_000
const HEALTH_POLL_MS = 250
// consecutive failed starts before the instance stops being retried
const CRASH_LIMIT = 3
const STOP_GRACE_MS = 10_000

type Child = {
	proc: ChildProcess.ChildProcess
	// set while a stop is deliberate, so the exit handler does not read it as a crash
	stopping: boolean
}

const children = new Map<string, Child>()
const starting = new Map<string, Promise<StartResult>>()
let log!: ReturnType<typeof Log.forModule>

export function setup() {
	log = Log.forModule('spawner')
}

export function isRunning(id: string): boolean {
	return children.has(id)
}

// A control plane that was killed rather than asked to stop leaves its children running, and an orphan still
// holds its port: respawning onto it would fail to bind, three times, and mark a perfectly good instance broken.
// So the first thing a fresh control plane does is clear the ones it recorded.
export async function killOrphans() {
	const orphans: number[] = []
	for (const instance of Registry.all()) {
		if (instance.pid === null) continue
		Registry.setPid(instance.id, null)
		try {
			process.kill(instance.pid, 'SIGTERM')
			orphans.push(instance.pid)
		} catch {
			// already gone
		}
	}
	if (orphans.length === 0) return
	log.warn('killed %d orphaned instance process(es) left by a previous control plane', orphans.length)
	await Prom.sleep(STOP_GRACE_MS)
	for (const pid of orphans) {
		try {
			process.kill(pid, 'SIGKILL')
		} catch {
			// exited during the grace period, which is the normal case
		}
	}
}

export function runningCount(): number {
	return children.size
}

// Everything that distinguishes one instance from another, and a demo instance from a real install. A guild
// instance runs with DEMO off: it has real identities, real rbac and a settings key of its own, and only the
// squad server underneath it is emulated.
function buildEnv(instance: Registry.Instance, dir: string): NodeJS.ProcessEnv {
	const env = ControlEnv.get()
	const common: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		NODE_ENV: 'production',
		HOST: '127.0.0.1',
		PORT: String(Registry.port(instance)),
		ORIGIN: Registry.origin(instance),
		DB_PATH: path.join(dir, 'db.sqlite3'),
		BACKUPS_DIR: path.join(dir, 'backups'),
		// nothing in a demo is worth an OTLP endpoint per instance, and 98 exporters looking for one is 98
		// connection failures a second
		OTEL_ENABLED: 'false',
		LOG_LEVEL_OVERRIDE: env.DEMO_LOG_LEVEL,
		PUBLIC_GIT_SHA: process.env.PUBLIC_GIT_SHA,
		PUBLIC_GIT_BRANCH: process.env.PUBLIC_GIT_BRANCH,
		// the emulated squad server is what there is to demonstrate, in both kinds
		DEMO_WORLDS: 'true',
	}

	switch (instance.kind) {
		case 'ephemeral':
			// DEMO fills in everything else: no-auth login portal, everyone-is-admin rbac, discord off. See
			// DEMO_DEFAULTS in src/server/env.ts.
			return { ...common, DEMO: 'true' }
		case 'guild': {
			const secrets = Secrets.forInstance(instance, dir)
			return {
				...common,
				QUERY_PARAM_AUTH_BYPASS: 'false',
				SETTINGS_ENCRYPTION_KEY: secrets.settingsEncryptionKey,
				DISCORD_MODE: 'proxy',
				DISCORD_HOME_GUILD_ID: instance.guildId!,
				DISCORD_PROXY_URL: `http://127.0.0.1:${env.DEMO_CONTROL_PORT}`,
				DISCORD_PROXY_SECRET: secrets.proxySecret,
				DEMO_BROKER_URL: env.apexOrigin,
				DEMO_LOGIN_TOKEN_PUBKEY: Secrets.getBrokerKeys().publicKey,
			}
		}
		default:
			assertNever(instance.kind)
	}
}

export type StartResult = { code: 'ok' } | { code: 'err:broken' }

export function start(instance: Registry.Instance): Promise<StartResult> {
	const inFlight = starting.get(instance.id)
	if (inFlight) return inFlight
	if (children.has(instance.id)) return Promise.resolve({ code: 'ok' })
	const promise = doStart(instance).finally(() => starting.delete(instance.id))
	starting.set(instance.id, promise)
	return promise
}

async function doStart(instance: Registry.Instance): Promise<StartResult> {
	const env = ControlEnv.get()
	if (instance.state === 'broken') return { code: 'err:broken' }

	const dir = Registry.dataDir(instance)
	fs.mkdirSync(dir, { recursive: true })
	Registry.setState(instance.id, 'starting')

	const proc = ChildProcess.spawn(process.execPath, [env.DEMO_INSTANCE_ENTRY], {
		cwd: process.cwd(),
		env: { ...buildEnv(instance, dir), NODE_OPTIONS: env.DEMO_INSTANCE_NODE_OPTIONS },
		stdio: ['ignore', 'inherit', 'inherit'],
	})
	const child: Child = { proc, stopping: false }
	children.set(instance.id, child)
	Registry.setPid(instance.id, proc.pid ?? null)
	log.info({ instanceId: instance.id, pid: proc.pid }, 'starting %s', Registry.host(instance))

	proc.on('exit', (code, signal) => {
		children.delete(instance.id)
		Registry.setPid(instance.id, null)
		if (child.stopping) {
			Registry.setState(instance.id, 'stopped')
			return
		}
		const crashes = Registry.recordCrash(instance.id)
		log.error({ instanceId: instance.id, code, signal, crashes }, '%s exited unexpectedly', Registry.host(instance))
		if (crashes >= CRASH_LIMIT) {
			Registry.setState(instance.id, 'broken')
			log.error(
				{ instanceId: instance.id },
				'%s is broken after %d failed starts; it will not be retried',
				Registry.host(instance),
				crashes,
			)
		} else {
			Registry.setState(instance.id, 'stopped')
		}
	})

	const healthy = await waitForHealth(instance, proc)
	if (!healthy) {
		// a boot that died on its own has already been counted by the exit handler above. Counting it again here
		// would reach the crash limit in two failed starts rather than three.
		if (children.has(instance.id)) {
			await stop(instance.id)
			const crashes = Registry.recordCrash(instance.id)
			if (crashes >= CRASH_LIMIT) Registry.setState(instance.id, 'broken')
		}
		return { code: 'err:broken' }
	}
	Registry.setState(instance.id, 'running')
	Registry.clearCrashes(instance.id)
	log.info({ instanceId: instance.id }, '%s is up on port %d', Registry.host(instance), Registry.port(instance))
	return { code: 'ok' }
}

// /check-auth answers 401 without a session, which is all the evidence needed that fastify is listening and the
// boot got past every system it sets up first.
async function waitForHealth(instance: Registry.Instance, proc: ChildProcess.ChildProcess): Promise<boolean> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS
	const url = `http://127.0.0.1:${Registry.port(instance)}/check-auth`
	while (Date.now() < deadline) {
		if (proc.exitCode !== null || proc.signalCode !== null) return false
		try {
			await fetch(url, { signal: AbortSignal.timeout(2000) })
			return true
		} catch {
			await Prom.sleep(HEALTH_POLL_MS)
		}
	}
	log.error({ instanceId: instance.id }, '%s did not answer within %dms', Registry.host(instance), HEALTH_TIMEOUT_MS)
	return false
}

export async function stop(id: string) {
	const child = children.get(id)
	if (!child) return
	child.stopping = true
	const exited = new Promise<void>((resolve) => child.proc.once('exit', () => resolve()))
	child.proc.kill('SIGTERM')
	const timedOut = await Promise.race([exited.then(() => false), Prom.sleep(STOP_GRACE_MS).then(() => true)])
	if (timedOut) {
		log.warn({ instanceId: id }, 'instance did not exit within %dms; killing', STOP_GRACE_MS)
		child.proc.kill('SIGKILL')
		await exited
	}
	children.delete(id)
	Registry.setState(id, 'stopped')
}

export async function stopAll() {
	await Promise.all([...children.keys()].map((id) => stop(id)))
}
