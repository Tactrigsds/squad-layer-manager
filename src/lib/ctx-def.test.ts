import { describe, expect, test } from 'vitest'

import * as CD from '@/lib/ctx-def'
import * as CS from '@/models/context-shared'
import * as USR from '@/models/users.models'

// The value of a def is entirely in the errors it produces, so most of this file is negative cases:
// each @ts-expect-error fails the build if the check it names stops firing.

type Db = CS.Ctx & { db: () => string } & Partial<Tx>
type Tx = CS.Ctx & { tx: { rollback(): void } }

const DbDef = CD.defCtx<Db>()(['db', 'tx'], { name: 'db' })

describe('defCtx key checking', () => {
	test('rejects a key list that misses a property, including an optional one', () => {
		// @ts-expect-error -- 'tx' is optional on Db but still owed
		CD.defCtx<Db>()(['db'])
	})

	test('rejects a key that is not on the type', () => {
		// @ts-expect-error -- 'nope' is not a key of Db
		CD.defCtx<Db>()(['db', 'tx', 'nope'])
	})

	test('rejects a duplicate key', () => {
		// @ts-expect-error -- 'tx' listed twice
		CD.defCtx<Db>()(['db', 'tx', 'tx'])
	})

	test('does not make anyone restate the brand', () => {
		expect(DbDef.keys).toEqual(['db', 'tx'])
	})
})

describe('extends', () => {
	// serverId is inherited rather than re-declared, which is what stops every per-server def from
	// claiming it and turning every merge into a false collision
	const VoteDef = CD.defCtx<CS.Ctx & { vote: number } & CS.ServerId>()(['vote'], {
		name: 'vote',
		extends: [CS.ServerIdDef],
	})

	test('inherited keys count as accounted for, and still land in keys', () => {
		expect(VoteDef.ownKeys).toEqual(['vote'])
		expect(VoteDef.keys).toEqual(['serverId', 'vote'])
	})

	test('two defs inheriting the same key do not collide', () => {
		const OtherDef = CD.defCtx<CS.Ctx & { other: number } & CS.ServerId>()(['other'], { extends: [CS.ServerIdDef] })
		const merged = CD.mergeDefs([VoteDef, OtherDef])
		expect(merged.keys).toEqual(['serverId', 'vote', 'other'])
	})
})

describe('collisions', () => {
	test('a width pun declared on both sides merges', () => {
		const merged = CD.mergeDefs([USR.CtxDef, USR.Ctx.IdDef])
		expect(merged.collisions).toEqual(['user'])
	})

	test('an undeclared collision is a type error', () => {
		const Undeclared = CD.defCtx<CS.Ctx & { user: { discordId: bigint } }>()(['user'])
		// @ts-expect-error -- USR.CtxDef declares `user`, this one does not, so the merge is refused
		CD.mergeDefs([USR.CtxDef, Undeclared])
	})
})

describe('select', () => {
	const project = CD.select([DbDef, CS.LogDef])

	test('copies exactly the declared keys, plus the brand', () => {
		const wide = { ...CS.init(), db: () => 'db', log: {} as CS.Logger, serverId: 'srv', extraneous: true }
		const narrow = project(wide)
		expect(Object.keys(narrow)).toEqual(['db', 'log'])
		expect(CS.isCtx(narrow)).toBe(true)
		expect('extraneous' in narrow).toBe(false)
	})

	test('keeps an optional key that is present but undefined', () => {
		const wide = { ...CS.init(), db: () => 'db', tx: undefined, log: {} as CS.Logger }
		expect('tx' in project(wide)).toBe(true)
	})

	test('a source missing a declared capability is a call-site error', () => {
		// @ts-expect-error -- no `log`
		project({ ...CS.init(), db: () => 'db' })
	})
})
