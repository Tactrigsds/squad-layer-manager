import * as CS from '@/models/context-shared'
import type * as Logs from '@/models/logs'
import * as ATTRS from '@/models/otel-attrs'
import type * as SETTINGS from '@/models/settings.models'
import * as SM from '@/models/squad.models'
import * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as Otel from '@opentelemetry/api'

import { EventEmitter } from 'node:events'
import net from 'node:net'
import * as Rx from 'rxjs'
import { filterTruthy, firstValueFrom } from '../async'

export type DecodedPacket = {
	type: number
	size: number
	id: number
	body: string
}

// Rcon owns all Source-protocol framing/reassembly and speaks to the game server through a transport, which is
// just a byte pipe plus connection lifecycle. Two implementations exist: a direct TCP socket (DirectSocketTransport,
// below), and a tunnel over the server-agent WebSocket (AgentTunnelTransport, in server-agent.server.ts). The latter
// keeps the RCON password off SLM entirely: the agent authenticates to localhost RCON itself and hands us an
// already-authenticated byte stream.
export type RconTransportHandlers = {
	// underlying link established. For a self-authenticating transport this is when Rcon sends the Source auth packet.
	onConnect(): void
	onData(data: Buffer): void
	onClose(): void
	onError(err: Error): void
	// the link is authenticated and usable WITHOUT Rcon driving the auth handshake (the transport did it). Maps to
	// the same readiness signal as the direct path's auth echo.
	onReady(): void
}

export interface RconTransport {
	// host:port (or an agent label) for logging
	readonly label: string
	// when set, Rcon performs the Source auth handshake on connect using this password (direct path). When undefined,
	// the transport delivers an already-authenticated stream and signals readiness via onReady (tunnel path).
	readonly authPassword?: string
	connect(handlers: RconTransportHandlers): void
	write(buf: Buffer): void
	readonly writable: boolean
	destroy(): void
}

export class DirectSocketTransport implements RconTransport {
	private client: net.Socket | null = null
	readonly label: string
	readonly authPassword: string
	constructor(private settings: SETTINGS.RconConnection) {
		for (const option of ['host', 'port', 'password'] as const) {
			if (!(option in settings)) throw new Error(`${option} must be specified.`)
		}
		this.label = `${settings.host}:${settings.port}`
		this.authPassword = settings.password
	}
	connect(handlers: RconTransportHandlers): void {
		this.client = net
			.createConnection({ port: this.settings.port, host: this.settings.host }, () => handlers.onConnect())
			.on('data', (data) => handlers.onData(data))
			.on('end', () => handlers.onClose())
			.on('error', (error) => handlers.onError(error))
	}
	write(buf: Buffer): void {
		this.client?.write(buf.toString('binary'), 'binary')
	}
	get writable(): boolean {
		return this.client?.writable ?? false
	}
	destroy(): void {
		this.client?.destroy()
		this.client = null
	}
}

const module = initModule('core-rcon')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

const meter = Otel.metrics.getMeter('core-rcon')

const requestCounter = meter.createCounter(ATTRS.Rcon.REQUESTS, {
	description: 'RCON commands issued, by server, command verb and outcome',
})

const ioCounter = meter.createCounter(ATTRS.Rcon.IO, {
	description: 'Bytes moved over the RCON socket, by server and direction',
	unit: 'By',
})

// The verb, not the whole command. `AdminKick "7656..." being a dick` is unique per invocation, so
// using the raw body as a metric dimension would mint a new series per kick.
function commandVerb(body: string): string {
	const verb = body.trim().split(/\s+/, 1)[0]
	return verb || 'unknown'
}

type Events = {
	server: [C.OtelCtx, DecodedPacket]
	auth: []
	[key: `response${string}`]: [string]
	RCON_ERROR: [Error]
}

export default class Rcon extends EventEmitter<Events> {
	serverId: string
	private transport: RconTransport
	private stream: Buffer
	private type: {
		auth: number
		command: number
		response: number
		server: number
	}
	private soh: { size: number; id: number; type: number; body: string }

	public get connected() {
		return this.connected$.closed ? false : this.connected$.value
	}
	public connected$ = new Rx.BehaviorSubject<boolean>(false)

	private autoReconnectDelay: number
	private msgId: number
	private responseString: { id: number; body: string }

	constructor(options: { serverId: string; transport: RconTransport; autoReconnectDelay?: number }) {
		super()
		this.serverId = options.serverId
		this.transport = options.transport
		this.stream = Buffer.alloc(0)
		this.type = { auth: 0x03, command: 0x02, response: 0x00, server: 0x01 }
		this.soh = { size: 7, id: 0, type: this.type.response, body: '' }
		this.autoReconnectDelay = options.autoReconnectDelay ?? 5000
		this.msgId = 20
		this.responseString = { id: 0, body: '' }
	}

