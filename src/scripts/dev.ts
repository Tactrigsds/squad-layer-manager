import * as childProcess from 'node:child_process'
import * as path from 'node:path'
import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'

// Runs this worktree's app and client on its slot's ports. `pnpm dev`.
//
// The emulator is not started here: it holds a REPL on stdin and has to outlive the app's watch restarts, so
// it gets its own terminal (`pnpm dev:emu`).

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

spawn('server', '\x1b[36m', bin('tsx'), [
	'watch',
	`--inspect=127.0.0.1:${slot.ports.inspect}`,
	'--include=./.env',
	'--tsconfig',
	'tsconfig.node.json',
	'src/server/main-instrumented.ts',
], { NODE_OPTIONS: '--import ./register-otel.mjs' })

spawn('client', '\x1b[35m', bin('vite'), [])

console.log(
	`slot ${slot.slot} (${slot.name}) -- app :${slot.ports.app}, client http://localhost:${slot.ports.client}, inspect :${slot.ports.inspect}`,
)

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
