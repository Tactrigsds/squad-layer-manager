import * as babel from '@babel/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as ICU from '@/messages/icu'
import { compile, UnsupportedPatternError } from '@/scripts/compile-messages'

// Collects every translatable message into a catalogue template, keyed the way the runtime keys them: by the
// message's own English, plus a context where two messages share one. Run with `pnpm i18n:extract`.
//
// `pnpm i18n:lint` runs the same visitor as a check instead, and fails on two things. First, a message is only
// translatable when its source is written at the call site, so a t/rt call whose first argument is not a string
// literal, or a non-literal `context`, is an error. This is the lexical half of the guarantee; the type-level
// half is `Literal` in src/models/messages.models.ts. Second, the committed catalogues have to match what the
// source would produce right now: nothing else notices when a message is edited and they are not regenerated,
// and every gate keeps passing while the reader is shown a key that no longer exists.
//
// Prose still built in JavaScript inside a def body is not translatable either; the summary counts those so the
// remaining conversion work stays visible rather than looking like an empty catalogue.

const SRC_DIR = 'src'
const OUT_DIR = 'src/messages/locales'
const COMPILED_SUFFIX = '.compiled.json'

function serialize(value: unknown) {
	return JSON.stringify(value, null, '\t') + '\n'
}

// the message vocabulary modules and the functions of each that take a source string first
const MSG_MODULES: Record<string, string[]> = {
	'@/models/messages.models': ['t', 'rt', 'raw', 'def'],
}

const mode = process.argv[2] === 'lint' ? 'lint' : 'extract'

type Entry = { source: string; context?: string; icu: boolean; from: string }
// `at` is a source location for a message the extractor cannot read, and the message's own key for one it can
// read but cannot compile
type Diagnostic = { at: string; message: string }

function parse(file: string) {
	return babel.parseSync(fs.readFileSync(file, 'utf8'), {
		babelrc: false,
		configFile: false,
		filename: file,
		// jsx only for .tsx: in a plain .ts file the jsx plugin misparses generic arrows like `<T>(x) => ...`
		parserOpts: { sourceType: 'module', plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] },
	})!
}

// how this file names the message functions: namespace aliases and named imports of the modules above
type Resolver = { ns: Map<string, Set<string>>; named: Map<string, string> }

function resolverOf(ast: babel.types.File): Resolver {
	const ns = new Map<string, Set<string>>()
	const named = new Map<string, string>()
	for (const stmt of ast.program.body) {
		if (stmt.type !== 'ImportDeclaration') continue
		const fns = MSG_MODULES[stmt.source.value]
		if (!fns) continue
		for (const spec of stmt.specifiers) {
			if (spec.type === 'ImportNamespaceSpecifier') ns.set(spec.local.name, new Set(fns))
			if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier' && fns.includes(spec.imported.name)) {
				named.set(spec.local.name, spec.imported.name)
			}
		}
	}
	return { ns, named }
}

function msgFnOf(node: babel.types.CallExpression, r: Resolver): string | undefined {
	const callee = node.callee
	if (
		callee.type === 'MemberExpression' &&
		!callee.computed &&
		callee.object.type === 'Identifier' &&
		callee.property.type === 'Identifier' &&
		r.ns.get(callee.object.name)?.has(callee.property.name)
	) {
		return callee.property.name
	}
	if (callee.type === 'Identifier') return r.named.get(callee.name)
	return undefined
}

// the source a call carries lexically: a string literal, a template with nothing interpolated, or a concatenation
// of those, which long ICU patterns use to stay within line width. The runtime key is the joined string.
function literalText(node: babel.types.Node | undefined): string | undefined {
	if (node?.type === 'StringLiteral') return node.value
	if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined
	if (node?.type === 'BinaryExpression' && node.operator === '+') {
		const left = literalText(node.left)
		const right = literalText(node.right)
		if (left !== undefined && right !== undefined) return left + right
	}
	return undefined
}

function readContext(node: babel.types.Node | undefined, report: (message: string, at: babel.types.Node) => void) {
	if (node?.type !== 'ObjectExpression') return undefined
	for (const prop of node.properties) {
		if (prop.type !== 'ObjectProperty' || prop.computed) continue
		if (prop.key.type !== 'Identifier' || prop.key.name !== 'context') continue
		const value = literalText(prop.value)
		if (value === undefined) report('context must be a string literal', prop.value)
		return value
	}
	return undefined
}

