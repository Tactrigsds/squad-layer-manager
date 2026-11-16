import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { transform } from 'lightningcss'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Reports CSS rules whose shape makes Chrome restyle many elements when one element changes state. The app's
// stylesheet is compiled the way the build compiles it (Tailwind over src/index.css), then each selector is classified
// by the state it tests outside the element it styles, and by how many elements its target can match.
// docs/developers/style-invalidation.md explains the mechanism and how to fix each kind of finding.
//
//   pnpm audit:style            medium and high findings
//   pnpm audit:style --min=0    every finding
//   pnpm audit:style --json     every finding, as JSON
//   pnpm audit:style --strict   fails on a high finding, unless `style-invalidation:` and a reason are written in a
//                               comment on the line that uses the rule or the line above (in a stylesheet, anywhere
//                               in the comment block above the rule)

const repoRoot = process.cwd()
const srcDir = path.join(repoRoot, 'src')

type Component = { type: string; [k: string]: any }
type Selector = Component[]

const STRUCTURAL = new Set(['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type'])
const POSITIONAL = new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'nth-col', 'nth-last-col'])
const DYNAMIC = new Set([
	'hover',
	'active',
	'focus',
	'focus-within',
	'focus-visible',
	'checked',
	'disabled',
	'enabled',
	'invalid',
	'valid',
	'user-invalid',
	'placeholder-shown',
	'open',
	'target',
	'indeterminate',
	'read-only',
	'read-write',
	'required',
	'optional',
	'autofill',
	'default',
	'popover-open',
])

// A compound with the combinator that joins it to the next compound to its right.
type Compound = { parts: Component[]; next: string | null }

function splitCompounds(sel: Selector): Compound[] {
	const out: Compound[] = [{ parts: [], next: null }]
	for (const c of sel) {
		if (c.type === 'combinator') {
			out[out.length - 1].next = c.value
			out.push({ parts: [], next: null })
		} else out[out.length - 1].parts.push(c)
	}
	return out
}

// Rewrites `:is(A B)` and `:where(A B)` in a compound into ancestor compounds, so `.x:is(.dark *)` reads as `.dark .x`.
// Returns every alternative, capped at 16.
function flatten(sel: Selector, depth = 0): Selector[] {
	if (depth > 4) return [sel]
	let results: Selector[] = [[]]
	for (const comp of splitCompounds(sel)) {
		// each variant is the ancestor chain a nested selector adds (ending in its combinator), then this compound
		let variants: Selector[] = [[]]
		let parts: Component[][] = [[]]
		for (const part of comp.parts) {
			const nested =
				part.type === 'pseudo-class' && (part.kind === 'is' || part.kind === 'where') ? (part.selectors as Selector[]) : null
			if (!nested || nested.every((s) => !s.some((c) => c.type === 'combinator'))) {
				parts = parts.map((ps) => [...ps, part])
				continue
			}
			const nextVariants: Selector[] = []
			const nextParts: Component[][] = []
			for (let v = 0; v < variants.length; v++) {
				for (const inner of nested.flatMap((s) => flatten(s, depth + 1))) {
					const lastComb = inner.map((c) => c.type).lastIndexOf('combinator')
					nextVariants.push([...variants[v], ...inner.slice(0, lastComb + 1)])
					nextParts.push([...parts[v], ...inner.slice(lastComb + 1).filter((c) => c.type !== 'universal')])
				}
			}
			variants = nextVariants.slice(0, 16)
			parts = nextParts.slice(0, 16)
		}
		const tail: Component[] = comp.next ? [{ type: 'combinator', value: comp.next }] : []
		results = results.flatMap((r) => variants.map((v, i) => [...r, ...v, ...parts[i], ...tail])).slice(0, 16)
	}
	return results
}

