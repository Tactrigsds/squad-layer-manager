import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach } from 'vitest'

import { liveFixtures } from './app-fixture'

// Keeps what each live app was doing when a test fails. The app runs as a child process and logs to a file in its
// fixture's temp directory, which dispose() deletes and CI throws away, so without this a failure in CI reports only
// what the test asserted.
//
// The full app log, the emulator's SquadGame.log and a snapshot of the database are copied to FAILURE_DIR, which CI
// uploads as an artifact. A tail of the log above debug is also printed, to be read straight from the job log.
const TAIL_LINES = 80
const FAILURE_DIR = path.resolve(import.meta.dirname, '../../integration-results')

beforeEach((ctx) => {
	ctx.onTestFailed(async () => {
		const testDir = path.join(FAILURE_DIR, slug(ctx.task.file.name), slug(ctx.task.name))
		for (const app of liveFixtures()) {
			if (!fs.existsSync(app.logFile)) continue
			const outDir = path.join(testDir, path.basename(app.tmpDir))
			fs.mkdirSync(outDir, { recursive: true })
			const log = fs.readFileSync(app.logFile, 'utf8')
			fs.writeFileSync(path.join(outDir, 'app.log'), log)
			if (fs.existsSync(app.squadLogPath)) fs.copyFileSync(app.squadLogPath, path.join(outDir, 'SquadGame.log'))
			let db: Database.Database | undefined
			try {
				db = new Database(app.dbPath, { readonly: true, fileMustExist: true })
				await db.backup(path.join(outDir, 'main.sqlite3'))
			} catch (err) {
				console.error(`could not snapshot the database of ${app.tmpDir}: ${(err as Error).message}`)
			} finally {
				db?.close()
			}
			const lines = log.split('\n').filter((line) => !/\[(DEBUG|TRACE) /.test(line))
			console.error(
				`app log of ${app.tmpDir} at the failure of "${ctx.task.name}" (full log, SquadGame.log and db in ${outDir}; last ${TAIL_LINES} lines above debug):\n${lines.slice(-TAIL_LINES).join('\n')}`,
			)
		}
	})
})

function slug(name: string): string {
	return name.replace(/[^\w.-]+/g, '_').slice(0, 120)
}
