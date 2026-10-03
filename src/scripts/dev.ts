import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
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
		wait: { type: 'boolean', default: false },
		open: { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
		admins: { type: 'string' },
		players: { type: 'string' },
	},
	allowPositionals: false,
})

if (args.values.help) {
	console.log(`usage: pnpm dev [options]

  --url          provision if needed, then print only the workspace URL
  --wait         block until a running \`pnpm dev\` answers, then print the workspace URL
  --open         open the workspace URL in your default browser, or $BROWSER, if \`pnpm dev\` is running
  --reset-data   replace this workspace's isolated database before starting
  --emu-only     run only the emulator and its REPL
  --no-emu       do not start an emulator with the app
  --players N    players to add when using --emu-only
  --admins IDS   comma-separated Steam IDs to add when using --emu-only`)
	process.exit(0)
}

if (args.values.open) {
	const existing = Slots.getSlot()
	if (!existing || !(await instanceAnswers(existing))) {
		console.error('the dev instance is not running; start `pnpm dev` first')
		process.exit(1)
	}
	await openInBrowser(Slots.instanceUrl(existing))
	process.exit(0)
}

// Both only report, so they leave a provisioned workspace alone: a second provision racing a starting `pnpm dev`
// fails on the database it is creating.
if (args.values.url || args.values.wait) {
	const existing = Slots.getSlot()
	if (args.values.wait) {
		if (!existing) {
			console.error('this workspace has no dev slot; start `pnpm dev` first')
			process.exit(1)
		}
		await waitForInstance(existing)
		console.log(Slots.instanceUrl(existing))
		process.exit(0)
	}
	if (existing && fs.existsSync(DevInstance.DEV_DB_PATH)) {
		console.log(Slots.instanceUrl(existing))
		process.exit(0)
	}
}

const provisionArgs = ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-init.ts']
if (args.values['reset-data']) provisionArgs.push('--reset-data')
// --url's stdout is the url alone, so it can be captured
const provision = childProcess.spawnSync(path.join(process.cwd(), 'node_modules/.bin/tsx'), provisionArgs, {
	stdio: ['inherit', args.values.url ? process.stderr : 'inherit', 'inherit'],
})
if (provision.status !== 0) process.exit(provision.status ?? 1)

const slot = Slots.requireSlot()
const env = { ...process.env, ...DevInstance.envOverrides(slot) }
const bin = (name: string) => path.join(process.cwd(), 'node_modules/.bin', name)

if (args.values.url) {
	console.log(Slots.instanceUrl(slot))
	process.exit(0)
}

extractMessages()

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

// Both ports, since the client proxies to the app. vite listens on ::1 only, hence localhost over 127.0.0.1.
async function instanceAnswers(slot: Slots.Slot) {
	const answered = await Promise.all(
		[slot.ports.app, slot.ports.client].map((port) =>
			fetch(`http://localhost:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) }).then(
				(res) => res.status < 500,
				() => false,
			),
		),
	)
	return answered.every(Boolean)
}

async function waitForInstance(slot: Slots.Slot) {
	const deadline = Date.now() + 180_000
	while (Date.now() < deadline) {
		if (await instanceAnswers(slot)) return
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	console.error(`the instance did not answer on ports ${slot.ports.app}, ${slot.ports.client} within 180s; check the \`pnpm dev\` output`)
	process.exit(1)
}

function openInBrowser(url: string) {
	const [command, ...commandArgs] = process.env.BROWSER
		? [process.env.BROWSER]
		: process.platform === 'darwin'
			? ['open']
			: process.platform === 'win32'
				? ['cmd', '/c', 'start', '""']
				: ['xdg-open']
	return new Promise<void>((resolve) => {
		const proc = childProcess.spawn(command, [...commandArgs, url], { detached: true, stdio: 'ignore' })
		proc.on('spawn', () => {
			proc.unref()
			console.log(url)
			resolve()
		})
		proc.on('error', (err) => {
			console.error(`could not run ${command} to open ${url}: ${err.message}`)
			process.exit(1)
		})
	})
}
