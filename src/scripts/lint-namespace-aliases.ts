import * as fs from 'node:fs'
import * as path from 'node:path'

// Fails when a module is imported as a namespace under more than one alias, or when one alias names more than one
// module, across src/, test/ and drizzle/. See "Namespace imports everywhere" in docs/developers/architecture.md.
//
// Specifiers are compared by the module they resolve to: relative paths are rewritten to `@/` or `$root/`, `node:` and
// file extensions are dropped, and a package we wrap is the same module as its wrapper in src/lib.

const ROOTS = ['src', 'test', 'drizzle']
const SKIP_DIRS = [`${path.sep}node_modules${path.sep}`, `test${path.sep}fixtures${path.sep}plugin-`]
const EXTENSIONS = new Set(['.ts', '.tsx'])

// context.ts and context-shared.models.ts alias by their own convention. The plugin API registries name each namespace after
// the `slm/*` specifier it serves.
const EXEMPT_FILES = new Set(
	[
		'src/server/context.ts',
		'src/models/context-shared.models.ts',
		'src/systems/plugin-api-registry.server.ts',
		'src/systems/plugin-api-registry.client.ts',
	].map((f) => path.normalize(f)),
)

const WRAPPED: Record<string, string> = {
	rxjs: '@/lib/rxjs',
	zustand: '@/lib/zustand',
	'@react-rxjs/core': '@/lib/react-rxjs',
	zod: '@/lib/zod',
}

const NAMESPACE_IMPORT = /^import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm
const SRC = path.resolve('src')
const ROOT = path.resolve('.')

type Site = { file: string; line: number; alias: string; module: string }

function moduleOf(specifier: string, file: string) {
	let id = specifier
	if (id.startsWith('.')) {
		const abs = path.resolve(path.dirname(file), id)
		id = abs.startsWith(SRC + path.sep) ? '@/' + path.relative(SRC, abs) : '$root/' + path.relative(ROOT, abs)
		id = id.split(path.sep).join('/')
	}
	id = id.replace(/^node:/, '').replace(/\.(?:tsx?|js)$/, '')
	return WRAPPED[id] ?? id
}

const sites: Site[] = []
for (const root of ROOTS) {
	for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name))) continue
		const file = path.join(entry.parentPath, entry.name)
		if (EXEMPT_FILES.has(file) || SKIP_DIRS.some((dir) => file.includes(dir))) continue
		const src = fs.readFileSync(file, 'utf8')
		if (!src.includes('* as ')) continue
		for (const match of src.matchAll(NAMESPACE_IMPORT)) {
			if (match[2].includes('${')) continue
			let line = 1
			for (let i = 0; i < match.index; i++) if (src.charCodeAt(i) === 10) line++
			sites.push({ file, line, alias: match[1], module: moduleOf(match[2], file) })
		}
	}
}

const byModule = Map.groupBy(sites, (s) => s.module)
const byAlias = Map.groupBy(sites, (s) => s.alias)

// the alias most sites use, or for a tie the alphabetically first, so the message is stable
function majority(group: Site[], key: 'alias' | 'module') {
	const counts = new Map<string, number>()
	for (const s of group) counts.set(s[key], (counts.get(s[key]) ?? 0) + 1)
	return [...counts].sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
}

const errors: string[] = []
for (const [module, group] of byModule) {
	const ranked = majority(group, 'alias')
	if (ranked.length < 2) continue
	const [canonical, count] = ranked[0]
	for (const s of group) {
		if (s.alias === canonical) continue
		errors.push(`${s.file}:${s.line}: \`${module}\` is imported as \`${s.alias}\`; ${count} other import(s) use \`${canonical}\``)
	}
}
for (const [alias, group] of byAlias) {
	const ranked = majority(group, 'module')
	if (ranked.length < 2) continue
	const modules = ranked.map(([m, n]) => `\`${m}\` (${n})`).join(', ')
	for (const s of group) {
		if (s.module === ranked[0][0]) continue
		errors.push(`${s.file}:${s.line}: \`${alias}\` already names another module; it is used for ${modules}`)
	}
}

for (const e of errors.sort()) console.error(e)
if (errors.length > 0) {
	console.error(`\n${errors.length} inconsistent namespace alias${errors.length === 1 ? '' : 'es'} found`)
	process.exit(1)
}
