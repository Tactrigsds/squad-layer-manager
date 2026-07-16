import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Port slots for running many worktrees of this repo side by side. A worktree claims a slot once and
// keeps it; every port that instance needs is derived from the slot number, so nothing has to be
// discovered at runtime and a browser tab pointed at a worktree stays valid across restarts.
//
// The registry lives next to the shared git dir rather than in any one worktree, since that is the only
// location every worktree of the repo agrees on.

// Slot ports start above the defaults in .env (3000/5173) so an un-orchestrated `pnpm server:dev` in the
// main checkout never contends with a slot.
const SLOT_PORT_BASE = 3100
const PORTS_PER_SLOT = 10
const MAX_SLOTS = 64

export type SlotPorts = {
	app: number
	client: number
	rcon: number
	bm: number
	// the app's --inspect port; per-slot for the same reason as the rest, a debugger cannot attach to two
	// instances sharing 9229
	inspect: number
}

export type Slot = {
	slot: number
	worktree: string
	name: string
	ports: SlotPorts
}

type RegistryEntry = { slot: number; name: string; claimedAt: string }
type Registry = Record<string, RegistryEntry>

export function portsForSlot(slot: number): SlotPorts {
	const base = SLOT_PORT_BASE + slot * PORTS_PER_SLOT
	return { app: base, client: base + 1, rcon: base + 2, bm: base + 3, inspect: base + 4 }
}

function git(args: string[], cwd: string): string {
	return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// The directory holding the shared git dir: the main checkout's root. `--git-common-dir` is what makes this
// work from inside a linked worktree, where `--git-dir` points at a per-worktree directory instead.
export function repoRootCheckout(cwd = process.cwd()): string {
	const commonDir = path.resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd))
	return path.dirname(commonDir)
}

export function worktreeRoot(cwd = process.cwd()): string {
	return git(['rev-parse', '--show-toplevel'], cwd)
}

function registryPath(cwd: string): string {
	return path.join(path.resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd)), 'slm-dev-slots.json')
}

function readRegistry(file: string): Registry {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as Registry
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
		throw err
	}
}

function writeRegistry(file: string, registry: Registry) {
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(registry, null, '\t') + '\n')
	fs.renameSync(tmp, file)
}

// Two `dev:init` runs racing would otherwise read the same registry and hand out the same slot. The lock is
// held for a file read plus a write, so a holder older than this is a crashed process, not a slow one.
const LOCK_STALE_MS = 10_000

async function withLock<T>(file: string, fn: (registry: Registry) => T | Promise<T>): Promise<T> {
	const lock = `${file}.lock`
	const deadline = Date.now() + 5_000
	let handle: number | undefined
	while (handle === undefined) {
		try {
			handle = fs.openSync(lock, 'wx')
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
			const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0)
			if (age > LOCK_STALE_MS) {
				fs.rmSync(lock, { force: true })
				continue
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for the slot registry lock at ${lock}`, { cause: err })
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	}
	try {
		const registry = readRegistry(file)
		const result = await fn(registry)
		writeRegistry(file, registry)
		return result
	} finally {
		fs.closeSync(handle)
		fs.rmSync(lock, { force: true })
	}
}

// A worktree that has been removed keeps its entry in the registry forever otherwise, and slots are a small
// finite space. Absence of the directory is the only liveness signal that matters here.
function prune(registry: Registry) {
	for (const worktree of Object.keys(registry)) {
		if (!fs.existsSync(worktree)) delete registry[worktree]
	}
}

function toSlot(worktree: string, entry: RegistryEntry): Slot {
	return { slot: entry.slot, worktree, name: entry.name, ports: portsForSlot(entry.slot) }
}

export async function claimSlot(cwd = process.cwd()): Promise<Slot> {
	const worktree = worktreeRoot(cwd)
	return withLock(registryPath(cwd), (registry) => {
		prune(registry)
		const existing = registry[worktree]
		if (existing) return toSlot(worktree, existing)

		const taken = new Set(Object.values(registry).map((entry) => entry.slot))
		let slot = 0
		while (taken.has(slot)) slot++
		if (slot >= MAX_SLOTS) {
			throw new Error(`no free dev slots (all ${MAX_SLOTS} are claimed); release one with \`pnpm dev:slots --release\``)
		}

		const entry: RegistryEntry = { slot, name: path.basename(worktree), claimedAt: new Date().toISOString() }
		registry[worktree] = entry
		return toSlot(worktree, entry)
	})
}

// The slot this worktree already holds. Distinct from claimSlot: anything that only reads the instance's
// ports should fail on an unprovisioned worktree rather than silently claim a slot as a side effect.
export function getSlot(cwd = process.cwd()): Slot | null {
	const worktree = worktreeRoot(cwd)
	const entry = readRegistry(registryPath(cwd))[worktree]
	return entry ? toSlot(worktree, entry) : null
}

export function requireSlot(cwd = process.cwd()): Slot {
	const slot = getSlot(cwd)
	if (!slot) throw new Error(`this worktree has no dev slot; run \`pnpm dev:init\` first`)
	return slot
}

export async function releaseSlot(cwd = process.cwd()): Promise<boolean> {
	const worktree = worktreeRoot(cwd)
	return withLock(registryPath(cwd), (registry) => {
		prune(registry)
		if (!registry[worktree]) return false
		delete registry[worktree]
		return true
	})
}

export async function listSlots(cwd = process.cwd()): Promise<Slot[]> {
	return withLock(registryPath(cwd), (registry) => {
		prune(registry)
		return Object.entries(registry).map(([worktree, entry]) => toSlot(worktree, entry)).sort((a, b) => a.slot - b.slot)
	})
}