function files(): string[] {
	return fs
		.readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(e.name))
		.map((e) => path.join(e.parentPath, e.name))
		.filter((f) => !f.startsWith(path.join(SRC_DIR, 'scripts') + path.sep))
}

function exportNameOf(p: babel.NodePath): string {
	let q: babel.NodePath | null = p
	while (q && q.node.type !== 'VariableDeclarator') q = q.parentPath
	const id = q?.node.type === 'VariableDeclarator' ? q.node.id : undefined
	return id?.type === 'Identifier' ? id.name : '?'
}

const entries: Entry[] = []
const diagnostics: Diagnostic[] = []
// prose still built in JavaScript inside a message body, which is what remains to convert
let untranslated = 0

for (const full of files()) {
	const module = path
		.relative(SRC_DIR, full)
		.replace(/\.tsx?$/, '')
		.replace(/^messages\//, '')
		.replace(/\.messages$/, '')
	const ast = parse(full)
	const resolver = resolverOf(ast as babel.types.File)
	if (resolver.ns.size === 0 && resolver.named.size === 0) continue

	const report = (message: string, at: babel.types.Node) => {
		diagnostics.push({ at: `${full}:${at.loc?.start.line ?? 0}:${(at.loc?.start.column ?? 0) + 1}`, message })
	}

	babel.traverse(ast, {
		CallExpression(p) {
			const fn = msgFnOf(p.node, resolver)
			if (!fn) return
			const [first, second, third] = p.node.arguments
			const from = `${module}.${exportNameOf(p)}`

			// raw() is deliberately untranslated, so it is neither extracted nor counted as work left to do
			if (fn === 'raw') return

			// a string resolved inside a message body, which carries its values inline rather than through a mapper
			if (fn === 't' || fn === 'rt') {
				const source = literalText(first)
				if (source === undefined) {
					report(`the first argument of ${fn} must be a string literal`, first ?? p.node)
					return
				}
				entries.push({ source, context: readContext(third, report), icu: !!second, from })
				return
			}
			// def: the string overloads are extractable; the builder form carries its strings through t/rt calls,
			// which this visitor reaches on its own
			const source = literalText(first)
			if (source === undefined) {
				if (first?.type === 'TemplateLiteral' || (first?.type === 'BinaryExpression' && first.operator === '+')) {
					report("def's message must be a string literal; move dynamic content into ICU args", first)
					return
				}
				untranslated += unwrappedProse(p, resolver)
				return
			}
			const icu = second?.type === 'ArrowFunctionExpression' || second?.type === 'FunctionExpression'
			entries.push({ source, context: readContext(icu ? third : second, report), icu, from })
		},
	})
}

// counts the prose a def still builds in JavaScript: a literal no t/rt/raw call has claimed, or JSX text
function unwrappedProse(defPath: babel.NodePath, resolver: Resolver) {
	let n = 0
	defPath.traverse({
		'StringLiteral|TemplateLiteral|JSXText'(p: babel.NodePath) {
			const node = p.node
			const text =
				node.type === 'StringLiteral' || node.type === 'JSXText'
					? node.value
					: (node as babel.types.TemplateLiteral).quasis.map((q) => q.value.cooked ?? '').join(' ')
			if (!/[a-z]/i.test(text) || text.trim().length < 3) return
			// a property key rather than a value
			if (p.parentPath?.node.type === 'ObjectProperty' && p.parentPath.node.value !== node) return
			// claimed by a t / rt / raw call above it; the walk stops at the def, which is itself a message call
			let up: babel.NodePath | null = p.parentPath
			while (up && up.node !== defPath.node) {
				const c = up.node
				if (c.type === 'CallExpression' && ['t', 'rt', 'raw'].includes(msgFnOf(c, resolver) ?? '')) return
				up = up.parentPath
			}
			n++
		},
	})
	return n
}

const byKey = new Map<string, Entry[]>()
for (const entry of entries) {
	const key = entry.context ? `${entry.source} [${entry.context}]` : entry.source
	byKey.set(key, [...(byKey.get(key) ?? []), entry])
}

const template: Record<string, string> = {}
for (const key of [...byKey.keys()].sort()) template[key] = byKey.get(key)![0].source

// Prose that ICU cannot parse, which reaches a reader unchanged. Reported rather than compiled, because a brace in
// a sentence is usually a quoting mistake, and because a translator will hit the same parse error.
const malformed: string[] = []

// Resolves a catalogue's patterns to the form the runtime walks. English omits a message that compiles to its own
// source, since the runtime hands the source back when a key is absent; a translated catalogue keeps every entry,
// because its fallback is the English rather than itself.
function compileCatalogue(catalogue: Record<string, string>, isSource: boolean) {
	const out: Record<string, ICU.Entry> = {}
	for (const [key, pattern] of Object.entries(catalogue)) {
		let entry: ICU.Entry
		try {
			entry = compile(pattern)
		} catch (error) {
			// value formatting is a deliberate omission and has to be fixed; anything else is prose ICU rejects,
			// and it renders verbatim, which is what the runtime does with it today
			if (error instanceof UnsupportedPatternError) {
				diagnostics.push({ at: describeKey(key), message: error.message })
				continue
			}
			malformed.push(`${describeKey(key)}  ${(error as Error).message}`)
			entry = pattern
		}
		if (!isSource || entry !== pattern) out[key] = entry
	}
	return out
}

function describeKey(key: string) {
	return JSON.stringify(key.length > 60 ? key.slice(0, 60) + '...' : key)
}

const catalogueFiles = fs.existsSync(OUT_DIR)
	? fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && !f.endsWith(COMPILED_SUFFIX) && f !== 'en.json')
	: []
