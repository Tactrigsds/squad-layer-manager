import type * as CS from '@/models/context-shared'
import crypto from 'crypto'
import EventEmitter from 'events'
import fs from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import type { SFTPWrapper } from 'ssh2'
import { Client } from 'ssh2'
import { getChildModule, type OtelModule } from './otel'

export type SftpTailOptions = {
	username: string
	password: string
	port: number
	host: string
	filePath: string
	pollInterval: number
	reconnectInterval: number
	// how many consecutive failures (each followed by a reconnect attempt) to tolerate before giving up
	maxReconnectAttempts: number
	// invoked when reconnection attempts are exhausted. the fetch loop stops itself before this fires, so the
	// handler is responsible for tearing down whatever owns this tail. we deliberately do NOT emit an 'error'
	// event for this: an EventEmitter 'error' with no listener crashes the process.
	onFatalError: (err: unknown) => void | Promise<void>

	parentModule: OtelModule
}

// TODO kind of awkward, could simplify the "options" type here. also we should thread context in through method params like we do elsewhere, and include context with events
type FullSftpTailOptions = {
	ftp: {
		encoding: 'utf-8'
		timeout: number
		port: number
		host: string
		filePath: string
		username: string
		password: string
	}
	fetchInterval: number
	reconnectInterval: number
	maxReconnectAttempts: number
	onFatalError: (err: unknown) => void | Promise<void>
	tailLastBytes: number
}

export class SftpTail extends EventEmitter {
	private options: FullSftpTailOptions
	private client: Client | null = null
	private sftp: SFTPWrapper | null = null
	private filePath: string | null = null
	private lastByteReceived: number | null = null
	private fetchLoopActive = false
	private fetchLoopPromise: Promise<void> | null = null
	private tmpFilePath: string | null = null
	private isConnected = false
	private consecutiveFailures = 0
	private log: CS.Logger

	constructor(
		options: SftpTailOptions,
	) {
		super()

		// Set default options.
		this.options = {
			ftp: { ...options, encoding: 'utf-8', timeout: 10 * 1000 },
			fetchInterval: options.pollInterval,
			tailLastBytes: 0,
			reconnectInterval: options.reconnectInterval,
			maxReconnectAttempts: options.maxReconnectAttempts,
			onFatalError: options.onFatalError,
		}

		this.filePath = options.filePath
		this.lastByteReceived = null
		this.fetchLoopActive = false
		this.fetchLoopPromise = null
		const module = getChildModule(options.parentModule, 'sftp-tail')
		this.log = module.getLogger()
	}

	watch() {
		// Setup temp file.
		this.tmpFilePath = path.join(
			'/tmp/',
			'slm-' + crypto
				.createHash('md5')
				.update(`${this.options.ftp.host}:${this.options.ftp.port}:${this.filePath}`)
				.digest('hex')
				+ '.log',
		)

		// Start fetch loop.
		this.log.info('Starting fetch loop...')
		this.fetchLoopActive = true
		this.fetchLoopPromise = this.fetchLoop()
	}

	async unwatch() {
		this.log.info('Stopping fetch loop...')
		this.fetchLoopActive = false
		await this.fetchLoopPromise
	}

	async _tryRead() {
		// Store the start time of the loop.
		const fetchStartTime = Date.now()

		// Connection failures are handled by the fetch loop's retry/reconnect logic, so let them propagate.
		await this.connect()

		// Get the size of the file on the SFTP server.
		this.log.trace('Fetching size of file...')
		const stats = await this.getFileStats(this.filePath!)
		const fileSize = stats.size
		this.log.trace({ fileSize }, 'File size retrieved')

		// If the file size has not changed then skip this loop iteration.
		if (fileSize === this.lastByteReceived) {
			this.log.trace('File has not changed.')
			await this.sleep(this.options.fetchInterval)
			return
		}

		// If the file has not been tailed before or it has been decreased in size download the last
		// few bytes.
		if (this.lastByteReceived === null || this.lastByteReceived > fileSize) {
			this.log.debug('File has not been tailed before or has decreased in size.')
			this.lastByteReceived = Math.max(0, fileSize - this.options.tailLastBytes)
		}

		// Download the data to a temp file overwritting any previous data.
		this.log.trace({ offset: this.lastByteReceived }, 'Downloading file...')
		await this.downloadToFile(this.tmpFilePath!, this.filePath!, this.lastByteReceived!)

		// Update the last byte marker - this is so we can get data since this position on the next
		// SFTP download.
		const downloadSize = fs.statSync(this.tmpFilePath!).size
		this.lastByteReceived += downloadSize
		this.log.trace({ downloadSize }, 'Downloaded file to %s', this.tmpFilePath!)

		// Get contents of download.
		const chunk = await readFile(this.tmpFilePath!, 'utf8')

		// Only return if something was fetched.
		if (chunk.length === 0) {
			this.log.trace('No data was fetched.')
			await this.sleep(this.options.fetchInterval)
			return
		}

		this.emit('chunk', chunk)

		// Log the loop runtime.
		const fetchEndTime = Date.now()
		const fetchTime = fetchEndTime - fetchStartTime
		this.log.trace('Fetch loop completed in %s ms', fetchTime)
		await this.sleep(this.options.fetchInterval)
	}