	ensureConnectedSub?: Rx.Subscription
	ensureConnected() {
		if (this.ensureConnectedSub) return
		const sub = new Rx.Subscription()
		this.ensureConnectedSub = sub
		sub.add(
			Rx.fromEvent(this, 'auth').subscribe(() => {
				log.info('RCON Connected to: %s', this.transport.label)
				this.connected$.next(true)
			}),
		)
		sub.add(
			this.connected$.pipe(
				Rx.distinctUntilChanged(),
				// switchMap means a successful connection will cancel reconnect attempts
				Rx.switchMap((connected) => {
					if (connected) return Rx.EMPTY
					// try to connect immediately, and then every `autoReconnectDelay` ms
					return Rx.concat(Rx.of(1), Rx.interval(this.autoReconnectDelay))
				}),
			).subscribe(() => {
				log.info('Attempting to connect to RCON: %s', this.transport.label)
				this.transport.destroy()
				this.transport.connect({
					// direct: TCP connected, send the Source auth packet. tunnel: no-op (the agent authenticates itself).
					onConnect: () => {
						if (this.transport.authPassword !== undefined) this.#sendAuth()
					},
					onData: (data) => this.#onData(data),
					onClose: () => this.#onClose(),
					onError: (error) => this.#onNetError(error),
					// tunnel readiness: the agent authenticated to local RCON. Same signal as the direct auth echo.
					onReady: () => this.emit('auth'),
				})
			}),
		)
	}

	connect() {
		this.ensureConnected()
		return Rx.firstValueFrom(this.connected$.pipe(filterTruthy()))
	}

	disconnect() {
		log.info('Disconnecting from: %s', this.transport.label)
		this.removeAllListeners()
		this.ensureConnectedSub?.unsubscribe()
		this.ensureConnectedSub = undefined
		this.transport.destroy()
		this.connected$.next(false)
		this.connected$.unsubscribe()
	}

	execute = C.spanOp(
		'execute',
		{
			module,
			kind: Otel.SpanKind.CLIENT,
			attrs: (body) => ({ [ATTRS.Rcon.COMMAND]: commandVerb(body), [ATTRS.Rcon.BODY]: body }),
			levels: { event: (body, opts) => opts?.level ?? 'trace' },
			extraText: (body) => body,
		},
		async (
			body: string,
			_opts?: { level?: Logs.Level; signal?: AbortSignal },
		): Promise<{ code: 'err:rcon'; msg: string } | { code: 'ok'; data: string }> => {
			if (typeof body !== 'string') {
				throw new Error('Rcon.execute() body must be a string.')
			}
			// counted here rather than in #write: one logical request is two socket writes (the command
			// plus a terminator), and a request that never reaches the socket (disconnected, oversize)
			// still needs to show up as an attempt.
			const recordOutcome = (outcome: ATTRS.Op.Outcome) =>
				requestCounter.add(1, {
					[ATTRS.SquadServer.ID]: this.serverId,
					[ATTRS.Rcon.COMMAND]: commandVerb(body),
					[ATTRS.Op.OUTCOME]: outcome,
				})
			_opts?.signal?.throwIfAborted()
			if (!this.connected) {
				const reconnected$ = this.connected$.pipe(Rx.filter(connected => connected), Rx.take(1))
				const res = await firstValueFrom(
					Rx.race([
						reconnected$,
						Rx.timer(2_000).pipe(Rx.map(() => false)),
					]),
					_opts?.signal,
				)
				if (!res) {
					recordOutcome('error')
					return ({ code: 'err:rcon' as const, msg: `Rcon response timed out` })
				}
			}
			if (!this.connected) {
				recordOutcome('error')
				return { code: 'err:rcon' as const, msg: "Couldn't establish connection with server" }
			}
			if (!this.transport.writable) {
				recordOutcome('error')
				return { code: 'err:rcon' as const, msg: 'Unable to write to RCON transport.' }
			}
			const length = Buffer.from(body).length
			if (length > SM.RCON_MAX_BUF_LEN) {
				recordOutcome('error')
				return { code: 'err:rcon' as const, msg: `Oversize, "" > ${SM.RCON_MAX_BUF_LEN}.` }
			} else {
				if (this.msgId > 80) this.msgId = 20
				const listenerId = `response${this.msgId}`
				const timeout$ = Rx.timer(2_000).pipe(Rx.map(() => ({ code: 'err:rcon' as const, msg: `Rcon response timed out` })))
				const response$ = Rx.fromEvent(this, listenerId).pipe(Rx.take(1), Rx.map(data => ({ code: 'ok' as const, data: data as string })))
				this.#send(body, this.msgId)
				this.msgId++
				const result = await firstValueFrom(Rx.race(timeout$, response$), _opts?.signal)
				recordOutcome(result.code === 'ok' ? 'ok' : 'error')
				return result
			}
		},
	)

