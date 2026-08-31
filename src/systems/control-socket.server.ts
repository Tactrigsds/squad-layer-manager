import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

import * as CS from '@/models/context-shared'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as EventArchive from '@/systems/event-archive.server'
import * as MatchLayers from '@/systems/match-layers.server'
import * as Plugins from '@/systems/plugins.server'

/**
 * A unix socket for operating the running app from inside its own container, where there is no session to
 * authenticate and no browser to click. Deployment uses it to load a plugin it just copied in:
 *
 *   docker exec slm-app-prod pnpm plugins:reload --expect seed-roller
 *
 * A socket rather than a port or a signal: it answers, so a deploy can fail on a plugin that did not come
 * back up, which neither of the others can tell it. The file is root-owned and 0600, so reaching it means
 * already being root in the container -- which is why the commands here take no identity and check none.
 *
 * One request per connection: a JSON line in, a JSON line back, close.
 */

const module = initModule('control-socket')
let log!: CS.Logger

type Request = { command: string; args?: Record<string, unknown> }
type Response = { code: string; [key: string]: unknown }

const envBuilder = Env.getEnvBuilder({ ...Env.groups.plugins })
const archiveEnvBuilder = Env.getEnvBuilder({ ...Env.groups.backups })

async function handle(req: Request): Promise<Response> {
	switch (req.command) {
		case 'reload-plugins': {
			const ctx = DB.addPooledDb({ ...CS.init(), log })
			await Plugins.reloadPackages(ctx)
			return {
				code: 'ok',
				plugins: Plugins.listRuntimeInfo().map((p) => ({ id: p.id, enabled: p.enabled, status: p.status, error: p.error })),
			}
		}
		// forces a compaction pass rather than waiting for the next scheduled one -- for after EVENT_ARCHIVE_WINDOW
		// is changed, or before taking a backup of a database that has just caught up on a long backlog
		case 'compact-events': {
			const ctx = DB.addPooledDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
			const env = archiveEnvBuilder()
			const res = await EventArchive.compactAgedMatches(ctx, {
				window: env.EVENT_ARCHIVE_WINDOW,
				minHotMatches: env.EVENT_ARCHIVE_MIN_HOT_MATCHES,
			})
			return { code: 'ok', ...res }
		}
		// forces a retention pass (including the sieve for retain-marked saved queries) -- for after
		// EVENT_HISTORY_RETENTION_PERIOD is shortened, or to reclaim space without waiting for the schedule
		case 'prune-events': {
			const retention = req.args?.retention
			if (typeof retention !== 'number') return { code: 'err:bad-args', message: 'retention (ms) is required' }
			const ctx = DB.addPooledDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
			const res = await EventArchive.pruneArchivedMatches(ctx, { retention })
			return { code: 'ok', ...res }
		}
		// re-resolves matches whose layer the engine could not place. Normally driven by a layer artifact
		// changing; forced here for the pass that follows an out-of-band artifact swap
		case 'reconcile-layers': {
			const ctx = DB.addPooledDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
			const res = await MatchLayers.reconcileMatchLayers(ctx)
			return { code: 'ok', ...(res ?? { skipped: 'already reconciled against this layer artifact' }) }
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
