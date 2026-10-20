// Writes the license of every third-party package a build bundles into one plain text file next to its output. A
// minified bundle keeps none of the notices its packages' licenses require, so this file carries them instead. The
// repo's NOTICE, which credits code SLM is based on, heads every file.
//
// Used by the client build (vite, including its worker bundles), the server build and the docs site build.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { OutputBundle, Plugin } from 'rolldown'

export type Entry = { name: string; version: string; license?: string; text?: string }

export const FILE_NAME = 'third-party-notices.txt'

const ROOT = path.resolve(import.meta.dirname, '../..')
const LICENSE_FILE = /^(licen[cs]e|copying)/i
const NODE_MODULES = `${path.sep}node_modules${path.sep}`
const CRATE_NOTICES = path.join(ROOT, 'layer-engine/third-party-notices.json')
// license texts for packages that publish none, taken from upstream, named `<package name, / as +>.txt`
const FALLBACK_LICENSES = path.join(ROOT, 'third-party-licenses')

export type CrateNotices = { lockPackages: string[]; entries: Entry[] }

// `collect` adds a bundle's packages without writing anything, for bundles whose packages are listed in another
// build's file, as a vite worker's are in the main client build's. `emit` adds its own bundle's packages and the
// extra entries, then writes the file.
export function thirdPartyNotices(opts: { extraEntries?: () => Entry[] } = {}) {
	const entries = new Map<string, Entry>()
	const packageByDir = new Map<string, Entry | null>()

	function collectBundle(bundle: OutputBundle) {
		for (const chunk of Object.values(bundle)) {
			if (chunk.type === 'asset') continue
			for (const moduleId of chunk.moduleIds) {
				if (moduleId.startsWith('\0') || !moduleId.includes(NODE_MODULES)) continue
				const entry = packageOf(path.dirname(moduleId.split('?')[0]), packageByDir)
				if (entry) entries.set(`${entry.name}@${entry.version}`, entry)
			}
		}
	}

	return {
		collect: (): Plugin => ({
			name: 'slm:third-party-notices-collect',
			generateBundle(_, bundle) {
				collectBundle(bundle)
			},
		}),
		emit: (): Plugin => ({
			name: 'slm:third-party-notices',
			generateBundle(_, bundle) {
				collectBundle(bundle)
				for (const entry of opts.extraEntries?.() ?? []) entries.set(`${entry.name}@${entry.version}`, entry)
				this.emitFile({ type: 'asset', fileName: FILE_NAME, source: render([...entries.values()]) })
			},
		}),
	}
}

// the nearest enclosing package.json with a name and version, skipping the bare `{"type": ...}` ones some packages
// put in their dist directories
function packageOf(startDir: string, cache: Map<string, Entry | null>): Entry | null {
	const visited: string[] = []
	let dir = startDir
	let found: Entry | null = null
	while (dir.includes(NODE_MODULES) || dir.endsWith(`${path.sep}node_modules`)) {
		const cached = cache.get(dir)
		if (cached !== undefined) {
			found = cached
			break
		}
		visited.push(dir)
		const manifest = path.join(dir, 'package.json')
		if (fs.existsSync(manifest)) {
			const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
			if (data.name && data.version) {
				found = packageEntry(dir, data)
				break
			}
		}
		dir = path.dirname(dir)
	}
	for (const d of visited) cache.set(d, found)
	return found
}

export function packageEntry(dir: string, data = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))): Entry {
	const license = typeof data.license === 'string' ? data.license : data.license?.type
	const files = licenseFiles(dir)
	const fallback = path.join(FALLBACK_LICENSES, `${data.name.replace('/', '+')}.txt`)
	if (files.length === 0 && fs.existsSync(fallback)) files.push(fallback)
	const texts = files.map((file) => fs.readFileSync(file, 'utf8').trim())
	return {
		name: data.name,
		version: data.version,
		license: license?.trim(),
		text: texts.length > 0 ? texts.join('\n\n') : undefined,
	}
}

// every license file in a package, including those inside a LICENSE directory, as pagefind ships them
function licenseFiles(dir: string): string[] {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => LICENSE_FILE.test(entry.name))
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) return licenseFiles(full)
			return entry.isFile() ? [full] : []
		})
}

// The crates compiled into layer-engine.wasm. They are committed rather than read at build time because the node
// build has neither cargo nor the crate sources. Refuses to build once Cargo.lock no longer matches them.
export function crateEntries(): Entry[] {
	const notices: CrateNotices = JSON.parse(fs.readFileSync(CRATE_NOTICES, 'utf8'))
	const locked = lockPackages()
	const recorded = new Set(notices.lockPackages)
	if (locked.length !== recorded.size || locked.some((p) => !recorded.has(p))) {
		throw new Error(
			`${path.relative(ROOT, CRATE_NOTICES)} is out of date with layer-engine/Cargo.lock. Run \`pnpm build:crate-notices\`.`,
		)
	}
	return notices.entries
}

export function lockPackages(): string[] {
	const lock = fs.readFileSync(path.join(ROOT, 'layer-engine/Cargo.lock'), 'utf8')
	return [...lock.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm)].map((m) => `${m[1]}@${m[2]}`).sort()
}

function render(entries: Entry[]): string {
	const rule = '-'.repeat(80)
	let text = `${fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8').trim()}\n\n${'='.repeat(80)}\n\nThis build includes the following third-party software.\n`
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
		text += `\n${rule}\n${entry.name} ${entry.version}${entry.license ? ` (${entry.license})` : ''}\n${rule}\n\n`
		text += `${entry.text ?? 'This package does not include a license file.'}\n`
	}
	return text
}
