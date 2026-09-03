import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'

// Provisions a development workspace. `pnpm dev` owns this script's public entry points.

const args = parseArgs({
	options: {
		force: { type: 'boolean', default: false },
		'reset-data': { type: 'boolean', default: false },
	},
	allowPositionals: false,
})

const worktree = Slots.worktreeRoot()
const root = Slots.repoRootCheckout()
const linkedWorktree = worktree !== root

const slot = await Slots.claimSlot()
console.log(`slot ${slot.slot} (${slot.name})`)

if (linkedWorktree) {
	for (const name of ['.env', '.env.secrets']) {
		const target = path.join(root, name)
		const link = path.join(worktree, name)
		if (!fs.existsSync(target)) {
			console.log(`  ${name}: the primary checkout has none, skipping`)
			continue
		}
		const existing = fs.lstatSync(link, { throwIfNoEntry: false })
		if (existing && !existing.isSymbolicLink() && !args.values.force) {
			console.log(`  ${name}: already a local file, leaving it alone`)
			continue
		}
		if (existing) fs.rmSync(link)
		fs.symlinkSync(target, link)
		console.log(`  ${name} -> ${target}`)
	}
}

{
	const ensureArgs = [path.join(worktree, 'scripts/worktree.mjs'), 'ensure-artifacts']
	if (args.values.force) ensureArgs.push('--force')
	const res = childProcess.spawnSync(process.execPath, ensureArgs, { cwd: worktree, stdio: 'inherit' })
	if (res.status !== 0) process.exit(res.status ?? 1)
}

const dest = DevInstance.DEV_DB_PATH
if (!fs.existsSync(dest) || args.values['reset-data']) {
	const cloneArgs = ['--tsconfig', 'tsconfig.node.json', 'src/scripts/dev-clone-db.ts']
	if (args.values['reset-data']) cloneArgs.push('--force')
	const res = childProcess.spawnSync(path.join(worktree, 'node_modules/.bin/tsx'), cloneArgs, {
		cwd: worktree,
		env: { ...process.env, ...DevInstance.envOverrides(slot) },
		stdio: 'inherit',
	})
	if (res.status !== 0) process.exit(res.status ?? 1)
}

console.log(`
ready. \`pnpm dev\` runs this instance -- the app, the client and the emulated squad server -- at

  ${Slots.instanceUrl(Slots.requireSlot())}

that one url is the whole instance. Drive the emulated server with \`pnpm emuctl <command>\`.`)
