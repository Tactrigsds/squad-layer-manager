import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { cmd } from '../harness/arrange'
import { createRollingFixture, ROLL_ADMIN_STEAM_ID, type RollingFixture } from '../harness/rolling'

// Which match an event across the roll belongs to, and whether it is read as something a player did or as
// part of the roll itself. See test/harness/rolling.ts for how the roll window works, and
// server-rolling.test.ts for what the roster does across it.

let app: RollingFixture

beforeAll(async () => {
	app = await createRollingFixture()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('server rolling: what an event across the roll is attributed to', () => {
	it('an organic team change just before the roll is attributed to the outgoing match, and does not disturb the roll that follows', async () => {
		const flipper = app.emu.world.connectPlayer(makePlayer({ name: ' pre_roll_flipper', teamId: 1 }))
		await app.waitForRosterSync()
		const oldMatch = app.latestMatch()

		// the player switches teams themselves in the last moments of the match, well before any roll begins
		flipper.teamId = flipper.teamId === 1 ? 2 : 1
		await app.waitForRosterSync()
		await app.waitFor(() => app.latestTeamChangeIsOrganic(oldMatch.id, flipper.eos) === true || undefined, {
			label: 'an unattributed (organic) team change recorded against the outgoing match',
		})

		app.roll()
		await app.waitForRosterSync()
		await app.waitForNewMatch(oldMatch.id)
	})

	it('after the roll settles, an organic team change is attributed to the new match and is distinct from the automatic side-swap the roll performs on everyone', async () => {
		const stayer = app.emu.world.connectPlayer(makePlayer({ name: ' post_roll_flipper', teamId: 1 }))
		await app.waitForRosterSync()
		const oldMatch = app.latestMatch()

		// Deliberately rolled with RCON up. A ListPlayers response can be in flight across the (instantaneous) roll,
		// so it still reflects the pre-roll roster yet is received just after the destination NEW_GAME. The pipeline
		// orders that poll by when its request was ISSUED (polledAt), not received, so the stale snapshot is treated
		// as pre-boundary and can't complete the roll -- which is what keeps the automatic side-swap from surfacing as
		// an organic team change here. See TeamsRes.polledAt and the pending-events roll gates.
		app.roll()
		await app.waitForRosterSync()
		const newMatch = await app.waitForNewMatch(oldMatch.id)

		// every connected player's side flips as part of the roll (World.swapTeamsOnRoll), but that's folded
		// into the wholesale RESET -- it must never surface as an individual team-change event for anyone
		expect(app.countEventsFor('PLAYER_CHANGED_TEAM', stayer.eos, newMatch.id)).toBe(0)

		// well after the roll has settled -- analogous to the real ~3-5s post-Bringing-World lockout having
		// elapsed -- the player organically switches teams themselves
		stayer.teamId = stayer.teamId === 1 ? 2 : 1
		await app.waitForRosterSync()

		await app.waitFor(() => app.latestTeamChangeIsOrganic(newMatch.id, stayer.eos) === true || undefined, {
			label: 'the post-settle organic swap attributed to the new match',
		})
	})

	it('a queued swapnext survives connects and disconnects happening during the same roll it is waiting on', async () => {
		const admin = makePlayer({ name: ' roll_swap_admin', steam: ROLL_ADMIN_STEAM_ID, teamId: 1 })
		const target = app.emu.world.connectPlayer(makePlayer({ name: ' roll_swap_target', teamId: 2 }))
		const noiseLeaver = app.emu.world.connectPlayer(makePlayer({ name: ' roll_noise_leaver', teamId: 1 }))
		app.emu.world.connectPlayer(admin)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnext roll_swap_target'))
		await app.waitFor(() => app.emu.rcon.commandLog.some((c) => c.body.startsWith('AdminWarn') && c.body.includes(admin.eos)), {
			label: 'acknowledgement to the admin',
			timeoutMs: 20_000,
		})
		expect(target.teamId).toBe(2)

		// noise during the same roll the swap is waiting on. Unlike the mid-roll connect/disconnect tests in
		// server-rolling.test.ts, RCON is deliberately left up here: execute-teamswaps itself depends on RCON
		// (it fetches current teams to decide who to force), so taking it offline would fail the swap for an
		// unrelated reason rather than exercise what this test is actually after.
		app.roll()
		app.emu.world.disconnectPlayer(noiseLeaver)
		app.emu.world.connectPlayer(makePlayer({ name: ' roll_noise_joiner' }))
		await app.waitForRosterSync()

		// the roll flips every connected player's side, so the target only ends up back on team 2 (what
		// they were asked to swap to) because the held swap was applied against the post-roll roster
		await app.waitFor(() => app.emu.rcon.commandLog.filter((c) => c.body === `AdminForceTeamChange ${target.eos}`).length > 0, {
			label: 'the held swap applied after the roll',
			timeoutMs: 30_000,
		})
		expect(target.teamId).toBe(2)
	})
})
