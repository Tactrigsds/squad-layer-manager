import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as L from '@/models/layer.models'

import { cmd, LAYERS, queue } from '../harness/arrange'
import { savedQueue } from '../harness/inspect'
import { rearrange } from '../harness/rearrange'
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

		// The sync above can complete on the roll's first poll, which reports the stayer team-less
		// (World.sortTeamsLateOnRoll). A switch before the app sees the stayer placed can't be told from the placement.
		await app.waitForRosterSync()

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

	it('a layer squad picked by in-game vote is attributed to the vote and leaves the queue head alone', async () => {
		const oldMatch = app.latestMatch()
		const headBefore = savedQueue(app)[0]

		// an admin had already stopped SLM writing the rotation, for their own reasons
		const admin = makePlayer({ name: ' vote_reason_admin', steam: ROLL_ADMIN_STEAM_ID, teamId: 1 })
		app.emu.world.connectPlayer(admin)
		await app.waitForRosterSync()
		app.emu.world.chat(admin, 'ChatAdmin', cmd('disableslm'))
		await app.waitFor(() => disabledReason(app)?.type === 'manual' || undefined, {
			label: 'updates disabled manually',
			timeoutMs: 30_000,
		})

		// the vote takes the next-layer slot itself and writes no map-set line doing it, so the app has no way to
		// see the pick coming: the roll lands on a layer it never set and whose classname it does not expect
		app.emu.world.startIngameVote('layer', ['Mutaha_Skirmish_v1'])

		// the vote takes the reason over: it decides the next layer now, whoever turned SLM off
		await app.waitFor(() => disabledReason(app)?.type === 'ingame-vote' || undefined, {
			label: 'the manual reason replaced by the in-game vote',
			timeoutMs: 30_000,
		})

		app.roll()

		const newMatch = await app.waitForNewMatch(oldMatch.id)
		expect(L.layerMatchesIngameLayerClassname(L.readStoredLayerId(newMatch.layerId), 'Mutaha_Skirmish_v1')).toBe(true)
		expect(setByTypeOf(app, newMatch.id)).toBe('ingame-vote')
		// the head was never set as next, so a layer it had no part in choosing must not consume it
		expect(savedQueue(app)[0]?.itemId).toBe(headBefore?.itemId)

		// turning SLM back on has to turn the vote off with it, or the next match resumes the same fight
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('enableslm'))
		await app.waitFor(() => app.emu.rcon.commandLog.some((c) => c.body === 'AdminEnableVoting 0') || undefined, {
			label: 'in-game voting turned off alongside re-enabling updates',
			timeoutMs: 30_000,
		})
		expect(disabledReason(app)).toBeNull()
	})

	it('a roll onto a layer other than the head leaves the head queued and writes it back as next', async () => {
		const oldMatch = app.latestMatch()
		const head = savedQueue(app)[0]
		const headLayerId = L.readStoredLayerId(head!.layerId!)
		expect(L.areLayersCompatible(headLayerId, LAYERS.narvaRaas)).toBe(false)

		// the roll clears the server's next layer, as a real server replacing it from its own rotation would
		app.emu.rcon.commandLog.length = 0
		app.emu.world.handleCommand(L.getLayerCommand(LAYERS.narvaRaas, 'change-layer'))
		const newMatch = await app.waitForNewMatch(oldMatch.id)
		expect(L.layerMatchesIngameLayerClassname(L.readStoredLayerId(newMatch.layerId), 'Narva_RAAS_v1')).toBe(true)

		await app.waitFor(() => app.emu.rcon.commandLog.some((c) => c.body === L.getLayerCommand(headLayerId, 'set-next')) || undefined, {
			label: 'the unplayed head written back as the next layer',
			timeoutMs: 30_000,
		})
		await app.waitForNextLayerSync()
		expect(savedQueue(app)[0]?.itemId).toBe(head!.itemId)
	})

	it('overrides a next layer set outside SLM straight after a status poll', async () => {
		// a set-next logged before the last roll has settled is dropped (#620), so the override would never see it
		await app.waitForRosterSync()
		await rearrange(app, {
			serverSettings: (settings) => {
				settings.overrideAdminSetNextLayer = true
			},
			layerQueue: queue(LAYERS.skorpoRaas, LAYERS.sumariSeed),
		})
		await app.waitForNextLayerSync()
		const head = savedQueue(app)[0]
		const headLayerId = L.readStoredLayerId(head!.layerId!)

		// SLM polls the server's layers every few seconds, so its last answer, still naming the head, is fresh
		app.emu.rcon.commandLog.length = 0
		app.emu.world.handleCommand(L.getLayerCommand(LAYERS.narvaRaas, 'set-next'))
		await app.waitFor(() => app.emu.rcon.commandLog.some((c) => c.body === L.getLayerCommand(headLayerId, 'set-next')) || undefined, {
			label: 'the head set back over the outside set-next',
			timeoutMs: 30_000,
		})
		expect(app.emu.world.nextLayer?.layer).toBe(L.toLayer(headLayerId).Layer)
		expect(savedQueue(app)[0]?.itemId).toBe(head!.itemId)

		await rearrange(app, {
			serverSettings: (settings) => {
				settings.overrideAdminSetNextLayer = false
			},
		})
	})

	it('reads the server losing its next layer as voting having been enabled, and marks that reason a guess', async () => {
		expect(disabledReason(app)).toBeNull()
		expect(savedQueue(app)[0]?.layerId).toBeTruthy()

		// enabling voting clears the next layer and logs nothing doing it, so this is all SLM ever gets to see
		app.emu.world.nextLayer = null

		await app.waitFor(
			() => {
				const reason = disabledReason(app)
				return reason?.type === 'ingame-vote' && reason.inferred === true ? reason : undefined
			},
			{ label: 'updates disabled with an inferred in-game-vote reason', timeoutMs: 60_000 },
		)
	})
})

function disabledReason(fixture: RollingFixture): { type: string; inferred?: boolean } | null {
	const db = fixture.readDb()
	try {
		const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(fixture.serverId) as { settings: string }
		return JSON.parse(row.settings).json.updatesToSquadServerDisabled ?? null
	} finally {
		db.close()
	}
}

function setByTypeOf(fixture: RollingFixture, matchId: number): string {
	const db = fixture.readDb()
	try {
		return (db.prepare(`SELECT setByType FROM matchHistory WHERE id = ?`).get(matchId) as { setByType: string }).setByType
	} finally {
		db.close()
	}
}
