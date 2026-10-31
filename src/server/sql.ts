/**
 * Statements as values. A statement is built without a connection, and runs only through an executor in db.ts
 * (`DB.all`, `DB.get`, `DB.run`), which takes the ctx that names the connection. See docs/developers/database.md.
 *
 * A file calls `forModule` once, with its own module, and builds its statements from what that returns:
 *
 * - `select`, `insert`, `update`, `delete`: drizzle's builders, bound to a session that refuses to run. A statement
 *   built per call renders and prepares on every call, through the connection's text cache.
 * - `def(name, params, stmt)`: a statement with a fixed shape, rendered and checked once at definition, and prepared
 *   once per connection. Calling it with its values gives what an executor runs. A module keeps its definitions and
 *   their parameters in `namespace Q`.
 * - `params`, `value`, `column`, `secret`, `unlogged`, `list`, `count`, `lit`, `inJson`: the parameters and literals a definition
 *   binds.
 *
 * What relies on drizzle internals: each builder's `_prepare(isOneTimeQuery)`, `session` and `config` fields, and
 * `Param`/`Placeholder` passing through `values`, `set` and `where` untouched inside a `SQL`. sql.test.ts round-trips
 * each of them.
 */
import * as Otel from '@opentelemetry/api'
import {
	Column,
	entityKind,
	is,
	isSQLWrapper,
	Param,
	Placeholder,
	SQL as DSQL,
	sql,
	type GetColumnData,
	StringChunk,
	Subquery,
	Table,
} from 'drizzle-orm'
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'

import { isUnlogged } from '$root/drizzle/columns'
import type { OtelModule } from '@/lib/otel'
import { isSecret, type Secret, secretEncoders } from '@/lib/secret'
import type * as z from '@/lib/zod'
import { checkSchema, sameValue } from '@/lib/zod-check'

export type Bindable = string | number | bigint | Uint8Array | null

// development and test only: zod checks on parameters and the per-call checks of definitions built from arguments
export const CHECKS = process.env.NODE_ENV !== 'production'

export const dialect = new SQLiteSyncDialect()

// -------- statements built per call --------

const RUN_HINT = 'run a statement with DB.all/get/run(ctx, stmt)'

// The session every pure builder carries. Each method throws, so a statement that is awaited, or run directly with
// .all()/.get()/.run(), fails in every environment. The executors swap the ctx's session in for the length of one
// prepare. Its module and database are what the executor checks and records against.
export class Unbound {
	static readonly [entityKind] = 'SlmUnboundSession'
	constructor(
		readonly module: OtelModule,
		readonly stats: Stats,
	) {}
	prepareQuery(): never {
		throw new Error(RUN_HINT)
	}
	prepareOneTimeQuery(): never {
		throw new Error(RUN_HINT)
	}
	run(): never {
		throw new Error(RUN_HINT)
	}
	all(): never {
		throw new Error(RUN_HINT)
	}
	get(): never {
		throw new Error(RUN_HINT)
	}
	values(): never {
		throw new Error(RUN_HINT)
	}
	count(): never {
		throw new Error(RUN_HINT)
	}
	transaction(): never {
		throw new Error('use DB.transaction(ctx, opts, cb)')
	}
	batch(): never {
		throw new Error(RUN_HINT)
	}
}

export type Builders = Pick<BetterSQLite3Database<Record<string, never>>, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete'>

// what an executor prepares: one of drizzle's builders
export type Preparable = {
	session: unknown
	config: Record<string, unknown>
	_prepare(isOneTimeQuery?: boolean): PreparedQuery
	getSQL(): DSQL
}

// drizzle's better-sqlite3 prepared query
export type PreparedQuery = {
	all(values?: Record<string, unknown>): unknown
	get(values?: Record<string, unknown>): unknown
	run(values?: Record<string, unknown>): { changes: number; lastInsertRowid: number | bigint }
	query: { sql: string; params: unknown[] }
}

// -------- stats --------

const BUCKETS_MS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 1000]

// a histogram of one statement's run times, read by the OTel instruments at collection (see observeStats)
export class Stats {
	count = 0
	errors = 0
	totalMs = 0
	maxMs = 0
	// definitions built from arguments: argument lists built, and evicted from the cache
	misses = 0
	evictions = 0
	readonly buckets = new Uint32Array(BUCKETS_MS.length + 1)
	constructor(
		readonly name: string,
		readonly module: string,
	) {}
	record(ms: number) {
		this.count++
		this.totalMs += ms
		if (ms > this.maxMs) this.maxMs = ms
		let i = 0
		while (i < BUCKETS_MS.length && ms > BUCKETS_MS[i]) i++
		this.buckets[i]++
	}
}

// -------- parameters --------

