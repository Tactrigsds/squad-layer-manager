import * as babel from '@babel/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Collects every translatable message into a catalogue template, keyed the way the runtime keys them: by the
// message's own English, plus a context where two messages share one. Run with `pnpm i18n:extract`.
//
// `pnpm i18n:lint` runs the same visitor as a check instead: a message is only translatable when its source is
// written at the call site, so a t/rt call whose first argument is not a string literal, or a non-literal
// `context`, is an error. This is the lexical half of the guarantee; the type-level half is `Literal` in
// src/models/messages.models.ts.
//
// Prose still built in JavaScript inside a def body is not translatable either; the summary counts those so the
// remaining conversion work stays visible rather than looking like an empty catalogue.

const SRC_DIR = 'src'
const OUT_DIR = 'src/messages/locales'

// the message vocabulary modules and the functions of each that take a source string first
const MSG_MODULES: Record<string, string[]> = {
	'@/models/messages.models': ['t', 'rt', 'raw', 'def'],
}

const mode = process.argv[2] === 'lint' ? 'lint' : 'extract'

type Entry = { source: string; context?: string; icu: boolean; from: string }
type Diagnostic = { file: string; line: number; col: number; message: string }

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
		diagnostics.push({ file: full, line: at.loc?.start.line ?? 0, col: (at.loc?.start.column ?? 0) + 1, message })
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

if (mode === 'lint') {
	for (const d of diagnostics) console.log(`${d.file}:${d.line}:${d.col}  ${d.message}`)
	if (diagnostics.length) {
		console.log(`\n${diagnostics.length} message sources are not extractable`)
		process.exit(1)
	}
	console.log('all message sources are extractable')
	process.exit(0)
}

const byKey = new Map<string, Entry[]>()
for (const entry of entries) {
	const key = entry.context ? `${entry.source} [${entry.context}]` : entry.source
	byKey.set(key, [...(byKey.get(key) ?? []), entry])
}

const collisions = [...byKey].filter(([, group]) => group.length > 1 && new Set(group.map((e) => e.from)).size > 1)

fs.mkdirSync(OUT_DIR, { recursive: true })
const template: Record<string, string> = {}
for (const key of [...byKey.keys()].sort()) template[key] = byKey.get(key)![0].source
fs.writeFileSync(path.join(OUT_DIR, 'en.json'), JSON.stringify(template, null, '\t') + '\n')

const existing = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && f !== 'en.json')
console.log(`extracted ${entries.length} translatable messages into ${byKey.size} keys`)
console.log(`  ${entries.filter((e) => e.icu).length} take arguments, ${entries.filter((e) => !e.icu).length} do not`)
console.log(`  ${untranslated} strings inside a message body are still built in JavaScript`)

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
