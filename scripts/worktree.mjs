#!/usr/bin/env node
// Creates this repo's worktrees under WORKTREE_ROOT instead of `.claude/worktrees`, so a worktree is a plain
// directory outside the repo rather than one sitting inside a path the repo itself excludes. Claude Code
// reaches it through the WorktreeCreate/WorktreeRemove hooks in .claude/settings.json, humans through
// `pnpm worktree`. See docs/dev_instances.md.
//
// Plain node with no dependencies on purpose: it runs as a hook from an arbitrary cwd, and it runs against a
// worktree that has no node_modules yet.

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const WORKTREE_ROOT = process.env.SLM_WORKTREE_ROOT || path.join(os.homedir(), 'projects', 'slm')
const BRANCH_PREFIX = 'worktree-'

function git(args, cwd = process.cwd()) {
	return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function tryGit(args, cwd = process.cwd()) {
	try {
		return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	} catch {
		return null
	}
}

// The main checkout: the directory holding the shared git dir. `--git-common-dir` is what makes this work
// from inside a linked worktree, where `--git-dir` points at a per-worktree directory instead.
function mainCheckout(cwd) {
	return path.dirname(path.resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd)))
}

function listWorktrees(cwd) {
	const entries = []
	let current = null
	for (const line of git(['worktree', 'list', '--porcelain'], cwd).split('\n')) {
		if (line.startsWith('worktree ')) {
			current = { path: line.slice(9), locked: false, branch: null }
			entries.push(current)
		} else if (line.startsWith('branch ') && current) {
			current.branch = line.slice(7).replace(/^refs\/heads\//, '')
		} else if (line === 'locked' || line.startsWith('locked ')) {
			if (current) current.locked = true
		}
	}
	return entries
}

// origin's default branch, as Claude Code's own `fresh` worktrees used. SLM_WORKTREE_BASE takes `head` for
// whatever this checkout is on, or any ref -- `main` included, when local main is ahead of the remote.
function baseRef(cwd) {
	const configured = process.env.SLM_WORKTREE_BASE
	if (configured === 'head') return 'HEAD'
	if (configured) return configured
	const remote = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd) ?? 'origin/main'
	return tryGit(['rev-parse', '--verify', `${remote}^{commit}`], cwd) ? remote : 'HEAD'
}

function assertName(name) {
	if (!name || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name)) {
		throw new Error(`invalid worktree name ${JSON.stringify(name)}: letters, digits, dot, underscore and dash only`)
	}
}

// Returns the worktree's path, creating it if it does not already exist. Idempotent so a re-run (or a Claude
// session resuming one) lands back in the same directory rather than failing or making a second copy.
function createWorktree(name, cwd) {
	assertName(name)
	const dest = path.join(WORKTREE_ROOT, name)
	const existing = listWorktrees(cwd).find((entry) => path.resolve(entry.path) === path.resolve(dest))
	if (existing) return { path: dest, created: false }

	if (fs.existsSync(dest)) throw new Error(`${dest} already exists but is not a worktree of this repo`)
	fs.mkdirSync(WORKTREE_ROOT, { recursive: true })

	const branch = name.startsWith(BRANCH_PREFIX) ? name : BRANCH_PREFIX + name
	const base = baseRef(cwd)
	const args = tryGit(['rev-parse', '--verify', `refs/heads/${branch}`], cwd)
		? ['worktree', 'add', dest, branch]
		: ['worktree', 'add', '-b', branch, dest, base]
	childProcess.execFileSync('git', args, { cwd, stdio: ['ignore', 2, 2] })
	return { path: dest, created: true, branch, base }
}

function removeWorktree(worktreePath, cwd) {
	const entry = listWorktrees(cwd).find((e) => path.resolve(e.path) === path.resolve(worktreePath))
	if (entry?.locked) tryGit(['worktree', 'unlock', worktreePath], cwd)
	childProcess.execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd, stdio: ['ignore', 2, 2] })
	// -d, never -D: it deletes a branch that added nothing and refuses one that did, which is the whole
	// judgement call here. A worktree removed with work still on its branch leaves the branch behind.
	if (entry?.branch) tryGit(['branch', '-d', entry.branch], cwd)
}

function readHookInput() {
	const raw = fs.readFileSync(0, 'utf8')
	return raw.trim() ? JSON.parse(raw) : {}
}

function run(command, args, cwd, { quiet = false } = {}) {
	// A hook's stdout is the worktree path and nothing else, so a child's output goes to stderr instead.
	const stdio = quiet ? ['ignore', 2, 2] : 'inherit'
	const res = childProcess.spawnSync(command, args, { cwd, stdio })
	if (res.status !== 0) process.exit(res.status ?? 1)
}

