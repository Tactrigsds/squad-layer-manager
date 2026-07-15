import * as Schema from '$root/drizzle/schema.ts'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as CS from '@/models/context-shared'
import * as DB from '@/server/db'
import { baseLogger } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Settings from '@/systems/settings.server'
import type { FastifyRequest } from 'fastify'
import { StringDecoder } from 'node:string_decoder'
import type { WebSocket } from 'ws'

// The log agent (see ./log-agent, a small rust program) tails a squad server's SquadGame.log and streams
// it here over a WebSocket on the app's normal port. This replaces the old dedicated-port TCP receiver:
// one endpoint, no extra port to expose, and TLS is whatever terminates in front of the app.
//
// Protocol (deliberately thin, no oRPC):
//   1. agent connects to `wss://<origin>/log-agent`
//   2. agent sends one text frame: `slm-log-agent@<version>:<serverId>:<token>`
//   3. we validate against the server's live settings; on failure we close with a 4xxx code, on success
//      we send a `ok` text frame
//   4. every subsequent frame is raw SquadGame.log bytes, routed into that server's chunk stream
//
// Application-private WebSocket close codes (4000-4999) we use to tell the agent why we hung up:
const CLOSE_BAD_HANDSHAKE = 4000
const CLOSE_UNAUTHORIZED = 4001
const CLOSE_UNKNOWN_SERVER = 4004
const CLOSE_DUPLICATE = 4009

// how long an agent has to send its handshake frame before we drop it
const HANDSHAKE_TIMEOUT_MS = 10_000

const HANDSHAKE_RE = /^slm-log-agent@(\d+\.\d+\.\d+):([\w-]+):(.+)$/

// Per-server chunk streams. Kept in a registry (rather than one global subject as before) so each squad
// server's slice only sees its own agent's data. The subject outlives individual agent connections: an
// agent can drop and reconnect without the consumer resubscribing.
const streams = new Map<string, IsolatedSubject<string>>()

// One live agent per server. A second connection claiming the same serverId is rejected as a duplicate.
const activeAgents = new Map<string, WebSocket>()

function getStream(serverId: string): IsolatedSubject<string> {
	let stream = streams.get(serverId)
	if (!stream) {
		stream = new IsolatedSubject<string>()
		streams.set(serverId, stream)
	}
	return stream
}

// Subscribed by each squad server slice (see squad-server.server.ts) when its log source is `log-receiver`.
export function streamFor(serverId: string): IsolatedSubject<string> {
	return getStream(serverId)
}

export async function setup() {
	const log = baseLogger
	const dbCtx = DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	const ids = (await dbCtx.db().select({ id: Schema.servers.id }).from(Schema.servers)).map(r => r.id)
	const usingReceiver: string[] = []
	for (const id of ids) {
		try {
			const settings = await Settings.getServerSettings(dbCtx, id)
			if (settings.connections.logs.type === 'log-receiver') usingReceiver.push(id)
		} catch (err) {
			log.error(err, `Server ${id} has invalid settings, excluding it from the log receiver`)
		}
	}
	if (usingReceiver.length === 0) {
		log.info('No server configured for the log receiver')
	} else {
		log.info('Log receiver ready for servers: %s', usingReceiver.join(', '))
	}
}

// Called by the fastify `/log-agent` websocket route (fastify.server.ts). One invocation per agent connection.
export function handleConnection(ws: WebSocket, req: FastifyRequest) {
	const log = baseLogger
	const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`

	const handshakeTimer = setTimeout(() => {
		log.warn('Log agent %s did not send a handshake in time', remote)
		close(ws, CLOSE_BAD_HANDSHAKE, 'handshake timeout')
	}, HANDSHAKE_TIMEOUT_MS)

	ws.on('error', (err) => log.error(err, 'Log agent socket error for %s', remote))

	ws.once('message', (raw: Buffer) => {
		clearTimeout(handshakeTimer)
		void onHandshake(ws, remote, raw.toString('utf-8').trim())
	})
}

async function onHandshake(ws: WebSocket, remote: string, handshake: string) {
	const log = baseLogger
	const match = HANDSHAKE_RE.exec(handshake)
	if (!match) {
		log.warn('Log agent %s sent a malformed handshake: %s', remote, handshake)
		close(ws, CLOSE_BAD_HANDSHAKE, 'malformed handshake')
		return
	}
	const [, version, serverId, token] = match

	const dbCtx = DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	let settings
	try {
		settings = await Settings.getServerSettings(dbCtx, serverId)
	} catch {
		log.warn('Log agent %s referenced unknown server %s', remote, serverId)
		close(ws, CLOSE_UNKNOWN_SERVER, 'unknown server')
		return
	}

	if (settings.connections.logs.type !== 'log-receiver') {
		log.warn('Log agent %s: server %s is not configured for log-receiver', remote, serverId)
		close(ws, CLOSE_UNKNOWN_SERVER, 'server not configured for log-receiver')
		return
	}

	if (settings.connections.logs.token !== token) {
		log.warn('Log agent %s: invalid token for server %s', remote, serverId)
		close(ws, CLOSE_UNAUTHORIZED, 'invalid token')
		return
	}

	if (activeAgents.has(serverId)) {
		log.warn('Log agent %s: server %s already has a connected agent', remote, serverId)
		close(ws, CLOSE_DUPLICATE, 'duplicate agent')
		return
	}

	// the connection may have dropped during the async settings lookup above
	if (ws.readyState !== ws.OPEN) return

	activeAgents.set(serverId, ws)
	const stream = getStream(serverId)
	log.info('Log agent %s connected for server %s (version %s)', remote, serverId, version)

	// a chunk can split a multi-byte utf-8 sequence across frames; the decoder buffers the trailing partial
	// bytes until the rest arrives rather than emitting replacement characters
	const decoder = new StringDecoder('utf8')
	// register the data handler before acking, so nothing the agent sends right after `ok` can slip through
	ws.on('message', (chunk: Buffer) => {
		const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
		if (text.length > 0) stream.next(text)
	})
	ws.send('ok')

	ws.on('close', () => {
		if (activeAgents.get(serverId) === ws) activeAgents.delete(serverId)
		log.info('Log agent %s for server %s disconnected', remote, serverId)
	})
}

function close(ws: WebSocket, code: number, reason: string) {
	try {
		ws.close(code, reason)
	} catch {
		ws.terminate()
	}
}
