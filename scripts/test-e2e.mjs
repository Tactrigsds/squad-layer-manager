// Builds what the e2e suite serves, then runs it against the server bundle. Extra args go to playwright. Runs inside
// the optional nix dev shell when there is one (see nix-shell.mjs).

import { spawn } from 'node:child_process'

import { reexecInFlake, repoRoot } from './nix-shell.mjs'

reexecInFlake(import.meta.url)

function run(command, commandArgs, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...env } })
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

async function runOrExit(command, commandArgs, env) {
	const code = await run(command, commandArgs, env)
	if (code !== 0) process.exit(code)
}

// Cargo skips the build when layer-engine/ is unchanged.
await runOrExit('pnpm', ['run', 'build:engine'])
await runOrExit('pnpm', ['exec', 'vite', 'build'], { NODE_ENV: 'production' })
await runOrExit('pnpm', ['run', 'precompress:dist'])
process.exit(await run('node', ['scripts/test-server-bundle.mjs', 'playwright', 'test', '--project=chromium', ...process.argv.slice(2)]))
