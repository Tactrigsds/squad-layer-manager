import type * as CS from '@/models/context-shared'

import type * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models'
import * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'

import { EventEmitter } from 'node:events'
import net from 'node:net'
import * as Rx from 'rxjs'
import { filterTruthy } from '../async'

export type DecodedPacket = {
	type: number
	size: number
	id: number
	body: string
}

const module = initModule('core-rcon')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

type Events = {
	server: [C.OtelCtx, DecodedPacket]
	auth: []
	[key: `response${string}`]: [string]
	RCON_ERROR: [Error]
}

export default class Rcon extends EventEmitter<Events> {
	serverId: string
	private settings: SS.ServerConnection['rcon']
	private client: net.Socket | null
	private stream: Buffer
	private type: {
		auth: number
		command: number
		response: number
		server: number
	}
	private soh: { size: number; id: number; type: number; body: string }

	public get connected() {
		return this.connected$.value
	}
	public connected$ = new Rx.BehaviorSubject<boolean>(false)

	private autoReconnectDelay: number
	private msgId: number
	private responseString: { id: number; body: string }

	constructor(options: { serverId: string; settings: SS.ServerConnection['rcon']; autoReconnectDelay?: number }) {
		super()
		for (const option of ['host', 'port', 'password']) {
			if (!(option in options.settings)) throw new Error(`${option} must be specified.`)
		}
		this.serverId = options.serverId
		this.settings = options.settings
		this.client = null
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
		const connect = () => {
		}
		const sub = new Rx.Subscription()
		this.ensureConnectedSub = sub
		sub.add(
			Rx.fromEvent(this, 'auth').subscribe(() => {
				log.info('RCON Connected to: %s', `${this.settings.host}:${this.settings.port}`)
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
				log.info('Attempting to connect to RCON: %s', `${this.settings.host}:${this.settings.port}`)
				this.client?.destroy()
				this.client = net
					.createConnection({ port: this.settings.port, host: this.settings.host }, () => this.#sendAuth())
					.on('data', (data) => this.#onData(data))
					.on('end', () => this.#onClose())
					.on('error', (error) => this.#onNetError(error))
				connect()
			}),
		)
	}

	connect() {
		this.ensureConnected()
		return Rx.firstValueFrom(this.connected$.pipe(filterTruthy()))
	}

	disconnect() {
		log.info('Disconnecting from: %s', `${this.settings.host}:${this.settings.port}`)
		this.removeAllListeners()
		this.ensureConnectedSub?.unsubscribe()
		this.ensureConnectedSub = undefined
		this.client?.destroy()
		this.connected$.next(false)
		this.connected$.unsubscribe()
	}

	execute = C.spanOp(
		'execute',
		{ module, levels: { event: 'trace' }, extraText: (body) => body },
		async (body: string): Promise<{ code: 'err:rcon'; msg: string } | { code: 'ok'; data: string }> => {
			if (typeof body !== 'string') {
				throw new Error('Rcon.execute() body must be a string.')
			}
			if (!this.connected) {
				const reconnected$ = this.connected$.pipe(Rx.filter(connected => connected), Rx.take(1))
				const res = await Rx.firstValueFrom(Rx.race([
					reconnected$,
					Rx.timer(2_000).pipe(Rx.map(() => false)),
				]))
				if (!res) return ({ code: 'err:rcon' as const, msg: `Rcon response timed out` })
			}
			if (!this.connected) return { code: 'err:rcon' as const, msg: "Couldn't establish connection with server" }
			if (!this.client?.writable) {
				return { code: 'err:rcon' as const, msg: 'Unable to write to node:net socket.' }
			}
			const length = Buffer.from(body).length
			if (length > SM.RCON_MAX_BUF_LEN) {
				return { code: 'err:rcon' as const, msg: `Oversize, "" > ${SM.RCON_MAX_BUF_LEN}.` }
			} else {
				if (this.msgId > 80) this.msgId = 20
				const listenerId = `response${this.msgId}`
				const timeout$ = Rx.timer(2_000).pipe(Rx.map(() => ({ code: 'err:rcon' as const, msg: `Rcon response timed out` })))
				const response$ = Rx.fromEvent(this, listenerId).pipe(Rx.take(1), Rx.map(data => ({ code: 'ok' as const, data: data as string })))
				log.debug(`Executing %s `, body)
				this.#send(body, this.msgId)
				this.msgId++
				return await Rx.firstValueFrom(Rx.race(timeout$, response$))
			}
		},
	)

	#sendAuth(): void {
		log.trace(`Sending Token to: ${this.settings.host}:${this.settings.port}`)
		log.trace(`Writing packet with type "${this.type.auth}" and body "${this.settings.password}".`)
		this.client?.write(this.#encode(this.type.auth, 2147483647, this.settings.password).toString('binary'), 'binary')
	}

	#send(body: string, id = 99): void {
		this.#write(this.type.command, id, body)
		this.#write(this.type.command, id + 2)
	}

	#write(type: number, id: number, body?: string): void {
		log.trace(`Writing packet with type "${type}", id "${id}" and body "${body || ''}".`)
		this.client?.write(this.#encode(type, id, body).toString('binary'), 'binary')
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

	#onData = C.spanOp('onData', { module, levels: { event: 'trace' }, root: true }, (data: Buffer): void => {
		this.stream = Buffer.concat([this.stream, data], this.stream.byteLength + data.byteLength)
		while (this.stream.byteLength >= 7) {
			const packet = this.#decode()
			if (!packet) break
			else {
				log.trace(`Processing decoded packet: Size: ${packet.size}, ID: ${packet.id}, Type: ${packet.type}, Body: ${packet.body}`)
			}
			if (packet.type === this.type.response) this.#onResponse(packet)
			else if (packet.type === this.type.server) this.emit('server', C.storeLinkToActiveSpan({}, 'event.emitter'), packet)
			else if (packet.type === this.type.command) this.emit('auth')
		}
	})

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
