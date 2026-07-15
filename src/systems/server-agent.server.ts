import * as Schema from '$root/drizzle/schema.ts'
import { IsolatedSubject } from '@/lib/isolated-subject'
import type { RconTransport, RconTransportHandlers } from '@/lib/rcon/core-rcon'
import * as CS from '@/models/context-shared'
import * as DB from '@/server/db'
import { baseLogger } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Settings from '@/systems/settings.server'
import type { FastifyRequest } from 'fastify'
import { StringDecoder } from 'node:string_decoder'
import type { WebSocket } from 'ws'

// The slm-server-agent (see ../../server-agent, a small rust program) runs on/near a squad server box and
// connects out to SLM over a WebSocket on the app's normal port. It handles BOTH of that server's I/O:
//   - tails SquadGame.log and streams it here
//   - proxies RCON: it holds the RCON password itself, authenticates to localhost RCON, and tunnels the
//     already-authenticated byte stream here. SLM never holds the RCON password for an agent-mode server.
//
// Protocol (deliberately thin, no oRPC):
//   1. agent connects to `wss://<origin>/server-agent`
//   2. agent sends one text frame: `slm-server-agent@<version>:<serverId>:<token>`
//   3. we validate against the server's live settings; on failure we close with a 4xxx code, on success we
//      send an `ok` text frame
//   4. every subsequent frame is BINARY, tagged by its first byte:
//        0x00 <log bytes>        raw SquadGame.log bytes, routed into the server's chunk stream
//        0x01 <rcon bytes>       raw post-auth Source RCON packet bytes, bridged to/from the server's Rcon
//        0x02 <utf8 control>     rcon control: `rcon-ready` | `rcon-error` | `rcon-disconnected`
//      SLM only ever sends the agent 0x01 rcon frames (commands for the tunnel).
const TAG_LOG = 0x00
const TAG_RCON_DATA = 0x01
const TAG_RCON_CONTROL = 0x02

// Application-private WebSocket close codes (4000-4999) we use to tell the agent why we hung up:
const CLOSE_BAD_HANDSHAKE = 4000
const CLOSE_UNAUTHORIZED = 4001
const CLOSE_UNKNOWN_SERVER = 4004
const CLOSE_DUPLICATE = 4009

// how long an agent has to send its handshake frame before we drop it
const HANDSHAKE_TIMEOUT_MS = 10_000

const HANDSHAKE_RE = /^slm-server-agent@(\d+\.\d+\.\d+):([\w-]+):(.+)$/

// Per-server log chunk streams. Kept in a registry so each squad server's slice only sees its own agent's
// data. The subject outlives individual agent connections: an agent can drop and reconnect without the
// consumer resubscribing.
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

// Subscribed by each squad server slice (see squad-server.server.ts) when its connection mode is `server-agent`.
export function streamFor(serverId: string): IsolatedSubject<string> {
	return getStream(serverId)
}

// The bidirectional bridge between the agent's RCON tunnel and the server slice's Rcon instance. Both ends
// outlive each other's connection lifecycle: the agent can drop and reconnect, and the Rcon can rebind on its
// own reconnect loop, without either recreating the tunnel.
class RconTunnel {
	// the Rcon side, bound while a slice's Rcon is trying to stay connected
	private handlers: RconTransportHandlers | null = null
	// the agent side, set while an agent is connected. Frames and sends a 0x01 rcon-data frame to the agent.
	private sendToAgent: ((payload: Buffer) => void) | null = null
	// the agent has authenticated to local RCON and the tunnel is carrying live traffic
	private ready = false

	// ---- agent (receiver) side ----
	attachAgent(sendToAgent: (payload: Buffer) => void) {
		this.sendToAgent = sendToAgent
	}
	detachAgent() {
		this.sendToAgent = null
		if (this.ready) {
			this.ready = false
			this.handlers?.onClose()
		}
	}
	onAgentData(payload: Buffer) {
		this.handlers?.onData(payload)
	}
	onAgentControl(msg: string) {
		if (msg === 'rcon-ready') {
			this.ready = true
			this.handlers?.onReady()
		} else if (msg === 'rcon-disconnected') {
			if (this.ready) {
				this.ready = false
				this.handlers?.onClose()
			}
		} else if (msg === 'rcon-error') {
			this.handlers?.onError(new Error('server-agent reported an RCON error'))
		}
	}

	// ---- Rcon (transport) side ----
	bind(handlers: RconTransportHandlers) {
		this.handlers = handlers
		// the agent may already be connected and authenticated when the Rcon binds (or rebinds) late
		if (this.ready) handlers.onReady()
	}
	unbind() {
		this.handlers = null
	}
	write(payload: Buffer) {
		this.sendToAgent?.(payload)
	}
	get writable(): boolean {
		return this.ready && this.sendToAgent !== null
	}
}

const rconTunnels = new Map<string, RconTunnel>()

function getRconTunnel(serverId: string): RconTunnel {
	let tunnel = rconTunnels.get(serverId)
	if (!tunnel) {
		tunnel = new RconTunnel()
		rconTunnels.set(serverId, tunnel)
	}
	return tunnel
}

