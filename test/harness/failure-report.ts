import fs from 'node:fs'
import { beforeEach } from 'vitest'

import { liveFixtures } from './app-fixture'

// Prints the app's own log when a test fails. The app runs as a child process and logs to a file in its fixture's
// temp directory, which CI throws away, so without this a failure in CI reports only what the test asserted and
// nothing of what the app was doing. Debug and trace lines are left out: the tail has to fit in a job log.
const TAIL_LINES = 80

beforeEach((ctx) => {
	ctx.onTestFailed(() => {
		for (const app of liveFixtures()) {
			if (!fs.existsSync(app.logFile)) continue
			const lines = fs
				.readFileSync(app.logFile, 'utf8')
				.split('\n')
				.filter((line) => !/\[(DEBUG|TRACE) /.test(line))
			console.error(
				`app log of ${app.tmpDir} at the failure of "${ctx.task.name}" (last ${TAIL_LINES} lines above debug):\n${lines.slice(-TAIL_LINES).join('\n')}`,
			)
		}
	})
})
