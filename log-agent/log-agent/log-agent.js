import { spawn } from 'child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import { parseArgs } from 'node:util'

const VERSION = '0.0.1'
const APP_NAME = 'slm-log-agent@' + VERSION

/**
 * @typedef {Object} StreamOptions
 * @property {string} host - The server host to connect to
 * @property {number} port - The server port to connect to
 * @property {string} filePath - The file path to stream
 * @property {number} [reconnectDelay] - Delay in ms before reconnecting (default: 5000)
 */

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		host: { type: 'string', default: 'localhost' },
		port: { type: 'string', default: '8443' },
		file: { type: 'string' },
		logfile: { type: 'string' },
		daemon: { type: 'boolean', default: false },
		reconnectDelay: { type: 'string', default: '5000' },
		serverId: { type: 'string' },
	},
})

// Set up logging to file if specified
let logStream = null
if (values.logfile) {
	logStream = fs.createWriteStream(values.logfile, { flags: 'a' })
	const originalConsoleLog = console.log
	const originalConsoleError = console.error

	console.log = (...args) => {
		const msg = args.join(' ')
		logStream.write(`[LOG] ${new Date().toISOString()} ${msg}\n`)
		originalConsoleLog(...args)
	}

	console.error = (...args) => {
		const msg = args.join(' ')
		logStream.write(`[ERROR] ${new Date().toISOString()} ${msg}\n`)
		originalConsoleError(...args)
	}
}

// console.log('starting

if (!values.file) {
	console.error('Error: --file option is required')
	process.exit(1)
}

console.log(`Starting ${APP_NAME} with PID ${process.pid}. Daemon mode: ${values.daemon}`)

/** @type {StreamOptions} */
const streamOptions = {
	host: values.host,
	port: parseInt(values.port),
	filePath: values.file,
	reconnectDelay: parseInt(values.reconnectDelay),
}

const shutdown = streamFileOverTCP(streamOptions)

if (values.daemon) {
	const PID_FILE = '/tmp/my-daemon.pid'
	fs.writeFileSync(PID_FILE, process.pid.toString())
	const signals = ['SIGINT', 'SIGTERM']
	for (let i = 0; i < signals.length; i++) {
		process.on(signals[i], () => {
			shutdown()
			if (logStream) {
				logStream.end()
			}
			fs.rm(PID_FILE)
			process.exit(0)
		})
	}
}

/**
 * Streams a file over TCP to a remote server
 * @param {StreamOptions}
 * @returns {Function} Shutdown function
 */
function streamFileOverTCP(options) {
	const {
		host,
		port,
		filePath,
		reconnectDelay,
	} = options

	/** @type {import('child_process').ChildProcess | null} */
	let tail = null
	/** @type {import('net').Socket | null} */
	let socket = null
	/** @type {NodeJS.Timeout | null} */
	let reconnectTimer = null
	/** @type {NodeJS.Timeout | null} */
	let statsTimer = null
	let isShuttingDown = false
	let reconnectAttempts = 0
	let bytesSent = 0
	let lastReportedBytes = 0
	let connectionStartTime = 0

	function cleanup() {
		if (tail) {
			tail.stdout?.removeAllListeners()
			tail.removeAllListeners()
			tail.kill()
			tail = null
		}

		if (socket) {
			socket.removeAllListeners()
			socket.destroy()
			socket = null
		}

		if (reconnectTimer) {
			clearTimeout(reconnectTimer)
			reconnectTimer = null
		}

		if (statsTimer) {
			clearInterval(statsTimer)
			statsTimer = null
		}
	}

	function connect() {
		if (isShuttingDown) return
		console.log(`Connecting to log receiver at ${host}:${port} ...`)

		socket = net.connect({ host, port }, () => {
			console.log(`Connected`)
			reconnectAttempts = 0 // Reset on successful connection
			bytesSent = 0
			lastReportedBytes = 0
			connectionStartTime = Date.now()

			// Send version string to server
			socket?.write(`${APP_NAME}:${values.serverId}\n`)

			// Start periodic stats reporting
			statsTimer = setInterval(() => {
				const bytesSinceLastReport = bytesSent - lastReportedBytes
				const uptimeSeconds = Math.floor((Date.now() - connectionStartTime) / 1000)
				const hours = Math.floor(uptimeSeconds / 3600)
				const minutes = Math.floor((uptimeSeconds % 3600) / 60)
				const seconds = uptimeSeconds % 60
				const uptimeStr = `${hours}h ${minutes}m ${seconds}s`
				console.log(`Uptime: ${uptimeStr} | Sent ${bytesSent} bytes total (${bytesSinceLastReport} bytes since last report)`)
				lastReportedBytes = bytesSent
			}, 60000) // Report every 60 seconds
		})

		// Wait for server to send the last known offset
		socket.once('data', (data) => {
			const offsetStr = data.toString().trim()

			// Validate the offset string matches tail's conventions
			// Can be: "+123" (from start), "123" (from end), or "0" (only new data)
			if (!/^[+-]?\d+$/.test(offsetStr)) {
				console.error('Invalid offset received from server:', offsetStr)
				socket?.end()
				return
			}

			console.log(`Server requested offset: ${offsetStr}`)

			// Use tail -c with the offset string directly
			// tail conventions:
			// - "+N" = start from byte N (1-based)
			// - "N" = last N bytes
			// - "0" = no initial output, only new data
			tail = spawn('tail', ['-f', '-c', offsetStr, filePath])

			tail.stdout?.on('data', (data) => {
				if (socket && socket.writable) {
					const canWrite = socket.write(data)
					bytesSent += data.length

					if (!canWrite && tail?.stdout?.readable) {
						tail.stdout.pause()
						console.log('Backpressure: paused tail')

						socket.once('drain', () => {
							console.log('Backpressure: resumed tail')
							tail?.stdout?.resume()
						})
					}
				}
			})

			tail.stderr?.on('data', (data) => {
				console.error(`tail stderr: ${data}`)
			})

			tail.on('error', (err) => {
				console.error('Tail process error:', err)
				socket?.end()
			})
		})

		socket.on('close', () => {
			console.log('Socket closed')
			cleanup()

			if (!isShuttingDown) {
				reconnectAttempts++
				console.log(`Reconnecting in ${reconnectDelay}ms... (attempt ${reconnectAttempts})`)
				reconnectTimer = setTimeout(connect, reconnectDelay)
			}
		})

		socket.on('error', (err) => {
			console.error('Socket error:', err.message)
			console.error('Stack:', err.stack)

			// Log inner errors if this is an AggregateError
			if (err.errors && Array.isArray(err.errors)) {
				console.error('Inner errors:')
				for (let i = 0; i < err.errors.length; i++) {
					const innerErr = err.errors[i]
					console.error(`  [${i}] ${innerErr.message}`)
					console.error(`      Stack: ${innerErr.stack}`)
				}
			}

			cleanup()

			if (!isShuttingDown) {
				console.log(`Reconnecting in ${reconnectDelay}ms... (attempt ${reconnectAttempts})`)
				reconnectTimer = setTimeout(connect, reconnectDelay)
			}
		})
	}

	connect()

	return () => {
		console.log('Shutting down...')
		isShuttingDown = true
		cleanup()
	}
}
