import DatabaseConstructor from 'better-sqlite3'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

import { tsMigrations } from '@/migrations/registry'
import * as CS from '@/models/context-shared.models'
import type * as SE from '@/models/server-events.models'
import * as DB from '@/server/db'
import * as Migrate from '@/server/migrate'

import * as EventWrites from './server-event-writes.server'

const EOS = '0002c621a88ff087ac6f85bc7160501e'

let driver: DatabaseConstructor.Database
let ctx: Parameters<typeof EventWrites.insertEvent>[0]
let nextTime = 1_000

beforeEach(async () => {
	driver = new DatabaseConstructor(':memory:')
	await Migrate.runMigrations(driver, { sqlDir: path.resolve(import.meta.dirname, '../../drizzle-sqlite'), tsMigrations })
	// events reference a match and a server this test has no reason to create
	driver.pragma('foreign_keys = OFF')
	ctx = { ...CS.init(), db: DB.connect(driver), log: { error: () => {}, warn: () => {} } } as unknown as typeof ctx
})

function write(event: Record<string, unknown>) {
	EventWrites.insertEvent(ctx, 'server', { matchId: 1, time: (nextTime += 1_000), ...event } as unknown as SE.NewEvent)
}

// a join log carries the tagless name as both names; a roster poll carries only the username
const joined = (username: string, usernameNoTag = username) =>
	write({ type: 'PLAYER_CONNECTED', player: { ids: { eos: EOS, username, usernameNoTag } } })
const polled = (username: string) => write({ type: 'PLAYER_RECONCILED', player: { ids: { eos: EOS, username } } })
const renamed = (newUsername: string) => write({ type: 'PLAYER_DETAILS_CHANGED', player: EOS, details: {}, newUsername })

const stored = () => driver.prepare(`SELECT username, usernameNoTag FROM players WHERE eosId = ?`).get(EOS)
const history = () =>
	(driver.prepare(`SELECT username FROM playerUsernames WHERE playerId = ? ORDER BY time`).all(EOS) as { username: string }[]).map(
		(r) => r.username,
	)

describe('player name writes', () => {
	test('a join log keeps a stored tagged name that still ends in the tagless one', () => {
		polled('[TT] grey')
		joined('grey')
		expect(stored()).toEqual({ username: '[TT] grey', usernameNoTag: 'grey' })
		expect(history()).toEqual(['[TT] grey'])
	})

	test('a polled tag change keeps the tagless name', () => {
		joined('grey')
		polled('[TT] grey')
		expect(stored()).toEqual({ username: '[TT] grey', usernameNoTag: 'grey' })
	})

	test('a polled rename clears a tagless name the new username does not end in', () => {
		joined('Smelly Pee')
		polled('Bo')
		expect(stored()).toEqual({ username: 'Bo', usernameNoTag: null })
		expect(history()).toEqual(['Smelly Pee', 'Bo'])
	})

	test('renames in the event batch, in event order, and records each name once per change', () => {
		joined('Alpha')
		renamed('Bravo')
		renamed('Charlie')
		// a later event that repeats the current name records nothing
		polled('Charlie')
		renamed('Alpha')
		expect(stored()).toEqual({ username: 'Alpha', usernameNoTag: null })
		expect(history()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Alpha'])
	})
})