	async fetchLoop() {
		while (this.fetchLoopActive) {
			try {
				await this._tryRead()
				this.consecutiveFailures = 0
			} catch (err) {
				this.consecutiveFailures++
				// tear down the dead connection so the next iteration reconnects from scratch
				this.resetClient()

				if (this.consecutiveFailures >= this.options.maxReconnectAttempts) {
					this.log.error(
						err,
						'SFTP tail failed %d times consecutively, giving up.',
						this.consecutiveFailures,
					)
					this.fetchLoopActive = false
					// hand off to the owner to tear things down. we can't await it: the owner's teardown typically
					// calls unwatch(), which awaits this very loop. fire-and-forget, and guard against a throwing or
					// rejecting handler so we don't resurrect the very crash we're trying to prevent.
					try {
						void Promise.resolve(this.options.onFatalError(err)).catch((handlerErr) => {
							this.log.error(handlerErr, 'SFTP tail onFatalError handler rejected.')
						})
					} catch (handlerErr) {
						this.log.error(handlerErr, 'SFTP tail onFatalError handler threw.')
					}
					break
				}

				this.log.warn(
					err,
					'SFTP tail error (attempt %d/%d), reconnecting in %d ms...',
					this.consecutiveFailures,
					this.options.maxReconnectAttempts,
					this.options.reconnectInterval,
				)
				await this.sleep(this.options.reconnectInterval)
			}
		}

		if (this.tmpFilePath && fs.existsSync(this.tmpFilePath)) {
			fs.unlinkSync(this.tmpFilePath)
			this.log.debug('Deleted temp file.')
		}

		await this.disconnect()
	}

	async connect() {
		if (this.isConnected && this.client && this.sftp) return

		// clear out any half-open state from a previous attempt before starting a fresh one
		this.resetClient()

		this.log.info('Connecting to SFTP server...')

		const client = new Client({ captureRejections: true })
		this.client = client

		try {
			await new Promise<void>((resolve, reject) => {
				const onConnectError = (err: Error) => reject(err)
				client.once('error', onConnectError)
				client.once('ready', () => {
					client.sftp((err, sftp) => {
						if (err) {
							reject(err)
							return
						}
						// swap the connect-phase error handler for a persistent one: a socket error after we're
						// connected drops the channel, so reset our state and let the fetch loop reconnect.
						client.removeListener('error', onConnectError)
						client.on('error', (e) => {
							this.log.warn(e, 'SFTP connection error, will reconnect.')
							this.resetClient()
						})
						this.sftp = sftp
						this.isConnected = true
						resolve()
					})
				})

				client.connect({
					host: this.options.ftp.host,
					port: this.options.ftp.port,
					username: this.options.ftp.username,
					password: this.options.ftp.password,
					readyTimeout: this.options.ftp.timeout,
				})
			})
		} catch (err) {
			this.resetClient()
			throw err
		}

		this.emit('connected')
		this.log.info('Connected to SFTP server.')
	}

	// tears down the underlying ssh2 client and clears connection state without emitting a 'disconnect' event.
	// safe to call repeatedly and when already disconnected.
	private resetClient() {
		const client = this.client
		this.client = null
		this.sftp = null
		this.isConnected = false
		if (client) {
			client.removeAllListeners()
			// keep a no-op 'error' listener so a late socket error emitted during teardown doesn't become an
			// unhandled 'error' event and crash the process.
			client.on('error', () => {})
			try {
				client.end()
			} catch {
				// client may already be torn down; nothing to do
			}
		}
	}

	async disconnect() {
		if (!this.isConnected && !this.client) return

		this.log.info('Disconnecting from SFTP server...')
		this.resetClient()
		this.emit('disconnect')
		this.log.info('Disconnected from SFTP server.')
	}

	async getFileStats(remotePath: string): Promise<fs.Stats> {
		const sftp = this.sftp
		if (!sftp) throw new Error('SFTP not connected')
		return this.withTimeout(
			'stat',
			new Promise<fs.Stats>((resolve, reject) => {
				sftp.stat(remotePath, (err, stats) => {
					if (err) {
						reject(err)
					} else {
						resolve(stats as unknown as fs.Stats)
					}
				})
			}),
		)
	}

	async downloadToFile(localPath: string, remotePath: string, startPosition: number): Promise<void> {
		const sftp = this.sftp
		if (!sftp) throw new Error('SFTP not connected')

		return new Promise((resolve, reject) => {
			const writeStream = fs.createWriteStream(localPath, { flags: 'w' })
			const readStream = sftp.createReadStream(remotePath, { start: startPosition })

			let settled = false
			const finish = (err?: Error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (err) {
					readStream.destroy()
					writeStream.destroy()
					reject(err)
				} else {
					resolve()
				}
			}

			// a hung transfer would otherwise block the fetch loop until the channel closes ("No response from
			// server"); bound it so we can reconnect instead.
			const timer = setTimeout(
				() => finish(new Error(`SFTP download timed out after ${this.options.ftp.timeout} ms`)),
				this.options.ftp.timeout,
			)

			readStream.on('error', (err: Error) => finish(err))
			writeStream.on('error', (err) => finish(err))
			writeStream.on('finish', () => finish())
			readStream.pipe(writeStream)
		})
	}

	// bounds a pending SFTP operation so a hung request rejects instead of hanging until the channel closes.
	private async withTimeout<T>(op: string, p: Promise<T>): Promise<T> {
		let timer: NodeJS.Timeout | undefined
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`SFTP operation "${op}" timed out after ${this.options.ftp.timeout} ms`)),
				this.options.ftp.timeout,
			)
		})
		try {
			return await Promise.race([p, timeout])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	async sleep(ms: number) {
		this.log.trace({ ms }, 'Sleeping...')
		await new Promise((resolve) => setTimeout(resolve, ms))
	}
}