// every pseudo-class kind in a compound, looking through :not(), :is() and :where()
function pseudoKinds(parts: Component[]): string[] {
	const out: string[] = []
	for (const p of parts) {
		if (p.type !== 'pseudo-class') continue
		out.push(p.kind)
		if ((p.kind === 'not' || p.kind === 'is' || p.kind === 'where') && Array.isArray(p.selectors)) {
			for (const s of p.selectors as Selector[]) if (!s.some((c) => c.type === 'combinator')) out.push(...pseudoKinds(s))
		}
	}
	return out
}

type Breadth = { rank: number; label: string; classes: string[] }

// how many elements a compound can match: a class narrows it to that class, a tag to every element of that tag
function targetBreadth(parts: Component[]): Breadth {
	const classes = parts.filter((p) => p.type === 'class').map((p) => p.name as string)
	if (parts.some((p) => p.type === 'id')) return { rank: 0, label: 'id', classes }
	// a Tailwind variant utility (`group-hover:x`) sits only on the elements written to use it; a plain shared class
	// (`.fd-btn`, `.group`) can sit on hundreds
	const variantClass = classes.find((c) => c.includes(':'))
	if (variantClass) return { rank: 1, label: `.${variantClass}`, classes }
	if (classes.length) return { rank: 2, label: `.${classes[0]} (shared class)`, classes }
	const attrs = parts.filter((p) => p.type === 'attribute')
	const type = parts.find((p) => p.type === 'type')
	if (type) return { rank: 3, label: type.name + (attrs.length ? `[${attrs[0].name}]` : ''), classes }
	if (attrs.length) {
		const narrow = attrs.find((a) => isNarrowAttribute(a.name))
		return narrow ? { rank: 1, label: `[${narrow.name}]`, classes } : { rank: 2, label: `[${attrs[0].name}]`, classes }
	}
	return { rank: 4, label: 'any element', classes }
}

// attributes UI libraries set on their own elements, so the app's source says nothing about how many elements carry them
const LIBRARY_ATTRIBUTE =
	/^(?:aria-|role$|dir$|type$|data-(?:state|orientation|side|align|disabled|highlighted|selected|placeholder|slot|radix-|headlessui-|rdp-|vaul-|sonner-|cmdk-))|^cmdk-/

// an attribute only our own markup sets, in at most two source files, sits on only the elements those files render
function isNarrowAttribute(name: string): boolean {
	if (LIBRARY_ATTRIBUTE.test(name)) return false
	const attr = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
	let files = 0
	for (const f of sourceFiles) {
		if (f.file.endsWith('.css')) continue
		if (attr.test(f.text) && ++files > 2) return false
	}
	return files > 0
}

type Trigger = { kind: 'structural' | 'positional' | 'empty' | 'dynamic' | 'has' | 'attribute'; detail: string; root: boolean }

function triggersOf(parts: Component[]): Trigger[] {
	const root = parts.some(
		(p) => (p.type === 'type' && (p.name === 'html' || p.name === 'body')) || (p.type === 'pseudo-class' && p.kind === 'root'),
	)
	const out: Trigger[] = []
	for (const k of pseudoKinds(parts)) {
		if (STRUCTURAL.has(k)) out.push({ kind: 'structural', detail: `:${k}`, root })
		else if (POSITIONAL.has(k)) out.push({ kind: 'positional', detail: `:${k}()`, root })
		else if (k === 'empty') out.push({ kind: 'empty', detail: ':empty', root })
		else if (k === 'has') out.push({ kind: 'has', detail: ':has()', root })
		else if (DYNAMIC.has(k)) out.push({ kind: 'dynamic', detail: `:${k}`, root })
	}
	for (const p of parts) if (p.type === 'attribute') out.push({ kind: 'attribute', detail: `[${p.name}]`, root })
	if (root && out.length === 0) {
		const cls = parts.find((p) => p.type === 'class')
		if (cls) out.push({ kind: 'attribute', detail: `.${cls.name}`, root })
	}
	return out
}

type Finding = {
	rule: string
	kind: string
	trigger: string
	target: string
	severity: number
	why: string
	classes: string[]
}

