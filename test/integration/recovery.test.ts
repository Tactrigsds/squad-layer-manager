import { makePlayer } from '@/emulator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// The failure modes a long-running server actually hits: rcon drops, the game rotates its log. The
// app has to notice and pick back up on its own -- these are the paths where a hang or a lost event
// stream would otherwise go unnoticed until someone complains.

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture({ layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed) })
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('recovering from a broken squad server', () => {
	it('reconnects and resumes polling after rcon drops', async () => {
		await app.emu.expectCommand(/^ListPlayers$/, { timeoutMs: 20_000 })

		await app.emu.cycleRcon({ downMs: 1_000 })

		// the app comes back on its own: it re-polls the roster it can no longer trust
		app.emu.rcon.commandLog.length = 0
		await app.emu.expectCommand(/^ListPlayers$/, { timeoutMs: 30_000 })

		// and the reconnect is recorded, so an admin can see the server dropped
		await app.waitFor(() => {
			const db = app.readDb()
			try {
				const row = db.prepare(`SELECT count(*) as n FROM serverEvents WHERE type = 'RCON_DISCONNECTED'`).get() as { n: number }
				return row.n > 0
			} finally {
				db.close()
			}
		}, { label: 'the disconnect recorded as a server event', timeoutMs: 25_000 })
	})

	it('keeps ingesting the log after the game rotates it', async () => {
		app.emu.rotateLog()

		// a player joining after the rotation still reaches the app, which means the tail restarted at
		// the top of the new file rather than waiting for it to grow past its old offset
		const player = makePlayer({ name: ' post_rotation_joiner' })
		app.emu.world.connectPlayer(player)

		await app.waitFor(() => {
			const db = app.readDb()
			try {
				// PLAYER_CONNECTED comes only from the log (the roster poll produces PLAYER_RECONCILED), so
				// this can't pass on rcon polling alone
				const row = db
					.prepare(`SELECT count(*) as n FROM serverEvents WHERE type = 'PLAYER_CONNECTED' AND data LIKE ?`)
					.get(`%${player.eos}%`) as { n: number }
				return row.n > 0
			} finally {
				db.close()
			}
		}, { label: 'a log-only event from after the rotation', timeoutMs: 30_000 })
	})

	it('still drives the server after both faults', async () => {
		// the queue survived, and the app can still act on the server it reconnected to
		app.emu.rcon.commandLog.length = 0
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 30_000 })
		expect(setNext.body).toContain('Sumari_Seed_v1')
	})
})
