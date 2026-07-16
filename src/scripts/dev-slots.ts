import { parseArgs } from 'node:util'
import * as Slots from '../dev/slots.ts'

// Lists the dev slots claimed across every worktree of this repo, or releases this worktree's.
// `pnpm dev:slots [--release]`.

const args = parseArgs({ options: { release: { type: 'boolean', default: false } }, allowPositionals: false })

if (args.values.release) {
	const released = await Slots.releaseSlot()
	console.log(released ? "released this worktree's slot" : 'this worktree had no slot')
} else {
	const slots = await Slots.listSlots()
	if (slots.length === 0) console.log('no slots claimed')
	for (const slot of slots) {
		console.log(`slot ${slot.slot}\tapp :${slot.ports.app}\tclient :${slot.ports.client}\trcon :${slot.ports.rcon}\t${slot.worktree}`)
	}
}
