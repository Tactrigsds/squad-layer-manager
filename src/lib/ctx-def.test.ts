import { describe, expect, test } from 'vitest'

import * as CD from '@/lib/ctx-def'
import * as GCtx from '@/lib/generic-ctx'

// The value of a def is entirely in the errors it produces, so most of this file is negative cases:
// each @ts-expect-error fails the build if the check it names stops firing.

// stand-ins for CS.ServerId and the two defs of `user` in users.models, one full and one id-only
type ServerId = GCtx.Ctx & { serverId: string }
const ServerIdDef = CD.defCtx<ServerId>()(['serverId'], { name: 'serverId' })
type User = GCtx.Ctx & { user: { discordId: bigint; username: string } }
const UserDef = CD.defCtx<User>()(['user'], { name: 'user', collisions: ['user'] })
type UserId = GCtx.Ctx & { user: { discordId: bigint } }
const UserIdDef = CD.defCtx<UserId>()(['user'], { name: 'userId', collisions: ['user'] })

type Db = GCtx.Ctx & { db: () => string } & Partial<Tx>
type Tx = GCtx.Ctx & { tx: { rollback(): void } }

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
	const VoteDef = CD.defCtx<GCtx.Ctx & { vote: number } & ServerId>()(['vote'], {
		name: 'vote',
		extends: [ServerIdDef],
	})

	test('inherited keys count as accounted for, and still land in keys', () => {
		expect(VoteDef.ownKeys).toEqual(['vote'])
		expect(VoteDef.keys).toEqual(['serverId', 'vote'])
	})

	test('two defs inheriting the same key do not collide', () => {
		const OtherDef = CD.defCtx<GCtx.Ctx & { other: number } & ServerId>()(['other'], { extends: [ServerIdDef] })
		const merged = CD.mergeDefs([VoteDef, OtherDef])
		expect(merged.keys).toEqual(['serverId', 'vote', 'other'])
	})
})

describe('collisions', () => {
	test('a width pun declared on both sides merges', () => {
		const merged = CD.mergeDefs([UserDef, UserIdDef])
		expect(merged.collisions).toEqual(['user'])
	})

	test('an undeclared collision is a type error', () => {
		const Undeclared = CD.defCtx<GCtx.Ctx & { user: { discordId: bigint } }>()(['user'])
		// @ts-expect-error -- UserDef declares `user`, this one does not, so the merge is refused
		CD.mergeDefs([UserDef, Undeclared])
	})
})

describe('select', () => {
	const project = CD.select([DbDef, GCtx.LogDef])

	test('copies exactly the declared keys, plus the brand', () => {
		const wide = { ...GCtx.init(), db: () => 'db', log: {} as GCtx.Logger, serverId: 'srv', extraneous: true }
		const narrow = project(wide)
		expect(Object.keys(narrow)).toEqual(['db', 'log'])
		expect(GCtx.isCtx(narrow)).toBe(true)
		expect('extraneous' in narrow).toBe(false)
	})

	test('keeps an optional key that is present but undefined', () => {
		const wide = { ...GCtx.init(), db: () => 'db', tx: undefined, log: {} as GCtx.Logger }
		expect('tx' in project(wide)).toBe(true)
	})

	test('a source missing a declared capability is a call-site error', () => {
		// @ts-expect-error -- no `log`
		project({ ...GCtx.init(), db: () => 'db' })
	})
})
