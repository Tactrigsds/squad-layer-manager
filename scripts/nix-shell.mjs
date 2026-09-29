// Optional nix dev shell for scripts that launch Playwright's chromium or build the engine.
//
// When the primary checkout carries an untracked flake.nix (a NixOS host, see that file's header) and `nix` is on
// PATH, reexecInFlake re-runs the calling script inside its dev shell, which supplies the rust toolchain and the
// libraries the downloaded chromium links against. Otherwise it returns and the script runs directly. The flake is
// copied beside the shared git dir first: `nix develop path:.` on a checkout would copy the entire tree into the
// store, and dies on the sockets under data/.

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function onPath(command) {
	return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, command)))
}

function flakeDir() {
	const commonDir = path.resolve(
		repoRoot,
		execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
	)
	const primary = path.dirname(commonDir)
	if (!fs.existsSync(path.join(primary, 'flake.nix')) || !onPath('nix')) return undefined
	const dir = path.join(commonDir, 'slm-flake')
	fs.mkdirSync(dir, { recursive: true })
	for (const file of ['flake.nix', 'flake.lock']) {
		const src = path.join(primary, file)
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, file))
	}
	return dir
}

// Never returns when it re-executes: the process exits with the shell's status.
export function reexecInFlake(scriptUrl) {
	if (process.env.IN_NIX_SHELL) return
	const dir = flakeDir()
	if (!dir) return
	const script = fileURLToPath(scriptUrl)
	const res = spawnSync('nix', ['develop', `path:${dir}`, '-c', 'node', script, ...process.argv.slice(2)], {
		cwd: process.cwd(),
		stdio: 'inherit',
	})
	process.exit(res.status ?? 1)
}
