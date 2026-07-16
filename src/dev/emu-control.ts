import * as fs from 'node:fs'
import * as net from 'node:net'
import type { BmServer } from '../emulator/bm-server.ts'
import type { Emulator, EmuPlayer } from '../emulator/index.ts'
import { makePlayer } from '../emulator/index.ts'

// The scenario verbs the emulator host understands, and the socket that carries them.
//
// One registry drives both front ends: the repl inside `pnpm dev:emu` and the one-shot `pnpm emuctl` from any
// other terminal. They dispatch the same commands against the same live world, so neither can grow a verb the
// other lacks.
//
// A unix socket rather than a port: it needs no slot allocation, it is unreachable from the network, and it
// lives in the worktree's own data/dev, so it is scoped to the instance by construction.

export type EmuCommand = {
	usage: string
	run: (args: string[]) => string | void | Promise<string | void>
}
export type EmuCommands = Record<string, EmuCommand>

type Request = { args: string[] }
type Response = { ok: boolean; output: string }

export function createEmuCommands(ctx: { emu: Emulator; bm: BmServer }): { commands: EmuCommands; join: (name: string) => EmuPlayer } {
	const { emu, bm } = ctx
	// Named players, so a scenario can refer to someone by the name it gave them rather than by an eos id.
	const players = new Map<string, EmuPlayer>()

	function join(name: string): EmuPlayer {
		if (players.has(name)) throw new Error(`${name} is already connected`)
		const player = emu.world.connectPlayer(makePlayer({ name, teamId: players.size % 2 === 0 ? 1 : 2 }))
		players.set(name, player)
		// so the app's battlemetrics lookups resolve this player rather than 404
		bm.addPlayer({ eosId: player.eos, steamId: player.steam })
		return player
	}

	function requirePlayer(name: string): EmuPlayer {
		const player = players.get(name)
		if (!player) throw new Error(`no player named '${name}' -- 'players' lists them, 'join ${name}' connects them`)
		return player
	}

	const commands: EmuCommands = {
		help: {
			usage: 'help                   list these commands',
			run: () => Object.values(commands).map(({ usage }) => `  ${usage}`).join('\n'),
		},
		join: {
			usage: 'join <name>            a player connects',
			run: ([name]) => {
				if (!name) throw new Error('usage: join <name>')
				const player = join(name)
				return `${name} joined team ${player.teamId} (steam ${player.steam}, eos ${player.eos})`
			},
		},
		leave: {
			usage: 'leave <name>           a player disconnects',
			run: ([name]) => {
				if (!name) throw new Error('usage: leave <name>')
				emu.world.disconnectPlayer(requirePlayer(name))
				players.delete(name)
				return `${name} left`
			},
		},
		chat: {
			usage: 'chat <name> <message>  say something in all-chat (this is how you drive !commands)',
			run: ([name, ...rest]) => {
				if (!name || rest.length === 0) throw new Error('usage: chat <name> <message>')
				emu.world.chat(requirePlayer(name), 'ChatAll', rest.join(' '))
				return `[ChatAll] ${name}: ${rest.join(' ')}`
			},
		},
		admchat: {
			usage: 'admchat <name> <msg>   say something in admin chat',
			run: ([name, ...rest]) => {
				if (!name || rest.length === 0) throw new Error('usage: admchat <name> <message>')
				emu.world.chat(requirePlayer(name), 'ChatAdmin', rest.join(' '))
				return `[ChatAdmin] ${name}: ${rest.join(' ')}`
			},
		},
		players: {
			usage: 'players                who is connected',
			run: () => {
				const list = emu.world.playerList()
				if (list.length === 0) return '(nobody connected)'
				return list.map((p) => `  ${p.name}\tteam ${p.teamId ?? '-'}\tsquad ${p.squadId ?? '-'}`).join('\n')
			},
		},
		squad: {
			usage: 'squad <name> <squad>   a player creates and leads a squad',
			run: ([name, ...rest]) => {
				if (!name || rest.length === 0) throw new Error('usage: squad <name> <squad name>')
				const squad = emu.world.createSquad(requirePlayer(name), rest.join(' '))
				return `${name} created squad ${squad.squadId} '${rest.join(' ')}' on team ${squad.teamId}`
			},
		},
		cam: {
			usage: 'cam <name> [off]       a player enters admin camera, or leaves it with `off`',
			run: ([name, off]) => {
				if (!name || (off && off !== 'off')) throw new Error('usage: cam <name> [off]')
				const player = requirePlayer(name)
				if (off) {
					emu.world.unpossessAdminCam(player)
					return `${name} left admin camera`
				}
				emu.world.possessAdminCam(player)
				return `${name} entered admin camera`
			},
		},
		end: {
			usage: 'end [1|2]              end the match, optionally naming the winning team',
			run: ([team]) => {
				if (team && team !== '1' && team !== '2') throw new Error('usage: end [1|2]')
				emu.world.endMatch(team ? { winnerTeamId: Number(team) } : undefined)
				return team ? `match ended, team ${team} won` : 'match ended'
			},
		},
		rcon: {
			usage: 'rcon <command>         run a raw rcon command against the world',
			run: (rest) => {
				if (rest.length === 0) throw new Error('usage: rcon <command>')
				return emu.world.handleCommand(rest.join(' '))
			},
		},
		cycle: {
			usage: 'cycle                  drop and restore rcon, as a server restart would',
			run: async () => {
				await emu.cycleRcon()
				return 'rcon cycled'
			},
		},
		rotate: {
			usage: 'rotate                 rotate the log file, as the game does',
			run: () => {
				emu.rotateLog()
				return 'log rotated'
			},
		},
	}

	return { commands, join }
}

export async function dispatch(commands: EmuCommands, args: string[]): Promise<Response> {
	const [name, ...rest] = args
	if (!name) return { ok: true, output: '' }
	const command = commands[name]
	if (!command) return { ok: false, output: `unknown command '${name}' -- try 'help'` }
	try {
		return { ok: true, output: (await command.run(rest)) ?? '' }
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

export async function serve(socketPath: string, commands: EmuCommands): Promise<net.Server> {
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
					response = await dispatch(commands, (JSON.parse(line) as Request).args)
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
