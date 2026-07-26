import * as fs from 'node:fs'
import * as net from 'node:net'

import type { BmServer } from '../emulator/bm-server.ts'
import type { Emulator, EmuPlayer } from '../emulator/index.ts'
import * as Verbs from '../emulator/verbs.ts'

// The socket that carries scenario commands to the emulator host.
//
// The verbs themselves live in @/models/sandbox.models and run through src/emulator/verbs.ts, shared with the
// app's sandbox window. This module is only the dev host's two front ends -- the repl inside `pnpm dev:emu` and
// the one-shot `pnpm emuctl` from any other terminal -- plus the transport between them.
//
// A unix socket rather than a port: it needs no slot allocation, it is unreachable from the network, and it
// lives in the worktree's own data/dev, so it is scoped to the instance by construction.

type Request = { args: string[] }
type Response = { ok: boolean; output: string }

export function createEmuHost(ctx: { emu: Emulator; bm: BmServer }): { host: Verbs.SandboxHost; join: (name: string) => EmuPlayer } {
	const host: Verbs.SandboxHost = {
		emu: ctx.emu,
		// Named players, so a scenario can refer to someone by the name it gave them rather than by an eos id.
		players: new Map(),
		onPlayerJoined: (player) => ctx.bm.addPlayer({ eosId: player.eos, steamId: player.steam }),
	}
	return { host, join: (name) => Verbs.joinPlayer(host, name) }
}

export async function dispatch(host: Verbs.SandboxHost, args: string[]): Promise<Response> {
	try {
		return { ok: true, output: await Verbs.executeTokens(host, args) }
	} catch (err) {
		return { ok: false, output: err instanceof Error ? err.message : String(err) }
	}
}

// A leftover socket file from a host that was killed rather than shut down would make listen() fail with
// EADDRINUSE forever. It is only stale if nothing answers on it: if something does, another host is already
// running for this worktree, which is a different problem and worth saying so.
async function clearStaleSocket(socketPath: string) {
	if (!fs.existsSync(socketPath)) return
	const answered = await new Promise<boolean>((resolve) => {
		const probe = net.connect(socketPath)
		probe.once('connect', () => {
			probe.destroy()
			resolve(true)
		})
		probe.once('error', () => resolve(false))
	})
	if (answered) throw new Error(`another emulator is already running for this worktree (${socketPath})`)
	fs.rmSync(socketPath, { force: true })
}

export async function serve(socketPath: string, host: Verbs.SandboxHost): Promise<net.Server> {
	await clearStaleSocket(socketPath)
	const server = net.createServer((socket) => {
		let buffered = ''
		socket.on('data', (chunk) => {
			buffered += chunk.toString()
			const newline = buffered.indexOf('\n')
			if (newline === -1) return
			const line = buffered.slice(0, newline)
			buffered = ''
			void (async () => {
				let response: Response
				try {
					response = await dispatch(host, (JSON.parse(line) as Request).args)
				} catch (err) {
					response = { ok: false, output: err instanceof Error ? err.message : String(err) }
				}
				socket.end(JSON.stringify(response) + '\n')
			})()
		})
		// a client that goes away mid-command is not the host's problem
		socket.on('error', () => {})
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(socketPath, () => resolve())
	})
	return server
}

export function send(socketPath: string, args: string[]): Promise<Response> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath)
		let buffered = ''
		socket.on('connect', () => socket.write(JSON.stringify({ args } satisfies Request) + '\n'))
		socket.on('data', (chunk) => {
			buffered += chunk.toString()
		})
		socket.on('end', () => {
			try {
				resolve(JSON.parse(buffered) as Response)
			} catch {
				reject(new Error(`the emulator sent a reply that could not be read: ${buffered}`))
			}
		})
		socket.on('error', (err) => {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
				reject(new Error('no emulator is running for this worktree -- start one with `pnpm dev:emu`'))
				return
			}
			reject(err)
		})
	})
}
