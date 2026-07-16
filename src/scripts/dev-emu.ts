import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { parseArgs } from 'node:util'
import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'
import { BmServer } from '../emulator/bm-server.ts'
import { Emulator, makePlayer } from '../emulator/index.ts'
import type { EmuPlayer } from '../emulator/index.ts'

// The emulated squad server this worktree's app talks to, plus the stub battlemetrics api, as a long-lived
// process. `pnpm dev:emu`.
//
// Deliberately not hosted inside the app: `pnpm server:dev` runs under `tsx watch` and restarts on every
// edit, which would take the emulated world -- players, squads, match state, log history -- down with it. As
// its own process the world outlives app reloads, which is the whole point of having one while iterating.

const args = parseArgs({
	options: {
		admins: { type: 'string' },
		players: { type: 'string', default: '0' },
	},
	allowPositionals: false,
})

DevInstance.ensureLayerData()
const slot = Slots.requireSlot()

fs.mkdirSync(DevInstance.DEV_DIR, { recursive: true })
const adminSteamIds = (args.values.admins ?? '').split(',').map((id) => id.trim()).filter(Boolean)
fs.writeFileSync(
	DevInstance.ADMINS_CFG_PATH,
	DevInstance.renderAdminsCfg(adminSteamIds, DevInstance.ADMIN_GROUP, ['canseeadminchat', 'balance', 'cameraman', 'teamchange']),
)

// Truncated rather than appended to: a stale log from a previous session would be replayed as if it had just
// happened the moment the app tails it.
fs.writeFileSync(DevInstance.SQUAD_LOG_PATH, '')

const emu = new Emulator({ serverName: `slm-dev (${slot.name})`, password: DevInstance.RCON_PASSWORD })
await emu.start({ rconPort: slot.ports.rcon })
emu.attachLogFile(DevInstance.SQUAD_LOG_PATH)

const bm = new BmServer()
await bm.listen(slot.ports.bm)

const players = new Map<string, EmuPlayer>()
function join(name: string): EmuPlayer {
	const player = emu.world.connectPlayer(makePlayer({ name, teamId: players.size % 2 === 0 ? 1 : 2 }))
	players.set(name, player)
	bm.addPlayer({ eosId: player.eos, steamId: player.steam })
	return player
}

for (let i = 0; i < Number(args.values.players); i++) join(`DevPlayer${i + 1}`)

console.log(`emulator up — slot ${slot.slot} (${slot.name})
  rcon      127.0.0.1:${slot.ports.rcon} (password ${DevInstance.RCON_PASSWORD})
  bm stub   http://127.0.0.1:${slot.ports.bm}
  log       ${DevInstance.SQUAD_LOG_PATH}
  app       http://localhost:${slot.ports.client}
type 'help' for scenario commands, ctrl-c to stop`)

const COMMANDS: Record<string, { usage: string; run: (rest: string[]) => void }> = {
	help: {
		usage: 'help',
		run: () => {
			for (const { usage } of Object.values(COMMANDS)) console.log(`  ${usage}`)
		},
	},
	join: {
		usage: 'join <name>            a player connects',
		run: ([name]) => {
			if (!name) throw new Error('name required')
			const player = join(name)
			console.log(`${name} joined team ${player.teamId} (steam ${player.steam})`)
		},
	},
	leave: {
		usage: 'leave <name>           a player disconnects',
		run: ([name]) => {
			const player = players.get(name)
			if (!player) throw new Error(`no player named ${name}`)
			emu.world.disconnectPlayer(player)
			players.delete(name)
		},
	},
	chat: {
		usage: 'chat <name> <message>  say something in all-chat (use !commands here)',
		run: ([name, ...rest]) => {
			const player = players.get(name)
			if (!player) throw new Error(`no player named ${name}`)
			emu.world.chat(player, 'ChatAll', rest.join(' '))
		},
	},
	admchat: {
		usage: 'admchat <name> <msg>   say something in admin chat',
		run: ([name, ...rest]) => {
			const player = players.get(name)
			if (!player) throw new Error(`no player named ${name}`)
			emu.world.chat(player, 'ChatAdmin', rest.join(' '))
		},
	},
	players: {
		usage: 'players                who is connected',
		run: () => {
			for (const player of emu.world.playerList()) console.log(`  ${player.name}\tteam ${player.teamId}\tsquad ${player.squadId ?? '-'}`)
		},
	},
	end: {
		usage: 'end [1|2]              end the match, optionally naming the winning team',
		run: ([team]) => emu.world.endMatch(team ? { winnerTeamId: Number(team) } : undefined),
	},
	rcon: {
		usage: 'rcon <command>         run a raw rcon command against the world',
		run: (rest) => console.log(emu.world.handleCommand(rest.join(' '))),
	},
	cycle: {
		usage: 'cycle                  drop and restore rcon, as a server restart would',
		run: () => void emu.cycleRcon(),
	},
	rotate: {
		usage: 'rotate                 rotate the log file, as the game does',
		run: () => emu.rotateLog(),
	},
}

function shutdown() {
	rl?.close()
	emu.dispose()
	bm.close()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Only offer the REPL to a terminal. Run without one (a pane manager, a background job) stdin is at EOF
// immediately, and a readline interface over it would fire 'close' and take the emulator down with it.
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' }) : null
if (!rl) {
	console.log('(no tty — scenario repl disabled; the emulator keeps running)')
	// nothing else holds the loop open once the sockets are idle
	setInterval(() => {}, 1 << 30)
}

rl?.prompt()
rl?.on('close', shutdown)
rl?.on('line', (line) => {
	const [name, ...rest] = line.trim().split(/\s+/)
	if (name) {
		const command = COMMANDS[name]
		if (!command) console.error(`unknown command '${name}' — try 'help'`)
		else {
			try {
				command.run(rest)
			} catch (err) {
				console.error(err instanceof Error ? err.message : err)
			}
		}
	}
	rl.prompt()
})
