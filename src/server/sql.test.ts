import Database from 'better-sqlite3'
import { and, between, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { beforeEach, describe, expect, test } from 'vitest'

import type { OtelModule } from '@/lib/otel'
import { Secret } from '@/lib/secret'
import * as z from '@/lib/zod'
import * as CS from '@/models/context-shared.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Sql from '@/server/sql'

// Round-trips each builder kind and each parameter kind through the executors, and pins the transaction rules. These
// lean on drizzle internals (see the header of sql.ts), so a drizzle upgrade that changes them fails here.

const noopLogger: any = new Proxy(() => {}, { get: () => noopLogger, apply: () => undefined })
const module = { name: 'sql-test', tracer: undefined as never, getLogger: () => noopLogger } as unknown as OtelModule
const SQL = Sql.forModule(module)

const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	officeId: text('officeId'),
	meta: text('meta', { mode: 'json' }),
	at: integer('at', { mode: 'timestamp_ms' }),
	live: integer('live', { mode: 'boolean' }),
	pin: text('pin'),
})
const offices = sqliteTable('offices', { id: text('id').primaryKey(), name: text('name').notNull() })
// created with `on conflict rollback`, so a duplicate ends the whole transaction, as SQLITE_FULL does
const dup = sqliteTable('dup', { id: text('id').primaryKey() })

let driver: Database.Database
let ctx: C.Db

beforeEach(() => {
	driver = new Database(':memory:')
	driver.exec(`create table users (id text primary key, name text not null, officeId text, meta text, at integer, live integer, pin text);
		create table offices (id text primary key, name text not null);
		create table dup (id text primary key on conflict rollback)`)
	ctx = { ...CS.init(), db: DB.connect(driver) }
})

const p = SQL.params({ id: users.id, name: users.name, meta: users.meta, at: users.at })
const insertUser = SQL.def('insertUser', p, SQL.insert(users).values({ id: p.id, name: p.name, meta: p.meta, at: p.at }))

const q = SQL.params({ id: users.id })
const userById = SQL.def('userById', q, SQL.select().from(users).where(eq(users.id, q.id)))
const r = SQL.params({ id: users.id, name: users.name })
const rename = SQL.def('rename', r, SQL.update(users).set({ name: r.name }).where(eq(users.id, r.id)))

describe('statements built per call', () => {
	test('each builder kind runs through the executors', () => {
		DB.run(ctx, SQL.insert(offices).values({ id: 'o', name: 'Office' }))
		const inserted = DB.all(
			ctx,
			SQL.insert(users)
				.values({ id: 'a', name: 'A', officeId: 'o', meta: { x: 1 }, at: new Date(5) })
				.returning({ id: users.id }),
		)
		expect(inserted).toEqual([{ id: 'a' }])
		const joined = DB.all(
			ctx,
			SQL.select({ id: users.id, office: offices.name }).from(users).leftJoin(offices, eq(offices.id, users.officeId)),
		)
		expect(joined).toEqual([{ id: 'a', office: 'Office' }])
		const row = DB.get(ctx, SQL.select().from(users).where(eq(users.id, 'a')))
		expect(row?.at).toEqual(new Date(5))
		expect(row?.meta).toEqual({ x: 1 })
		expect(DB.run(ctx, SQL.update(users).set({ name: 'B' }).where(eq(users.id, 'a'))).changes).toBe(1)
		expect(DB.run(ctx, SQL.delete(users).where(eq(users.id, 'a'))).changes).toBe(1)
		expect(DB.get(ctx, SQL.select().from(users).where(eq(users.id, 'a')))).toBeUndefined()
	})

	test('cannot run without an executor', async () => {
		const stmt = SQL.select().from(users)
		expect(() => stmt.all()).toThrow(/DB.all/)
		await expect(Promise.resolve().then(() => stmt)).rejects.toThrow(/DB.all/)
	})

	test('a cached statement used for array rows and then object rows reads both right', () => {
		DB.run(ctx, SQL.insert(users).values({ id: 'a', name: 'A' }))
		// a partial select reads array rows; a whole-row raw read of the same text reads object rows
		expect(DB.get(ctx, SQL.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, 'a')))).toEqual({
			id: 'a',
			name: 'A',
		})
		for (let i = 0; i < 2; i++) expect(DB.all(ctx, SQL.select().from(users)).map((u) => u.name)).toEqual(['A'])
	})
})