declare const PARAM: unique symbol
// a parameter is a SQL expression of its type, never the value, so `p.id === 'x'` is a type error
export type Parameter<T> = DSQL<T> & { readonly [PARAM]: T }
export type CountParam = Placeholder<string, number> & { readonly [PARAM]: number }

declare const DECL: unique symbol
// a parameter declaration with no column, or with a schema, or that takes a Secret
export type Decl<T> = { readonly [DECL]: T; readonly kind: DeclKind }
type CountDecl = Decl<number> & { readonly kind: 'count' }
type DeclKind = 'value' | 'column' | 'count'
type RuntimeDecl = {
	kind: DeclKind
	column?: Column
	// SQL.list: the column each element is encoded like
	listOf?: Column
	encode?: (v: never) => unknown
	schema?: z.ZodType
	secret?: boolean
	unlogged?: boolean
}

type Spec = Column | Decl<unknown>
type SpecValue<S> = S extends Column ? GetColumnData<S> : S extends Decl<infer T> ? T : never
type ParamOf<S> = S extends CountDecl ? CountParam : Parameter<SpecValue<S>>

declare const VALUES: unique symbol
export type Params<P extends Record<string, Spec> = Record<string, Spec>> = { readonly [K in keyof P]: ParamOf<P[K]> } & {
	readonly [VALUES]: { [K in keyof P]: SpecValue<P[K]> }
}
export type ValuesOf<P> = P extends { readonly [VALUES]: infer V } ? V : never

// the runtime facts of one parameter, keyed by its Placeholder
type ParamInfo = {
	name: string
	placeholder: Placeholder
	sql: DSQL
	decl: RuntimeDecl
}
const PARAM_INFO = new WeakMap<object, ParamInfo>()
// every declared parameter set, by its object
const PARAM_SETS = new WeakMap<object, ParamInfo[]>()

const COUNT_DECL: RuntimeDecl = { kind: 'count' }

function nullAware(decl: RuntimeDecl, name: string) {
	const { column, encode, schema, secret } = decl
	const base: (v: unknown) => unknown = encode
		? (encode as (v: unknown) => unknown)
		: column
			? (v) => column.mapToDriverValue(v)
			: (v) => v
	return {
		mapToDriverValue(v: unknown) {
			if (secret && v !== null) {
				if (!isSecret(v)) throw new TypeError(`parameter ${name} takes a Secret`)
				// a secretColumn's own encoder takes the Secret and reveals it
				if (!column || !isSecretColumn(column)) v = v.reveal()
				else return base(v)
			} else if (isSecret(v)) {
				throw new TypeError(`parameter ${name} is not declared as a secret: declare it with SQL.secret`)
			}
			if (CHECKS && schema && v !== null) checkSchemaValue(schema, v, name)
			// a JSON column would store null as the text 'null', and a codec would throw on it
			return v === null ? null : base(v)
		},
	}
}

function params<P extends Record<string, Spec>>(spec: P): Params<P> {
	const out: Record<string, unknown> = {}
	const infos: ParamInfo[] = []
	for (const [name, s] of Object.entries(spec)) {
		const decl: RuntimeDecl = is(s, Column) ? { kind: 'column', column: s } : (s as unknown as RuntimeDecl)
		const placeholder = new Placeholder(name)
		if (decl.kind === 'count') {
			const info: ParamInfo = { name, placeholder, sql: placeholder as unknown as DSQL, decl }
			PARAM_INFO.set(placeholder, info)
			infos.push(info)
			out[name] = Object.freeze(placeholder)
			continue
		}
		const param = new Param(placeholder, nullAware(decl, name))
		const s2 = sql`${param}`
		const info: ParamInfo = { name, placeholder, sql: s2, decl }
		PARAM_INFO.set(placeholder, info)
		PARAM_INFO.set(s2, info)
		infos.push(info)
		// only the SQL, its chunks, the Param and the Placeholder: the encoder holds the column, which is shared
		Object.freeze(placeholder)
		Object.freeze(param)
		Object.freeze(s2.queryChunks)
		Object.freeze((s2 as unknown as { usedTables: string[] }).usedTables)
		Object.freeze(s2)
		out[name] = s2
	}
	Object.freeze(out)
	PARAM_SETS.set(out, infos)
	return out as Params<P>
}

// A zod schema that only checks, so skipping it in production changes nothing: no pipes, transforms, coercions or
// defaults, and objects strict (see checkSchema).
type Checking<S extends z.ZodType> =
	S extends z.ZodPipe<any, any> ? never : [z.input<S>] extends [z.output<S>] ? ([z.output<S>] extends [z.input<S>] ? S : never) : never

