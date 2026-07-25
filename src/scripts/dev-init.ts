import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as Slots from '../dev/slots.ts'

// Provisions this worktree as a dev instance: claims a port slot, links the env files it shares with the main
// checkout, and clones the main checkout's database. `pnpm dev:init`.

const args = parseArgs({
	options: {
		force: { type: 'boolean', default: false },
		'no-clone': { type: 'boolean', default: false },
	},
	allowPositionals: false,
})

const worktree = Slots.worktreeRoot()
const root = Slots.repoRootCheckout()
if (worktree === root) {
	console.error('this is the main checkout, which runs on its own .env and needs no slot')
	process.exit(1)
}

const slot = await Slots.claimSlot()
console.log(`slot ${slot.slot} (${slot.name})`)

// Symlinked rather than copied: a worktree wants the same discord app, encryption key and battlemetrics
// credentials as the main checkout, and a copy would silently keep the old values when one of them is
// rotated. The per-worktree differences are injected as env overrides at spawn time instead (src/dev/instance.ts).
for (const name of ['.env', '.env.secrets']) {
	const target = path.join(root, name)
	const link = path.join(worktree, name)
	if (!fs.existsSync(target)) {
		console.log(`  ${name}: the main checkout has none, skipping`)
		continue
	}
	const existing = fs.lstatSync(link, { throwIfNoEntry: false })
	if (existing && !existing.isSymbolicLink() && !args.values.force) {
		console.log(`  ${name}: already a real file here, leaving it alone (--force to replace with a link)`)
		continue
	}
	if (existing) fs.rmSync(link)
	fs.symlinkSync(target, link)
	console.log(`  ${name} -> ${target}`)
}

// `worktree new` and the WorktreeCreate hook have already done this; a worktree made any other way has not.
{
	const ensureArgs = [path.join(worktree, 'scripts/worktree.mjs'), 'ensure-artifacts']
	if (args.values.force) ensureArgs.push('--force')
	const res = childProcess.spawnSync(process.execPath, ensureArgs, { cwd: worktree, stdio: 'inherit' })
	if (res.status !== 0) process.exit(res.status ?? 1)
}

if (!args.values['no-clone']) {
	const cloneArgs = ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-clone-db.ts']
	if (args.values.force) cloneArgs.push('--force')
	const res = childProcess.spawnSync(path.join(worktree, 'node_modules/.bin/tsx'), cloneArgs, { cwd: worktree, stdio: 'inherit' })
	if (res.status !== 0) process.exit(res.status ?? 1)
}

console.log(`
ready. \`pnpm dev\` runs this instance -- the app, the client and the emulated squad server -- at

  ${Slots.instanceUrl(Slots.requireSlot())}

that one url is the whole instance, already signed in. Drive the emulated server with \`pnpm emuctl <command>\`.
if you change layer-engine/, rebuild this worktree's copy with \`pnpm build:engine\`.`)
