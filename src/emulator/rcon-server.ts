import * as net from 'node:net'
import type { World } from './world'

// RCON protocol frontend over a World. The framing reproduces what the real squad server was
// observed to do (test/corpus/rcon/*): for a command with id N followed by the client's empty
// probe with id N+2, respond with data packets (type 0, id N, body chunked), then two empty
// type 0 packets with the probe's id, then the raw 7-byte SOH sequence 00 01 00 00 00 00 00,
// which is what actually completes response assembly in the app's client. Chat-stream packets
// are type 1, id 0, broadcast to every authed connection. A successful auth from an IP closes
// older authed sessions from the same IP, like the real server.

const TYPE = { auth: 0x03, command: 0x02, response: 0x00, server: 0x01 } as const
const SOH_SEQUENCE = Buffer.from([0, 1, 0, 0, 0, 0, 0])
// observed data packets cap out around 4KiB; the exact split point doesn't matter to clients
const MAX_CHUNK = 4000

export type ReceivedCommand = { time: number; body: string }

type Conn = {
	socket: net.Socket
	stream: Buffer
	authed: boolean
	remoteAddress: string
}

function encode(type: number, id: number, body = ''): Buffer {
	const size = Buffer.byteLength(body) + 14
	const buffer = Buffer.alloc(size)
	buffer.writeInt32LE(size - 4, 0)
	buffer.writeInt32LE(id, 4)
	buffer.writeInt32LE(type, 8)
	buffer.write(body, 12, size - 2, 'utf8')
	buffer.writeInt16LE(0, size - 2)
	return buffer
}

export class RconServer {
	commandLog: ReceivedCommand[] = []
	#world: World
	#password: string
	#server: net.Server
	#conns = new Set<Conn>()
	#commandWaiters: { pred: (cmd: ReceivedCommand) => boolean; resolve: (cmd: ReceivedCommand) => void }[] = []

	constructor(world: World, opts: { password: string }) {
		this.#world = world
		this.#password = opts.password
		this.#server = net.createServer((socket) => this.#onConnection(socket))
	}

	listen(port = 0, host = '127.0.0.1'): Promise<number> {
		return new Promise((resolve, reject) => {
			this.#server.once('error', reject)
			this.#server.listen(port, host, () => {
				resolve((this.#server.address() as net.AddressInfo).port)
			})
		})
	}

	close() {
		for (const conn of this.#conns) conn.socket.destroy()
		this.#conns.clear()
		this.#server.close()
	}

	// -------- fault injection --------

	// drops every connection without closing the listener, as a server does when it restarts its RCON
	// or the network blips. Clients have to notice and reconnect.
	dropConnections() {
		for (const conn of this.#conns) conn.socket.destroy()
		this.#conns.clear()
	}

	// while unreachable, connection attempts are refused: the listener is closed and only comes back
	// when `listen` is called again on the same port
	async goOffline(): Promise<void> {
		this.dropConnections()
		await new Promise<void>((resolve) => this.#server.close(() => resolve()))
	}

	async goOnline(port: number, host = '127.0.0.1'): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.#server.once('error', reject)
			this.#server.listen(port, host, () => resolve())
		})
	}

	broadcastChatPacket(body: string) {
		for (const conn of this.#conns) {
			if (conn.authed) conn.socket.write(encode(TYPE.server, 0, body))
		}
	}

	// resolves when a command matching `pattern` has been received (including past commands)
	expectCommand(pattern: RegExp, opts?: { timeoutMs?: number }): Promise<ReceivedCommand> {
		const existing = this.commandLog.find((c) => pattern.test(c.body))
		if (existing) return Promise.resolve(existing)
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#commandWaiters = this.#commandWaiters.filter((w) => w.resolve !== wrapped)
				reject(new Error(`timed out waiting for command matching ${pattern}`))
			}, opts?.timeoutMs ?? 5000)
			const wrapped = (cmd: ReceivedCommand) => {
				clearTimeout(timer)
				resolve(cmd)
			}
			this.#commandWaiters.push({ pred: (cmd) => pattern.test(cmd.body), resolve: wrapped })
		})
	}

	#onConnection(socket: net.Socket) {
		const conn: Conn = {
			socket,
			stream: Buffer.alloc(0),
			authed: false,
			remoteAddress: socket.remoteAddress ?? 'unknown',
		}
		this.#conns.add(conn)
		socket.on('data', (data) => {
			conn.stream = Buffer.concat([conn.stream, data])
			this.#drain(conn)
		})
		socket.on('close', () => this.#conns.delete(conn))
		socket.on('error', () => this.#conns.delete(conn))
	}

	#drain(conn: Conn) {
		while (conn.stream.byteLength >= 4) {
			const bufSize = conn.stream.readInt32LE(0)
			if (bufSize < 10 || bufSize > 8192) {
				conn.socket.destroy()
				return
			}
			if (bufSize > conn.stream.byteLength - 4) return
			const id = conn.stream.readInt32LE(4)
			const type = conn.stream.readInt32LE(8)
			const body = conn.stream.toString('utf8', 12, bufSize + 2)
			conn.stream = conn.stream.subarray(bufSize + 4)
			this.#onPacket(conn, type, id, body)
		}
	}

	#onPacket(conn: Conn, type: number, id: number, body: string) {
		if (type === TYPE.auth) {
			if (body === this.#password) {
				// the real server stops older sessions when a client re-authenticates from the same IP
				for (const other of this.#conns) {
					if (other !== conn && other.authed && other.remoteAddress === conn.remoteAddress) {
						other.socket.destroy()
						this.#conns.delete(other)
					}
				}
				conn.authed = true
				conn.socket.write(encode(TYPE.response, id))
				conn.socket.write(encode(TYPE.command, id))
			} else {
				conn.socket.write(encode(TYPE.response, id))
				conn.socket.write(encode(TYPE.command, -1))
			}
			return
		}
		if (type !== TYPE.command || !conn.authed) return

		if (body === '') {
			// the empty probe: two empty responses with its id, then the SOH terminator
			conn.socket.write(encode(TYPE.response, id))
			conn.socket.write(encode(TYPE.response, id))
			conn.socket.write(SOH_SEQUENCE)
			return
		}

		const cmd: ReceivedCommand = { time: Date.now(), body }
		this.commandLog.push(cmd)
		const waiters = this.#commandWaiters.filter((w) => w.pred(cmd))
		this.#commandWaiters = this.#commandWaiters.filter((w) => !w.pred(cmd))
		for (const w of waiters) w.resolve(cmd)

		const response = this.#world.handleCommand(body)
		for (let i = 0; i < response.length; i += MAX_CHUNK) {
			conn.socket.write(encode(TYPE.response, id, response.slice(i, i + MAX_CHUNK)))
		}
	}
}
