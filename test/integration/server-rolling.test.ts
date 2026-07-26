import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { LAYERS } from '../harness/arrange'
import { createRollingFixture, type RollingFixture } from '../harness/rolling'

// What the roster does across the roll window: who is carried over, who is folded in, who is dropped, and
// which of those produce an individual event rather than being absorbed into the wholesale RESET. See
// test/harness/rolling.ts for how the window works and why RCON is taken offline around the mid-roll cases.

let app: RollingFixture

beforeAll(async () => {
	app = await createRollingFixture()
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
