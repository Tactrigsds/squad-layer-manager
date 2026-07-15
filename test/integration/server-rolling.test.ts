import { makePlayer } from '@/emulator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// The map roll is the trickiest window in the event pipeline: the app enters `syncState: 'rolling'` on the
// TransitionMap log, commits the destination NEW_GAME once it arrives, then waits for the first roster poll
// timestamped after that to produce the boundary-completing RESET (see pending-events.models.ts). Anything
// that happens to a player in between -- connecting, disconnecting, changing team on their own -- is folded
// into that one wholesale roster snapshot rather than reported as an individual event, by design.
//
// On the real game server, players are also blocked from self-serve team changes for a few seconds after the
// destination "Bringing World" line, so an organic team change can only be genuine either shortly before a
// roll starts or once the new match has been running a while -- never in the instant right after. The
// scenarios below respect that: we never simulate a self-swap landing in the very first post-roll poll,
// since that can't happen on a real server (the automatic side-swap every player gets as part of the roll
// itself is a different thing, and is asserted on separately).
//
// RCON is taken offline (`emu.rcon.goOffline`/`goOnline`) around the mid-roll scenarios specifically to make
// them deterministic: with no ListPlayers poll able to land until we bring it back, everything that happens
// while it's down is guaranteed to still be mid-roll from the app's point of view. Log-line ingestion (which
// is how the roll itself and connects/disconnects are seen) doesn't depend on RCON at all.

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
		admins: ['76561198000000009'],
		adminSteamIds: ['76561198000000009'],
	})
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

// Rolls to whatever the app has already set as the emulator's next layer (via its own AdminSetNextLayer,
// driven by its queue). Deliberately doesn't override the layer directly: doing so fights the app's own
// idea of what the next layer should be -- it keeps re-asserting its queue head over RCON every poll to
// correct the "external" change, which is realistic server behavior but not what these tests are after.
function roll() {
	app.emu.world.endMatch()
	app.emu.world.startNewGame()
}

// Runs `fn` with RCON genuinely down, so no ListPlayers poll can complete until it comes back -- whatever
// `fn` does (roll, connect, disconnect) is guaranteed to still be mid-roll from the app's point of view when
// it resolves. The settle delay after goOffline mirrors cycleRcon's default downMs: without it the app may
// not have noticed the drop yet, which is what made an earlier version of this flaky.
async function withRconOffline<T>(fn: () => T): Promise<T> {
	const port = app.emu.rconPort
	await app.emu.rcon.goOffline()
	await new Promise((resolve) => setTimeout(resolve, 500))
	try {
		return fn()
	} finally {
		await app.emu.rcon.goOnline(port)
	}
}

function latestMatch(): { id: number; layerId: string } {
	const db = app.readDb()
	try {
		return db.prepare(`SELECT id, layerId FROM matchHistory ORDER BY id DESC LIMIT 1`).get() as { id: number; layerId: string }
	} finally {
		db.close()
	}
}

// match creation is purely log-driven (onNewGameDuringRoll), so it can lag slightly behind
// waitForRosterSync's RCON-based notion of "settled" -- poll rather than read once
async function waitForNewMatch(oldMatchId: number): Promise<{ id: number; layerId: string }> {
	return app.waitFor(
		() => {
			const match = latestMatch()
			return match.id > oldMatchId ? match : undefined
		},
		{ label: 'the roll producing a new match history row' },
	)
}

// a RESET's roster is recorded via playerEventAssociations (assocType 'game-participant'), so "was this
// player in the roster this RESET carried" is just a join, no need to touch the superjson-encoded payload
function inResetRoster(matchId: number, eos: string): boolean {
	const db = app.readDb()
	try {
		const row = db
			.prepare(
				`SELECT se.id FROM serverEvents se
				 JOIN playerEventAssociations pea ON pea.serverEventId = se.id
				 WHERE se.type = 'RESET' AND se.matchId = ? AND pea.playerId = ?`,
			)
			.get(matchId, eos)
		return !!row
	} finally {
		db.close()
	}
}