	#sendAuth(): void {
		const password = this.transport.authPassword
		if (password === undefined) return
		log.trace(`Sending auth to: ${this.transport.label}`)
		this.#writeBuf(this.#encode(this.type.auth, 2147483647, password))
	}

	#send(body: string, id = 99): void {
		this.#write(this.type.command, id, body)
		this.#write(this.type.command, id + 2)
	}

	#write(type: number, id: number, body?: string): void {
		log.trace(`Writing packet with type "${type}", id "${id}" and body "${body || ''}".`)
		this.#writeBuf(this.#encode(type, id, body))
	}

	// the one place bytes leave the socket, so the auth handshake is counted too rather than only
	// command traffic. The payload is written as latin1, which is one byte per char, so the buffer's
	// byteLength is what actually goes on the wire.
	#writeBuf(buf: Buffer): void {
		ioCounter.add(buf.byteLength, {
			[ATTRS.SquadServer.ID]: this.serverId,
			[ATTRS.IO.DIRECTION]: 'sent' satisfies ATTRS.IO.Direction,
		})
		this.transport.write(buf)
	}

	#encode(type: number, id: number, body = ''): Buffer {
		const size = Buffer.byteLength(body) + 14
		const buffer = Buffer.alloc(size)
		buffer.writeInt32LE(size - 4, 0)
		buffer.writeInt32LE(id, 4)
		buffer.writeInt32LE(type, 8)
		buffer.write(body, 12, size - 2, 'utf8')
		buffer.writeInt16LE(0, size - 2)
		return buffer
	}

	#onData(data: Buffer): void {
		ioCounter.add(data.byteLength, {
			[ATTRS.SquadServer.ID]: this.serverId,
			[ATTRS.IO.DIRECTION]: 'received' satisfies ATTRS.IO.Direction,
		})
		this.stream = Buffer.concat([this.stream, data], this.stream.byteLength + data.byteLength)
		while (this.stream.byteLength >= 7) {
			const packet = this.#decode()
			if (!packet) break
			else {
				log.trace(`Processing decoded packet: Size: ${packet.size}, ID: ${packet.id}, Type: ${packet.type}, Body: ${packet.body}`)
			}
			if (packet.type === this.type.response) this.#onResponse(packet)
			else if (packet.type === this.type.server) this.emit('server', C.storeLinkToActiveSpan(CS.init(), 'event.emitter'), packet)
			else if (packet.type === this.type.command) this.emit('auth')
		}
	}

	#decode(): { size: number; id: number; type: number; body: string } | null {
		if (
			this.stream[0] === 0
			&& this.stream[1] === 1
			&& this.stream[2] === 0
			&& this.stream[3] === 0
			&& this.stream[4] === 0
			&& this.stream[5] === 0
			&& this.stream[6] === 0
		) {
			this.stream = this.stream.subarray(7)
			return this.soh
		}
		const bufSize = this.stream.readInt32LE(0)
		if (bufSize > 8192 || bufSize < 10) return this.#badPacket()
		else if (bufSize <= this.stream.byteLength - 4) {
			const bufId = this.stream.readInt32LE(4)
			const bufType = this.stream.readInt32LE(8)
			if (this.stream[bufSize + 2] !== 0 || this.stream[bufSize + 3] !== 0 || bufId < 0 || bufType < 0 || bufType > 5) {
				return this.#badPacket()
			} else {
				const response = {
					size: bufSize,
					id: bufId,
					type: bufType,
					body: this.stream.toString('utf8', 12, bufSize + 2),
				} satisfies DecodedPacket
				this.stream = this.stream.subarray(bufSize + 4)
				return response
			}
		} else return null
	}

	#onResponse(packet: { size: number; id: number; type: number; body: string }): void {
		if (packet.body === '') {
			this.emit(`response${this.responseString.id - 2}`, this.responseString.body)
			this.responseString.body = ''
		} else if (!packet.body.includes('')) {
			this.responseString.body = this.responseString.body += packet.body
			this.responseString.id = packet.id
		} else this.#badPacket()
	}

	#badPacket(): null {
		log.error(`Bad packet, clearing: ${this.#bufToHexString(this.stream)} Pending string: ${JSON.stringify(this.responseString)}`)
		this.stream = Buffer.alloc(0)
		this.responseString = { id: 0, body: '' }
		return null
	}

	#onClose(): void {
		log.trace(`Socket closed.`)
		if (this.connected$.value) this.connected$.next(false)
	}

	#onNetError(error: Error): void {
		log.error(error, `node:net error`)
		this.emit('RCON_ERROR', error)
		if (this.connected$.value) this.connected$.next(false)
	}

	#bufToHexString(buf: Buffer): string {
		return buf.toString('hex').match(/../g)?.join(' ') || ''
	}
}