type ValueFns = {
	// bound as given
	<T extends Bindable>(): Decl<T>
	// any type, through its own encoder
	<T>(encode: (v: T) => Bindable): Decl<T>
	// checked by a schema in development and test, then bound
	<S extends z.ZodType<Bindable>>(schema: Checking<S>): Decl<z.output<S>>
	<S extends z.ZodType>(schema: Checking<S>, encode: (v: z.output<S>) => Bindable): Decl<z.output<S>>
}

function isZod(v: unknown): v is z.ZodType {
	return typeof v === 'object' && v !== null && '_zod' in v
}

const value = ((a?: unknown, b?: unknown) => {
	if (a === undefined) return { kind: 'value' } satisfies RuntimeDecl
	if (typeof a === 'function') return { kind: 'value', encode: a as (v: never) => unknown } satisfies RuntimeDecl
	if (isZod(a)) {
		checkSchema(a, 'strict', 'parameter')
		return { kind: 'value', schema: a, encode: b as ((v: never) => unknown) | undefined } satisfies RuntimeDecl
	}
	throw new TypeError('SQL.value takes nothing, an encoder or a zod schema')
}) as unknown as ValueFns

// encoded like the column, and checked by the schema in development and test
function column<C extends Column, S extends z.ZodType<GetColumnData<C>>>(col: C, schema: Checking<S>): Decl<z.output<S>> {
	checkSchema(schema, 'strict', 'parameter')
	return { kind: 'column', column: col, schema } satisfies RuntimeDecl as unknown as Decl<z.output<S>>
}

// shown as '[redacted]' in the development debug log, like a parameter that meets an unlogged column
function unlogged<S extends Spec>(spec: S): Decl<SpecValue<S>> {
	const decl: RuntimeDecl = is(spec, Column) ? { kind: 'column', column: spec } : { ...(spec as unknown as RuntimeDecl) }
	if (decl.kind === 'count') throw new TypeError('SQL.unlogged takes a column or a declaration, not SQL.count()')
	return { ...decl, unlogged: true } as unknown as Decl<SpecValue<S>>
}

type SecretFns = {
	<S extends z.ZodType<Bindable>>(schema: Checking<S>): Decl<Secret<z.output<S>>>
	// null too, for a nullable column
	<C extends Column, S extends z.ZodType<Unsecret<NonNullable<GetColumnData<C>>>>>(
		col: C,
		schema: Checking<S>,
	): Decl<Secret<z.output<S>> | (null extends GetColumnData<C> ? null : never)>
}
type Unsecret<T> = T extends Secret<infer U> ? U : T

// takes a Secret, binds its revealed value, and is masked in every log
const secret = ((a: unknown, b?: unknown) => {
	if (is(a, Column)) {
		checkSchema(b as z.ZodType, 'strict', 'parameter')
		return { kind: 'column', column: a, schema: b as z.ZodType, secret: true } satisfies RuntimeDecl
	}
	checkSchema(a as z.ZodType, 'strict', 'parameter')
	return { kind: 'value', schema: a as z.ZodType, secret: true } satisfies RuntimeDecl
}) as unknown as SecretFns

// A list as one JSON parameter, each element encoded like `col`, for SQL.inJson against a column of its type
function list<C extends Column>(col: C): Decl<NonNullable<GetColumnData<C>>[]> {
	return {
		kind: 'value',
		listOf: col,
		encode: (vs: unknown[]) => JSON.stringify(vs.map((v) => col.mapToDriverValue(v))),
	} satisfies RuntimeDecl as unknown as Decl<NonNullable<GetColumnData<C>>[]>
}

// a bare placeholder for limit and offset, which accept only `number | Placeholder`
function count(): CountDecl {
	return COUNT_DECL as unknown as CountDecl
}

// while checkDefinition renders, a SQL.lit encodes to this marker
let checking = false
const LIT_MARKER = Object.freeze({ lit: true })
// each SQL.lit's statement chunk, with the value it was given
const LITS = new WeakMap<object, string | number | bigint | boolean | null>()

// A literal a definition binds once, when it is built. Booleans are stored as 1 and 0, as boolean columns store them.
function lit(v: string | number | bigint | boolean | null): DSQL<never> {
	if (v !== null && typeof v === 'object') throw new TypeError('SQL.lit takes a string, number, bigint, boolean or null')
	// drizzle binds a null without calling its encoder, so it is written into the SQL instead
	if (v === null) {
		const s = sql.raw('null')
		LITS.set(s, null)
		return Object.freeze(s) as DSQL<never>
	}
	const bound = v === true ? 1 : v === false ? 0 : v
	const p = new Param(bound, { mapToDriverValue: () => (checking ? LIT_MARKER : bound) })
	const s = new DSQL([p])
	LITS.set(s, v)
	Object.freeze(p)
	Object.freeze(s.queryChunks)
	return Object.freeze(s) as DSQL<never>
}

