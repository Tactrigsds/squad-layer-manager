import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { LAYERS } from '../harness/arrange'
import { matchOrdinal } from '../harness/inspect'
import { createOrpcClient, type TestOrpcClient } from '../harness/orpc-client'
import { createRollingFixture, type RollingFixture } from '../harness/rolling'

// What the roster does across the roll window: who is carried over, who is folded in, who is dropped, and
// which of those produce an individual event rather than being absorbed into the wholesale RESET. See
// test/harness/rolling.ts for how the window works and why RCON is taken offline around the mid-roll cases.

let app: RollingFixture
let client: TestOrpcClient

beforeAll(async () => {
	app = await createRollingFixture()
	client = await createOrpcClient(app)
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('server rolling: the roster across the roll', () => {
	it('a plain roll advances match history, tags the boundary, and carries the existing roster over untouched', async () => {
		const steady = app.emu.world.connectPlayer(makePlayer({ name: ' steady_player', teamId: 1 }))
		await app.waitForRosterSync()
		const oldMatch = app.latestMatch()

		// the fixture starts the server on the queue's steady state (its next layer is the queue head), so
		// rolling with no override lands on the seeded gorodokRaas without any tug-of-war over the next layer
		app.roll()
		await app.waitForRosterSync()

		const newMatch = await app.waitForNewMatch(oldMatch.id)
		expect(newMatch.layerId).toBe(LAYERS.gorodokRaas)

		await app.waitFor(() => app.inResetRoster(newMatch.id, steady.eos) || undefined, {
			label: 'the pre-existing player carried into the new match roster',
		})
	})

	it('a player who connects during the map-load window is folded into the post-roll roster, with no separate mid-roll connect event', async () => {
		const oldMatch = app.latestMatch()
		const lateJoiner = await app.withRconOffline(() => {
			app.roll()
			// lands in the log right behind the destination Bringing World line
			return app.emu.world.connectPlayer(makePlayer({ name: ' load_screen_joiner', teamId: 1 }))
		})
		await app.waitForRosterSync()

		const newMatch = await app.waitForNewMatch(oldMatch.id)
		await app.waitFor(() => app.inResetRoster(newMatch.id, lateJoiner.eos) || undefined, {
			label: 'the late joiner appearing in the post-roll roster reset',
		})
		expect(app.countEventsFor('PLAYER_CONNECTED', lateJoiner.eos)).toBe(0)
	})

	it('a player who disconnects during the map-load window leaves cleanly, with no stray disconnect event, and is absent from the new roster', async () => {
		const leaver = app.emu.world.connectPlayer(makePlayer({ name: ' load_screen_leaver', teamId: 2 }))
		await app.waitForRosterSync()
		const oldMatch = app.latestMatch()

		await app.withRconOffline(() => {
			app.roll()
			app.emu.world.disconnectPlayer(leaver)
		})
		await app.waitForRosterSync()

		const newMatch = await app.waitForNewMatch(oldMatch.id)
		expect(app.inResetRoster(newMatch.id, leaver.eos)).toBe(false)
		expect(app.countEventsFor('PLAYER_DISCONNECTED', leaver.eos, newMatch.id)).toBe(0)
	})
})

// Last, and deliberately so: compaction deletes the event rows of every finished match on this server, which
// the roster assertions above read. Nothing after it may depend on those rows.
describe('the event archive', () => {
	function hotEventCount(matchId: number): number {
		const db = app.readDb()
		try {
			return (db.prepare(`SELECT count(*) AS n FROM serverEvents WHERE matchId = ?`).get(matchId) as { n: number }).n
		} finally {
			db.close()
		}
	}

	function archiveRow(matchId: number): { eventCount: number; bytes: number } | undefined {
		const db = app.readDb()
		try {
			return db.prepare(`SELECT eventCount, length(events) AS bytes FROM archivedMatches WHERE matchId = ?`).get(matchId) as
				| { eventCount: number; bytes: number }
				| undefined
		} finally {
			db.close()
		}
	}

	// Every read path is written on the assumption that it cannot tell a compacted match from a hot one, so
	// that is what is asserted: the same match, read the same way, either side of a compaction pass.
	it('a compacted match reads back exactly as it did before, and its hot rows are gone', async () => {
		const talker = app.emu.world.connectPlayer(makePlayer({ name: ' archive_subject', teamId: 1 }))
		await app.waitForRosterSync()
		const played = app.latestMatch()
		app.emu.world.chat(talker, 'ChatAll', 'archive me please')
		await app.waitForRosterSync()

		// roll, so the match under test is finished and no longer the newest on the server
		app.roll()
		await app.waitForRosterSync()
		await app.waitForNewMatch(played.id)

		const ordinal = matchOrdinal(app, played.id)
		const before = await client.matchHistory.getMatchEvents({ serverId: app.serverId, ordinal })
		if (!('events' in before)) throw new Error(`expected the match feed, got ${JSON.stringify(before)}`)
		expect(before.events.length).toBeGreaterThan(0)

		const hotBefore = hotEventCount(played.id)
		expect(hotBefore).toBeGreaterThan(0)

		const res = await app.control('compact-events')
		expect(res.code).toBe('ok')
		expect(res.matches).toBeGreaterThan(0)

		const archived = archiveRow(played.id)
		if (!archived) throw new Error('the finished match was not compacted')
		expect(hotEventCount(played.id)).toBe(0)
		expect(archived.eventCount).toBe(hotBefore)
		// the whole point of packing them: a match costs a fraction of what its rows did
		expect(archived.bytes).toBeLessThan(hotBefore * 100)

		const after = await client.matchHistory.getMatchEvents({ serverId: app.serverId, ordinal })
		expect(after).toEqual(before)
	})

	// The layer parts are what a layer-filtered search over history reads; the migration cannot fill them in
	// (the engine is not loaded there), so this pass is what makes the whole layer dimension non-empty.
	it('resolves the layer parts of recorded matches, so a layer-filtered search can see them', async () => {
		const res = await app.control('reconcile-layers')
		expect(res.code).toBe('ok')

		const db = app.readDb()
		try {
			const row = db.prepare(`SELECT count(*) AS n FROM matchHistory WHERE layerMap IS NOT NULL`).get() as { n: number }
			expect(row.n).toBeGreaterThan(0)
			const parts = db.prepare(`SELECT layerMap, layerGamemode FROM matchHistory WHERE layerId = ? LIMIT 1`).get(LAYERS.gorodokRaas) as
				| { layerMap: string; layerGamemode: string }
				| undefined
			expect(parts?.layerMap).toBe('Gorodok')
			expect(parts?.layerGamemode).toBe('RAAS')
		} finally {
			db.close()
		}
	})

	// combat detail is projected out of the payload at insert time, because after compaction the payload is a
	// blob and no SQL -- dashboard or otherwise -- can reach into it
	it('projects the damage source and variant, interned, so combat survives compaction as queryable columns', async () => {
		const attacker = app.emu.world.connectPlayer(makePlayer({ name: ' shooter', teamId: 1 }))
		const victim = app.emu.world.connectPlayer(makePlayer({ name: ' target', teamId: 2 }))
		await app.waitForRosterSync()
		app.emu.world.killPlayer(victim, attacker, 'BP_M4_M68')

		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db
						.prepare(`SELECT count(*) AS n FROM playerEventIndex WHERE type = 'PLAYER_DIED' AND damageSourceId IS NOT NULL`)
						.get() as { n: number }
					return row.n > 0 || undefined
				} finally {
					db.close()
				}
			},
			{ label: 'the kill reaching the player event index with an interned damage source' },
		)

		const db = app.readDb()
		try {
			const rows = db
				.prepare(
					`SELECT ds.name AS source, pei.variant, count(*) AS n
					 FROM playerEventIndex pei JOIN damageSources ds ON ds.id = pei.damageSourceId
					 WHERE pei.type IN ('PLAYER_DIED', 'PLAYER_WOUNDED') GROUP BY ds.name, pei.variant`,
				)
				.all() as { source: string; variant: string; n: number }[]
			expect(rows.length).toBeGreaterThan(0)
			for (const row of rows) {
				expect(row.source).toBeTruthy()
				expect(['normal', 'suicide', 'teamkill']).toContain(row.variant)
			}
			// interned, not repeated inline: one row per distinct name however many events used it
			const names = db.prepare(`SELECT count(*) AS n, count(DISTINCT name) AS d FROM damageSources`).get() as { n: number; d: number }
			expect(names.n).toBe(names.d)
		} finally {
			db.close()
		}
	})

	it('keeps chat text searchable after the events it came from have been packed away', async () => {
		const res = await client.history.query({ query: { chat: 'archive' } })
		expect(res.code).toBe('ok')
		if (res.code !== 'ok' || res.type !== 'events') return
		expect(res.events.events.length).toBeGreaterThan(0)
	})
})
