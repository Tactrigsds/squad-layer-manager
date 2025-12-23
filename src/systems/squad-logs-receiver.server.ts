import { CleanupTasks } from '@/lib/async'
import { CONFIG } from '@/server/config'
import * as Env from '@/server/env'
import { baseLogger } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as net from 'node:net'
import { parseArgs } from 'node:util'
import * as Rx from 'rxjs'

const VERSION = '0.0.1'

type ServerOptions = {
	port: number
	host?: string
}

type ClientConnection = {
	clientId: string
	socket: net.Socket
	version?: string
	serverId?: string
	offset?: string
}

export type ReceiverEvent = {
	type: 'connected'
	client: ClientConnection
	time: number
} | {
	type: 'disconnected'
	client: ClientConnection
	time: number
} | {
	type: 'data'
	client: ClientConnection
	data: string
	time: number
}
const envBuilder = Env.getEnvBuilder({ ...Env.groups.squadLogsReceiver, ...Env.groups.httpServer })
let ENV!: ReturnType<typeof envBuilder>

export const event$ = new Rx.Subject<ReceiverEvent>()

export function setup() {
	ENV = envBuilder()
	const ctx = { log: baseLogger }
	ctx.log.info('Setting up log receiver')
	if (!CONFIG.servers.some(s => s.connections.logs.type === 'log-receiver')) {
		ctx.log.info('No log receiver configured, skipping setup')
		return
	}

	const clients = new Map<string, ClientConnection>()
	let currentOffset = 0 // Track the current byte offset we've received

	const server = net.createServer((socket) => {
		const clientId = `${socket.remoteAddress}:${socket.remotePort}`
		ctx.log.info(`Client connected: ${clientId}`)

		const client: ClientConnection = {
			clientId,
			socket,
		}

		socket.once('data', (data: Buffer) => {
			const versionStr = data.toString().trim()

			// Extract version, serverId, and optional token
			const match = versionStr.match(/^slm-log-agent@(\d+\.\d+\.\d+):([\w-]+)(?::(.+))?$/)
			if (!match) {
				ctx.log.error(`Failed to parse version string from ${clientId}: ${versionStr}`)
				socket.end()
				return
			}

			const [, version, serverId, receivedToken] = match
			client.version = version
			client.serverId = serverId

			if (clients.has(serverId)) {
				ctx.log.error(`Duplicate serverId ${serverId} from ${clientId}`)
				socket.end()
				return
			}

			// Validate token
			const serverConfig = CONFIG.servers.find(s => s.id === serverId)
			if (!serverConfig) {
				ctx.log.error(`Unknown serverId ${serverId} from ${clientId}`)
				socket.end()
				return
			}

			if (serverConfig.connections.logs.type !== 'log-receiver') {
				ctx.log.error(`Server ${serverId} is not configured for log-receiver`)
				socket.end()
				return
			}

			const expectedToken = serverConfig.connections.logs.token
			if (expectedToken !== receivedToken) {
				ctx.log.error(`Invalid token for serverId ${serverId} from ${clientId}`)
				socket.end()
				return
			}

			clients.set(serverId, client)
			event$.next({
				type: 'connected',
				client,
				time: Date.now(),
			})

			ctx.log.info(`Client ${clientId} version: ${version}, serverId: ${serverId}`)

			// Send the current offset to the client
			// For now, always request new data
			const offsetToSend = currentOffset === 0 ? '0' : `+${currentOffset + 1}`
			client.offset = offsetToSend
			ctx.log.info(`Sending offset to client: ${offsetToSend}`)
			socket.write(`${offsetToSend}\n`)

			// Now start receiving log data
			socket.on('data', (chunk: Buffer) => {
				// Update our offset
				currentOffset += chunk.length

				// Validate that the chunk is valid UTF-8
				const data = chunk.toString('utf-8')
				const reencoded = Buffer.from(data, 'utf-8')
				if (!chunk.equals(reencoded)) {
					ctx.log.error(`Invalid UTF-8 data from ${clientId}, skipping chunk`)
					return
				}

				event$.next({
					type: 'data',
					client,
					time: Date.now(),
					data,
				})
			})
		})

		socket.on('error', (err) => {
			ctx.log.error(err, `Socket error for ${clientId}`)
		})

		socket.on('close', () => {
			if (client.serverId) {
				clients.delete(client.serverId)
				event$.next({
					type: 'disconnected',
					client,
					time: Date.now(),
				})
			}
		})
	})

	server.listen(ENV.SQUAD_LOGS_RECEIVER_PORT, ENV.HOST, () => {
		ctx.log.info(`Log receiver listening on ${ENV.HOST}:${ENV.SQUAD_LOGS_RECEIVER_PORT}`)
	})

	server.on('error', (err) => {
		ctx.log.error(err, 'Receiver server error')
	})

	CleanupSys.register(() => {
		for (const client of clients.values()) {
			client.socket.end()
		}
		server.close(() => {
			ctx.log.error('Receiver server closed')
		})
	})
}
