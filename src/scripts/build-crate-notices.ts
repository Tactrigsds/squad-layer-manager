// Regenerates layer-engine/third-party-notices.json, the crates compiled into layer-engine.wasm and their license
// texts, from `cargo metadata`. Needs cargo and the crate sources, so it runs on a development machine rather than in
// the build. Proc-macro crates and their dependencies run only at compile time, so they are left out.

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import * as TPN from './third-party-notices.ts'

type CargoPackage = {
	id: string
	name: string
	version: string
	license: string | null
	manifest_path: string
	targets: { kind: string[] }[]
}
type CargoMetadata = {
	packages: CargoPackage[]
	resolve: { root: string; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] }
}

const ROOT = path.resolve(import.meta.dirname, '../..')
const LICENSE_FILE = /^(licen[cs]e|copying)/i

const metadata: CargoMetadata = JSON.parse(
	childProcess.execFileSync(
		'cargo',
		['metadata', '--format-version', '1', '--manifest-path', 'layer-engine/Cargo.toml', '--filter-platform', 'wasm32-unknown-unknown'],
		{ cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
	),
)

const packages = new Map(metadata.packages.map((p) => [p.id, p]))
const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]))
const shipped = new Set<string>()
const pending = [metadata.resolve.root]
while (pending.length > 0) {
	for (const dep of nodes.get(pending.pop()!)!.deps) {
		if (!dep.dep_kinds.some((k) => k.kind === null) || shipped.has(dep.pkg)) continue
		if (packages.get(dep.pkg)!.targets.some((t) => t.kind.includes('proc-macro'))) continue
		shipped.add(dep.pkg)
		pending.push(dep.pkg)
	}
}

const entries: TPN.Entry[] = [...shipped].map((id) => {
	const pkg = packages.get(id)!
	const dir = path.dirname(pkg.manifest_path)
	const files = fs
		.readdirSync(dir)
		.filter((f) => LICENSE_FILE.test(f))
		.sort()
	// a crate offering MIT among alternatives is used under MIT, so only that text is carried
	const offersMit = pkg.license?.split(/\s+OR\s+/).some((l) => l.replace(/[()]/g, '') === 'MIT') ?? false
	const mitFile = files.find((f) => /mit/i.test(f))
	const chosen = offersMit && mitFile ? [mitFile] : files
	return {
		name: pkg.name,
		version: pkg.version,
		license: offersMit && mitFile ? 'MIT' : (pkg.license ?? undefined),
		text: chosen.length > 0 ? chosen.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n') : undefined,
	}
})

const out: TPN.CrateNotices = { lockPackages: TPN.lockPackages(), entries: entries.sort((a, b) => a.name.localeCompare(b.name)) }
fs.writeFileSync(path.join(ROOT, 'layer-engine/third-party-notices.json'), JSON.stringify(out, null, '\t') + '\n')
console.log(`wrote ${entries.length} crates: ${entries.map((e) => e.name).join(', ')}`)
