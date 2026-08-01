#!/usr/bin/env node
// Takes a worktree from whatever state it is in to one that can run, then hands off to src/scripts/dev.ts,
// which runs it. `pnpm dev`.
//
// Plain node with no dependencies, for the same reason scripts/worktree.mjs is: a worktree that has never
// been installed cannot run anything out of node_modules, and that is one of the states this has to fix.
// Each step is a no-op once it has been done, so the cost of all of this on an ordinary `pnpm dev` is a few
// stats.

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

function git(args) {
	return childProcess.execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const worktree = git(['rev-parse', '--show-toplevel'])
const gitCommonDir = path.resolve(worktree, git(['rev-parse', '--git-common-dir']))
const mainCheckout = path.dirname(gitCommonDir)
const tsx = path.join(worktree, 'node_modules/.bin/tsx')

function run(command, args) {
	const res = childProcess.spawnSync(command, args, { cwd: worktree, stdio: 'inherit' })
	if (res.status !== 0) process.exit(res.status ?? 1)
}

function fail(message) {
	console.error(message)
	process.exit(1)
}

if (path.resolve(worktree) === path.resolve(mainCheckout)) {
	fail(
		"`pnpm dev` runs a worktree's own dev instance, and the main checkout has no slot.\n" +
			'Run `pnpm server:dev` and `pnpm client:dev` here, or `pnpm worktree new <name>` for an instance.',
	)
}

// node_modules is per worktree and gitignored, so a worktree made outside `pnpm worktree new` has none at
// all, and one whose branch changed a dependency has a stale one. Against a warm store pnpm is a couple of
// seconds either way, and it rewrites .modules.yaml every run, so this settles rather than repeating.
function ensureDependencies() {
	const stamp = fs.statSync(path.join(worktree, 'node_modules/.modules.yaml'), { throwIfNoEntry: false })
	const lock = fs.statSync(path.join(worktree, 'pnpm-lock.yaml'), { throwIfNoEntry: false })
	if (stamp && (!lock || stamp.mtimeMs >= lock.mtimeMs)) return
	console.log(stamp ? 'pnpm-lock.yaml is newer than node_modules; installing' : 'this worktree has no node_modules; installing')
	run('pnpm', ['install'])
}

// better-sqlite3 is compiled against one node ABI, and the addon loads when the first database is opened
// rather than at import. A worktree that installed under a different node than it runs under -- which is
// what a moved .tool-versions does to one -- therefore fails deep inside whatever opened a database first,
// as a NODE_MODULE_VERSION mismatch that says nothing about the install that caused it.
//
// In a child rather than here: a process that has already tried to dlopen the old build cannot load the new
// one, and says `Module did not self-register` instead of anything about the rebuild that just fixed it.
function ensureNativeModules() {
	const probe = () => {
		const res = childProcess.spawnSync(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], {
			cwd: worktree,
			encoding: 'utf8',
		})
		return res.status === 0 ? null : (res.stderr || '').trim()
	}

	if (!probe()) return
	console.log(`better-sqlite3 does not load under node ${process.version}; rebuilding it`)
	run('pnpm', ['rebuild', 'better-sqlite3'])
	const stillBroken = probe()
	if (stillBroken) fail(stillBroken)
}

function slotEntry() {
	try {
		return JSON.parse(fs.readFileSync(path.join(gitCommonDir, 'slm-dev-slots.json'), 'utf8'))[worktree] ?? null
	} catch {
		return null
	}
}

// dev:init claims the port slot, links the env files this worktree shares with the main checkout, and gives
// the worktree a database. A worktree that has never run it, or that has lost one of the three, gets it run
// here rather than being told to go and run it. It keeps a database already here rather than replacing one.
function ensureProvisioned() {
	const envLinked = fs.lstatSync(path.join(worktree, '.env'), { throwIfNoEntry: false }) !== undefined
	const envAvailable = fs.existsSync(path.join(mainCheckout, '.env'))
	if (slotEntry() && fs.existsSync(path.join(worktree, 'data/db.sqlite3')) && (envLinked || !envAvailable)) return
	run(tsx, ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-init.ts', '--no-summary'])
}

ensureDependencies()
ensureNativeModules()
ensureProvisioned()

const child = childProcess.spawn(tsx, ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev.ts', ...process.argv.slice(2)], {
	cwd: worktree,
	stdio: 'inherit',
})
// Ctrl-C reaches the child on its own, from the process group; forwarding is for the signal sent to this pid
// alone, and either way the shell gets its prompt back when the instance is down rather than before.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
