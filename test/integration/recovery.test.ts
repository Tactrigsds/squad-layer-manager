import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as L from '@/models/layer'

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

	it('still drives the server after both faults', async () => {
		// the queue survived, and the app can still act on the server it reconnected to
		app.emu.rcon.commandLog.length = 0
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 30_000 })
		expect(setNext.body).toContain('Sumari_Seed_v1')
	})
})

// A roll the app was not running for still consumes the queue item the app set as next. Nothing tells it that on
// the way back up -- it reads the current layer off rcon, not the roll it missed -- so the head has to be
// reconciled against what is actually playing, or the layer gets set as next a second time and played twice.
describe('a map roll that happened while the app was down', () => {
	let downApp: AppFixture

	beforeAll(async () => {
		downApp = await createAppFixture({ layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed) })
	}, 120_000)

	afterAll(async () => {
		await downApp?.dispose()
	})

	it('consumes the queue head the server already played', async () => {
		// the head is the item the server is about to play in the roll below
		expect(savedQueueOf(downApp)[0]?.layerId).toBe(LAYERS.gorodokRaas)

		await downApp.restart(() => {
			downApp.emu.world.handleCommand(L.getLayerCommand(LAYERS.gorodokRaas, 'set-next'))
			downApp.emu.world.startNewGame()
		})

		// the head is the layer now playing, so it has been played already: the next item is what is next
		await downApp.waitFor(() => savedQueueOf(downApp)[0]?.layerId === LAYERS.sumariSeed, {
			label: 'the played head consumed rather than queued again',
			timeoutMs: 45_000,
		})
	})
})

function savedQueueOf(fixture: AppFixture): { layerId?: string }[] {
	const db = fixture.readDb()
	try {
		const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(fixture.serverId) as { layerQueue: string }
		return JSON.parse(row.layerQueue).json
	} finally {
		db.close()
	}
}
