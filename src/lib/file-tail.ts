import EventEmitter from 'node:events'
import * as fsp from 'node:fs/promises'
import { getChildModule, type OtelModule } from './otel'

// Tails a SquadGame.log on the local filesystem, emitting 'chunk' events as the file grows.
// Same shape as SftpTail, so squad-server's log pipeline treats the two interchangeably.
//
// Intended for a squad server running on the same host (or with its log directory mounted), and
// for the emulator in tests. Truncation/rotation is handled by restarting from the top of the new
// file, which is what happens when the game rolls its log over.

export type FileTailOptions = {
	filePath: string
	// how often to check the file for growth. fs.watch would be lighter but is unreliable across
	// platforms and network mounts, and the log is appended to constantly anyway.
	pollInterval: number
	// on first read, start this far back from the end rather than replaying the whole file
	tailLastBytes?: number
	onFatalError?: (err: unknown) => void | Promise<void>
	parentModule: OtelModule
}

const DEFAULT_TAIL_LAST_BYTES = 0

export class FileTail extends EventEmitter {
	private options: FileTailOptions
	private lastByteReceived: number | null = null
	private active = false
	private loopPromise: Promise<void> | null = null
	private log: ReturnType<OtelModule['getLogger']>

	constructor(options: FileTailOptions) {
		super()
		this.options = options
		this.log = getChildModule(options.parentModule, 'file-tail').getLogger()
	}

	watch() {
		if (this.active) return
		this.active = true
		this.loopPromise = this.loop()
	}

	async unwatch() {
		this.active = false
		await this.loopPromise
	}

	private async loop() {
		while (this.active) {
			try {
				await this.tryRead()
			} catch (err) {
				// a missing file is expected while the server is starting up (or the emulator hasn't
				// written yet); anything else is worth surfacing but not worth dying over
				if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
					this.log.error(err, 'error reading log file %s', this.options.filePath)
					await this.options.onFatalError?.(err)
					return
				}
			}
			await new Promise((resolve) => setTimeout(resolve, this.options.pollInterval))
		}
	}

	private async tryRead() {
		const stats = await fsp.stat(this.options.filePath)
		const fileSize = stats.size

		if (this.lastByteReceived === null) {
			const tailLastBytes = this.options.tailLastBytes ?? DEFAULT_TAIL_LAST_BYTES
			this.lastByteReceived = Math.max(0, fileSize - tailLastBytes)
		}

		// truncated or rotated under us: the offset we held no longer points where we think, so start over
		if (this.lastByteReceived > fileSize) {
			this.log.info('log file shrank (rotated or truncated), restarting from its start')
			this.lastByteReceived = 0
		}

		if (this.lastByteReceived === fileSize) return

		const handle = await fsp.open(this.options.filePath, 'r')
		try {
			const length = fileSize - this.lastByteReceived
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, this.lastByteReceived)
			if (bytesRead === 0) return
			this.lastByteReceived += bytesRead
			this.emit('chunk', buffer.subarray(0, bytesRead).toString('utf8'))
		} finally {
			await handle.close()
		}
	}

	// exposed for tests/tools that want to know where the tail is
	get offset(): number | null {
		return this.lastByteReceived
	}
}