const SEVERITY_LABEL = ['info', 'low', 'medium', 'high']

function analyze(sel: Selector, text: string, ruleClasses: string[]): Finding[] {
	const findings: Finding[] = []
	const compounds = splitCompounds(sel)
	const subject = compounds[compounds.length - 1]
	const breadth = targetBreadth(subject.parts)
	const push = (kind: string, trigger: string, severity: number, why: string) =>
		findings.push({ rule: text, kind, trigger, target: breadth.label, severity: Math.max(0, severity), why, classes: ruleClasses })

	// state tested on an ancestor or an earlier sibling
	for (let i = 0; i < compounds.length - 1; i++) {
		const via = compounds[i].next
		const relation =
			via === 'next-sibling' || via === 'later-sibling'
				? 'sibling'
				: via === 'child' && i === compounds.length - 2
					? 'parent'
					: 'ancestor'
		for (const t of triggersOf(compounds[i].parts)) {
			const broad = breadth.rank >= 2 && relation !== 'parent'
			if (t.kind === 'structural' || t.kind === 'positional' || t.kind === 'empty') {
				push(
					`${t.kind} ${relation}`,
					t.detail,
					broad ? 3 : 2,
					`a mount or unmount beside the ${relation} restyles every ${breadth.label} it covers`,
				)
			} else if (t.kind === 'has') {
				// unlike the other kinds, the target's breadth does not bound the cost: a `group-has-*` rule with a
				// variant-class target made one insertion in the queue panel restyle 857 of the page's 885 elements
				push(
					`:has() ${relation}`,
					t.detail,
					relation === 'parent' ? 2 : 3,
					`any change inside the ${relation} re-checks :has() and restyles every ${breadth.label} it covers`,
				)
			} else if (t.root) {
				push('document-root state', t.detail, broad ? 3 : 1, `a change on <html>/<body> restyles every ${breadth.label} in the page`)
			} else if (broad) {
				push(
					`${t.kind} ${relation}`,
					t.detail,
					t.kind === 'dynamic' ? 2 : 1,
					`a ${t.detail} change restyles every ${breadth.label} the ${relation} covers`,
				)
			}
		}
	}

	// the subject's own structure
	const kinds = pseudoKinds(subject.parts)
	for (const k of kinds) {
		if (POSITIONAL.has(k))
			push(
				'positional subject',
				`:${k}()`,
				1,
				'inserting or removing a sibling shifts the index of every later sibling, which are all restyled',
			)
		// info only: on the settings page the 27 `space-*`/`divide-*` rules of this shape restyled nothing on their own,
		// and added restyles only alongside a broad structural-ancestor rule
		else if (STRUCTURAL.has(k) && breadth.rank >= 4 && compounds.length > 1)
			push(
				'structural subject, no narrowing',
				`:${k}`,
				0,
				'restyles the flipped element only, but adds to the cost of a broad structural-ancestor rule',
			)
		else if (k === 'has') push(':has() subject', ':has()', 1, 'every change inside a matching element re-checks the :has() argument')
	}
	return findings
}

async function compileAppCss(): Promise<string> {
	const entry = path.join(srcDir, 'index.css')
	const compiler = await compile(fs.readFileSync(entry, 'utf8'), { base: srcDir, onDependency: () => {} })
	const scanner = new Scanner({ sources: compiler.sources })
	return compiler.build(scanner.scan())
}

// a Chrome older than CSS nesting, so lightningcss flattens Tailwind's nested variant rules before the visitor sees them
const PRE_NESTING_CHROME = 100 << 16