// A worktree has no node_modules of its own, and every command in this repo needs them. With a warm pnpm
// store this is a couple of seconds of hard links, which is worth not making anyone think about it.
function install(dest, opts) {
	if (fs.existsSync(path.join(dest, 'node_modules'))) return
	run('pnpm', ['install'], dest, opts)
}

function slotRegistryPath(cwd) {
	return path.join(path.resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd)), 'slm-dev-slots.json')
}

// A worktree's slot is keyed by its absolute path, so a move that does not rewrite the registry orphans the
// slot and the instance silently claims a second one.
function rekeySlot(from, to, cwd) {
	const file = slotRegistryPath(cwd)
	let registry
	try {
		registry = JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch {
		return false
	}
	if (!registry[from]) return false
	registry[to] = registry[from]
	delete registry[from]
	fs.writeFileSync(file, JSON.stringify(registry, null, '\t') + '\n')
	return true
}

function processesUnder(dir) {
	const res = childProcess.spawnSync('pgrep', ['-f', dir], { encoding: 'utf8' })
	return res.stdout?.trim().split('\n').filter(Boolean).length ?? 0
}

const [command, ...rest] = process.argv.slice(2)
const cwd = process.cwd()

// Whatever goes wrong here is read by whoever ran the command, or shown by Claude Code as the reason the hook
// failed. A stack trace is noise in both places.
try {
	dispatch()
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}

function dispatch() {
	switch (command) {
		case 'hook-create': {
			const input = readHookInput()
			const result = createWorktree(input.name, input.cwd || cwd)
			install(result.path, { quiet: true })
			process.stdout.write(result.path + '\n')
			break
		}

		case 'hook-remove': {
			const input = readHookInput()
			removeWorktree(input.worktree_path, mainCheckout(cwd))
			break
		}

		case 'root':
			process.stdout.write(WORKTREE_ROOT + '\n')
			break

		case 'new': {
			const name = rest.find((arg) => !arg.startsWith('-'))
			const setup = !rest.includes('--no-setup')
			const result = createWorktree(name, cwd)
			console.log(result.created ? `created ${result.path} on ${result.branch} (from ${result.base})` : `${result.path} already exists`)
			if (setup) {
				install(result.path)
				run('pnpm', ['dev:init'], result.path)
				console.log(`\ncd ${result.path}`)
			} else {
				console.log(`\nnext: cd ${result.path} && pnpm dev:init`)
			}
			break
		}

		case 'ls': {
			const root = mainCheckout(cwd)
			for (const entry of listWorktrees(cwd)) {
				if (path.resolve(entry.path) === path.resolve(root)) continue
				console.log(entry.path + (entry.locked ? ' (locked)' : ''))
			}
			break
		}

		// Relocates worktrees still living under the main checkout's .claude/worktrees. Reports by default;
		// --apply moves them.
		case 'migrate': {
			const apply = rest.includes('--apply')
			const root = mainCheckout(cwd)
			const legacyDir = path.join(root, '.claude', 'worktrees')
			const stale = listWorktrees(cwd).filter((entry) => path.resolve(entry.path).startsWith(legacyDir + path.sep))
			if (stale.length === 0) {
				console.log(`no worktrees left under ${legacyDir}`)
				break
			}
			fs.mkdirSync(WORKTREE_ROOT, { recursive: true })
			const here = path.resolve(git(['rev-parse', '--show-toplevel'], cwd))
			for (const entry of stale) {
				const dest = path.join(WORKTREE_ROOT, path.basename(entry.path))
				if (path.resolve(entry.path) === here) {
					console.log(`skip  ${entry.path}\n      this is the worktree you are running from; move it from another one`)
					continue
				}
				const running = processesUnder(entry.path)
				if (running > 0) {
					console.log(`skip  ${entry.path}\n      ${running} process(es) still running in it; stop them (pnpm dev, dev:emu) and re-run`)
					continue
				}
				if (!apply) {
					console.log(`would move ${entry.path}\n        -> ${dest}${entry.locked ? ' (unlocking first)' : ''}`)
					continue
				}
				if (entry.locked) git(['worktree', 'unlock', entry.path], root)
				git(['worktree', 'move', entry.path, dest], root)
				if (entry.locked) git(['worktree', 'lock', dest], root)
				rekeySlot(entry.path, dest, root)
				console.log(`moved ${entry.path}\n   -> ${dest}`)
			}
			if (!apply) console.log('\nnothing moved. re-run with --apply.')
			break
		}

		default:
			console.log(`worktrees live in ${WORKTREE_ROOT} (override with SLM_WORKTREE_ROOT)

  pnpm worktree new <name>      create one, install, provision its dev instance
  pnpm worktree ls              every worktree of this repo
  pnpm worktree migrate         relocate worktrees still under .claude/worktrees (--apply to do it)
  pnpm worktree root            print the worktree root`)
			process.exit(command ? 1 : 0)
	}
}