const IN_JSON = new WeakMap<object, Column>()
// `column in (select value from json_each(list))`: a SQL.list parameter, searched by index
function inJson<C extends Column>(col: C, list: Parameter<NonNullable<GetColumnData<C>>[]>): DSQL<unknown> {
	const s = sql`${col} in (select value from json_each(${list}))`
	IN_JSON.set(s, col)
	return s
}

// -------- secret columns (see drizzle/columns.ts) --------

function isSecretColumn(col: object) {
	return secretEncoders.has((col as { mapTo?: object }).mapTo ?? {})
}

// -------- zod checks --------

function checkSchemaValue(schema: z.ZodType, v: unknown, name: string) {
	const r = schema.safeParse(v)
	if (!r.success) throw new TypeError(`parameter ${name}: ${r.error.message}`)
	// catches in-place rewrites, such as .trim(), that no type shows
	if (!sameValue(r.data, v)) throw new TypeError(`parameter ${name}: its schema changed the value, and schemas here may only check`)
}

// -------- definitions --------

declare const CALLED_STMT: unique symbol
export const CALLED = Symbol('called')
// a definition called with its values: what an executor runs
export type Called<S> = { readonly [CALLED]: Entry; readonly values: Record<string, unknown>; readonly [CALLED_STMT]?: S }

export type Entry = {
	name: string
	module: OtelModule
	stmt: Preparable
	text: string
	prepared: WeakMap<object, PreparedQuery>
	stats: Stats
	// the argument list a definition built from arguments was called with
	args?: readonly unknown[]
	// tables the boot check lets the statement scan
	scans: readonly string[]
	// parameters the development debug log shows as '[redacted]': those declared with SQL.unlogged or that meet an
	// unlogged column
	unlogged: ReadonlySet<string>
}

type Primitive = string | number | boolean | null | undefined

export type DefOpts<A extends unknown[]> = {
	// maps richer arguments to primitives, and canonicalises them, so equal argument lists share a statement
	key?: (...args: A) => Primitive[]
	// the values each argument can take, so the boot check can build every argument list
	domains?: { [K in keyof A]?: readonly A[K][] }
	// an argument list of the domains that cannot be built, such as a partial update with every field off
	skip?: (...args: A) => boolean
	// argument lists kept, least recently used evicted first
	max?: number
	// tables the boot check lets the statement scan
	scans?: readonly string[]
}

export type Def<V, S> = (values: V) => Called<S>
// a definition built from arguments takes every parameter, and one its statement for these arguments leaves out may be
// undefined
type BuiltValues<V> = { [K in keyof V]: V[K] | undefined }

type Registered = {
	name: string
	module: OtelModule
	stats: Stats
	entries: () => Iterable<Entry>
	// definitions built from arguments: every argument list its domains allow
	enumerate?: () => void
}
export const registry = new Map<string, Registered>()
// statements built per call, by module
export const adhocStats = new Map<string, Stats>()

function register(r: Registered) {
	if (registry.has(r.name)) throw new Error(`statement ${r.name} is defined twice`)
	registry.set(r.name, r)
}

function makeEntry(
	name: string,
	module: OtelModule,
	stmt: Preparable,
	p: object,
	stats: Stats,
	scans: readonly string[],
	args?: readonly unknown[],
): Entry {
	const unbound = stmt.session
	if (!(unbound instanceof Unbound)) throw new Error(`${name}: build the statement with SQL.select/insert/update/delete`)
	// a definition built from arguments may leave a parameter out of some of its statements
	const text = checkDefinition(name, stmt, p, { allUsed: args === undefined })
	freezeConfig(stmt)
	return { name, module, stmt, text, prepared: new WeakMap(), stats, args, scans, unlogged: unloggedParams(p) }
}

function unloggedParams(p: object): ReadonlySet<string> {
	const out = new Set<string>()
	for (const { name, decl } of PARAM_SETS.get(p) ?? []) {
		const col = decl.column ?? decl.listOf
		if (decl.unlogged || (col && isUnlogged(col))) out.add(name)
	}
	return out
}

// .where(), .orderBy() and the other builder methods change the builder they are called on, so a definition's would
// carry one call's changes into the next
function freezeConfig(stmt: Preparable) {
	const c = stmt.config
	for (const v of Object.values(c)) if (Array.isArray(v)) Object.freeze(v)
	Object.freeze(c)
	Object.freeze(stmt)
}