function countEventsFor(type: string, eos: string, matchId?: number): number {
	const db = app.readDb()
	try {
		const row = db
			.prepare(
				`SELECT count(*) as n FROM serverEvents se
				 JOIN playerEventAssociations pea ON pea.serverEventId = se.id
				 WHERE se.type = ? AND pea.playerId = ?${matchId !== undefined ? ' AND se.matchId = ?' : ''}`,
			)
			.get(...(matchId !== undefined ? [type, eos, matchId] : [type, eos])) as { n: number }
		return row.n
	} finally {
		db.close()
	}
}

// appEventId is only populated when the event's source links back to an app event (an admin/system action);
// an organic change inferred purely from team polling never carries one. See buildEventRows in
// squad-server.server.ts.
function latestTeamChangeIsOrganic(matchId: number, eos: string): boolean | undefined {
	const db = app.readDb()
	try {
		const row = db
			.prepare(
				`SELECT se.appEventId as appEventId FROM serverEvents se
				 JOIN playerEventAssociations pea ON pea.serverEventId = se.id
				 WHERE se.type = 'PLAYER_CHANGED_TEAM' AND se.matchId = ? AND pea.playerId = ?
				 ORDER BY se.id DESC LIMIT 1`,
			)
			.get(matchId, eos) as { appEventId: string | null } | undefined
		return row === undefined ? undefined : row.appEventId === null
	} finally {
		db.close()
	}
}

