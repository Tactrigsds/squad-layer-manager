import { Logger } from '@/server/logger.ts'
import { EventEmitter } from 'node:events'
import net from 'node:net'

export default class Rcon extends EventEmitter {
	private host: string
	private port: number
	private password: string
	private client: net.Socket | null
	private stream: Buffer
	private type: { auth: number; command: number; response: number; server: number }
	private soh: { size: number; id: number; type: number; body: string }
	private connected: boolean
	private autoReconnect: boolean
	private autoReconnectDelay: number
	private connectionRetry: NodeJS.Timeout | undefined
	private msgId: number
	private responseString: { id: number; body: string }

	constructor(
		options: { host: string; port: number; password: string; autoReconnectDelay?: number } = { host: '', port: 0, password: '' },
		public log: Logger
	) {
		super()
		for (const option of ['host', 'port', 'password']) {
			if (!(option in options)) throw new Error(`${option} must be specified.`)
		}
		this.host = options.host
		this.port = options.port
		this.password = options.password
		this.client = null
		this.stream = Buffer.alloc(0)
		this.type = { auth: 0x03, command: 0x02, response: 0x00, server: 0x01 }
		this.soh = { size: 7, id: 0, type: this.type.response, body: '' }
		this.connected = false
		this.autoReconnect = false
		this.autoReconnectDelay = options.autoReconnectDelay || 5000
		this.connectionRetry = undefined
		this.msgId = 20
		this.responseString = { id: 0, body: '' }
	}

	processChatPacket(_decodedPacket: any): void {}

	async connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.client && this.connected && !this.client.destroyed) return reject(new Error('Rcon.connect() Rcon already connected.'))
			this.removeAllListeners('server')
			this.removeAllListeners('auth')
			this.on('server', (pkt) => this.processChatPacket(pkt)).once('auth', () => {
				this.log.info(`Connected to: ${this.host}:${this.port}`)
				clearTimeout(this.connectionRetry)
				this.connected = true
				resolve()
			})
			this.log.info(`Connecting to: ${this.host}:${this.port}`)
			this.connectionRetry = setTimeout(() => this.connect(), this.autoReconnectDelay)
			this.autoReconnect = true
			this.client = net
				.createConnection({ port: this.port, host: this.host }, () => this.#sendAuth())
				.on('data', (data) => this.#onData(data))
				.on('end', () => this.#onClose())
				.on('error', (error) => this.#onNetError(error))
		}).catch((error) => {
			this.log.error(`Rcon.connect() ${error}`)
		})
	}

	async disconnect(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.log.info(`Disconnecting from: ${this.host}:${this.port}`)
			clearTimeout(this.connectionRetry)
			this.removeAllListeners()
			this.autoReconnect = false
			this.client?.end()
			this.connected = false
			resolve()
		}).catch((error) => {
			this.log.error(`Rcon.disconnect() ${error}`)
		})
	}

	async execute(body: string): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.connected) return reject(new Error('Rcon not connected.'))
			if (!this.client?.writable) return reject(new Error('Unable to write to node:net socket.'))
			const string = String(body)
			const length = Buffer.from(string).length
			if (length > 4152) this.log.error(`Error occurred. Oversize, "${length}" > 4152.`)
			else {
				const outputData = (data: any) => {
					clearTimeout(timeOut)
					resolve(data)
				}
				const timedOut = () => {
					this.removeListener(listenerId, outputData)
					return reject(new Error(`Rcon response timed out`))
				}
				if (this.msgId > 80) this.msgId = 20
				const listenerId = `response${this.msgId}`
				const timeOut = setTimeout(timedOut, 10000)
				this.once(listenerId, outputData)
				this.#send(string, this.msgId)
				this.msgId++
			}
		}).catch((error) => {
			this.log.error(`Rcon.execute() ${error}`)
		})
	}

	#sendAuth(): void {
		this.log.info(`Sending Token to: ${this.host}:${this.port}`)
		this.log.debug(`Writing packet with type "${this.type.auth}" and body "${this.password}".`)
		this.client?.write(this.#encode(this.type.auth, 2147483647, this.password).toString('binary'), 'binary')
	}

	#send(body: string, id = 99): void {
		this.#write(this.type.command, id, body)
		this.#write(this.type.command, id + 2)
	}

	#write(type: number, id: number, body?: string): void {
		this.log.debug(`Writing packet with type "${type}", id "${id}" and body "${body || ''}".`)
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

	#onData(data: Buffer): void {
		this.log.debug(`Got data: ${this.#bufToHexString(data)}`)
		this.stream = Buffer.concat([this.stream, data], this.stream.byteLength + data.byteLength)
		while (this.stream.byteLength >= 7) {
			const packet = this.#decode()
			if (!packet) break
			else this.log.debug(`Processing decoded packet: Size: ${packet.size}, ID: ${packet.id}, Type: ${packet.type}, Body: ${packet.body}`)
			if (packet.type === this.type.response) this.#onResponse(packet)
			else if (packet.type === this.type.server) this.emit('server', packet)
			else if (packet.type === this.type.command) this.emit('auth')
		}
	}

	#decode(): { size: number; id: number; type: number; body: string } | null {
		if (
			this.stream[0] === 0 &&
			this.stream[1] === 1 &&
			this.stream[2] === 0 &&
			this.stream[3] === 0 &&
			this.stream[4] === 0 &&
			this.stream[5] === 0 &&
			this.stream[6] === 0
		) {
			this.stream = this.stream.subarray(7)
			return this.soh
		}
		const bufSize = this.stream.readInt32LE(0)
		if (bufSize > 8192 || bufSize < 10) return this.#badPacket()
		else if (bufSize <= this.stream.byteLength - 4) {
			const bufId = this.stream.readInt32LE(4)
			const bufType = this.stream.readInt32LE(8)
			if (this.stream[bufSize + 2] !== 0 || this.stream[bufSize + 3] !== 0 || bufId < 0 || bufType < 0 || bufType > 5)
				return this.#badPacket()
			else {
				const response = { size: bufSize, id: bufId, type: bufType, body: this.stream.toString('utf8', 12, bufSize + 2) }
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
		this.log.error(`Bad packet, clearing: ${this.#bufToHexString(this.stream)} Pending string: ${this.responseString}`)
		this.stream = Buffer.alloc(0)
		this.responseString = { id: 0, body: '' }
		return null
	}

	#onClose(): void {
		this.log.info(`Socket closed.`)
		this.#cleanUp()
	}

	#onNetError(error: Error): void {
		this.log.error(`node:net error:`, error)
		this.emit('RCON_ERROR', error)
		this.#cleanUp()
	}

	#cleanUp(): void {
		this.connected = false
		this.removeAllListeners()
		clearTimeout(this.connectionRetry)
		if (this.autoReconnect) {
			this.log.debug(`Sleeping ${this.autoReconnectDelay}ms before reconnecting.`)
			this.connectionRetry = setTimeout(() => this.connect(), this.autoReconnectDelay)
		}
	}

	#bufToHexString(buf: Buffer): string {
		return buf.toString('hex').match(/../g)?.join(' ') || ''
	}

	async warn(steamID: string, message: string): Promise<void> {
		this.execute(`AdminWarn "${steamID}" ${message}`)
	}

	async kick(steamID: string, reason: string): Promise<void> {
		this.execute(`AdminKick "${steamID}" ${reason}`)
	}

	async forceTeamChange(steamID: string): Promise<void> {
		this.execute(`AdminForceTeamChange "${steamID}"`)
	}
}
