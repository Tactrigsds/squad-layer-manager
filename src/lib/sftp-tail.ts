import * as CS from '@/models/context-shared'
import crypto from 'crypto'
import EventEmitter from 'events'
import fs from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { Client, SFTPWrapper } from 'ssh2'

export type SftpTailOptions = {
	username: string
	password: string
	port: number
	host: string
	filePath: string
	pollInterval: number
	reconnectInterval: number
}

// TODO kind of awkward, could simplify the "options" type here
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

	constructor(
		private ctx: CS.Log,
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
	}

	async watch() {
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
		this.ctx.log.info('Starting fetch loop...')
		this.fetchLoopActive = true
		this.fetchLoopPromise = this.fetchLoop()
	}

	async unwatch() {
		this.ctx.log.info('Stopping fetch loop...')
		this.fetchLoopActive = false
		await this.fetchLoopPromise
	}

	async fetchLoop() {
		while (this.fetchLoopActive) {
			try {
				// Store the start time of the loop.
				const fetchStartTime = Date.now()

				try {
					await this.connect()
				} catch (err) {
					this.ctx.log.error(err, 'Failed to connect to SFTP server: %s', (err as any)?.message)
					await this.sleep(this.options.reconnectInterval)
					continue
				}

				// Get the size of the file on the SFTP server.
				this.ctx.log.trace('Fetching size of file...')
				const stats = await this.getFileStats(this.filePath!)
				const fileSize = stats.size
				this.ctx.log.trace({ fileSize }, 'File size retrieved')

				// If the file size has not changed then skip this loop iteration.
				if (fileSize === this.lastByteReceived) {
					this.ctx.log.trace('File has not changed.')
					await this.sleep(this.options.fetchInterval)
					continue
				}

				// If the file has not been tailed before or it has been decreased in size download the last
				// few bytes.
				if (this.lastByteReceived === null || this.lastByteReceived > fileSize) {
					this.ctx.log.debug('File has not been tailed before or has decreased in size.')
					this.lastByteReceived = Math.max(0, fileSize - this.options.tailLastBytes)
				}

				// Download the data to a temp file overwritting any previous data.
				this.ctx.log.trace({ offset: this.lastByteReceived }, 'Downloading file...')
				await this.downloadToFile(this.tmpFilePath!, this.filePath!, this.lastByteReceived!)

				// Update the last byte marker - this is so we can get data since this position on the next
				// SFTP download.
				const downloadSize = fs.statSync(this.tmpFilePath!).size
				this.lastByteReceived += downloadSize
				this.ctx.log.trace({ downloadSize }, 'Downloaded file to %s', this.tmpFilePath!)

				// Get contents of download.
				const data = await readFile(this.tmpFilePath!, 'utf8')

				// Only continue if something was fetched.
				if (data.length === 0) {
					this.ctx.log.trace('No data was fetched.')
					await this.sleep(this.options.fetchInterval)
					continue
				}

				data
					// Remove trailing new lines.
					.replace(/\r?\n$/, '')
					// Split the data on the lines.
					.split(/\r?\n/)
					// Emit each line.
					.forEach((line) => {
						if (!line.trim()) return
						this.ctx.log.trace('Processing line: %s', JSON.stringify(line))
						return this.emit('line', line)
					})

				// Log the loop runtime.
				const fetchEndTime = Date.now()
				const fetchTime = fetchEndTime - fetchStartTime
				this.ctx.log.trace({ fetchTime }, 'Fetch loop completed')

				await this.sleep(this.options.fetchInterval)
			} catch (err) {
				this.emit('error', err)
				this.ctx.log.error(err instanceof Error ? err : { error: String(err) }, 'Error in fetch loop')
			}
		}

		if (this.tmpFilePath && fs.existsSync(this.tmpFilePath)) {
			fs.unlinkSync(this.tmpFilePath)
			this.ctx.log.debug('Deleted temp file.')
		}

		await this.disconnect()
	}

	async connect() {
		if (this.isConnected) return

		this.ctx.log.info('Connecting to SFTP server...')

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
					this.ctx.log.info('Connected to SFTP server.')
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

		this.ctx.log.info('Disconnecting from SFTP server...')
		this.client.end()
		this.isConnected = false
		this.emit('disconnect')
		this.ctx.log.info('Disconnected from SFTP server.')
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
		this.ctx.log.trace({ ms }, 'Sleeping...')
		await new Promise((resolve) => setTimeout(resolve, ms))
	}
}
