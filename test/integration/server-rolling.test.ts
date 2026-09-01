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
		expect(CHAT.Wire.decode(before.events).length).toBeGreaterThan(0)

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

	// App events are SLM's own actions, indexed in appEvents plus its association sidecar rather than in
	// playerEventIndex, and merged into the same result page. The two families overlap on a handful of type
	// names, and a search for one deliberately gets both.
	it('returns app events alongside server events, and filters them by the same vocabulary', async () => {
		const db = app.readDb()
		let indexed: { total: number; type: string }
		try {
			// the backfill is what fills feedVisible, so a null here means it never ran
			const unbackfilled = db.prepare(`SELECT count(*) AS n FROM appEvents WHERE feedVisible IS NULL`).get() as { n: number }
			expect(unbackfilled.n).toBe(0)
			const row = db
				.prepare(
					`SELECT count(*) AS total, type FROM appEvents
					 WHERE feedVisible = 1 AND serverId IS NOT NULL AND matchId IS NOT NULL
					 GROUP BY type ORDER BY total DESC LIMIT 1`,
				)
				.get() as { total: number; type: string } | undefined
			if (!row) throw new Error('no feed-visible app event was recorded')
			indexed = row
		} finally {
			db.close()
		}

		const byType = await client.history.query({ query: { type: 'events', types: [indexed.type as never] } })
		expect(byType.code).toBe('ok')
		if (byType.code !== 'ok' || byType.type !== 'events') return
		expect(byType.total).toBeGreaterThan(0)
		expect(byType.rowsHtml.length).toBeGreaterThan(0)

		// a server-event-only dimension excludes them rather than erroring: an app event has no kill variant
		const withVariant = await client.history.query({
			query: {
				mode: 'advanced',
				q: {
					type: 'and',
					children: [
						{
							type: 'eq',
							neg: false,
							args: [
								{ type: 'column', column: 'event.type' },
								{ type: 'value', value: indexed.type },
							],
						},
						{
							type: 'eq',
							neg: false,
							args: [
								{ type: 'column', column: 'event.variant' },
								{ type: 'value', value: 'teamkill' },
							],
						},
					],
				},
			},
		})
		expect(withVariant.code).toBe('ok')
		if (withVariant.code !== 'ok' || withVariant.type !== 'events') return
		expect(withVariant.total).toBe(0)
	})

	// The `user` dimension: the SLM user an app event is attributable to, indexed in the same generic sidecar
	// as the player dimension. Nothing else covers it, and the rows only exist because migration 0110 clears
	// feedVisible to make the backfill replay the extractors over rows that predate them.
	it('searches app events by the SLM user they are attributable to', async () => {
		// an app event with an slm-user actor: everything the emulator drives on its own is system-actored, so
		// the dimension has nothing to index until a signed-in user does something
		const toggled = await client.squadServer.toggleFogOfWar({ serverId: app.serverId, disabled: true })
		expect(toggled.code).toBe('ok')

		const db = app.readDb()
		let subject: { value: string; total: number }
		try {
			const row = db
				.prepare(
					`SELECT value, count(*) AS total FROM appEventAssociations
					 WHERE dimension = 'user' GROUP BY value ORDER BY total DESC LIMIT 1`,
				)
				.get() as { value: string; total: number } | undefined
			if (!row) throw new Error('the backfill recorded no user associations')
			subject = row
		} finally {
			db.close()
		}

		const byUser = await client.history.query({ query: { type: 'events', users: [subject.value] } })
		expect(byUser.code).toBe('ok')
		if (byUser.code !== 'ok' || byUser.type !== 'events') return
		expect(byUser.total).toBeGreaterThan(0)

		// a user nobody is: the dimension filters rather than being ignored
		const nobody = await client.history.query({ query: { type: 'events', users: ['00000000000000000'] } })
		expect(nobody.code).toBe('ok')
		if (nobody.code !== 'ok' || nobody.type !== 'events') return
		expect(nobody.total).toBe(0)

		// every result type compiles it, matches included, where it reads as "matches containing such an event"
		for (const type of ['matches', 'players'] as const) {
			const res = await client.history.query({ query: { type, users: [subject.value] } })
			expect(res.code, `${type} filtered by user`).toBe('ok')
		}
	})

	// The user field lists the whole table and filters it client-side, so what the server owes it is a name
	// per user. Names also work as query values, which is the only cover for resolveNamedUserIds.
	it('lists users with names, and accepts a name as a user ref', async () => {
		const db = app.readDb()
		let name: string
		try {
			const row = db
				.prepare(
					`SELECT coalesce(u.nickname, d.username) AS name FROM users u JOIN discordAccounts d ON d.discordId = u.discordId LIMIT 1`,
				)
				.get() as { name: string } | undefined
			if (!row) throw new Error('no user to list')
			name = row.name
		} finally {
			db.close()
		}

		const listed = await client.history.listUsers()
		expect(listed.code).toBe('ok')
		if (listed.code !== 'ok') return
		expect(listed.users.some((u) => u.name === name)).toBe(true)

		// a ref that is not a discord id resolves as a name substring, so the combo-box's typed needle runs
		const byName = await client.history.query({ query: { type: 'events', users: [name] } })
		expect(byName.code).toBe('ok')

		const nobody = await client.history.query({ query: { type: 'events', users: ['zzz-no-such-user-zzz'] } })
		if (nobody.code !== 'ok' || nobody.type !== 'events') throw new Error('expected an events page')
		expect(nobody.total).toBe(0)
	})

	// A match-layer node is rewritten to a match-ids node before it reaches the engine (see history-resolve),
	// and every compiler has to know that kind. Nothing else covers the advanced editor's layer node.
	it('runs an advanced query whose layer node resolved to match ids', async () => {
		// an empty `and` matches every layer, so what is under test is the node kind rather than the filter
		const layerNode = { type: 'match-layer' as const, neg: false, filter: { type: 'and' as const, children: [] } }
		for (const type of ['events', 'matches', 'players'] as const) {
			const res = await client.history.query({ query: { type, mode: 'advanced', q: layerNode } })
			expect(res.code, `${type} with a layer node`).toBe('ok')
		}
	})

	// match.ticketDiff is computed rather than stored, and it compiles differently for each of the three
	// result types (a correlated subquery for the two event families, the bare expression for matches).
	it('filters by ticket difference, and reads the same bound from every result type', async () => {
		const db = app.readDb()
		let diffs: number[]
		try {
			const rows = db
				.prepare(
					`SELECT abs(team1Tickets - team2Tickets) AS d FROM matchHistory WHERE team1Tickets IS NOT NULL AND team2Tickets IS NOT NULL`,
				)
				.all() as { d: number }[]
			diffs = rows.map((r) => r.d)
		} finally {
			db.close()
		}
		if (diffs.length === 0) throw new Error('no finished match recorded a ticket count')
		const max = Math.max(...diffs)

		// a bound at the largest recorded difference keeps every match; one above it keeps none
		const kept = await client.history.query({ query: { type: 'matches', ticketDiffMax: max } })
		expect(kept.code).toBe('ok')
		if (kept.code !== 'ok' || kept.type !== 'matches') return
		expect(kept.total).toBe(diffs.length)

		const none = await client.history.query({ query: { type: 'matches', ticketDiffMin: max + 1 } })
		expect(none.code).toBe('ok')
		if (none.code !== 'ok' || none.type !== 'matches') return
		expect(none.total).toBe(0)

		// the events and players compilers reach the same column through matchId, so they must at least run
		for (const type of ['events', 'players'] as const) {
			const res = await client.history.query({ query: { type, ticketDiffMin: 0, ticketDiffMax: max } })
			expect(res.code, `${type} with a ticket bound`).toBe('ok')
		}
	})

	// the player field accepts a name, so the picker's list has to resolve to the same ids the filter does
	it('searches players by name substring', async () => {
		const res = await client.history.searchPlayers({ needle: 'archive_subject'.slice(0, 8) })
		expect(res.code).toBe('ok')
		if (res.code !== 'ok') return
		expect(res.players.some((p) => p.username?.includes('archive_subject'))).toBe(true)
	})
})
