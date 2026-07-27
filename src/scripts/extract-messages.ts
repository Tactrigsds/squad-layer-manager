import * as babel from '@babel/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Collects every translatable message into a catalogue template, keyed the way the runtime keys them: by the
// message's own English, plus a context where two messages share one. Run with `pnpm script src/scripts/extract-messages.ts`.
//
// Only the shorthand forms are translatable, so only they are collected. A message still written as a target map
// carries strings its author built in JavaScript, which a translator cannot be handed; the summary counts those so
// the remaining conversion work stays visible rather than looking like an empty catalogue.

const MESSAGES_DIR = 'src/messages'
const OUT_DIR = 'src/messages/locales'

type Entry = { source: string; context?: string; icu: boolean; from: string }

function parse(file: string) {
	return babel.parseSync(fs.readFileSync(file, 'utf8'), {
		babelrc: false,
		configFile: false,
		filename: file,
		parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
	})!
}

function exportNameOf(p: babel.NodePath): string {
	let q: babel.NodePath | null = p
	while (q && q.node.type !== 'VariableDeclarator') q = q.parentPath
	const id = q?.node.type === 'VariableDeclarator' ? q.node.id : undefined
	return id?.type === 'Identifier' ? id.name : '?'
}

function readContext(node: babel.types.Node | undefined) {
	if (node?.type !== 'ObjectExpression') return undefined
	for (const prop of node.properties) {
		if (prop.type !== 'ObjectProperty' || prop.computed) continue
		if (prop.key.type === 'Identifier' && prop.key.name === 'context' && prop.value.type === 'StringLiteral') {
			return prop.value.value
		}
	}
	return undefined
}

const entries: Entry[] = []
// prose still built in JavaScript inside a target body, which is what remains to convert
let untranslated = 0

for (const file of fs.readdirSync(MESSAGES_DIR).filter((f) => /\.messages\.tsx?$/.test(f))) {
	const full = path.join(MESSAGES_DIR, file)
	const module = file.replace(/\.messages\.tsx?$/, '')
	babel.traverse(parse(full), {
		CallExpression(p) {
			const callee = p.node.callee
			if (callee.type !== 'MemberExpression') return
			if (callee.object.type !== 'Identifier' || callee.object.name !== 'Msgs') return
			if (callee.property.type !== 'Identifier') return
			const [first, second, third] = p.node.arguments
			const from = `${module}.${exportNameOf(p)}`

			// a string resolved inside a target body, which carries its values inline rather than through a mapper
			if (callee.property.name === 't' || callee.property.name === 'node') {
				if (first?.type === 'StringLiteral') entries.push({ source: first.value, icu: !!second, from })
				return
			}
			if (callee.property.name !== 'def') return
			if (first?.type !== 'StringLiteral') {
				untranslated += unwrappedProse(p)
				return
			}
			const icu = second?.type === 'ArrowFunctionExpression' || second?.type === 'FunctionExpression'
			entries.push({ source: first.value, context: readContext(icu ? third : second), icu, from })
		},
	})
}

// counts the prose a def still builds in JavaScript: a literal no Msgs.t/node call has claimed, or JSX text
function unwrappedProse(defPath: babel.NodePath) {
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
			// claimed by a Msgs.t / Msgs.node above it; the walk stops at the def, which is itself a Msgs call
			let up: babel.NodePath | null = p.parentPath
			while (up && up.node !== defPath.node) {
				const c = up.node
				if (
					c.type === 'CallExpression' &&
					c.callee.type === 'MemberExpression' &&
					c.callee.object.type === 'Identifier' &&
					c.callee.object.name === 'Msgs' &&
					c.callee.property.type === 'Identifier' &&
					['t', 'node'].includes(c.callee.property.name)
				)
					return
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

const collisions = [...byKey].filter(([, group]) => group.length > 1 && new Set(group.map((e) => e.from)).size > 1)

fs.mkdirSync(OUT_DIR, { recursive: true })
const template: Record<string, string> = {}
for (const key of [...byKey.keys()].sort()) template[key] = byKey.get(key)![0].source
fs.writeFileSync(path.join(OUT_DIR, 'en.json'), JSON.stringify(template, null, '\t') + '\n')

const existing = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && f !== 'en.json')
console.log(`extracted ${entries.length} translatable messages into ${byKey.size} keys`)
console.log(`  ${entries.filter((e) => e.icu).length} take arguments, ${entries.filter((e) => !e.icu).length} do not`)
console.log(`  ${untranslated} strings inside target maps are still built in JavaScript`)

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