// Renders the statement once, and checks that its placeholders are exactly the declared parameters, its other bound
// values are SQL.lit literals, and each column parameter meets a column of its own type. Returns the SQL text.
function checkDefinition(name: string, stmt: Preparable, p: object, opts: { allUsed: boolean }): string {
	const declared = PARAM_SETS.get(p)
	if (!declared) throw new Error(`${name}: declare the parameters with SQL.params`)
	// rendered with each SQL.lit standing in as its marker, so a literal it bound can be told from one it did not
	let q: { sql: string; params: unknown[] }
	checking = true
	try {
		q = dialect.sqlToQuery(stmt.getSQL())
	} finally {
		checking = false
	}
	const used = new Set<ParamInfo>()
	const config = stmt.config as { limit?: unknown; offset?: unknown; table?: Record<symbol, unknown>; values?: unknown }
	// drizzle binds a number given to limit() and offset() as a literal, and an insert binds each column's schema default
	// for a column it is not given, which are fixed by the schema
	const allowedLiterals: unknown[] = [config.limit, config.offset].filter((x) => typeof x === 'number')
	if (config.values && config.table) {
		const columns = config.table[Symbol.for('drizzle:Columns')] as Record<string, Column> | undefined
		for (const col of Object.values(columns ?? {}))
			if (col.hasDefault && col.default !== undefined && !is(col.default, DSQL)) allowedLiterals.push(col.mapToDriverValue(col.default))
	}
	const problems: string[] = []
	for (const raw of q.params) {
		const ph = is(raw, Placeholder) ? raw : is(raw, Param) && is(raw.value, Placeholder) ? raw.value : undefined
		if (ph) {
			const info = PARAM_INFO.get(ph)
			if (!info || !declared.includes(info)) problems.push(`placeholder ${ph.name} is not one of the declared parameters`)
			else used.add(info)
			continue
		}
		if (raw === LIT_MARKER) continue
		const at = allowedLiterals.indexOf(raw)
		if (at !== -1) {
			allowedLiterals.splice(at, 1)
			continue
		}
		if (raw instanceof Date || (raw !== null && typeof raw === 'object' && !(raw instanceof Uint8Array)))
			problems.push(`binds a ${raw instanceof Date ? 'Date' : 'object'} literal, which would never change: make it a parameter`)
		else
			problems.push(
				`binds the literal ${typeof raw === 'bigint' ? `${raw}n` : JSON.stringify(raw)} once, at definition: wrap it in SQL.lit(...) or make it a parameter`,
			)
	}
	if (opts.allUsed) for (const info of declared) if (!used.has(info)) problems.push(`declares ${info.name} and never uses it`)
	problems.push(
		...checkPositions(
			stmt,
			declared.filter((info) => used.has(info)),
		),
	)
	if (problems.length) throw new Error(`statement ${name}:\n  ${problems.join('\n  ')}`)
	return q.sql
}

// Column types whose encoder changes the value: a parameter with an encoder of its own would bypass the column's.
const ENCODED = new Set(['SQLiteTimestamp', 'SQLiteBoolean', 'SQLiteTextJson', 'SQLiteBlobJson', 'SQLiteCustomColumn', 'SQLiteBigInt'])

// the operators drizzle's comparison helpers put between their two sides
const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>='])
// and those that take a value of the column's type on either side
const OPERATORS = new Set([...COMPARISONS, 'like', 'not like', 'glob', 'between', 'not between'])
const BETWEEN = new Set(['between', 'not between'])
const chunkText = (chunk: unknown) => (is(chunk, StringChunk) ? chunk.value.join('').trim() : '')

function sameColumnType(a: Column, b: Column) {
	return a.columnType === b.columnType && a.getSQLType() === b.getSQLType()
}

// why a SQL.lit cannot stand for a value of `col`, or undefined when it can
function litProblem(v: string | number | bigint | boolean | null, col: Column, compared: boolean): string | undefined {
	if (v === null) {
		if (compared) return 'compares with a null literal, which matches no row: use isNull'
		return col.notNull ? 'is null, and the column is not null' : undefined
	}
	const want = { string: 'string', number: 'number', boolean: 'boolean', bigint: 'bigint' }[col.dataType as string]
	if (!want) return `cannot be encoded as ${col.columnType}: make it a parameter`
	if (typeof v !== want) return `is a ${typeof v}, and the column holds a ${want}`
	if (col.columnType === 'SQLiteInteger' && !Number.isInteger(v)) return 'is not an integer'
	const values = (col as { enumValues?: readonly string[] }).enumValues
	if (values?.length && !values.includes(v as string)) return `is not one of the column's values (${values.join(', ')})`
	return undefined
}

