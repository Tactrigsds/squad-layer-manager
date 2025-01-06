// This file controls the host process for the server in prod mode. It ensures that the server keeps running and writes incoming logs from stdout and stderr, while ensuring that all lines that are output to the logfile are valid json. If we decide to add some other logging  or telemetry integration, this is the place to do it so we capture catastrophic failures
import { exec } from 'node:child_process'
import { setupConfig } from '@/server/config'
import * as path from 'node:path'
import * as Paths from '@/server/paths'
import * as fsAsync from 'node:fs/promises'
import * as fs from 'node:fs'
import { ENV, setupEnv } from '@/server/env'

setupEnv()
// we don't need this, just calling it to check for validation errors before starting the server process
setupConfig()

let restartAttempts = 0
const MAX_RESTART_DELAY = 1000 * 60 * 5 // 5 minutes

if (ENV.PROD_LOG_PATH && !fs.existsSync(ENV.PROD_LOG_PATH)) {
	if (!fs.existsSync(path.dirname(ENV.PROD_LOG_PATH))) {
		fs.mkdirSync(path.dirname(ENV.PROD_LOG_PATH), { recursive: true })
	}
	fs.writeFileSync(ENV.PROD_LOG_PATH, '')
}

function startServer() {
	const mainPath = path.join(Paths.PROJECT_ROOT, 'src/server/main.ts')
	const child = exec(`tsx ${mainPath}`, { env: process.env })
	let lastRestartTime = Date.now()

	const writeLog = async (data: string) => {
		if (!ENV.PROD_LOG_PATH) return
		await fsAsync.appendFile(ENV.PROD_LOG_PATH, data).catch(() => {})
	}

	child.stdout?.on('data', async (data: string) => {
		try {
			for (let line of data.trim().split('\n')) {
				line = line.trim()
				JSON.parse(line)
				const logLine = line + '\n'
				process.stdout.write(logLine)
				await writeLog(logLine)
			}
		} catch (e) {
			const output =
				JSON.stringify({
					message: 'error while parsing stdout from server process',
					module: 'host',
					err: e,
					data,
				}) + '\n'
			process.stderr.write(output)
			await writeLog(output)
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
			const error =
				JSON.stringify({
					module: 'host',
					msg: 'error while parsing stderr from server process',
					err: e,
					data,
				}) + '\n'
			process.stderr.write(error)
			writeLog(error)
		}
	})

	child.on('exit', (code) => {
		if (code == 0 || !ENV.PROD_AUTORESTART) process.exit(code)
		const now = Date.now()
		if (now - lastRestartTime > 10 * 60 * 1000) {
			restartAttempts = 0
		}
		lastRestartTime = now

		const delay = Math.min(1000 * Math.pow(2, restartAttempts), MAX_RESTART_DELAY)
		const delaySeconds = delay / 1000
		const msg = JSON.stringify({
			module: 'host',
			msg: `Server exited with code ${code}, restarting in ${delaySeconds} seconds`,
			code,
		})
		process.stderr.write(msg)
		writeLog(msg)
		restartAttempts++
		setTimeout(startServer, delay)
	})
}

startServer()
