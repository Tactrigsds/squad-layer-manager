// Optional nix dev shell for scripts that launch Playwright's chromium or build the engine.
//
// On a linux host with `nix` on PATH, reexecInFlake re-runs the calling script inside the dev shell of nix/flake.nix,
// which supplies the rust toolchain and the libraries the downloaded chromium links against. Otherwise it returns and
// the script runs directly. The dev container has no nix and takes the direct path.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function onPath(command) {
	return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, command)))
}

function flakeDir() {
	if (process.platform !== 'linux' || !onPath('nix')) return undefined
	return path.join(repoRoot, 'nix')
}

// The command and args that run `command` inside the dev shell when there is one, and directly otherwise. For a
// single step that needs the toolchain, where re-executing the whole script would be slower.
export function inFlake(command, args) {
	if (process.env.IN_NIX_SHELL) return [command, args]
	const dir = flakeDir()
	if (!dir) return [command, args]
	return ['nix', ['develop', `path:${dir}`, '-c', command, ...args]]
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
