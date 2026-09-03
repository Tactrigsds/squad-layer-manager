import * as childProcess from 'node:child_process'
import * as net from 'node:net'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'
import { extractMessages } from './messages-build.ts'

const args = parseArgs({
	options: {
		'no-emu': { type: 'boolean', default: false },
		'emu-only': { type: 'boolean', default: false },
		'reset-data': { type: 'boolean', default: false },
		url: { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
		admins: { type: 'string' },
		players: { type: 'string' },
	},
	allowPositionals: false,
})

if (args.values.help) {
	console.log(`usage: pnpm dev [options]

  --url          provision if needed, then print the workspace URL
  --reset-data   replace this workspace's isolated database before starting
  --emu-only     run only the emulator and its REPL
  --no-emu       do not start an emulator with the app
  --players N    players to add when using --emu-only
  --admins IDS   comma-separated Steam IDs to add when using --emu-only`)
	process.exit(0)
}

const provisionArgs = ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-init.ts']
if (args.values['reset-data']) provisionArgs.push('--reset-data')
const provision = childProcess.spawnSync(path.join(process.cwd(), 'node_modules/.bin/tsx'), provisionArgs, { stdio: 'inherit' })
if (provision.status !== 0) process.exit(provision.status ?? 1)

const slot = Slots.requireSlot()
const env = { ...process.env, ...DevInstance.envOverrides(slot) }
const bin = (name: string) => path.join(process.cwd(), 'node_modules/.bin', name)

extractMessages()

if (args.values.url) {
	console.log(Slots.instanceUrl(slot))
	process.exit(0)
}

if (args.values['emu-only']) {
	const emuArgs = ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-emu.ts']
	if (args.values.admins) emuArgs.push('--admins', args.values.admins)
	if (args.values.players) emuArgs.push('--players', args.values.players)
	const emu = childProcess.spawn(bin('tsx'), emuArgs, { env, stdio: 'inherit' })
	emu.on('exit', (code) => process.exit(code ?? 1))
} else {
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

	// A `pnpm dev --emu-only` in another terminal owns the world and the repl; starting a second host would fail on its
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

	if (!args.values['no-emu'] && !(await emulatorRunning())) {
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
			'--include=./data/generated/messages',
			'--tsconfig',
			'tsconfig.node.json',
			'src/server/main-instrumented.ts',
		],
		{ NODE_OPTIONS: '--import ./register-otel.mjs' },
	)

	spawn('client', '\x1b[35m', bin('vite'), [])

	console.log(`slot ${slot.slot} (${slot.name}), debugger on :${slot.ports.inspect}\n\n  ${Slots.instanceUrl(slot)}\n`)

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}
