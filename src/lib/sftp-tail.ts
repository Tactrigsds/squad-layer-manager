import * as CS from '@/models/context-shared'
import * as C from '@/server/context'
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
	tailLastBytes: number
}

export class SftpTail extends EventEmitter {
	private options: FullSftpTailOptions
	private client: Client
	private sftp: SFTPWrapper | null = null
	private filePath: string | null = null
	private lastByteReceived: number | null = null
	private fetchLoopActive = false
	private fetchLoopPromise: Promise<void> | null = null
	private tmpFilePath: string | null = null
	private isConnected = false
	private log: CS.Logger
	private tryRead: (ctx: C.OtelCtx) => Promise<void>

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
		}

		// Setup ssh2 client
		this.client = new Client({ captureRejections: true })
		this.filePath = options.filePath
		this.lastByteReceived = null
		this.fetchLoopActive = false
		this.fetchLoopPromise = null
		const module = getChildModule(options.parentModule, 'sftp-tail')
		this.log = module.getLogger()
		this.tryRead = C.spanOp('tryRead', { module, root: true, levels: { error: 'error', event: 'trace' } }, () => this._tryRead())
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
		// C.setSpanOpAttrs({'

		try {
			await this.connect()
		} catch (err) {
			this.log.error(err, 'Failed to connect to SFTP server: %s', (err as any)?.message)
			await this.sleep(this.options.reconnectInterval)
			return
		}

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
				await this.tryRead(C.storeLinkToActiveSpan(CS.init(), 'event.setup'))
			} catch (err) {
				this.emit('error', err)
			}
		}

		if (this.tmpFilePath && fs.existsSync(this.tmpFilePath)) {
			fs.unlinkSync(this.tmpFilePath)
			this.log.debug('Deleted temp file.')
		}

		await this.disconnect()
	}

	async connect() {
		if (this.isConnected) return

		this.log.info('Connecting to SFTP server...')

		return new Promise<void>((resolve, reject) => {
			this.client.on('ready', () => {
				this.client.sftp((err, sftp) => {
					if (err) {
						reject(err)
						return
					}

					this.sftp = sftp
					this.isConnected = true
					this.emit('connected')
					this.log.info('Connected to SFTP server.')
					resolve()
				})
			})

			this.client.on('error', (err) => {
				this.isConnected = false
				reject(err)
			})

			this.client.connect({
				host: this.options.ftp.host,
				port: this.options.ftp.port,
				username: this.options.ftp.username,
				password: this.options.ftp.password,
				readyTimeout: this.options.ftp.timeout,
			})
		})
	}

	async disconnect() {
		if (!this.isConnected) return

		this.log.info('Disconnecting from SFTP server...')
		this.client.end()
		this.isConnected = false
		this.emit('disconnect')
		this.log.info('Disconnected from SFTP server.')
	}

	async getFileStats(remotePath: string): Promise<fs.Stats> {
		return new Promise((resolve, reject) => {
			if (!this.sftp) {
				return reject(new Error('SFTP not connected'))
			}

			this.sftp.stat(remotePath, (err, stats) => {
				if (err) {
					reject(err)
				} else {
					resolve(stats as unknown as fs.Stats)
				}
			})
		})
	}

	async downloadToFile(localPath: string, remotePath: string, startPosition: number): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.sftp) {
				return reject(new Error('SFTP not connected'))
			}

			const writeStream = fs.createWriteStream(localPath, { flags: 'w' })

			this.sftp.createReadStream(remotePath, { start: startPosition })
				.on('error', (err: any) => {
					writeStream.close()
					reject(err)
				})
				.pipe(writeStream)
				.on('error', (err) => {
					writeStream.close()
					reject(err)
				})
				.on('finish', () => {
					resolve()
				})
		})
	}

	async sleep(ms: number) {
		this.log.trace({ ms }, 'Sleeping...')
		await new Promise((resolve) => setTimeout(resolve, ms))
	}
}
