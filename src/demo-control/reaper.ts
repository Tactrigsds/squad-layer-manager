import fs from 'node:fs/promises'

import * as Prom from '@/lib/promise-utils'
import { assertNever } from '@/lib/type-guards'

import * as Bot from './bot.ts'
import * as ControlEnv from './env.ts'
import * as Log from './log.ts'
import * as Registry from './registry.ts'
import * as Secrets from './secrets.ts'
import * as Spawner from './spawner.ts'

// What keeps the fleet under its caps. An instance is disposable by construction -- every one of them started from
// an empty database -- so reaping is deleting, not archiving.

let log!: ReturnType<typeof Log.forModule>

export function setup() {
	log = Log.forModule('reaper')
}

type Verdict = { reap: false } | { reap: true; reason: string }

export function judge(instance: Registry.Instance, now = Date.now()): Verdict {
	const env = ControlEnv.get()
	const idleFor = now - instance.lastActiveAt
	switch (instance.kind) {
		case 'ephemeral': {
			const age = now - instance.createdAt
			if (age >= env.DEMO_EPHEMERAL_MAX_LIFETIME) return { reap: true, reason: 'reached its maximum lifetime' }
			if (idleFor >= env.DEMO_EPHEMERAL_IDLE_TIMEOUT) return { reap: true, reason: 'went idle' }
			return { reap: false }
		}
		case 'guild':
			if (idleFor >= env.DEMO_GUILD_IDLE_TIMEOUT) return { reap: true, reason: 'went idle' }
			return { reap: false }
		default:
			assertNever(instance.kind)
	}
}

export async function reap(instance: Registry.Instance, reason: string) {
	log.info({ instanceId: instance.id, kind: instance.kind }, 'reaping %s: %s', Registry.host(instance), reason)
	await Spawner.stop(instance.id)
	Secrets.forgetInstance(instance.id)
	// the row goes first: a failed rmdir must not leave a slot allocated to an instance nothing will ever serve
	Registry.remove(instance.id)
	try {
		await fs.rm(Registry.dataDir(instance), { recursive: true, force: true })
	} catch (err) {
		log.error({ err, instanceId: instance.id }, 'could not delete the data directory of a reaped instance')
	}
	if (instance.kind === 'guild' && instance.guildId) await Bot.leaveGuild(instance.guildId, 'idle')
}

export async function runOnce(now = Date.now()) {
	for (const instance of Registry.all()) {
		const verdict = judge(instance, now)
		if (verdict.reap) await reap(instance, verdict.reason)
	}
}

export async function run(signal: AbortSignal) {
	const interval = ControlEnv.get().DEMO_REAP_INTERVAL
	while (!signal.aborted) {
		try {
			await Prom.sleep(interval, signal)
		} catch {
			return
		}
		try {
			await runOnce()
		} catch (err) {
			log.error({ err }, 'a reaper pass failed')
		}
	}
}
