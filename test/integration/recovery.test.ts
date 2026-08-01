import * as fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as L from '@/models/layer'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { savedQueue } from '../harness/inspect'

// The failure modes a long-running server actually hits: the app itself is down when the map rolls, rcon
// drops, the game rotates its log. The app has to notice and pick back up on its own -- these are the paths
// where a hang or a lost event stream would otherwise go unnoticed until someone complains.
//
// One app carries all three, in that order: the missed roll needs the seeded head still unplayed, so it runs
// before the faults that roll the map themselves.

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture({ layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.skorpoRaas) })
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

// A roll the app was not running for still consumes the queue item the app set as next. Nothing tells it that on
// the way back up -- it reads the current layer off rcon, not the roll it missed -- so the head has to be
// reconciled against what is actually playing, or the layer gets set as next a second time and played twice.
describe('a map roll that happened while the app was down', () => {
	it('consumes the queue head the server already played', async () => {
		// the head is the item the server is about to play in the roll below
		expect(savedQueue(app)[0]?.layerId).toBe(LAYERS.gorodokRaas)

		await app.restart(() => {
			app.emu.world.handleCommand(L.getLayerCommand(LAYERS.gorodokRaas, 'set-next'))
			app.emu.world.startNewGame()
		})

		// the head is the layer now playing, so it has been played already: the next item is what is next
		await app.waitFor(() => savedQueue(app)[0]?.layerId === LAYERS.sumariSeed, {
			label: 'the played head consumed rather than queued again',
			timeoutMs: 45_000,
		})
	})
})

describe('recovering from a broken squad server', () => {
	it('reconnects and resumes polling after rcon drops', async () => {
		await app.emu.expectCommand(/^ListPlayers$/, { timeoutMs: 20_000 })

		await app.emu.cycleRcon({ downMs: 1_000 })

		// the app comes back on its own: it re-polls the roster it can no longer trust
		app.emu.rcon.commandLog.length = 0
		await app.emu.expectCommand(/^ListPlayers$/, { timeoutMs: 30_000 })

		// and the reconnect is recorded, so an admin can see the server dropped
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT count(*) as n FROM serverEvents WHERE type = 'RCON_DISCONNECTED'`).get() as { n: number }
					return row.n > 0
				} finally {
					db.close()
				}
			},
			{ label: 'the disconnect recorded as a server event', timeoutMs: 25_000 },
		)
	})

	it('keeps ingesting the log after the game rotates it', async () => {
		app.emu.rotateLog()

		// The tail detects rotation only by the file shrinking below its held offset. This fixture's log is
		// tiny, so writing immediately can grow the new file past the old offset before the app's next poll
		// and the rotation goes unseen -- a window a real multi-megabyte SquadGame.log does not have. Hold
		// the join until the app has observed the shrink.
		await app.waitFor(() => fs.readFileSync(app.logFile, 'utf8').includes('log file shrank'), {
			label: 'the app noticing the rotation',
		})

		// a player joining after the rotation still reaches the app, which means the tail restarted at
		// the top of the new file rather than waiting for it to grow past its old offset
		const player = makePlayer({ name: ' post_rotation_joiner' })
		app.emu.world.connectPlayer(player)

		await app.waitFor(
			() => {
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
			},
			{ label: 'a log-only event from after the rotation', timeoutMs: 30_000 },
		)
	})

	it('still drives the server after all the faults', async () => {
		// the queue survived, and the app can still act on the server it reconnected to: the roll plays the
		// Sumari head and the app promotes the next item
		app.emu.rcon.commandLog.length = 0
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 30_000 })
		expect(setNext.body).toContain('Skorpo')
	})
})
