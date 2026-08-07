import * as Prom from '@/lib/promise-utils'

import * as Bot from './bot.ts'
import * as Broker from './broker.ts'
import * as ControlEnv from './env.ts'
import * as GuildApi from './guild-api.ts'
import * as Ingress from './ingress.ts'
import * as Log from './log.ts'
import * as Portal from './portal.ts'
import * as Proxy from './proxy.ts'
import * as Reaper from './reaper.ts'
import * as Registry from './registry.ts'
import * as Secrets from './secrets.ts'
import * as Spawner from './spawner.ts'

// The demo fleet's control plane. It provisions, routes to, and reaps SLM instances; it is not an SLM instance
// itself and shares nothing with one but the bundle it is built into.

const env = ControlEnv.setup()
Log.setup()
const log = Log.forModule('main')

Registry.setup()
Secrets.setupBrokerKeys()
Spawner.setup()
Proxy.setup()
Portal.setup()
Reaper.setup()
Broker.setup()
GuildApi.setup()

const shutdown = new AbortController()

// Restarting the control plane must not restart 90 node processes at once: each one loads the layer engine, and
// the thundering herd is what would take the box down rather than the steady state. The proxy would wake any of
// them on the first request anyway, so this is a warm-up, not a requirement.
const RESPAWN_STAGGER_MS = 2_000

async function respawnPreviouslyRunning() {
	const previouslyRunning = Registry.all().filter((instance) => instance.state === 'running' || instance.state === 'starting')
	if (previouslyRunning.length === 0) return
	log.info('restoring %d instance(s) that were up before the restart', previouslyRunning.length)
	for (const instance of previouslyRunning) {
		if (shutdown.signal.aborted) return
		void Spawner.start(instance)
		try {
			await Prom.sleep(RESPAWN_STAGGER_MS, shutdown.signal)
		} catch {
			return
		}
	}
}

async function main() {
	await Spawner.killOrphans()
	Ingress.setup()
	if (env.guildFlowEnabled) await Bot.setup(shutdown.signal)
	else log.warn('no discord application configured; the guild flow is off and only the ephemeral portal is served')
	void respawnPreviouslyRunning()
	void Reaper.run(shutdown.signal)
}

let stopping = false
async function stop(signal: string) {
	if (stopping) return
	stopping = true
	log.warn('%s received, shutting the fleet down', signal)
	shutdown.abort()
	await Ingress.close()
	await Bot.close()
	await Spawner.stopAll()
	Registry.close()
	process.exit(0)
}

process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))

await main().catch((err) => {
	log.fatal({ err }, 'the control plane failed to start')
	process.exit(1)
})
