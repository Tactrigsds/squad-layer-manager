import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import BasePlugin from './base-plugin.js'

export default class SLMLogAgent extends BasePlugin {
	static get description() {
		return 'Send logs to Squad Layer Manager http://github.com/Tactrigsds/squad-layer-manager/'
	}

	static get defaultEnabled() {
		return true
	}

	static get optionsSpecification() {
		return {
			host: {
				required: false,
				description: 'The host to connect to',
				default: 'localhost',
			},
			port: {
				required: false,
				description: 'The port to connect to',
				default: 8443,
			},
			pidFile: {
				required: false,
				description: 'Path to the PID file',
				default: '/tmp/slm-agent-daemon.pid',
			},
			logFile: {
				required: false,
				description: 'Path to the log file',
				default: '/tmp/slm-agent-daemon.log',
			},
			killOnExit: {
				required: false,
				description: 'Kill the daemon when the plugin unmounts',
				default: true,
			},
			slmServerId: {
				required: true,
				description: 'ID of the server as configured in Squad Layer Manager',
			},
			token: {
				required: true,
				description: 'Authentication token for Squad Layer Manager',
			},
			tls: {
				required: false,
				description: 'Use TLS for secure connection',
				default: false,
			},
			rejectUnauthorized: {
				required: false,
				description: 'Reject unauthorized TLS certificates',
				default: true,
			},
		}
	}

	constructor(server, options, connectors) {
		super(server, options, connectors)
		this.tailProcess = null
	}

	async mount() {
		this.cleanup = []
		if (existsSync(this.options.pidFile)) {
			try {
				const pid = parseInt(readFileSync(this.options.pidFile, 'utf8'))
				// Check if process exists
				process.kill(pid, 0)
				// already running, tail the log file
				this.verbose(1, `Daemon already running with PID: ${pid}`)
				if (this.options.killOnExit) {
					this.cleanup.push(() => {
						this.verbose(1, `Killing daemon with PID: ${pid}`)
						process.kill(pid, 'SIGTERM')
						unlinkSync(this.options.pidFile)
					})
				}
				this.tailAgentLogFile()
				return
			} catch (e) {
				// Process doesn't exist, clean up stale PID file
				try {
					unlinkSync(this.options.pidFile)
				} catch {}
			}
		}

		this.tailAgentLogFile()

		const args = [
			'./squad-server/plugins/log-agent/log-agent.js',
			'--file',
			path.join(this.server.options.logDir, 'SquadGame.log'),
			'--host',
			this.options.host,
			'--port',
			this.options.port,
			'--logfile',
			this.options.logFile,
			'--serverId',
			this.options.slmServerId,
			'--daemon',
		]

		// Add token
		args.push('--token', this.options.token)

		// Add TLS options
		if (this.options.tls) {
			args.push('--tls')
		}

		if (!this.options.rejectUnauthorized) {
			args.push('--rejectUnauthorized=false')
		}

		this.verbose(1, `Starting daemon: node ${args.join(' ')}`)

		const child = spawn('node', args, {
			detached: !this.options.killOnExit,
			stdio: 'ignore',
			cwd: process.cwd(),
		})

		// Write PID file
		writeFileSync(this.options.pidFile, child.pid.toString())

		// Monitor daemon process exit
		child.on('exit', (code, signal) => {
			if (code !== null) {
				this.verbose(1, `Daemon exited with code ${code}`)
			} else if (signal !== null) {
				this.verbose(1, `Daemon killed by signal ${signal}`)
			}
		})

		if (!this.options.killOnExit) {
			child.unref()
		} else {
			// Unref allows parent to exit independently
			this.cleanup.push(() => child.kill('SIGTERM'))
		}

		this.verbose(1, `Daemon started with PID: ${child.pid}`)
	}

	tailAgentLogFile() {
		this.tailProcess = spawn('tail', ['-f', '-n', '0', this.options.logFile])

		this.tailProcess.stdout.on('data', (data) => {
			const lines = data.toString().trim().split('\n')
			for (const line of lines) {
				if (line.includes('[ERROR]')) {
					const msg = line.replace(/^\[ERROR\]\s*\S+\s*/, '')
					this.verbose(1, `agent: ${msg}`)
				} else if (line.includes('[LOG]')) {
					const msg = line.replace(/^\[LOG\]\s*\S+\s*/, '')
					this.verbose(1, `agent: ${msg}`)
				}
			}
		})
		this.verbose(1, `Tailing log file ${this.options.logFile}`)

		this.tailProcess.on('error', (err) => {
			this.verbose(2, `Failed to tail log file: ${err.message}`)
		})

		this.cleanup.push(() => {
			this.tailProcess.kill()
		})
	}

	async unmount() {
		for (const cleanupFn of this.cleanup) {
			await cleanupFn()
		}
	}
}
