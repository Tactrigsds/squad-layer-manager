import * as childProcess from 'node:child_process'
import * as net from 'node:net'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'

// Runs this worktree's whole dev instance -- the app, the client and the emulated squad server -- on its
// slot's ports. `pnpm dev`.
//
// The emulator runs as its own child rather than inside the app: it has to outlive the app's watch restarts,
// or an edit would take the emulated world (players, squads, match state) down with it. `pnpm dev:emu` runs
// it alone, with a repl on stdin, and `pnpm dev --no-emu` then leaves it to that one.

const args = parseArgs({ options: { 'no-emu': { type: 'boolean', default: false } }, allowPositionals: false })

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
	proc.on('exit', (code) => {
		if (shuttingDown) return
		console.log(`${prefix} exited with code ${code}`)
		shutdown()
	})
	children.push({ name, color, proc })
}

function shutdown() {
	if (shuttingDown) return
	shuttingDown = true
	for (const child of children) child.proc.kill('SIGTERM')
	setTimeout(() => {
		for (const child of children) child.proc.kill('SIGKILL')
		process.exit(0)
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

if (!args.values['no-emu'] && !await emulatorRunning()) {
	spawn('emu', '\x1b[33m', bin('tsx'), ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-emu.ts'])
}

spawn('server', '\x1b[36m', bin('tsx'), [
	'watch',
	`--inspect=127.0.0.1:${slot.ports.inspect}`,
	'--include=./.env',
	'--tsconfig',
	'tsconfig.node.json',
	'src/server/main-instrumented.ts',
], { NODE_OPTIONS: '--import ./register-otel.mjs' })

spawn('client', '\x1b[35m', bin('vite'), [])

console.log(`slot ${slot.slot} (${slot.name}), debugger on :${slot.ports.inspect}\n\n  ${Slots.instanceUrl(slot)}\n`)

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
