import * as EmuControl from '../dev/emu-control.ts'
import * as DevInstance from '../dev/instance.ts'

// Drives this worktree's emulated squad server from any terminal. `pnpm emuctl <command> [args...]`, e.g.
//
//   pnpm emuctl join Alice
//   pnpm emuctl chat Alice '!vote 1'
//   pnpm emuctl end 1
//
// `pnpm emuctl help` lists the commands. They are the same ones the repl in `pnpm dev:emu` takes, dispatched
// against the same running world (src/dev/emu-control.ts).

const args = process.argv.slice(2)
if (args.length === 0) args.push('help')

// Everything reaching here (a refused socket, most of all) is a message meant for whoever typed the command,
// so it is printed as one line rather than left to surface as an unhandled rejection with a stack trace.
try {
	const { ok, output } = await EmuControl.send(DevInstance.EMU_SOCKET_PATH, args)
	if (output) (ok ? console.log : console.error)(output)
	if (!ok) process.exit(1)
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}
