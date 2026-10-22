// Builds layer-engine/ to assets/layer-engine.wasm, inside the optional nix dev shell when there is one (see
// nix-shell.mjs), which supplies the C linker cargo's build scripts need and the lld the wasm target links through.
//
// assets/layer-engine.wasm.stamp records a hash of the engine sources and of the wasm built from them. When both still
// match, the build is skipped without starting the nix shell or cargo, so any script can call this before it reads the
// wasm. A wasm copied in from another checkout has no matching stamp and is rebuilt.
//
//   --if-present  do nothing when there is no wasm yet. For the unit suite, which skips the engine tests without one.

import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { reexecInFlake, repoRoot } from './nix-shell.mjs'

const ENGINE_DIR = path.join(repoRoot, 'layer-engine')
const WASM = path.join(repoRoot, 'assets', 'layer-engine.wasm')
const STAMP = WASM + '.stamp'
const ENGINE_INPUTS = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'src']

function hashInto(hash, file) {
	const stat = fs.statSync(file, { throwIfNoEntry: false })
	if (!stat) return
	if (stat.isDirectory()) {
		for (const entry of fs.readdirSync(file).sort()) hashInto(hash, path.join(file, entry))
		return
	}
	hash.update(path.relative(ENGINE_DIR, file)).update('\0').update(fs.readFileSync(file)).update('\0')
}

function sourcesHash() {
	const hash = crypto.createHash('sha256')
	for (const input of ENGINE_INPUTS) hashInto(hash, path.join(ENGINE_DIR, input))
	return hash.digest('hex')
}

function wasmHash() {
	return crypto.createHash('sha256').update(fs.readFileSync(WASM)).digest('hex')
}

function readStamp() {
	try {
		return fs.readFileSync(STAMP, 'utf8').trim()
	} catch {
		return null
	}
}

if (!fs.existsSync(WASM) && process.argv.includes('--if-present')) process.exit(0)

const sources = sourcesHash()
if (fs.existsSync(WASM) && readStamp() === `${sources} ${wasmHash()}`) process.exit(0)

reexecInFlake(import.meta.url)

const cargo = spawnSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: ENGINE_DIR, stdio: 'inherit' })
if (cargo.error) {
	console.error(`cargo: ${cargo.error.message}`)
	process.exit(1)
}
if (cargo.status !== 0) process.exit(cargo.status ?? 1)

fs.mkdirSync(path.dirname(WASM), { recursive: true })
fs.copyFileSync(path.join(ENGINE_DIR, 'target', 'wasm32-unknown-unknown', 'release', 'layer_engine.wasm'), WASM)
fs.writeFileSync(STAMP, `${sources} ${wasmHash()}\n`)
