import { LogAgentClient, type LogAgentOptions } from './log-agent-client'
import { LogFileSink } from './log-file'
import { RconServer } from './rcon-server'
import { World, type WorldOptions } from './world'

export * as Fmt from './format'
export { LogAgentClient } from './log-agent-client'
export { LogFileSink } from './log-file'
export { RconServer } from './rcon-server'
export { makePlayer, World } from './world'
export type { EmuPlayer, WorldOptions } from './world'

export type EmulatorOptions = WorldOptions & {
	password?: string
	rconPort?: number
	// ms until AdminChangeLayer actually travels; the real server takes seconds
	layerChangeDelayMs?: number
	// periodic tick-rate log line, like a real server's constant chatter. Also load-bearing for
	// consumers: parseLogStream only completes an entry once the next one arrives, so a silent
	// server would leave the last event stuck in the parser. 0 disables.
	tickRateIntervalMs?: number
}

// One emulated squad server: a World plus its protocol frontends. Logs go wherever the app is
// configured to read them from: a file it tails (attachLogFile, the `local-file` source) or a push
// into its log receiver (attachLogAgent). Either way the lines are the same.
export class Emulator {
	world: World
	rcon: RconServer
	rconPort!: number
	password: string
	logLines: string[] = []
	#logSubscribers = new Set<(line: string) => void>()
	#layerChangeDelayMs: number
	#timers = new Set<NodeJS.Timeout>()

	constructor(opts: EmulatorOptions = {}) {
		this.password = opts.password ?? 'testpassword'
		this.#layerChangeDelayMs = opts.layerChangeDelayMs ?? 200
		this.world = new World({
			chatPacket: (body) => this.rcon.broadcastChatPacket(body),
			logLine: (line) => {
				this.logLines.push(line)
				for (const sub of this.#logSubscribers) sub(line)
			},
			layerChangeRequested: (layer) => {
				const timer = setTimeout(() => {
					this.#timers.delete(timer)
					this.world.endMatch()
					this.world.startNewGame(layer)
				}, this.#layerChangeDelayMs)
				this.#timers.add(timer)
			},
		}, opts)
		this.rcon = new RconServer(this.world, { password: this.password })

		const tickRateIntervalMs = opts.tickRateIntervalMs ?? 2000
		if (tickRateIntervalMs > 0) {
			const timer = setInterval(() => this.world.reportTickRate(60 + Math.random() * 5), tickRateIntervalMs)
			timer.unref()
			this.#timers.add(timer)
		}
	}

	async start(opts?: { rconPort?: number }): Promise<this> {
		this.rconPort = await this.rcon.listen(opts?.rconPort ?? 0)
		return this
	}

	logFile: LogFileSink | null = null

	// writes every world log line to `path`, for the app's `local-file` log source
	attachLogFile(path: string): LogFileSink {
		const sink = new LogFileSink(path)
		this.logFile = sink
		this.onLogLine((line) => sink.writeLine(line))
		return sink
	}

	logAgent: LogAgentClient | null = null

	// connects the log frontend to the app's squad-logs-receiver and streams every subsequent
	// world log line to it
	async attachLogAgent(opts: LogAgentOptions): Promise<LogAgentClient> {
		const client = new LogAgentClient(opts)
		await client.connect()
		this.logAgent = client
		this.onLogLine((line) => client.writeLine(line))
		return client
	}

	onLogLine(cb: (line: string) => void): () => void {
		this.#logSubscribers.add(cb)
		return () => this.#logSubscribers.delete(cb)
	}

	expectCommand(pattern: RegExp, opts?: { timeoutMs?: number }) {
		return this.rcon.expectCommand(pattern, opts)
	}

	dispose() {
		for (const timer of this.#timers) clearTimeout(timer)
		this.#timers.clear()
		this.logAgent?.destroy()
		this.logFile?.close()
		this.rcon.close()
	}
}