function checkPositions(stmt: Preparable, declared: ParamInfo[]): string[] {
	const problems: string[] = []
	const classified = new Set<ParamInfo>()
	const meet = (info: ParamInfo, col: Column, where: string) => {
		classified.add(info)
		const own = info.decl.column
		if (own) {
			if (!sameColumnType(own, col))
				problems.push(
					`${info.name} is declared as ${own.name} (${own.columnType}) and used against ${col.name} (${col.columnType}) in ${where}`,
				)
		} else if (info.decl.listOf) {
			problems.push(`${info.name} is a list and is used against ${col.name} in ${where}: match a list with SQL.inJson`)
		} else if (!info.decl.encode) {
			// the parameter's type then comes from the column, not from a type argument nothing checks against it
			problems.push(
				`${info.name} is used against ${col.name} in ${where}: declare it with that column, or with ${info.decl.secret ? 'SQL.secret(column, schema)' : 'SQL.column'}`,
			)
		} else if (ENCODED.has(col.columnType)) {
			problems.push(
				`${info.name} has an encoder of its own and is used against ${col.name}, whose encoder it bypasses: declare it with that column`,
			)
		}
		if (isSecretColumn(col) && !info.decl.secret)
			problems.push(`${info.name} is used against the secret column ${col.name}: declare it with SQL.secret`)
	}
	const meetLit = (v: string | number | bigint | boolean | null, col: Column, where: string, compared: boolean) => {
		const problem = litProblem(v, col, compared)
		if (problem)
			problems.push(`the literal ${typeof v === 'bigint' ? `${v}n` : JSON.stringify(v)} for ${col.name} in ${where} ${problem}`)
	}
	const infoOf = (chunk: unknown) => (chunk !== null && typeof chunk === 'object' ? PARAM_INFO.get(chunk) : undefined)
	const c = stmt.config as {
		table?: { [k: symbol]: unknown }
		set?: Record<string, unknown>
		values?: Record<string, unknown>[]
		onConflict?: unknown
	}
	const tableColumns = c.table ? (c.table[Symbol.for('drizzle:Columns')] as Record<string, Column> | undefined) : undefined
	const assign = (rec: Record<string, unknown>, where: string) => {
		for (const [k, v] of Object.entries(rec)) {
			const info = infoOf(v)
			const col = tableColumns?.[k]
			if (!col) continue
			if (info) meet(info, col, `${where} ${k}`)
			else if (v !== null && typeof v === 'object' && LITS.has(v)) meetLit(LITS.get(v)!, col, `${where} ${k}`, false)
		}
	}
	if (c.set) assign(c.set, 'set')
	for (const row of c.values ?? []) assign(row, 'values')

	const seen = new Set<object>()
	const walk = (s: DSQL) => {
		if (seen.has(s)) return
		seen.add(s)
		const chunks = s.queryChunks
		const listCol = IN_JSON.get(s)
		for (let i = 0; i < chunks.length; i++) {
			const ch = chunks[i]
			const info = infoOf(ch)
			if (info) {
				if (listCol) {
					classified.add(info)
					const of = info.decl.listOf
					if (!of) problems.push(`${info.name} is matched against ${listCol.name} with SQL.inJson: declare it with SQL.list`)
					else if (!sameColumnType(of, listCol))
						problems.push(
							`${info.name} is a list of ${of.name} (${of.columnType}) and is matched against ${listCol.name} (${listCol.columnType})`,
						)
					continue
				}
				// drizzle's operators build `${column} <op> ${value}`, with the operator a string chunk between
				const left = chunks[i - 2]
				const right = chunks[i + 2]
				if (is(left, Column) && OPERATORS.has(chunkText(chunks[i - 1]))) meet(info, left, 'a comparison')
				// the upper bound of `${column} between ${min} and ${max}`
				else if (chunkText(chunks[i - 1]) === 'and' && is(chunks[i - 4], Column) && BETWEEN.has(chunkText(chunks[i - 3])))
					meet(info, chunks[i - 4] as Column, 'a comparison')
				else if (is(right, Column) && OPERATORS.has(chunkText(chunks[i + 1]))) meet(info, right, 'a comparison')
				continue
			}
			if (ch !== null && typeof ch === 'object' && LITS.has(ch)) {
				const v = LITS.get(ch)!
				const left = chunks[i - 2]
				const right = chunks[i + 2]
				if (is(left, Column) && COMPARISONS.has(chunkText(chunks[i - 1]))) meetLit(v, left, 'a comparison', true)
				else if (is(right, Column) && COMPARISONS.has(chunkText(chunks[i + 1]))) meetLit(v, right, 'a comparison', true)
				continue
			}
			if (is(ch, Column) && is(chunks[i + 2], Column) && COMPARISONS.has(chunkText(chunks[i + 1]))) {
				const other = chunks[i + 2] as Column
				if (!sameColumnType(ch, other))
					problems.push(`compares ${ch.name} (${ch.columnType}) with ${other.name} (${other.columnType}), a column of another type`)
				continue
			}
			if (is(ch, DSQL)) walk(ch)
			else if (is(ch, DSQL.Aliased)) walk((ch as unknown as { sql: DSQL }).sql)
			else if (is(ch, Subquery)) walk((ch as unknown as { _: { sql: DSQL } })._.sql)
			// a subquery builder, such as the select in inArray(column, SQL.select(...))
			else if (isSQLWrapper(ch) && !is(ch, Column) && !is(ch, Table) && !is(ch, Param) && !is(ch, Placeholder) && !seen.has(ch)) {
				seen.add(ch)
				walk(ch.getSQL())
			} else if (Array.isArray(ch)) for (const x of ch) if (is(x, DSQL)) walk(x)
		}
	}
	walk(stmt.getSQL())
	for (const info of declared) {
		if (classified.has(info) || info.decl.kind === 'count') continue
		if (info.decl.column)
			problems.push(
				`${info.name} is declared with a column and used where the check cannot tell which column it meets: declare it with SQL.value`,
			)
	}
	return problems
}

