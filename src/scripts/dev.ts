import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'

// Runs this worktree's whole dev instance -- the app, the client and the emulated squad server -- on its
// slot's ports. Reached through scripts/dev.mjs, which provisions whatever the worktree is missing before
// handing over to this. `pnpm dev`.
//
// The emulator runs as its own child rather than inside the app: it has to outlive the app's watch restarts,
// or an edit would take the emulated world (players, squads, match state) down with it. `pnpm dev:emu` runs
// it alone, with a repl on stdin, and `pnpm dev --no-emu` then leaves it to that one.

const args = parseArgs({
	options: {
		'no-emu': { type: 'boolean', default: false },
		restart: { type: 'boolean', default: false },
	},
	allowPositionals: false,
})

const slot = Slots.requireSlot()
const env = { ...process.env, ...DevInstance.envOverrides(slot) }
const bin = (name: string) => path.join(process.cwd(), 'node_modules/.bin', name)

type Child = { name: string; color: string; proc: childProcess.ChildProcess }

const children: Child[] = []
let shuttingDown = false

function spawn(name: string, color: string, command: string, args: string[], extraEnv: Record<string, string> = {}) {
	const proc = childProcess.spawn(command, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
	const prefix = `${color}[${name}]\x1b[0m`
	for (const stream of [proc.stdout, proc.stderr]) {
		let buffered = ''
		stream.on('data', (chunk: Buffer) => {
			buffered += chunk.toString()
			const lines = buffered.split('\n')
			buffered = lines.pop() ?? ''
			for (const line of lines) console.log(`${prefix} ${line}`)
		})
	}
	// The instance is the three of them together, so one child stopping on its own has taken it down whatever
	// it exited with. Reporting that as a success is how a `pnpm dev` that never bound a port reads as a
	// working instance to anything that only sees the exit code.
	proc.on('exit', (code) => {
		if (shuttingDown) return
		console.log(`${prefix} exited with code ${code}`)
		shutdown(code || 1)
	})
	children.push({ name, color, proc })
}

function shutdown(code: number) {
	if (shuttingDown) return
	shuttingDown = true
	process.exitCode = code
	for (const child of children) child.proc.kill('SIGTERM')
	setTimeout(() => {
		for (const child of children) child.proc.kill('SIGKILL')
		process.exit(code)
	}, 5_000).unref()
}

// A `pnpm dev:emu` in another terminal owns the world and the repl; starting a second host would fail on its
// rcon port anyway, and less usefully.
function emulatorRunning(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(DevInstance.EMU_SOCKET_PATH)
		socket.on('connect', () => {
			socket.destroy()
			resolve(true)
		})
		socket.on('error', () => resolve(false))
	})
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
	return condition()
}

// Every port a slot owns is bound by this instance's own children, so anything already listening on one is a
// dev instance still running in this worktree -- often the children of a supervisor that died, which
// otherwise surfaces as vite failing to bind and nothing saying what holds the port.
//
// By port rather than by process name: what stops the instance coming up is the bind, whoever made it.
function listeners(port: number): { occupied: boolean; pids: number[] } {
	const res = childProcess.spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
	const out = res.stdout?.trim() ?? ''
	// no ss on this machine: nothing to report, and vite's own bind error is what the run falls back to
	if (res.status !== 0 || out === '') return { occupied: false, pids: [] }
	return { occupied: true, pids: [...out.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])) }
}

function describe(pid: number): { command: string; mine: boolean } {
	const read = (file: string) => {
		try {
			return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8')
		} catch {
			return ''
		}
	}
	const command = read('cmdline').replaceAll('\0', ' ').trim() || `pid ${pid}`
	let cwd = ''
	try {
		cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
	} catch {
		/* exited, or another user's */
	}
	const mine = cwd === slot.worktree || command.includes(slot.worktree)
	// a tsx or vite command line repeats the worktree path several times and runs to hundreds of characters,
	// which buries the one thing being reported
	const short = mine ? command.replaceAll(slot.worktree + '/', '') : command
	return { command: short.length > 120 ? short.slice(0, 119) + '…' : short, mine }
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function stop(pids: number[]) {
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		for (const pid of pids) {
			try {
				process.kill(pid, signal)
			} catch {
				/* already gone */
			}
		}
		if (await waitFor(() => !pids.some(alive), signal === 'SIGTERM' ? 5_000 : 1_000)) return
	}
}

async function ensurePortsFree(ports: number[]) {
	const held = ports.map((port) => ({ port, ...listeners(port) })).filter((entry) => entry.occupied)
	if (held.length === 0) return

	const holders = held.flatMap((entry) => entry.pids.map((pid) => ({ port: entry.port, pid, ...describe(pid) })))
	const foreign = holders.filter((holder) => !holder.mine)
	const anonymous = held.filter((entry) => entry.pids.length === 0)
	if (foreign.length > 0 || anonymous.length > 0) {
		for (const holder of foreign)
			console.error(`port ${holder.port} is held from outside this worktree by pid ${holder.pid}: ${holder.command}`)
		for (const entry of anonymous) console.error(`port ${entry.port} is held by a process this user cannot see`)
		console.error(`this worktree holds slot ${slot.slot}. \`pnpm dev:slots\` lists what every worktree holds.`)
		process.exit(1)
	}

	if (!args.values.restart) {
		for (const holder of holders) console.error(`port ${holder.port} is held by pid ${holder.pid}: ${holder.command}`)
		console.error('a dev instance is already running in this worktree. Stop it, or take it over with `pnpm dev --restart`.')
		process.exit(1)
	}

	const pids = [...new Set(holders.map((holder) => holder.pid))]
	console.log(`stopping the dev instance already running here (pid ${pids.join(', ')})`)
	await stop(pids)
	if (!(await waitFor(() => ports.every((port) => !listeners(port).occupied), 2_000))) {
		console.error(`could not free port(s) ${ports.filter((port) => listeners(port).occupied).join(', ')}`)
		process.exit(1)
	}
}

const startEmulator = !args.values['no-emu'] && !(await emulatorRunning())
await ensurePortsFree([slot.ports.app, slot.ports.client, slot.ports.inspect, ...(startEmulator ? [slot.ports.rcon, slot.ports.bm] : [])])

if (startEmulator) {
	spawn('emu', '\x1b[33m', bin('tsx'), ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-emu.ts'])
}

spawn(
	'server',
	'\x1b[36m',
	bin('tsx'),
	[
		'watch',
		`--inspect=127.0.0.1:${slot.ports.inspect}`,
		'--include=./.env',
		'--tsconfig',
		'tsconfig.node.json',
		'src/server/main-instrumented.ts',
	],
	{ NODE_OPTIONS: '--import ./register-otel.mjs' },
)

spawn('client', '\x1b[35m', bin('vite'), [])

console.log(`slot ${slot.slot} (${slot.name}), debugger on :${slot.ports.inspect}\n\n  ${Slots.instanceUrl(slot)}\n`)

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
