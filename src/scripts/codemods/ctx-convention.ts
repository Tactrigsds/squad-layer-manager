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

/**
 * Contexts move to their domain's models file. Each entry is the old qualified name, the new one,
 * and the import the new name needs. Order matters only in that longer names must be listed before
 * any prefix of themselves.
 */
const MOVES: { from: string; to: string; imp: string }[] = [
	{ from: 'CS.EffectiveColumnConfig', to: 'LC.Ctx', imp: "import type * as LC from '@/models/layer-columns'" },
	{ from: 'CS.LayerGeneration', to: 'LC.Ctx.Generation', imp: "import type * as LC from '@/models/layer-columns'" },
	{ from: 'CS.LayerEngine', to: 'LE.Ctx', imp: "import type * as LE from '@/models/layer-engine'" },
	{ from: 'CS.LayerQuery', to: 'LQY.Ctx', imp: "import type * as LQY from '@/models/layer-queries.models'" },
	{ from: 'CS.Filters', to: 'F.Ctx', imp: "import type * as F from '@/models/filter.models'" },
	{ from: 'CS.MatchHistory', to: 'MH.Ctx.Recent', imp: "import type * as MH from '@/models/match-history.models'" },
	{ from: 'C.UserId', to: 'USR.Ctx.Id', imp: "import type * as USR from '@/models/users.models'" },
	{ from: 'C.UserOrPlayer', to: 'SM.Ctx.UserOrPlayer', imp: "import type * as SM from '@/models/squad.models'" },
	{ from: 'C.UserRbac', to: 'RBAC.Ctx', imp: "import type * as RBAC from '@/rbac.models'" },
	{ from: 'C.User', to: 'USR.Ctx', imp: "import type * as USR from '@/models/users.models'" },
	{ from: 'C.PlayerIds', to: 'SM.Ctx.Ids', imp: "import type * as SM from '@/models/squad.models'" },
	{ from: 'C.Player', to: 'SM.Ctx', imp: "import type * as SM from '@/models/squad.models'" },
	{ from: 'Instr.OtelCtx', to: 'CS.Otel', imp: "import type * as CS from '@/models/context-shared'" },
	{ from: 'C.ServerId', to: 'SS.Ctx', imp: "import type * as SS from '@/models/server-state.models'" },
]

function moveContexts(src: string, file: string): string {
	for (const { from, to, imp } of MOVES) {
		const re = new RegExp(`\\b${from.replace('.', '\\.')}\\b`, 'g')
		if (!re.test(src)) continue
		// inside the module that now declares it, the name is reached unqualified
		const selfDeclared = file.endsWith(imp.slice(imp.lastIndexOf('/') + 1, -1) + '.ts')
		src = src.replace(re, selfDeclared ? to.split('.').slice(1).join('.') : to)
		// the file may already reach the destination module under the same namespace
		const ns = to.split('.')[0]
		if (!selfDeclared && !new RegExp(`import (?:type )?\\* as ${ns} from`).test(src)) src = insertImport(src, imp)
	}
	return src
}

async function main() {
	const files = await sourceFiles()
	let changed = 0
	for (const file of files) {
		const before = await Fsp.readFile(file, 'utf8')
		const after = moveContexts(instrumentation(before, file), file)
		if (after !== before) {
			await Fsp.writeFile(file, after)
			changed++
		}
	}
	console.log(`rewrote ${changed} of ${files.length} files`)
}

await main()
