// Runs a test command with whatever the checkout is missing built first, so that either suite works run
// first, in any order, from a fresh worktree.
//
// Only the client bundle is built here. The server is not bundled at all any more: production runs the
// TypeScript sources through tsx (see `pnpm run server:prod`), and so does the harness, which is what
// keeps plugins able to reach SLM's own modules at runtime. The harness spawns a fresh app per fixture
// and each pays tsx's transform cost, measured at ~2.7s over the bundle it used to load.

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

// The integration suite's file-serving tests read the client bundle out of dist/, and fail on ENOENT in a
// checkout that has never built one. Only built when missing: they assert response headers, which an older
// bundle answers just as well, while e2e is served the bundle and rebuilds it unconditionally before getting
// here.
if (!fs.existsSync(path.join(repoRoot, 'dist/index.html'))) {
	const buildCode = await run('pnpm', ['run', 'build:client'], { NODE_ENV: 'production' })
	if (buildCode !== 0) process.exit(buildCode)
}

process.exit(await run('pnpm', ['exec', command, ...args]))
