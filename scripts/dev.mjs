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
import { createRequire } from 'node:module'
import * as path from 'node:path'

const DB = 'data/db.sqlite3'

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
function ensureNativeModules() {
	const require_ = createRequire(path.join(worktree, 'package.json'))
	const probe = () => {
		try {
			const Database = require_('better-sqlite3')
			new Database(':memory:').close()
			return null
		} catch (err) {
			return err
		}
	}

	const err = probe()
	if (!err) return
	console.log(`better-sqlite3 does not load under node ${process.version}; rebuilding it`)
	run('pnpm', ['rebuild', 'better-sqlite3'])
	const stillBroken = probe()
	if (stillBroken) fail(stillBroken.message)
}

function slotEntry() {
	try {
		return JSON.parse(fs.readFileSync(path.join(gitCommonDir, 'slm-dev-slots.json'), 'utf8'))[worktree] ?? null
	} catch {
		return null
	}
}

// dev:init claims the port slot, links the env files this worktree shares with the main checkout, and clones
// the main checkout's database. A worktree that has never run it, or that has lost one of the three, gets it
// run here rather than being told to go and run it.
function ensureProvisioned() {
	const dbExists = fs.existsSync(path.join(worktree, DB))
	const envLinked = fs.lstatSync(path.join(worktree, '.env'), { throwIfNoEntry: false }) !== undefined
	const envAvailable = fs.existsSync(path.join(mainCheckout, '.env'))
	if (slotEntry() && dbExists && (envLinked || !envAvailable)) return

	// A database sitting here without a slot was made by an app booting in an unprovisioned worktree, not by
	// a clone. dev:init refuses to replace one, so keep it and provision everything else.
	const args = ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-init.ts', '--no-summary']
	if (dbExists) args.push('--no-clone')
	run(tsx, args)
	if (dbExists) console.log(`kept the ${DB} already here; \`pnpm dev:db:clone --force\` replaces it with a clone of the main checkout's`)
}

ensureDependencies()
ensureNativeModules()
ensureProvisioned()

const res = childProcess.spawnSync(tsx, ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev.ts', ...process.argv.slice(2)], {
	cwd: worktree,
	stdio: 'inherit',
})
process.exit(res.status ?? 1)