// The RCON transport used by a `server-agent` server slice (see squad-server.server.ts). It has no auth
// password of its own: the agent authenticates to local RCON and this transport just carries the resulting
// byte stream, becoming ready when the agent signals `rcon-ready`.
export function rconTransportFor(serverId: string): RconTransport {
	const tunnel = getRconTunnel(serverId)
	return {
		label: `server-agent:${serverId}`,
		authPassword: undefined,
		connect(handlers) {
			tunnel.bind(handlers)
		},
		write(buf) {
			tunnel.write(buf)
		},
		get writable() {
			return tunnel.writable
		},
		destroy() {
			tunnel.unbind()
		},
	}
}

export async function setup() {
	const log = baseLogger
	const dbCtx = DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	const ids = (await dbCtx.db().select({ id: Schema.servers.id }).from(Schema.servers)).map(r => r.id)
	const usingAgent: string[] = []
	for (const id of ids) {
		try {
			const settings = await Settings.getServerSettings(dbCtx, id)
			if (settings.connections.type === 'server-agent') usingAgent.push(id)
		} catch (err) {
			log.error(err, `Server ${id} has invalid settings, excluding it from the server agent`)
		}
	}
	if (usingAgent.length === 0) {
		log.info('No server configured for the server agent')
	} else {
		log.info('Server agent ready for servers: %s', usingAgent.join(', '))
	}
}

// Called by the fastify `/server-agent` websocket route (fastify.server.ts). One invocation per agent connection.
export function handleConnection(ws: WebSocket, req: FastifyRequest) {
	const log = baseLogger
	const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`

	const handshakeTimer = setTimeout(() => {
		log.warn('Server agent %s did not send a handshake in time', remote)
		close(ws, CLOSE_BAD_HANDSHAKE, 'handshake timeout')
	}, HANDSHAKE_TIMEOUT_MS)

	ws.on('error', (err) => log.error(err, 'Server agent socket error for %s', remote))

	ws.once('message', (raw: Buffer) => {
		clearTimeout(handshakeTimer)
		void onHandshake(ws, remote, raw.toString('utf-8').trim())
	})
}

async function onHandshake(ws: WebSocket, remote: string, handshake: string) {
	const log = baseLogger
	const match = HANDSHAKE_RE.exec(handshake)
	if (!match) {
		log.warn('Server agent %s sent a malformed handshake: %s', remote, handshake)
		close(ws, CLOSE_BAD_HANDSHAKE, 'malformed handshake')
		return
	}
	const [, version, serverId, token] = match

	const dbCtx = DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	let settings
	try {
		settings = await Settings.getServerSettings(dbCtx, serverId)
	} catch {
		log.warn('Server agent %s referenced unknown server %s', remote, serverId)
		close(ws, CLOSE_UNKNOWN_SERVER, 'unknown server')
		return
	}

	if (settings.connections.type !== 'server-agent') {
		log.warn('Server agent %s: server %s is not configured for a server agent', remote, serverId)
		close(ws, CLOSE_UNKNOWN_SERVER, 'server not configured for a server agent')
		return
	}

	if (settings.connections.token !== token) {
		log.warn('Server agent %s: invalid token for server %s', remote, serverId)
		close(ws, CLOSE_UNAUTHORIZED, 'invalid token')
		return
	}

	if (activeAgents.has(serverId)) {
		log.warn('Server agent %s: server %s already has a connected agent', remote, serverId)
		close(ws, CLOSE_DUPLICATE, 'duplicate agent')
		return
	}

	// the connection may have dropped during the async settings lookup above
	if (ws.readyState !== ws.OPEN) return

	activeAgents.set(serverId, ws)
	const stream = getStream(serverId)
	const tunnel = getRconTunnel(serverId)
	tunnel.attachAgent((payload) => {
		if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([TAG_RCON_DATA]), payload]))
	})
	log.info('Server agent %s connected for server %s (version %s)', remote, serverId, version)

	// a chunk can split a multi-byte utf-8 sequence across frames; the decoder buffers the trailing partial
	// bytes until the rest arrives rather than emitting replacement characters
	const decoder = new StringDecoder('utf8')
	// register the data handler before acking, so nothing the agent sends right after `ok` can slip through
	ws.on('message', (raw: Buffer) => {
		const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
		if (buf.byteLength === 0) return
		const tag = buf[0]
		const payload = buf.subarray(1)
		if (tag === TAG_LOG) {
			const text = decoder.write(payload)
			if (text.length > 0) stream.next(text)
		} else if (tag === TAG_RCON_DATA) {
			tunnel.onAgentData(payload)
		} else if (tag === TAG_RCON_CONTROL) {
			tunnel.onAgentControl(payload.toString('utf8'))
		} else {
			log.warn('Server agent %s: unknown frame tag %d for server %s', remote, tag, serverId)
		}
	})
	ws.send('ok')

	ws.on('close', () => {
		if (activeAgents.get(serverId) === ws) activeAgents.delete(serverId)
		tunnel.detachAgent()
		log.info('Server agent %s for server %s disconnected', remote, serverId)
	})
}

function close(ws: WebSocket, code: number, reason: string) {
	try {
		ws.close(code, reason)
	} catch {
		ws.terminate()
	}
}