type Builder<S> = S | ((...args: never[]) => S)

function defFor(module: OtelModule) {
	function def<P extends Params<any>, A extends Primitive[], S extends object>(
		name: string,
		p: P,
		build: (...args: A) => S,
		opts?: Omit<DefOpts<A>, 'key'>,
	): (...args: A) => Def<BuiltValues<ValuesOf<P>>, S>
	function def<P extends Params<any>, A extends unknown[], S extends object>(
		name: string,
		p: P,
		build: (...args: A) => S,
		opts: DefOpts<A> & { key: (...args: A) => Primitive[] },
	): (...args: A) => Def<BuiltValues<ValuesOf<P>>, S>
	function def<P extends Params<any>, S extends object>(
		name: string,
		p: P,
		stmt: S,
		opts?: { scans?: readonly string[] },
	): Def<ValuesOf<P>, S>
	function def(name: string, p: object, stmtOrBuild: Builder<object>, opts?: DefOpts<unknown[]>): unknown {
		const full = `${module.name}:${name}`
		const stats = new Stats(full, module.name)
		if (typeof stmtOrBuild !== 'function') {
			const entry = makeEntry(full, module, stmtOrBuild as Preparable, p, stats, opts?.scans ?? [])
			register({ name: full, module, stats, entries: () => [entry] })
			return (values: Record<string, unknown>) => ({ [CALLED]: entry, values })
		}
		return defBuilt(full, module, p, stmtOrBuild as (...args: unknown[]) => Preparable, stats, opts ?? {})
	}
	return def
}

const LEAF = Symbol('leaf')
type Node = Map<unknown, Node> & { [LEAF]?: { caller: (values: Record<string, unknown>) => unknown; entry: Entry; path: unknown[] } }

