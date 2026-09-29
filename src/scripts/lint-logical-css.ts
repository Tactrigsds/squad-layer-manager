import * as fs from 'node:fs'
import * as path from 'node:path'

// Fails on physical Tailwind utilities (ml-2, left-0, text-right, border-l, rounded-tl, ...) in the string literals of
// src/ and plugins/, since they do not mirror in right-to-left locales. Use the logical forms instead: ms/me, ps/pe,
// inset-s/inset-e, text-start/text-end, border-s/border-e, rounded-s/rounded-e, rounded-ss/se/es/ee.
//
// A deliberate physical utility is allowed when `physical:` appears in a comment on its line or the line above,
// followed by the reason. Two cases pass without one: `left-1/2` and `right-1/2` in a string that also translates on
// x, which is centering rather than a side, and a physical utility whose string mirrors it with an `rtl:` variant.

const ROOTS = ['src', 'plugins']
const SKIP_DIRS = [`${path.sep}node_modules${path.sep}`, `src${path.sep}scripts${path.sep}`]
const EXTENSIONS = new Set(['.ts', '.tsx'])

const PHYSICAL =
	/^-?(?:(?:scroll-)?[mp][lr]-|(?:left|right)-(?:\d|px|auto|full|\[|\()|(?:border-[lr]|rounded-(?:[lr]|[tb][lr])|origin-(?:left|right|(?:top|bottom)-(?:left|right))|bg-(?:linear|gradient)-to-(?:[lr]|[tb][lr])|slide-(?:in|out)-from-(?:left|right))(?:-|$))/
const EXACT = new Set(['text-left', 'text-right', 'float-left', 'float-right', 'clear-left', 'clear-right'])
const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
const CENTERING = /^-?(?:left|right)-1\/2$/

type Diagnostic = { file: string; line: number; token: string }

// the utility a token applies, with its variants (`rtl:`, `data-[x=y]:`, `[&>*]:`) and important marker stripped
function utilityOf(token: string) {
	let depth = 0
	let start = 0
	for (let i = 0; i < token.length; i++) {
		const c = token[i]
		if (c === '[' || c === '(') depth++
		else if (c === ']' || c === ')') depth--
		else if (c === ':' && depth === 0) start = i + 1
	}
	return token.slice(start).replace(/^!|!$/g, '')
}

function isPhysical(utility: string) {
	return EXACT.has(utility) || PHYSICAL.test(utility)
}

function lintFile(file: string, diagnostics: Diagnostic[]) {
	const src = fs.readFileSync(file, 'utf8')
	if (
		!/\b(?:m[lr]|p[lr]|left|right|border-[lr]|rounded-|origin-|-to-[lrtb]|text-(?:left|right)|float-|clear-|from-(?:left|right))/.test(
			src,
		)
	)
		return
	const lineStarts = [0]
	for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1)
	const lineAt = (offset: number) => {
		let lo = 0
		let hi = lineStarts.length - 1
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1
			if (lineStarts[mid] <= offset) lo = mid
			else hi = mid - 1
		}
		return lo
	}
	const lines = src.split('\n')
	for (const match of src.matchAll(STRING)) {
		const body = match[0].slice(1, -1)
		const tokens = body.split(/\s+/)
		const centered = tokens.some((t) => /^-?translate-x-/.test(utilityOf(t)))
		const mirrored = tokens.some((t) => /(?:^|:)rtl:/.test(t) && isPhysical(utilityOf(t)))
		for (const token of tokens) {
			const utility = utilityOf(token)
			if (!isPhysical(utility) || mirrored) continue
			if (centered && CENTERING.test(utility)) continue
			const line = lineAt(match.index + match[0].indexOf(token))
			if (lines[line].includes('physical:') || (line > 0 && lines[line - 1].includes('physical:'))) continue
			diagnostics.push({ file, line: line + 1, token })
		}
	}
}

const diagnostics: Diagnostic[] = []
for (const root of ROOTS) {
	for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name))) continue
		if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
		const file = path.join(entry.parentPath, entry.name)
		if (SKIP_DIRS.some((dir) => file.includes(dir))) continue
		lintFile(file, diagnostics)
	}
}

for (const d of diagnostics) {
	console.error(`${d.file}:${d.line}: physical utility \`${d.token}\`; use the logical form, or mark it with a \`physical:\` comment`)
}
if (diagnostics.length > 0) {
	console.error(`\n${diagnostics.length} physical Tailwind utilit${diagnostics.length === 1 ? 'y' : 'ies'} found`)
	process.exit(1)
}