const compiled: Record<string, Record<string, ICU.Entry>> = { en: compileCatalogue(template, true) }
for (const file of catalogueFiles) {
	const locale = path.basename(file, '.json')
	compiled[locale] = compileCatalogue(JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8')), false)
}

if (mode === 'lint') {
	for (const d of diagnostics) console.log(`${d.at}  ${d.message}`)
	if (diagnostics.length) {
		console.log(`\n${diagnostics.length} messages are not extractable or do not compile`)
		process.exit(1)
	}
	// content, not bytes: oxfmt reformats these after they are written, and its layout is the better one
	const stale = ['en.json', ...Object.keys(compiled).map((l) => l + COMPILED_SUFFIX)].filter((f) => {
		const at = path.join(OUT_DIR, f)
		if (!fs.existsSync(at)) return true
		const want = f === 'en.json' ? template : compiled[path.basename(f, COMPILED_SUFFIX)]
		return JSON.stringify(JSON.parse(fs.readFileSync(at, 'utf8'))) !== JSON.stringify(want)
	})
	for (const f of stale) console.log(`${path.join(OUT_DIR, f)} is out of date`)
	if (stale.length) {
		console.log(`\nrun \`pnpm i18n:extract\``)
		process.exit(1)
	}
	for (const m of malformed) console.log(`ICU cannot parse ${m}; it renders verbatim`)
	console.log('all message sources are extractable, compile, and their catalogues are up to date')
	process.exit(0)
}

const collisions = [...byKey].filter(([, group]) => group.length > 1 && new Set(group.map((e) => e.from)).size > 1)

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'en.json'), serialize(template))
for (const [locale, catalogue] of Object.entries(compiled)) {
	fs.writeFileSync(path.join(OUT_DIR, locale + COMPILED_SUFFIX), serialize(catalogue))
}

const existing = catalogueFiles
console.log(`extracted ${entries.length} translatable messages into ${byKey.size} keys`)
console.log(`  ${entries.filter((e) => e.icu).length} take arguments, ${entries.filter((e) => !e.icu).length} do not`)
console.log(`  ${untranslated} strings inside a message body are still built in JavaScript`)
for (const d of diagnostics) console.log(`  does not compile: ${d.at}  ${d.message}`)
for (const m of malformed) console.log(`  ICU cannot parse ${m}; it renders verbatim`)

for (const [key, group] of collisions) {
	console.log(`  shared key ${JSON.stringify(key)}: ${group.map((e) => e.from).join(', ')}`)
}
if (collisions.length) console.log(`  ${collisions.length} keys are shared; give one a context if their translations differ`)

for (const file of existing) {
	const locale = path.basename(file, '.json')
	const catalogue: Record<string, string> = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8'))
	const orphaned = Object.keys(catalogue).filter((k) => !(k in template))
	const missing = Object.keys(template).filter((k) => !(k in catalogue))
	console.log(`${locale}: ${missing.length} untranslated, ${orphaned.length} no longer in the source`)
	for (const key of orphaned) console.log(`  orphaned: ${JSON.stringify(key)}`)
}
