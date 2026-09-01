import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as CHAT from '@/models/chat.models'

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
		expect(res.rowsHtml.length).toBeGreaterThan(0)
		// server-rendered, and interactivity rides on attributes rather than anything element-attached
		expect(res.rowsHtml[0]).toContain('data-dom-')
	})

	it('finds players by name substring, and a name works as a player ref', async () => {
		// three or more characters, so this goes through the trigram index rather than the LIKE fallback
		const players = await client.history.query({ query: { type: 'players', name: 'archive_subj' } })
		expect(players.code).toBe('ok')
		if (players.code !== 'ok' || players.type !== 'players') return
		expect(players.rows.some((r) => r.username?.includes('archive_subject'))).toBe(true)

		const events = await client.history.query({ query: { player: 'archive_subject' } })
		expect(events.code).toBe('ok')
		if (events.code !== 'ok' || events.type !== 'events') return
		expect(events.total).toBeGreaterThan(0)
	})

	// The layer parts come out of the layer id via L.toLayer, not out of matchHistory's denormalized columns:
	// the id spells them out, so the engine needs no join and no layer engine artifact to filter on them.
	it('filters by the parts of the layer played, on both the matches and the events anchors', async () => {
		const all = await client.history.query({ query: { type: 'matches' } })
		const gorodok = await client.history.query({ query: { type: 'matches', map: 'Gorodok' } })
		expect(all.code).toBe('ok')
		expect(gorodok.code).toBe('ok')
		if (all.code !== 'ok' || all.type !== 'matches') return
		if (gorodok.code !== 'ok' || gorodok.type !== 'matches') return
		expect(gorodok.total).toBeGreaterThan(0)
		expect(gorodok.matches.every((m) => m.layerId.startsWith('GD-'))).toBe(true)

		// negation has to keep the rows a positive filter drops rather than propagating a null through the
		// compare, so the two halves partition the whole
		const notGorodok = await client.history.query({
			query: {
				type: 'matches',
				mode: 'advanced',
				q: {
					type: 'eq',
					neg: true,
					args: [
						{ type: 'column', column: 'layer.map' },
						{ type: 'value', value: 'Gorodok' },
					],
				},
			},
		})
		expect(notGorodok.code).toBe('ok')
		if (notGorodok.code !== 'ok' || notGorodok.type !== 'matches') return
		expect(gorodok.total + notGorodok.total).toBe(all.total)
		expect(notGorodok.matches.every((m) => !m.layerId.startsWith('GD-'))).toBe(true)

		// a faction matches whichever side played it, since the slot a side occupies flips between matches
		const rgf = await client.history.query({ query: { type: 'matches', faction: 'RGF' } })
		expect(rgf.code).toBe('ok')
		if (rgf.code !== 'ok' || rgf.type !== 'matches') return
		expect(rgf.total).toBeGreaterThan(0)

		// The same predicate on the events anchor, which reaches matchHistory through the event's match. The
		// map is read out of the db rather than assumed: which match holds the events depends on where the
		// queue had rolled to by the time the earlier tests ran.
		const db = app.readDb()
		let indexedMap: string
		try {
			const row = db
				.prepare(
					`SELECT m.layerMap AS map FROM playerEventIndex i JOIN matchHistory m ON m.id = i.matchId
					 WHERE m.layerMap IS NOT NULL LIMIT 1`,
				)
				.get() as { map: string } | undefined
			if (!row) throw new Error('no indexed event belongs to a match with resolved layer parts')
			indexedMap = row.map
		} finally {
			db.close()
		}

		const allEvents = await client.history.query({ query: {} })
		const onMap = await client.history.query({ query: { map: indexedMap } })
		expect(onMap.code).toBe('ok')
		if (allEvents.code !== 'ok' || allEvents.type !== 'events') return
		if (onMap.code !== 'ok' || onMap.type !== 'events') return
		expect(onMap.total).toBeGreaterThan(0)

		const offMap = await client.history.query({
			query: {
				mode: 'advanced',
				q: {
					type: 'eq',
					neg: true,
					args: [
						{ type: 'column', column: 'layer.map' },
						{ type: 'value', value: indexedMap },
					],
				},
			},
		})
		expect(offMap.code).toBe('ok')
		if (offMap.code !== 'ok' || offMap.type !== 'events') return
		expect(onMap.total! + offMap.total!).toBe(allEvents.total)
	})

	// The player details window interleaves a player's history with the live match's events and punctuates it
	// by match, so it asks the engine for the events themselves rather than for rendered rows.
	it('returns wire-encoded events, with match boundaries, for callers that interleave them', async () => {
		const res = await client.history.query({ query: { player: 'archive_subject' }, format: 'wire', includeMatchBoundaries: true })
		expect(res.code).toBe('ok')
		if (res.code !== 'ok' || res.type !== 'events') return
		// the html path is what the results feed uses; a wire caller gets events instead of rows, not both
		expect(res.rowsHtml).toEqual([])
		expect(res.events).not.toBeNull()
		const events = CHAT.Wire.decode(res.events!)
		expect(events.length).toBeGreaterThan(0)
		expect(events.some((e) => e.type === 'CHAT_MESSAGE')).toBe(true)
		// no player filter selects a NEW_GAME, so its presence is the boundary option doing its job
		expect(events.some((e) => e.type === 'NEW_GAME')).toBe(true)

		const without = await client.history.query({ query: { player: 'archive_subject' }, format: 'wire' })
		if (without.code !== 'ok' || without.type !== 'events') return
		expect(CHAT.Wire.decode(without.events!).some((e) => e.type === 'NEW_GAME')).toBe(false)
	})

	// Last of all: pruning deletes every archived match on the server, so nothing after this can read one.
	it('a retention rule sieves its events out of a pruned match; everything else is dropped', async () => {
		const saved = await client.history.save({
			name: 'keep archive chat',
			visibility: 'private',
			query: { type: 'events', mode: 'basic', chat: 'archive' },
		})
		expect(saved.code).toBe('ok')
		if (saved.code !== 'ok') return
		const marked = await client.history.setRetain({ id: saved.id, retain: true })
		expect(marked.code).toBe('ok')

		const pruned = await app.control('prune-events', { retention: 1 })
		expect(pruned.code).toBe('ok')
		expect(pruned.matches as number).toBeGreaterThan(0)

		const db = app.readDb()
		let retainedIds: number[]
		try {
			const rows = db.prepare(`SELECT serverEventId FROM retainedEvents`).all() as { serverEventId: number }[]
			retainedIds = rows.map((r) => r.serverEventId)
			expect(retainedIds.length).toBeGreaterThan(0)
			const claims = db.prepare(`SELECT count(*) AS n FROM retainedEventClaims WHERE savedQueryId = ?`).get(saved.id) as { n: number }
			expect(claims.n).toBe(retainedIds.length)
			// the archive blobs are gone, and only the retained events kept their index and chat rows
			const archives = db.prepare(`SELECT count(*) AS n FROM archivedMatches`).get() as { n: number }
			expect(archives.n).toBe(0)
			const strayIndex = db
				.prepare(
					`SELECT count(*) AS n FROM playerEventIndex
					 WHERE matchId IN (SELECT matchId FROM retainedEvents)
					   AND serverEventId NOT IN (SELECT serverEventId FROM retainedEvents)`,
				)
				.get() as { n: number }
			expect(strayIndex.n).toBe(0)
		} finally {
			db.close()
		}

		// the retained events remain queryable end to end: the index finds them, and the bodies are read
		// back from retainedEvents now that the archive rows are gone
		const res = await client.history.query({ query: { chat: 'archive' } })
		expect(res.code).toBe('ok')
		if (res.code !== 'ok' || res.type !== 'events') return
		expect(res.rowsHtml.length).toBeGreaterThan(0)

		// dropping the rule garbage-collects the events it alone kept
		const unmarked = await client.history.setRetain({ id: saved.id, retain: false })
		expect(unmarked.code).toBe('ok')
		const db2 = app.readDb()
		try {
			const kept = db2.prepare(`SELECT count(*) AS n FROM retainedEvents`).get() as { n: number }
			expect(kept.n).toBe(0)
		} finally {
			db2.close()
		}
	})
})