// the identity of a statement: its text plus every literal drizzle bound into it
function identity(stmt: Preparable) {
	const q = dialect.sqlToQuery(stmt.getSQL())
	const literals = q.params.filter((x) => !is(x, Placeholder) && !(is(x, Param) && is(x.value, Placeholder)))
	return JSON.stringify([q.sql, literals], (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}

function defBuilt(
	name: string,
	module: OtelModule,
	p: object,
	build: (...args: unknown[]) => Preparable,
	stats: Stats,
	opts: DefOpts<unknown[]>,
) {
	const max = opts.max ?? 64
	const root: Node = new Map()
	// least recently used first
	const lru = new Map<Node, unknown[]>()
	// development and test: the SQL text of each argument list, to report an argument that only changes a literal
	const texts = CHECKS ? new Map<string, unknown[]>() : undefined

	const buildEntry = (args: unknown[], key: unknown[]) => {
		stats.misses++
		const stmt = build(...args)
		const entry = makeEntry(`${name}(${key.map(String).join(', ')})`, module, stmt, p, stats, opts.scans ?? [], key)
		if (CHECKS) {
			const again = identity(build(...args))
			if (again !== identity(stmt)) throw new Error(`${entry.name}: the callback built a different statement for the same arguments`)
			const other = texts!.get(entry.text)
			if (other && identity(build(...other)) !== identity(stmt))
				throw new Error(
					`${name}: (${key.map(String).join(', ')}) and (${other.map(String).join(', ')}) differ only in a bound literal. ` +
						'An argument that does not change the SQL is a value: make it a parameter.',
				)
			texts!.set(entry.text, args)
		}
		return entry
	}

	const call = (...args: unknown[]) => {
		const key = opts.key ? opts.key(...args) : args
		let node = root
		for (const a of key) {
			if (CHECKS && a !== null && a !== undefined && typeof a === 'object')
				throw new TypeError(`${name}: statement arguments must be primitives; pass a key function for richer ones`)
			let next = node.get(a)
			if (!next) node.set(a, (next = new Map()))
			node = next
		}
		let leaf = node[LEAF]
		if (leaf) {
			lru.delete(node)
			lru.set(node, key)
			if (CHECKS && opts.key && identity(build(...args)) !== identity(leaf.entry.stmt))
				throw new Error(
					`${name}: the key function maps (${args.map(String).join(', ')}) to (${key.map(String).join(', ')}), which was built differently`,
				)
			return leaf.caller
		}
		const entry = buildEntry(args, key)
		leaf = { caller: (values) => ({ [CALLED]: entry, values }), entry, path: key }
		node[LEAF] = leaf
		lru.set(node, key)
		if (lru.size > max) {
			const [oldNode, oldKey] = lru.entries().next().value!
			lru.delete(oldNode)
			delete oldNode[LEAF]
			stats.evictions++
			// prune the emptied branch
			let n = root
			const path: Node[] = [root]
			for (const a of oldKey) path.push((n = n.get(a)!))
			for (let i = oldKey.length - 1; i >= 0 && path[i + 1].size === 0 && !path[i + 1][LEAF]; i--) path[i].delete(oldKey[i])
		}
		return leaf.caller
	}

	const enumerate = () => {
		const domains = opts.domains as unknown[][] | undefined
		if (!domains) return
		const lists: unknown[][] = [[]]
		for (const d of domains) {
			const next: unknown[][] = []
			for (const l of lists) for (const v of d ?? [undefined]) next.push([...l, v])
			lists.splice(0, lists.length, ...next)
		}
		for (const l of lists) if (!opts.skip?.(...l)) call(...l)
	}
	register({
		name,
		module,
		stats,
		entries: function* () {
			for (const node of lru.keys()) if (node[LEAF]) yield node[LEAF].entry
		},
		enumerate,
	})
	return call
}

// -------- forModule --------

// `replace` drops the module's earlier statements first, for a plugin, which defines its
// statements again each time it activates.
export function forModule(module: OtelModule, opts?: { replace?: boolean }) {
	const key = module.name
	if (opts?.replace) {
		adhocStats.delete(key)
		for (const [name, r] of registry) if (r.module.name === key) registry.delete(name)
	}
	let stats = adhocStats.get(key)
	if (stats) throw new Error(`Sql.forModule called twice for ${module.name}; call it once per file`)
	stats = new Stats(`${module.name}:(built per call)`, module.name)
	adhocStats.set(key, stats)
	const unbound = new Unbound(module, stats)
	const builders = new BetterSQLite3Database('sync', dialect, unbound as never, undefined) as unknown as Builders
	return Object.freeze({
		select: builders.select.bind(builders) as Builders['select'],
		selectDistinct: builders.selectDistinct.bind(builders) as Builders['selectDistinct'],
		insert: builders.insert.bind(builders) as Builders['insert'],
		update: builders.update.bind(builders) as Builders['update'],
		delete: builders.delete.bind(builders) as Builders['delete'],
		def: defFor(module),
		params,
		value,
		column,
		secret,
		unlogged,
		list,
		count,
		lit,
		inJson,
	})
}

export type SqlModule = ReturnType<typeof forModule>

// -------- OTel --------

let observing = false
// OTel instruments over every statement's stats, read at collection
export function observeStats() {
	if (observing) return
	observing = true
	const meter = Otel.metrics.getMeter('sql')
	const all = () => [...[...registry.values()].map((r) => r.stats), ...adhocStats.values()]
	const attrs = (s: Stats) => ({ 'sql.statement': s.name, 'code.namespace': s.module })
	meter
		.createObservableCounter('sql.statement.count', { description: 'Statements run, by statement' })
		.addCallback((r) => all().forEach((s) => s.count && r.observe(s.count, attrs(s))))
	meter
		.createObservableCounter('sql.statement.errors', { description: 'Statements that threw, by statement' })
		.addCallback((r) => all().forEach((s) => s.errors && r.observe(s.errors, attrs(s))))
	meter
		.createObservableCounter('sql.statement.duration.sum', { description: 'Total time spent running each statement', unit: 'ms' })
		.addCallback((r) => all().forEach((s) => s.count && r.observe(s.totalMs, attrs(s))))
	meter
		.createObservableGauge('sql.statement.duration.max', { description: 'Slowest run of each statement since boot', unit: 'ms' })
		.addCallback((r) => all().forEach((s) => s.count && r.observe(s.maxMs, attrs(s))))
	meter
		.createObservableCounter('sql.statement.duration.bucket', { description: 'Runs of each statement at or under `le` ms', unit: '1' })
		.addCallback((r) =>
			all().forEach((s) => {
				if (!s.count) return
				let acc = 0
				for (let i = 0; i < s.buckets.length; i++) {
					acc += s.buckets[i]
					r.observe(acc, { ...attrs(s), le: i < BUCKETS_MS.length ? String(BUCKETS_MS[i]) : '+Inf' })
				}
			}),
		)
}
