/**
 * Codemod for the phase 1A library reorganization. Idempotent: it matches only pre-migration
 * spellings, so re-running it on a migrated tree is a no-op.
 *
 * The point of committing it is rebase recovery. A whole-repo import rewrite is not worth
 * resolving by hand, so on a conflict you reset to main, re-run this, and re-run `pnpm format`.
 *
 *   pnpm script src/scripts/codemods/lib-reorg.ts && pnpm run format && pnpm run lint:fix
 *
 * lint:fix is part of the recipe, not an afterthought: this rewrites `import type * as X` into a
 * value import, and consistent-type-imports narrows it back.
 */
import * as Fsp from 'node:fs/promises'
import * as Path from 'node:path'

const ROOTS = ['src', 'test']
const SELF = 'src/scripts/codemods/lib-reorg.ts'
/** the one module allowed to import zustand directly: it is the barrel */
const ZUSTAND_BARREL = 'src/lib/zustand.ts'

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

/** drop an entire import statement, and the newline it sat on */
function dropImport(src: string, pattern: RegExp) {
	return src.replace(new RegExp(`^${pattern.source}\\n`, 'gm'), '')
}

function zustand(src: string, file: string): string {
	if (file === ZUSTAND_BARREL) return src

	const hadBarrel = /import \* as ZusUtils from '(@\/lib\/zustand(\.ts)?|\.\/zustand)'/.test(src)
	const hadPackage = /from 'zustand(-rx|\/[\w/]+)?'/.test(src)
	if (!hadBarrel && !hadPackage) return src

	// the barrel now covers every symbol these reached for directly
	src = dropImport(src, /import (?:type )?\* as Zus from 'zustand'/)
	src = dropImport(src, /import \* as ZusMiddle from 'zustand\/middleware'/)
	src = dropImport(src, /import \* as ZusRx from 'zustand-rx'/)
	src = dropImport(src, /import \{ persist \} from 'zustand\/middleware'/)
	src = dropImport(src, /import \{ toStream \} from 'zustand-rx'/)
	src = dropImport(src, /import \{ immer as zustandImmerMiddleware \} from 'zustand\/middleware\/immer'/)
	src = dropImport(src, /import \{ createStore, type StoreApi \} from 'zustand\/vanilla'/)

	// bare identifiers that came from those imports have to be qualified before ZusUtils -> Zus,
	// or the qualifier would be applied twice
	src = src.replace(/\bZusMiddle\./g, 'Zus.')
	src = src.replace(/\bZusRx\./g, 'Zus.')
	src = src.replace(/\bzustandImmerMiddleware\b/g, 'Zus.immer')
	src = src.replace(/(?<!\.)\bpersist\(/g, 'Zus.persist(')
	src = src.replace(/(?<!\.)\btoStream\(/g, 'Zus.toStream(')
	src = src.replace(/(?<!\.)\bcreateStore</g, 'Zus.createStore<')
	src = src.replace(/(?<!\.)\bStoreApi</g, 'Zus.StoreApi<')

	src = src.replace(/\bZusUtils\b/g, 'Zus')

	// a file that only ever used the package now needs the barrel it did not import before.
	// `m` matters: plenty of these files open with a comment rather than an import.
	if (!hadBarrel && /\bZus\./.test(src)) {
		const rel = file.startsWith('src/lib/') ? './zustand' : '@/lib/zustand'
		src = src.replace(/^import /m, `import * as Zus from '${rel}'\nimport `)
	}
	return src
}

/** the one module allowed to import react-rxjs directly */
const REACT_RXJS_BARREL = 'src/lib/react-rxjs.ts'

function reactRxjs(src: string, file: string): string {
	if (file === REACT_RXJS_BARREL) return src
	if (!/RxHelpers|@react-rxjs/.test(src)) return src

	const hadBarrel = /import \* as RxHelpers from '@\/lib\/react-rxjs(-helpers)?(\.ts)?'/.test(src)

	// before RxHelpers -> ReactRx, or our guarded bind would be renamed alongside the package's
	src = src.replace(/\bReactRx\.bind\(/g, 'ReactRx.bindWithDefault(')
	// vote.client.ts imported the package's bind bare; both of its binds pass a default
	src = src.replace(/^import \{ bind \} from '@react-rxjs\/core'\n/m, '')
	if (!/\bReactRx\b/.test(src) && /(?<![.\w])bind\(/.test(src)) {
		src = src.replace(/(?<![.\w])bind\(/g, 'ReactRx.bindWithDefault(')
	}

	src = dropImport(src, /import \* as ReactRx from '@react-rxjs\/core'/)
	src = dropImport(src, /import \{ createSignal \} from '@react-rxjs\/utils'/)
	src = src.replace(/(?<!\.)\bcreateSignal</g, 'ReactRx.createSignal<')

	src = src.replace(/\bRxHelpers\b/g, 'ReactRx')
	src = src.replace(/'@\/lib\/react-rxjs-helpers'/g, "'@/lib/react-rxjs'")

	if (!hadBarrel && /\bReactRx\./.test(src)) {
		const rel = file.startsWith('src/lib/') ? './react-rxjs' : '@/lib/react-rxjs'
		src = src.replace(/^import /m, `import * as ReactRx from '${rel}'\nimport `)
	}
	return src
}

/** modules that make up the rxjs barrel, and so must keep importing the package directly */
const RXJS_BARREL = new Set(['src/lib/rxjs.ts', 'src/lib/rxjs-ext.ts'])
/** where each of the old async.ts exports ended up */
const EXT = new Set(['firstValueFrom', 'distinctDeepEquals', 'toAsyncGenerator', 'toCold', 'filterTruthy', 'traceTag', 'withAbortSignal'])
const PROM = new Set(['sleep', 'isAbortError', 'anySignal', 'raceAbort', 'acquireInBlock'])

function relTo(file: string, mod: string) {
	return file.startsWith('src/lib/') ? `./${mod}` : `@/lib/${mod}`
}

function insertImport(src: string, line: string) {
	return src.includes(line) ? src : src.replace(/^import /m, `${line}\nimport `)
}

function rxjsAndPromise(src: string, file: string): string {
	if (RXJS_BARREL.has(file)) return src

	// route rxjs through the barrel
	if (!file.startsWith('src/lib/rcon/')) {
		src = src.replace(/^(import (?:type )?\* as Rx from )'rxjs'$/gm, `$1'${relTo(file, 'rxjs')}'`)
	} else {
		src = src.replace(/^(import (?:type )?\* as Rx from )'rxjs'$/gm, "$1'../rxjs'")
	}

	// the tree's one named rxjs import, alongside a `* as Rx` in the same file. Scoped to the file
	// rather than done by pattern, because `map(` is far too common to rewrite blind.
	if (file === 'src/systems/vote.client.ts') {
		src = dropImport(src, /import \{ map, share \} from 'rxjs'/)
		src = src.replace(/(?<![.\w])share\(\)/g, 'Rx.share()').replace(/(?<![.\w])map\(/g, 'Rx.map(')
	}

	// split the named imports from the old async.ts across Rx.Ext and Prom
	const asyncImport = /^import \{ ([^}]+) \} from '(?:@\/lib\/async(?:\.ts)?|\.\.?\/(?:lib\/)?async)'\n/m
	const m = src.match(asyncImport)
	if (m) {
		const names = m[1]
			.split(',')
			.map((n) => n.trim())
			.filter(Boolean)
		const unknown = names.filter((n) => !EXT.has(n) && !PROM.has(n))
		if (unknown.length) throw new Error(`${file}: no bucket for ${unknown.join(', ')}`)
		src = src.replace(asyncImport, '')
		for (const n of names) {
			if (EXT.has(n)) src = src.replace(new RegExp(`(?<![.\\w])${n}\\b`, 'g'), `Rx.Ext.${n}`)
			else src = src.replace(new RegExp(`(?<![.\\w])${n}\\b`, 'g'), `Prom.${n}`)
		}
		if (names.some((n) => PROM.has(n))) {
			src = insertImport(src, `import * as Prom from '${relTo(file, 'promise-utils')}'`)
		}
		if (names.some((n) => EXT.has(n)) && !/^import (?:type )?\* as Rx from/m.test(src)) {
			const rx = file.startsWith('src/lib/rcon/') ? '../rxjs' : relTo(file, 'rxjs')
			src = insertImport(src, `import * as Rx from '${rx}'`)
		}
	}
	return src
}

async function main() {
	const files = await sourceFiles()
	let changed = 0
	for (const file of files) {
		const before = await Fsp.readFile(file, 'utf8')
		const after = rxjsAndPromise(reactRxjs(zustand(before, file), file), file)
		if (after !== before) {
			await Fsp.writeFile(file, after)
			changed++
		}
	}
	console.log(`rewrote ${changed} of ${files.length} files`)
}

await main()