// where a rule comes from: the source files that mention its first class, or the hand-written stylesheet holding it
const sourceFiles = (() => {
	const files: { file: string; text: string }[] = []
	for (const root of ['src', 'plugins']) {
		if (!fs.existsSync(root)) continue
		for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
			if (!e.isFile()) continue
			const full = path.join(e.parentPath, e.name)
			if (full.includes(`${path.sep}node_modules${path.sep}`) || full.includes(`src${path.sep}scripts${path.sep}`)) continue
			if (!/\.(tsx?|css|html)$/.test(e.name)) continue
			files.push({ file: path.relative(repoRoot, full), text: fs.readFileSync(full, 'utf8') })
		}
	}
	return files
})()

const CLASS_CHAR = /[\w\-:/.[\]&>=%#!()*]/

// occurrences of a class as a whole token, so `space-y-1` does not count inside `space-y-1.5`
function countToken(text: string, cls: string): number {
	let n = 0
	let at = text.indexOf(cls)
	while (at !== -1) {
		const before = text[at - 1]
		const after = text[at + cls.length]
		if ((!before || !CLASS_CHAR.test(before)) && (!after || !CLASS_CHAR.test(after))) n++
		at = text.indexOf(cls, at + cls.length)
	}
	return n
}

function originOf(classes: string[]): { files: string[]; uses: number } {
	for (const cls of classes) {
		let uses = 0
		const files: string[] = []
		for (const f of sourceFiles) {
			const n = countToken(f.text, cls)
			if (n) {
				uses += n
				files.push(`${f.file} (${n})`)
			}
		}
		if (uses) return { files: files.sort((a, b) => Number(b.match(/\((\d+)\)$/)![1]) - Number(a.match(/\((\d+)\)$/)![1])), uses }
	}
	return { files: [], uses: 0 }
}

const css = await compileAppCss()
const findings: Finding[] = []
const seen = new Set<string>()
transform({
	filename: 'index.css',
	code: Buffer.from(css),
	errorRecovery: true,
	targets: { chrome: PRE_NESTING_CHROME },
	visitor: {
		Rule: {
			style(rule: any) {
				for (const sel of rule.value.selectors as Selector[]) {
					for (const flat of flatten(sel)) {
						const text = stringify(flat)
						for (const f of analyze(flat, stringify(sel), classNames(sel))) {
							const key = `${f.rule}|${f.kind}|${f.trigger}|${text}`
							if (seen.has(key)) continue
							seen.add(key)
							findings.push(f)
						}
					}
				}
			},
		},
	},
})

// class names in document order, looking into nested selectors, so a rule's own utility class comes first
function classNames(sel: Selector): string[] {
	const out: string[] = []
	for (const c of sel) {
		if (c.type === 'class') out.push(c.name)
		else if (Array.isArray(c.selectors)) for (const s of c.selectors as Selector[]) out.push(...classNames(s))
	}
	return out
}

function stringify(sel: Selector): string {
	const comb: Record<string, string> = { descendant: ' ', child: ' > ', 'next-sibling': ' + ', 'later-sibling': ' ~ ' }
	return sel
		.map((c) => {
			switch (c.type) {
				case 'combinator':
					return comb[c.value] ?? ` ${c.value} `
				case 'class':
					return `.${c.name}`
				case 'id':
					return `#${c.name}`
				case 'type':
					return c.name
				case 'universal':
					return '*'
				case 'attribute':
					return `[${c.name}${c.operation ? `=${JSON.stringify(c.operation.value)}` : ''}]`
				case 'pseudo-class':
					if (c.selectors) return `:${c.kind}(${(c.selectors as Selector[]).map(stringify).join(', ')})`
					if (c.kind.startsWith('nth')) return `:${c.kind}(${c.a}n+${c.b})`
					if (c.kind === 'dir' || c.kind === 'lang') return `:${c.kind}(${c.direction ?? c.languages ?? ''})`
					return `:${c.kind}`
				case 'pseudo-element':
					return `::${c.kind}`
				case 'nesting':
					return '&'
				default:
					return `<${c.type}>`
			}
		})
		.join('')
}

// one entry per rule, at its highest severity
const byRule = new Map<string, Finding>()
for (const f of findings) {
	const prev = byRule.get(f.rule)
	if (!prev || prev.severity < f.severity) byRule.set(f.rule, f)
}
const report = [...byRule.values()]
	.map((f) => ({ ...f, origin: originOf(f.classes) }))
	.sort((a, b) => b.severity - a.severity || a.kind.localeCompare(b.kind) || b.origin.uses - a.origin.uses)

const ALLOW_MARKER = 'style-invalidation:'

// whether every place that uses the rule carries the marker: the rule's utility class in a source file, or, for a
// stylesheet, a line holding the rule's first class and its trigger
function allowed(f: (typeof report)[number]): boolean {
	const cls = f.classes[0]
	if (!cls) return false
	const sites: { lines: string[]; at: number; css: boolean }[] = []
	for (const file of sourceFiles) {
		const css = file.file.endsWith('.css')
		if (css && cls.includes(':')) continue
		const lines = file.text.split('\n')
		lines.forEach((line, at) => {
			if (countToken(line, cls) === 0) return
			if (css && !line.includes(f.trigger.replace(/\(\)$/, ''))) return
			sites.push({ lines, at, css })
		})
	}
	if (sites.length === 0) return false
	return sites.every(({ lines, at, css }) => {
		if (lines[at].includes(ALLOW_MARKER)) return true
		// the comment block directly above the use, skipping the rest of its statement (`const X =`, `cond &&`) or,
		// in a stylesheet, the rule's other selector lines
		let inComment = false
		for (let i = at - 1; i >= 0; i--) {
			const line = lines[i].trim()
			if (line.includes(ALLOW_MARKER)) return true
			const comment = /^(\/\/|\/\*|\*)/.test(line)
			if (comment) inComment = true
			else if (inComment || line === '') return false
			else if (css ? line.endsWith('}') || line.endsWith('{') : !/(=|&&|\|\||\(|,|\?|:)$/.test(line)) return false
		}
		return false
	})
}

if (process.argv.includes('--strict')) {
	const violations = report.filter((f) => f.severity >= 3 && !allowed(f))
	for (const f of violations) {
		console.log(`${f.origin.files[0]?.replace(/ \(\d+\)$/, '') ?? '(unknown source)'}: ${f.kind} ${f.trigger} -> ${f.target}`)
		console.log(`    ${f.rule.length > 160 ? f.rule.slice(0, 160) + '…' : f.rule}`)
		console.log(`    ${f.why}`)
	}
	if (violations.length) {
		console.log(
			`\n${violations.length} CSS rule(s) can make one DOM change restyle most of the page. See docs/developers/style-invalidation.md,` +
				` or add a "${ALLOW_MARKER} <reason>" comment where the rule is used.`,
		)
		process.exit(1)
	}
} else if (process.argv.includes('--json')) {
	console.log(JSON.stringify(report, null, 1))
} else {
	const min = Number(process.argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 2)
	const shown = report.filter((f) => f.severity >= min)
	const counts: Record<string, number> = {}
	for (const f of report)
		counts[`${SEVERITY_LABEL[f.severity]}: ${f.kind}`] = (counts[`${SEVERITY_LABEL[f.severity]}: ${f.kind}`] ?? 0) + 1
	console.log(`${report.length} findings in ${css.length} bytes of compiled CSS\n`)
	for (const [k, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${String(n).padStart(4)}  ${k}`)
	console.log()
	for (const f of shown) {
		console.log(`[${SEVERITY_LABEL[f.severity]}] ${f.kind} ${f.trigger} -> ${f.target}`)
		console.log(`    ${f.rule.length > 160 ? f.rule.slice(0, 160) + '…' : f.rule}`)
		console.log(`    ${f.why}`)
		if (f.origin.files.length)
			console.log(
				`    from: ${f.origin.files.slice(0, 4).join(', ')}${f.origin.files.length > 4 ? `, +${f.origin.files.length - 4} more` : ''}`,
			)
	}
}
