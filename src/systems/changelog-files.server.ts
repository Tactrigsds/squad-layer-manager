import fs from 'node:fs'
import path from 'node:path'
import * as YAML from 'yaml'

import { z } from '@/lib/zod'
import * as CL from '@/models/changelog.models'

// Reads the changelog off disk. Shared by the running server and the release and check scripts, so it holds no
// state and logs nothing: problems come back as `errors` for the caller to report or fail on.

export type Loaded = {
	index: CL.ReleaseIndex
	// newest first, the pending changes (if any) ahead of every release
	releases: CL.Release[]
	pending: CL.Entry[]
	errors: string[]
}

export type ParseResult = { code: 'ok'; entry: CL.Entry } | { code: 'err:invalid-fragment'; msg: string }

export function parseFragment(id: string, text: string): ParseResult {
	if (!CL.EntryIdSchema.safeParse(id).success) {
		return { code: 'err:invalid-fragment', msg: `"${id}" is not a valid id: lower case letters, digits and dashes` }
	}
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
	if (!match) return { code: 'err:invalid-fragment', msg: 'expected YAML frontmatter between two `---` lines' }

	let raw: unknown
	try {
		raw = YAML.parse(match[1])
	} catch (err) {
		return { code: 'err:invalid-fragment', msg: `frontmatter is not valid YAML: ${(err as Error).message}` }
	}
	const fm = CL.FrontmatterSchema.safeParse(raw ?? {})
	if (!fm.success) return { code: 'err:invalid-fragment', msg: z.prettifyError(fm.error) }

	const content = match[2].trim()
	const breakAt = content.search(/\r?\n\s*\r?\n/)
	const title = (breakAt === -1 ? content : content.slice(0, breakAt)).replace(/\s*\r?\n\s*/g, ' ').trim()
	const body = breakAt === -1 ? null : content.slice(breakAt).trim() || null
	if (!title) return { code: 'err:invalid-fragment', msg: 'the entry has no text after its frontmatter' }

	return { code: 'ok', entry: { id, ...fm.data, title, body } }
}

function readFragments(dir: string, errors: string[]): CL.Entry[] {
	if (!fs.existsSync(dir)) return []
	const entries: CL.Entry[] = []
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.md') || name === 'README.md') continue
		const file = path.join(dir, name)
		const res = parseFragment(name.slice(0, -'.md'.length), fs.readFileSync(file, 'utf8'))
		if (res.code === 'ok') entries.push(res.entry)
		else errors.push(`${path.relative(process.cwd(), file)}: ${res.msg}`)
	}
	return CL.sortEntries(entries)
}

export function readIndex(changelogDir: string, errors: string[]): CL.ReleaseIndex {
	const file = path.join(changelogDir, 'releases.json')
	if (!fs.existsSync(file)) return []
	const parsed = CL.ReleaseIndexSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
	if (!parsed.success) {
		errors.push(`${file}: ${parsed.error.message}`)
		return []
	}
	return parsed.data.toSorted((a, b) => CL.compareVersions(b.version, a.version))
}

export function load(changelogDir: string, changesDir: string): Loaded {
	const errors: string[] = []
	const index = readIndex(changelogDir, errors)
	const pending = readFragments(changesDir, errors)
	const releases: CL.Release[] = []
	if (pending.length > 0) releases.push({ version: null, date: null, entries: pending })
	for (const { version, date } of index) {
		releases.push({ version, date, entries: readFragments(path.join(changelogDir, version), errors) })
	}

	const seen = new Set<string>()
	for (const release of releases) {
		for (const entry of release.entries) {
			if (seen.has(entry.id)) errors.push(`entry id "${entry.id}" is used more than once; rename one of the fragments`)
			seen.add(entry.id)
		}
	}
	return { index, releases, pending, errors }
}
