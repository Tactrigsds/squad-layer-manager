import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { parseArgs } from 'node:util'
import * as EmuControl from '../dev/emu-control.ts'
import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'
import { BmServer } from '../emulator/bm-server.ts'
import { Emulator } from '../emulator/index.ts'

// The emulated squad server this worktree's app talks to, plus the stub battlemetrics api, as a long-lived
// process. `pnpm dev:emu`.
//
// Deliberately not hosted inside the app: `pnpm server:dev` runs under `tsx watch` and restarts on every
// edit, which would take the emulated world -- players, squads, match state, log history -- down with it. As
// its own process the world outlives app reloads, which is the whole point of having one while iterating.
//
// Scenarios are driven either from the repl below or from `pnpm emuctl` in another terminal; both dispatch
// the same registry (src/dev/emu-control.ts).

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

const { commands, join } = EmuControl.createEmuCommands({ emu, bm })
const control = await EmuControl.serve(DevInstance.EMU_SOCKET_PATH, commands)

for (let i = 0; i < Number(args.values.players); i++) join(`DevPlayer${i + 1}`)

console.log(`emulator up -- slot ${slot.slot} (${slot.name})
  rcon      127.0.0.1:${slot.ports.rcon} (password ${DevInstance.RCON_PASSWORD})
  bm stub   http://127.0.0.1:${slot.ports.bm}
  log       ${DevInstance.SQUAD_LOG_PATH}
  app       http://localhost:${slot.ports.client}
drive it from here ('help'), or with \`pnpm emuctl <command>\` from anywhere in this worktree. ctrl-c to stop.`)

let shuttingDown = false
function shutdown() {
	if (shuttingDown) return
	shuttingDown = true
	rl?.close()
	control.close()
	// the socket file outlives the listener, and a leftover would look like a running emulator to the next host
	fs.rmSync(DevInstance.EMU_SOCKET_PATH, { force: true })
	emu.dispose()
	bm.close()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Only offer the REPL to a terminal. Run without one (a pane manager, a background job) stdin is at EOF
// immediately, and a readline interface over it would fire 'close' and take the emulator down with it.
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' }) : null
if (!rl) console.log('(no tty -- repl disabled; drive it with `pnpm emuctl` instead)')

rl?.prompt()
rl?.on('close', shutdown)
rl?.on('line', (line) => {
	void (async () => {
		const { ok, output } = await EmuControl.dispatch(commands, line.trim().split(/\s+/).filter(Boolean))
		if (output) (ok ? console.log : console.error)(output)
		rl.prompt()
	})()
})