describe('server rolling', () => {
	it('a plain roll advances match history, tags the boundary, and carries the existing roster over untouched', async () => {
		const steady = app.emu.world.connectPlayer(makePlayer({ name: ' steady_player', teamId: 1 }))
		await app.waitForRosterSync()
		const oldMatch = latestMatch()

		// the fixture starts the server on the queue's steady state (its next layer is the queue head), so
		// rolling with no override lands on the seeded gorodokRaas without any tug-of-war over the next layer
		roll()
		await app.waitForRosterSync()

		const newMatch = await waitForNewMatch(oldMatch.id)
		expect(newMatch.layerId).toBe(LAYERS.gorodokRaas)

		await app.waitFor(() => inResetRoster(newMatch.id, steady.eos) || undefined, {
			label: 'the pre-existing player carried into the new match roster',
		})
	})

	it('a player who connects during the map-load window is folded into the post-roll roster, with no separate mid-roll connect event', async () => {
		const oldMatch = latestMatch()
		const lateJoiner = await withRconOffline(() => {
			roll()
			// lands in the log right behind the destination Bringing World line
			return app.emu.world.connectPlayer(makePlayer({ name: ' load_screen_joiner', teamId: 1 }))
		})
		await app.waitForRosterSync()

		const newMatch = await waitForNewMatch(oldMatch.id)
		await app.waitFor(() => inResetRoster(newMatch.id, lateJoiner.eos) || undefined, {
			label: 'the late joiner appearing in the post-roll roster reset',
		})
		expect(countEventsFor('PLAYER_CONNECTED', lateJoiner.eos)).toBe(0)
	})

	it('a player who disconnects during the map-load window leaves cleanly, with no stray disconnect event, and is absent from the new roster', async () => {
		const leaver = app.emu.world.connectPlayer(makePlayer({ name: ' load_screen_leaver', teamId: 2 }))
		await app.waitForRosterSync()
		const oldMatch = latestMatch()

		await withRconOffline(() => {
			roll()
			app.emu.world.disconnectPlayer(leaver)
		})
		await app.waitForRosterSync()

		const newMatch = await waitForNewMatch(oldMatch.id)
		expect(inResetRoster(newMatch.id, leaver.eos)).toBe(false)
		expect(countEventsFor('PLAYER_DISCONNECTED', leaver.eos, newMatch.id)).toBe(0)
	})

	it('an organic team change just before the roll is attributed to the outgoing match, and does not disturb the roll that follows', async () => {
		const flipper = app.emu.world.connectPlayer(makePlayer({ name: ' pre_roll_flipper', teamId: 1 }))
		await app.waitForRosterSync()
		const oldMatch = latestMatch()

		// the player switches teams themselves in the last moments of the match, well before any roll begins
		flipper.teamId = flipper.teamId === 1 ? 2 : 1
		await app.waitForRosterSync()
		await app.waitFor(() => latestTeamChangeIsOrganic(oldMatch.id, flipper.eos) === true || undefined, {
			label: 'an unattributed (organic) team change recorded against the outgoing match',
		})

		roll()
		await app.waitForRosterSync()
		await waitForNewMatch(oldMatch.id)
	})

	it('after the roll settles, an organic team change is attributed to the new match and is distinct from the automatic side-swap the roll performs on everyone', async () => {
		const stayer = app.emu.world.connectPlayer(makePlayer({ name: ' post_roll_flipper', teamId: 1 }))
		await app.waitForRosterSync()
		const oldMatch = latestMatch()

		await withRconOffline(() => roll())
		await app.waitForRosterSync()
		const newMatch = await waitForNewMatch(oldMatch.id)

		// every connected player's side flips as part of the roll (World.swapTeamsOnRoll), but that's folded
		// into the wholesale RESET -- it must never surface as an individual team-change event for anyone
		expect(countEventsFor('PLAYER_CHANGED_TEAM', stayer.eos, newMatch.id)).toBe(0)

		// well after the roll has settled -- analogous to the real ~3-5s post-Bringing-World lockout having
		// elapsed -- the player organically switches teams themselves
		stayer.teamId = stayer.teamId === 1 ? 2 : 1
		await app.waitForRosterSync()

		await app.waitFor(() => latestTeamChangeIsOrganic(newMatch.id, stayer.eos) === true || undefined, {
			label: 'the post-settle organic swap attributed to the new match',
		})
	})

	it('a queued !swapnext survives connects and disconnects happening during the same roll it is waiting on', async () => {
		const admin = makePlayer({ name: ' roll_swap_admin', steam: '76561198000000009', teamId: 1 })
		const target = app.emu.world.connectPlayer(makePlayer({ name: ' roll_swap_target', teamId: 2 }))
		const noiseLeaver = app.emu.world.connectPlayer(makePlayer({ name: ' roll_noise_leaver', teamId: 1 }))
		app.emu.world.connectPlayer(admin)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', '!swapnext roll_swap_target')
		await app.waitFor(
			() => app.emu.rcon.commandLog.some((c) => c.body.startsWith('AdminWarn') && c.body.includes(admin.eos)),
			{ label: 'acknowledgement to the admin', timeoutMs: 20_000 },
		)
		expect(target.teamId).toBe(2)

		// noise during the same roll the swap is waiting on. Unlike the mid-roll connect/disconnect tests
		// above, RCON is deliberately left up here: execute-teamswaps itself depends on RCON (it fetches
		// current teams to decide who to force), so taking it offline would fail the swap for an unrelated
		// reason rather than exercise what this test is actually after.
		roll()
		app.emu.world.disconnectPlayer(noiseLeaver)
		app.emu.world.connectPlayer(makePlayer({ name: ' roll_noise_joiner' }))
		await app.waitForRosterSync()

		// the roll flips every connected player's side, so the target only ends up back on team 2 (what
		// they were asked to swap to) because the held swap was applied against the post-roll roster
		await app.waitFor(
			() => app.emu.rcon.commandLog.filter((c) => c.body === `AdminForceTeamChange ${target.eos}`).length > 0,
			{ label: 'the held swap applied after the roll', timeoutMs: 30_000 },
		)
		expect(target.teamId).toBe(2)
	})
})