describe('definitions', () => {
	test('values are bound, encoded like their columns, and a null is stored as SQL NULL', () => {
		DB.run(ctx, insertUser({ id: 'a', name: 'A', meta: null, at: new Date(7) }))
		DB.run(ctx, SQL.insert(users).values({ id: 'b', name: 'B', meta: null }))
		expect(driver.prepare('select id, meta, at from users order by id').all()).toEqual([
			{ id: 'a', meta: null, at: 7 },
			{ id: 'b', meta: null, at: null },
		])
		DB.run(ctx, rename({ id: 'a', name: 'Z' }))
		expect(DB.get(ctx, userById({ id: 'a' }))?.name).toBe('Z')
		// one prepared statement, many values
		for (let i = 0; i < 5; i++) DB.run(ctx, insertUser({ id: `u${i}`, name: 'n', meta: { i }, at: null }))
		expect(DB.get(ctx, userById({ id: 'u3' }))?.meta).toEqual({ i: 3 })
	})

	test('an uncalled definition is refused', () => {
		// @ts-expect-error a definition must be called with its values
		expect(() => DB.get(ctx, userById)).toThrow(/called with its values/)
	})

	test('the definition check rejects misused parameters and literals', () => {
		const a = SQL.params({ id: users.id, name: users.name })
		expect(() => SQL.def('unused', a, SQL.select().from(users).where(eq(users.id, a.id)))).toThrow(/declares name and never uses it/)
		const b = SQL.params({ id: users.id })
		expect(() => SQL.def('foreign', b, SQL.update(users).set({ name: a.name }).where(eq(users.id, b.id)))).toThrow(
			/not one of the declared/,
		)
		expect(() =>
			SQL.def(
				'literal',
				b,
				SQL.select()
					.from(users)
					.where(and(eq(users.id, b.id), eq(users.name, 'x'))),
			),
		).toThrow(/SQL.lit/)
		expect(() =>
			SQL.def(
				'date',
				b,
				SQL.select()
					.from(users)
					.where(and(eq(users.id, b.id), eq(users.at, new Date()))),
			),
		).toThrow(/literal/)
		const lit = SQL.def(
			'lit',
			b,
			SQL.update(users)
				.set({ live: SQL.lit(true), name: SQL.lit('x') })
				.where(eq(users.id, b.id)),
		)
		DB.run(ctx, SQL.insert(users).values({ id: 'a', name: 'A' }))
		DB.run(ctx, lit({ id: 'a' }))
		expect(DB.get(ctx, userById({ id: 'a' }))).toMatchObject({ live: true, name: 'x' })
		const c = SQL.params({ name: users.name })
		expect(() =>
			SQL.def(
				'wrongColumn',
				c,
				SQL.select()
					.from(users)
					.where(eq(users.at, c.name as never)),
			),
		).toThrow(/declared as name/)
		const d = SQL.params({ at: SQL.value<number>() })
		expect(() =>
			SQL.def(
				'rawAgainstEncoded',
				d,
				SQL.select()
					.from(users)
					.where(eq(users.at, d.at as never)),
			),
		).toThrow(/declare it with that column/)
		const e = SQL.params({ at: SQL.value((at: Date) => at.getTime() / 1000) })
		expect(() =>
			SQL.def(
				'ownEncoder',
				e,
				SQL.select()
					.from(users)
					.where(lt(users.at, e.at as never)),
			),
		).toThrow(/an encoder of its own/)
	})

	test('a parameter that meets a column is declared with it, inside a subquery too', () => {
		const v = SQL.params({ name: SQL.value<string>() })
		expect(() => SQL.def('bareValue', v, SQL.select().from(users).where(eq(users.name, v.name)))).toThrow(
			/name is used against name in a comparison/,
		)
		// a column of another type, met only inside the subquery
		const s = SQL.params({ at: users.name })
		expect(() =>
			SQL.def(
				'inSubquery',
				s,
				SQL.select()
					.from(offices)
					.where(
						inArray(
							offices.id,
							SQL.select({ id: users.officeId })
								.from(users)
								.where(lt(users.at, s.at as never)),
						),
					),
			),
		).toThrow(/declared as name \(SQLiteText\) and used against at \(SQLiteTimestamp\)/)
		// both bounds of a between meet its column
		const b = SQL.params({ lo: users.name, hi: SQL.value<string>() })
		expect(() =>
			SQL.def(
				'betweenHi',
				b,
				SQL.select()
					.from(users)
					.where(between(users.name, b.lo, b.hi)),
			),
		).toThrow(/hi is used against name in a comparison/)
		const b2 = SQL.params({ lo: users.name, hi: users.name })
		SQL.def(
			'betweenBoth',
			b2,
			SQL.select()
				.from(users)
				.where(between(users.name, b2.lo, b2.hi)),
		)
		// json_extract(...) = ? meets no column
		const j = SQL.params({ x: SQL.value<string>() })
		SQL.def(
			'notAColumn',
			j,
			SQL.select()
				.from(users)
				.where(sql`${users.meta} ->> 'x' = ${j.x}`),
		)
	})

	test('a literal fits the column it meets', () => {
		const b = SQL.params({ id: users.id })
		const bad = (name: string, set: Record<string, unknown>) => () =>
			SQL.def(name, b, SQL.update(users).set(set).where(eq(users.id, b.id)))
		expect(bad('litType', { live: SQL.lit('yes') })).toThrow(
			/the literal "yes" for live in set live is a string, and the column holds a boolean/,
		)
		expect(bad('litNotNull', { name: SQL.lit(null) })).toThrow(/is null, and the column is not null/)
		expect(bad('litJson', { meta: SQL.lit('{}') })).toThrow(/cannot be encoded as SQLiteTextJson/)
		expect(() =>
			SQL.def(
				'litNullCompared',
				b,
				SQL.select()
					.from(users)
					.where(and(eq(users.id, b.id), eq(users.officeId, SQL.lit(null)))),
			),
		).toThrow(/use isNull/)
		const roles = sqliteTable('roles', { role: text('role', { enum: ['admin', 'staff'] }) })
		expect(() =>
			SQL.def(
				'litEnum',
				SQL.params({}),
				SQL.select()
					.from(roles)
					.where(eq(roles.role, SQL.lit('admn'))),
			),
		).toThrow(/is not one of the column's values \(admin, staff\)/)
	})

	test('a comparison of two columns needs them to be of one type', () => {
		const none = SQL.params({})
		expect(() =>
			SQL.def('joinMismatch', none, SQL.select({ id: users.id }).from(users).innerJoin(offices, eq(offices.id, users.at))),
		).toThrow(/compares id \(SQLiteText\) with at \(SQLiteTimestamp\)/)
		SQL.def('joinMatch', none, SQL.select({ id: users.id }).from(users).innerJoin(offices, eq(offices.id, users.officeId)))
	})

	test('a parameter is frozen', () => {
		expect(() => q.id.append(sql`x`)).toThrow()
		expect(() => q.id.mapWith(String)).toThrow()
	})

	test('a definition is frozen', () => {
		const s = SQL.select()
			.from(users)
			.where(eq(users.id, SQL.lit('x')))
		SQL.def('frozen', SQL.params({}), s)
		expect(() => (s as unknown as typeof s & { where: (w: unknown) => unknown }).where(eq(users.id, SQL.lit('y')))).toThrow()
	})

	test('lists go in as one JSON parameter, each element encoded like its column', () => {
		const l = SQL.params({ ids: SQL.list(users.id) })
		const inList = SQL.def('inList', l, SQL.select({ id: users.id }).from(users).where(SQL.inJson(users.id, l.ids)).orderBy(users.id))
		for (const [i, id] of ['a', 'b', 'c'].entries()) DB.run(ctx, SQL.insert(users).values({ id, name: id, at: new Date(i) }))
		expect(DB.all(ctx, inList({ ids: ['a', 'c', 'z'] }))).toEqual([{ id: 'a' }, { id: 'c' }])
		const t = SQL.params({ ats: SQL.list(users.at) })
		const atTimes = SQL.def('atTimes', t, SQL.select({ id: users.id }).from(users).where(SQL.inJson(users.at, t.ats)))
		expect(DB.all(ctx, atTimes({ ats: [new Date(1)] }))).toEqual([{ id: 'b' }])
		const raw = SQL.params({ ids: SQL.value((ids: string[]) => JSON.stringify(ids)) })
		expect(() => SQL.def('rawList', raw, SQL.select().from(users).where(SQL.inJson(users.id, raw.ids)))).toThrow(
			/declare it with SQL.list/,
		)
		expect(() =>
			SQL.def(
				'listOfOther',
				t,
				SQL.select()
					.from(users)
					.where(SQL.inJson(users.id, t.ats as never)),
			),
		).toThrow(/a list of at \(SQLiteTimestamp\) and is matched against id \(SQLiteText\)/)
	})

	test('a count parameter goes to limit', () => {
		const l = SQL.params({ n: SQL.count() })
		const firstN = SQL.def('firstN', l, SQL.select({ id: users.id }).from(users).orderBy(users.id).limit(l.n))
		for (const id of ['a', 'b', 'c']) DB.run(ctx, SQL.insert(users).values({ id, name: id }))
		expect(DB.all(ctx, firstN({ n: 2 }))).toEqual([{ id: 'a' }, { id: 'b' }])
	})

	test('a secret parameter takes a Secret and binds its value', () => {
		const s = SQL.params({ id: users.id, pin: SQL.secret(users.pin, z.string()) })
		const setPin = SQL.def('setPin', s, SQL.update(users).set({ pin: s.pin }).where(eq(users.id, s.id)))
		DB.run(ctx, SQL.insert(users).values({ id: 'a', name: 'A' }))
		DB.run(ctx, setPin({ id: 'a', pin: new Secret('1234') }))
		expect(driver.prepare('select pin from users').get()).toEqual({ pin: '1234' })
		expect(() => DB.run(ctx, setPin({ id: 'a', pin: '1234' as never }))).toThrow(/takes a Secret/)
	})

	test('an unlogged parameter binds as declared and is listed as unlogged', () => {
		const u = SQL.params({ pin: SQL.unlogged(users.pin), lowerName: SQL.unlogged(SQL.value<string>()) })
		const setPin = SQL.def(
			'setPinByName',
			u,
			SQL.update(users)
				.set({ pin: u.pin })
				.where(eq(sql`lower(${users.name})`, u.lowerName)),
		)
		DB.run(ctx, SQL.insert(users).values({ id: 'a', name: 'A' }))
		const called = setPin({ pin: '1234', lowerName: 'a' })
		expect([...called[Sql.CALLED].unlogged].sort()).toEqual(['lowerName', 'pin'])
		DB.run(ctx, called)
		expect(driver.prepare('select pin from users').get()).toEqual({ pin: '1234' })
		expect(() => SQL.unlogged(SQL.count() as never)).toThrow(/not SQL.count/)
	})

	test('a zod parameter may only check', () => {
		expect(() => SQL.value(z.string().transform((x) => x) as never)).toThrow(/transforms/)
		expect(() => SQL.value(z.object({ a: z.string() }) as never)).toThrow(/strictObject/)
		const t = SQL.params({ id: users.id, name: SQL.column(users.name, z.string().trim()) })
		const trimmed = SQL.def('trimmed', t, SQL.update(users).set({ name: t.name }).where(eq(users.id, t.id)))
		expect(() => DB.run(ctx, trimmed({ id: 'a', name: ' x ' }))).toThrow(/changed the value/)
	})

	test('a definition built from arguments caches each argument list', () => {
		const o = SQL.params({ officeId: users.officeId })
		const inOffice = SQL.def('inOffice', o, (onlyNamed: boolean, order: 'id' | 'name') => {
			let where = eq(users.officeId, o.officeId)
			if (onlyNamed) where = and(where, isNull(users.pin))!
			return SQL.select({ id: users.id })
				.from(users)
				.where(where)
				.orderBy(order === 'id' ? users.id : users.name)
		})
		for (const [id, name] of [
			['a', 'z'],
			['b', 'y'],
		])
			DB.run(ctx, SQL.insert(users).values({ id, name, officeId: 'o' }))
		expect(DB.all(ctx, inOffice(true, 'id')({ officeId: 'o' })).map((x) => x.id)).toEqual(['a', 'b'])
		expect(DB.all(ctx, inOffice(true, 'name')({ officeId: 'o' })).map((x) => x.id)).toEqual(['b', 'a'])
		expect(inOffice(true, 'id')).toBe(inOffice(true, 'id'))
		// an argument that only changes a bound literal is a value
		const bad = SQL.def('bad', o, (name: string) =>
			SQL.select()
				.from(users)
				.where(and(eq(users.officeId, o.officeId), eq(users.name, SQL.lit(name)))),
		)
		bad('x')
		expect(() => bad('y')).toThrow(/differ only in a bound literal/)
	})

	test('the statement check builds every argument list of the domains but the skipped ones', () => {
		const u = SQL.params({ id: users.id, name: users.name, officeId: users.officeId })
		const built: [boolean, boolean][] = []
		SQL.def(
			'partial',
			u,
			(name: boolean, office: boolean) => {
				built.push([name, office])
				return SQL.update(users)
					.set({ ...(name && { name: u.name }), ...(office && { officeId: u.officeId }) })
					.where(eq(users.id, u.id))
			},
			{
				domains: [
					[false, true],
					[false, true],
				],
				skip: (name, office) => !name && !office,
			},
		)
		Sql.registry.get('sql-test:partial')!.enumerate!()
		expect(new Set(built.map((b) => b.join()))).toEqual(new Set(['false,true', 'true,false', 'true,true']))
	})
})

describe('row counts', () => {
	test('a check with an upper bound undoes the write that fails it', () => {
		for (const id of ['a', 'b']) DB.run(ctx, SQL.insert(users).values({ id, name: 'n' }))
		const res = DB.run(ctx, SQL.update(users).set({ name: 'm' }), { changes: 1, otherwise: 'err:too-many' })
		expect(res).toEqual({ code: 'err:too-many', changes: 2 })
		expect(DB.all(ctx, SQL.select({ name: users.name }).from(users)).map((u) => u.name)).toEqual(['n', 'n'])
		expect(DB.run(ctx, rename({ id: 'a', name: 'm' }), { changes: 1, otherwise: 'err:not-found' })).toEqual({ code: 'ok', changes: 1 })
		expect(DB.run(ctx, rename({ id: 'z', name: 'm' }), { changes: 1, otherwise: 'err:not-found' }).code).toBe('err:not-found')
		const inserted = DB.run(ctx, SQL.insert(users).values({ id: 'c', name: 'n' }), { changes: 1, otherwise: 'err:conflict' })
		expect(inserted.code === 'ok' && inserted.lastInsertRowid).toBe(3)
	})
})

describe('transactions', () => {
	const names = () => DB.all(ctx, SQL.select({ id: users.id }).from(users).orderBy(users.id)).map((u) => u.id)
	const insert = (c: C.Db, id: string) => DB.run(c, SQL.insert(users).values({ id, name: id }))

	test('ok and nothing commit, err and a throw roll back', () => {
		DB.transaction(ctx, {}, (tx) => (insert(tx, 'a'), { code: 'ok' }))
		DB.transaction(ctx, {}, (tx) => void insert(tx, 'b'))
		DB.transaction(ctx, {}, (tx) => (insert(tx, 'c'), { code: 'err:no' }))
		expect(() =>
			DB.transaction(ctx, {}, (tx) => {
				insert(tx, 'd')
				throw new Error('boom')
			}),
		).toThrow('boom')
		DB.transaction(ctx, { dryRun: true }, (tx) => (insert(tx, 'e'), { code: 'ok' }))
		expect(names()).toEqual(['a', 'b'])
	})

	test('commitDespiteError commits and is spent by its scope', () => {
		const res = DB.transaction(
			ctx,
			{},
			(tx) => (insert(tx, 'a'), { code: 'err:partial' as const, commitDespiteError: true as const, sent: 1 }),
		)
		expect(res).toEqual({ code: 'err:partial', sent: 1 })
		// an outer scope passing the inner result through rolls back, inner writes included
		DB.transaction(ctx, {}, (tx) =>
			DB.transaction(tx, {}, (inner) => (insert(inner, 'b'), { code: 'err:x' as const, commitDespiteError: true as const })),
		)
		expect(names()).toEqual(['a'])
	})

	test('a nested scope is a savepoint', () => {
		DB.transaction(ctx, {}, (tx) => {
			insert(tx, 'a')
			const inner = DB.transaction(tx, {}, (t2) => (insert(t2, 'b'), { code: 'err:inner' as const }))
			expect(inner.code).toBe('err:inner')
			DB.transaction(tx, {}, (t2) => void insert(t2, 'c'))
			return { code: 'ok' }
		})
		expect(names()).toEqual(['a', 'c'])
	})

	test('afterCommit runs after the outermost commit, and a rolled-back scope drops its tasks', () => {
		const ran: string[] = []
		DB.transaction(ctx, {}, (tx) => {
			tx.tx.afterCommit(() => ran.push('outer'))
			DB.transaction(tx, {}, (t2) => {
				t2.tx.afterCommit(() => ran.push('released'))
			})
			DB.transaction(tx, {}, (t2) => {
				t2.tx.afterCommit(() => ran.push('dropped'))
				return { code: 'err:x' }
			})
			expect(ran).toEqual([])
			return { code: 'ok' }
		})
		expect(ran).toEqual(['outer', 'released'])
		DB.transaction(ctx, {}, (tx) => {
			tx.tx.afterCommit(() => ran.push('rolled back'))
			return { code: 'err:x' }
		})
		expect(ran).toEqual(['outer', 'released'])
	})

	test('an async callback is refused and rolled back', () => {
		// @ts-expect-error an async callback
		expect(() => DB.transaction(ctx, {}, async (tx) => void insert(tx, 'a'))).toThrow(/promise/)
		expect(names()).toEqual([])
	})

	test('a ctx from outside the transaction cannot reach into it, and an ended one cannot run', () => {
		let captured!: C.Db & C.Tx
		expect(() => DB.transaction(ctx, {}, () => void insert(ctx, 'a'))).toThrow(/outside the transaction/)
		DB.transaction(ctx, {}, (tx) => void (captured = tx))
		expect(() => insert(captured, 'b')).toThrow(/has ended/)
		expect(() => captured.tx.afterCommit(() => {})).toThrow(/has ended/)
		expect(names()).toEqual([])
	})

	test('a transaction sqlite ended is marked aborted', () => {
		expect(() =>
			DB.transaction(ctx, {}, (tx) => {
				insert(tx, 'a')
				DB.run(tx, SQL.insert(dup).values({ id: 'x' }))
				try {
					DB.run(tx, SQL.insert(dup).values({ id: 'x' }))
				} catch {
					// caught and carried on, which would otherwise run the rest in autocommit
				}
				insert(tx, 'b')
			}),
		).toThrow(/sqlite ended this transaction/)
		expect(driver.inTransaction).toBe(false)
		expect(names()).toEqual([])
	})
})
