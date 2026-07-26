// Runs a test command against bundles rather than the TypeScript sources, building whichever of them the
// checkout is missing so that either suite works run first, in any order, from a fresh worktree.
//
// The harness spawns a fresh app process per fixture (test/harness/app-fixture.ts), and there are dozens of
// those in a run. Loading the server's module graph through tsx costs ~3.5s each time; bundling it once with
// rolldown costs ~1.5s total, so it pays for itself before the second fixture.
//
// An SLM_TEST_SERVER_ENTRY already in the environment wins and nothing is built: that is the docker test image
// pointing at the bundle it ships, which is the artifact CI is meant to be exercising.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...env } })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (signal) {
				reject(new Error(`${command} died on ${signal}`))
				return
			}
			resolve(code ?? 1)
		})
	})
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
	console.error('usage: node scripts/test-server-bundle.mjs <command> [args...]')
	process.exit(2)
}

let entry = process.env.SLM_TEST_SERVER_ENTRY
if (!entry) {
	const buildCode = await run('pnpm', ['run', 'build:server'])
	if (buildCode !== 0) process.exit(buildCode)
	entry = path.join(repoRoot, 'dist-server/main-instrumented.js')
}

// The integration suite's file-serving tests read the client bundle out of dist/, and fail on ENOENT in a
// checkout that has never built one. Only built when missing: they assert response headers, which an older
// bundle answers just as well, while e2e is served the bundle and rebuilds it unconditionally before getting
// here.
if (!fs.existsSync(path.join(repoRoot, 'dist/index.html'))) {
	const buildCode = await run('pnpm', ['run', 'build:client'], { NODE_ENV: 'production' })
	if (buildCode !== 0) process.exit(buildCode)
}

process.exit(await run('pnpm', ['exec', command, ...args], { SLM_TEST_SERVER_ENTRY: entry }))
