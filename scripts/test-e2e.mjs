// Builds what the e2e suite serves, then runs it against the server bundle. Extra args go to playwright. Runs inside
// the optional nix dev shell when there is one (see nix-shell.mjs).

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

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

function newestMtime(p) {
	const stat = fs.statSync(p)
	if (!stat.isDirectory()) return stat.mtimeMs
	let newest = 0
	for (const entry of fs.readdirSync(p)) {
		if (entry === 'target') continue
		newest = Math.max(newest, newestMtime(path.join(p, entry)))
	}
	return newest
}

function engineIsStale() {
	const wasm = path.join(repoRoot, 'assets/layer-engine.wasm')
	if (!fs.existsSync(wasm)) return true
	return newestMtime(path.join(repoRoot, 'layer-engine')) > fs.statSync(wasm).mtimeMs
}

if (engineIsStale()) await runOrExit('pnpm', ['run', 'build:engine'])
await runOrExit('pnpm', ['exec', 'vite', 'build'], { NODE_ENV: 'production' })
await runOrExit('pnpm', ['run', 'precompress:dist'])
process.exit(await run('node', ['scripts/test-server-bundle.mjs', 'playwright', 'test', '--project=chromium', ...process.argv.slice(2)]))
