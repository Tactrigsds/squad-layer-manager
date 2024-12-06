// This file controls the host process for the server in prod mode. It ensures that the server keeps running and writes incoming logs from stdout and stderr, while ensuring that all lines that are output to the logfile are valid json. If we decide to add some other logging  or telemetry integration, this is the place to do it
import { exec } from 'node:child_process'
import { PROJECT_ROOT_DIR, setupConfig } from '@/server/config'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as fsOld from 'node:fs'
import { setupEnv } from '@/server/env'
import { Mutex } from 'async-mutex'

const mainPath = path.join(PROJECT_ROOT_DIR, 'src/server/main.ts')
setupEnv()
// we don't need this, just calling it to check for errors before starting the server process
setupConfig()

let restartAttempts = 0
const MAX_RESTART_DELAY = 1000 * 60 * 5 // 5 minutes

// done separately from rest of env because we don't need this in the server process
if (!process.env.LOG_PATH) {
	process.stderr.write('LOG_PATH not set\n')
	process.exit(1)
}
if (!fsOld.existsSync(process.env.LOG_PATH)) {
	process.stderr.write(`LOG_PATH ${process.env.LOG_PATH} does not exist\n`)
	process.exit(1)
}

function startServer() {
	const child = exec(`tsx ${mainPath}`, { env: process.env })
	let lastRestartTime = Date.now()

	// unsure if this is necessary
	const logMtx = new Mutex()
	const writeLog = (data: string) => {
		logMtx.runExclusive(async () => {
			fs.appendFile(process.env.LOG_PATH!, data).catch(() => {})
		})
	}

	child.stdout?.on('data', (data: string) => {
		try {
			for (let line of data.trim().split('\n')) {
				line = line.trim()
				JSON.parse(line)
				const logLine = (line += '\n')
				process.stdout.write(logLine)
				writeLog(logLine)
			}
		} catch (e) {
			const output = JSON.stringify({ message: 'error while parsing log entries', error: e, data }) + '\n'
			process.stderr.write(output)
			writeLog(output)
		}
	})

	child.stderr?.on('data', (data: string) => {
		try {
			for (let line of data.split('\n')) {
				line = line.trim()
				if (!line) continue
				JSON.parse(line)
				const logLine = line + '\n'
				process.stderr.write(logLine)
				writeLog(logLine)
			}
		} catch (e) {
			const error = JSON.stringify({ message: 'error while parsing log entries', error: e, data }) + '\n'
			process.stderr.write(error)
			writeLog(error)
		}
	})

	child.on('exit', (code) => {
		if (code == 0) process.exit(0)
		const now = Date.now()
		if (now - lastRestartTime > 10 * 60 * 1000) {
			restartAttempts = 0
		}
		lastRestartTime = now

		const delay = Math.min(1000 * Math.pow(2, restartAttempts), MAX_RESTART_DELAY)
		const delaySeconds = delay / 1000
		const msg = JSON.stringify({ message: `Server exited with code ${code}, restarting in ${delaySeconds} seconds` })
		process.stderr.write(msg)
		writeLog(msg)
		restartAttempts++
		setTimeout(startServer, delay)
	})
}

startServer()
