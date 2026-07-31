import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Checks every link in the project's markdown for a target that does not exist. Run with `pnpm docs:lint`.
//
// Docs go stale silently: renaming a file or a heading breaks every link into it, and nothing at build time reads
// markdown, so the first person to notice is a reader who followed the link. This is the gate for that. It covers
// links between doc files, the images they embed, and `#fragment` anchors against the target's own headings.
//
// External urls are not fetched: a network call would make the check slow and flaky, and a 404 on someone else's
// site is not something a push should block on.

type Diagnostic = { file: string; line: number; col: number; message: string }

const EXTERNAL = /^(https?:|mailto:|tel:|data:|#!)/

const docs = execSync("git ls-files '*.md'", { encoding: 'utf8' }).trim().split('\n').filter(Boolean)

// Anchors are generated from the heading's rendered text, so the markup has to come off first. Emphasis markers are
// only stripped where they are flanked the way an emphasis run has to be, which leaves `snake_case` in a heading
// alone -- GitHub keeps that underscore in the anchor because it never renders as emphasis.
function slug(heading: string) {
	const rendered = heading
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g, '$1$2')
		.replace(/(^|[^A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9])/g, '$1$2')
	return rendered
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
}

// A fenced block's contents are a sample, not links, and neither are inline code spans. Blanking them rather than
// dropping them keeps every remaining line and column honest for the diagnostics.
function blankCode(src: string) {
	let fenced = false
	return src
		.split('\n')
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				fenced = !fenced
				return ''
			}
			if (fenced) return ''
			return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
		})
		.join('\n')
}

function headingAnchors(file: string) {
	const seen = new Map<string, number>()
	const anchors = new Set<string>()
	for (const line of blankCode(fs.readFileSync(file, 'utf8')).split('\n')) {
		const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
		if (!m) continue
		const base = slug(m[2])
		if (!base) continue
		const n = seen.get(base) ?? 0
		seen.set(base, n + 1)
		anchors.add(n === 0 ? base : `${base}-${n}`)
	}
	return anchors
}

const anchorsByFile = new Map(docs.map((f) => [path.normalize(f), headingAnchors(f)]))
const diagnostics: Diagnostic[] = []

for (const file of docs) {
	const dir = path.dirname(file)
	const src = blankCode(fs.readFileSync(file, 'utf8'))
	const lineStarts = [0]
	for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1)
	const at = (index: number) => {
		const line = lineStarts.findLastIndex((start) => start <= index)
		return { line: line + 1, col: index - lineStarts[line] + 1 }
	}

	const links: { raw: string; index: number }[] = []
	for (const m of src.matchAll(/!?\[[^\]]*\]\(([^)]*)\)/g)) links.push({ raw: m[1], index: m.index })
	for (const m of src.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) links.push({ raw: m[1], index: m.index })

	for (const { raw, index } of links) {
		const { line, col } = at(index)
		const target = raw
			.trim()
			.replace(/^<(.*)>$/, '$1')
			.replace(/\s+["'].*$/, '')
		if (!target) {
			diagnostics.push({ file, line, col, message: 'link has no target' })
			continue
		}
		if (EXTERNAL.test(target)) continue

		const hashAt = target.indexOf('#')
		const rel = hashAt === -1 ? target : target.slice(0, hashAt)
		const fragment = hashAt === -1 ? '' : target.slice(hashAt + 1)
		const resolved = rel ? path.normalize(path.join(dir, decodeURIComponent(rel))) : path.normalize(file)

		if (!fs.existsSync(resolved)) {
			diagnostics.push({ file, line, col, message: `missing file: ${target}` })
			continue
		}
		if (!fragment) continue

		const anchors = anchorsByFile.get(resolved)
		// a fragment into something that is not a doc (a source file on the forge, say) has no headings to check
		if (!anchors) continue
		if (!anchors.has(fragment)) {
			diagnostics.push({ file, line, col, message: `missing anchor: ${target}` })
		}
	}
}

for (const d of diagnostics) console.log(`${d.file}:${d.line}:${d.col}  ${d.message}`)
if (diagnostics.length) {
	console.log(`\n${diagnostics.length} dead link(s) across ${docs.length} doc(s)`)
	process.exit(1)
}
console.log(`no dead links across ${docs.length} docs`)
