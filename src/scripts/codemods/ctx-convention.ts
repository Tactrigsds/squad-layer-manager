/**
 * Codemod for phase 1B: the context convention. Idempotent -- it matches only pre-migration
 * spellings, so re-running it on a migrated tree is a no-op.
 *
 * Committed for rebase recovery, same as lib-reorg.ts: reset to main, re-run, re-format.
 *
 *   pnpm script src/scripts/codemods/ctx-convention.ts && pnpm run format && pnpm run lint:fix
 */
import * as Fsp from 'node:fs/promises'
import * as Path from 'node:path'

const ROOTS = ['src', 'test', 'drizzle']
const SELF = 'src/scripts/codemods/ctx-convention.ts'

async function sourceFiles(): Promise<string[]> {
	const out: string[] = []
	async function walk(dir: string) {
		for (const entry of await Fsp.readdir(dir, { withFileTypes: true })) {
			const full = Path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
				await walk(full)
			} else if (/\.tsx?$/.test(entry.name) && full !== SELF) {
				out.push(full)
			}
		}
	}
	for (const root of ROOTS) await walk(root)
	return out
}

function insertImport(src: string, line: string) {
	if (src.includes(line)) return src
	if (!/^import /m.test(src)) return `${line}\n\n${src}`
	return src.replace(/^import /m, `${line}\nimport `)
}

/** what moved out of context.ts into instrumentation.ts */
const INSTR = ['spanOp', 'durableSub', 'setSpanOpAttrs', 'setSpanStatus', 'recordGenericError', 'storeLinkToActiveSpan', 'OtelCtx']

function instrumentation(src: string, file: string): string {
	if (file === 'src/server/instrumentation.ts' || file === 'src/server/context.ts') return src
	if (!INSTR.some((s) => src.includes(`C.${s}`))) return src

	for (const sym of INSTR) src = src.replace(new RegExp(`\\bC\\.${sym}\\b`, 'g'), `Instr.${sym}`)

	// keeps whatever path style the file already used to reach @/server
	const viaRelative = /from '\.\/context(\.ts)?'/.test(src)
	const spec = viaRelative ? './instrumentation.ts' : '@/server/instrumentation'
	return insertImport(src, `import * as Instr from '${spec}'`)
}

async function main() {
	const files = await sourceFiles()
	let changed = 0
	for (const file of files) {
		const before = await Fsp.readFile(file, 'utf8')
		const after = instrumentation(before, file)
		if (after !== before) {
			await Fsp.writeFile(file, after)
			changed++
		}
	}
	console.log(`rewrote ${changed} of ${files.length} files`)
}

await main()
