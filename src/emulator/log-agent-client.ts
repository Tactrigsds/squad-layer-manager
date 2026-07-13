import * as net from 'node:net'

// Log frontend: speaks the slm-log-agent push protocol to the app's squad-logs-receiver
// (src/systems/squad-logs-receiver.server.ts). Handshake is `slm-log-agent@<ver>:<serverId>:<token>\n`;
// the receiver replies with the byte offset it wants (`0` or `+N`), after which everything
// written on the socket is raw SquadGame.log content.

export type LogAgentOptions = {
	host: string
	port: number
	serverId: string
	token: string
	version?: string
}

export class LogAgentClient {
	#opts: Required<LogAgentOptions>
	#socket: net.Socket | null = null
	#ready = false
	#pending: string[] = []

	constructor(opts: LogAgentOptions) {
		this.#opts = { version: '1.0.0', ...opts }
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ host: this.#opts.host, port: this.#opts.port })
			this.#socket = socket
			socket.once('error', reject)
			socket.once('connect', () => {
				socket.write(`slm-log-agent@${this.#opts.version}:${this.#opts.serverId}:${this.#opts.token}\n`)
			})
			// first line back is the requested offset; we always stream from "now", so its value is
			// only consumed as a go-ahead
			socket.once('data', () => {
				this.#ready = true
				for (const line of this.#pending) socket.write(line)
				this.#pending = []
				socket.removeListener('error', reject)
				resolve()
			})
			socket.once('close', () => {
				this.#ready = false
			})
		})
	}

	get connected() {
		return this.#ready && this.#socket !== null && !this.#socket.destroyed
	}

	writeLine(line: string) {
		const data = line.endsWith('\n') ? line : line + '\n'
		if (!this.#ready || !this.#socket || this.#socket.destroyed) {
			this.#pending.push(data)
			return
		}
		this.#socket.write(data)
	}

	// abruptly drops the connection, for fault-injection scenarios
	destroy() {
		this.#socket?.destroy()
		this.#socket = null
		this.#ready = false
	}
}
