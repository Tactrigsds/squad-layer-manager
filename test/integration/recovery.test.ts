import * as fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as L from '@/models/layer'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { savedQueue } from '../harness/inspect'
import { createOrpcClient, firstYield, type TestOrpcClient } from '../harness/orpc-client'

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

function resetsFromReconnect(): number {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT count(*) as n FROM serverEvents WHERE type = 'RESET' AND data LIKE ?`).get('%rcon-reconnected%') as {
			n: number
		}
		return row.n
	} finally {
		db.close()
	}
}

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

		// The reconnect is not finished until the roster has been reseeded. Until that RESET lands the app is
		// still syncing, and a log-derived join in that window is folded into the snapshot rather than reported
		// as an arrival (see PLAYER_CONNECTED_CHAIN in pending-events.models.ts) -- which is exactly what the
		// next test asserts on.
		await app.waitFor(() => resetsFromReconnect() > 0, {
			label: 'the roster reseeded after the reconnect',
			timeoutMs: 30_000,
		})
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

// Rcon down and staying down, which is what a squad server being off looks like to the app. Every rcon read then
// costs its whole retry ladder, and queue ops hold matchHistory.mtx across theirs -- so the dashboard's streams
// have to answer from what the app already knows rather than wait on the connection. They have 15s before the
// client abandons them and renders an error instead of the dashboard.
//
// Last in the file: it leaves rcon offline for the rest of the run.
describe('a squad server that is simply off', () => {
	let client: TestOrpcClient

	beforeAll(async () => {
		client = await createOrpcClient(app)
		await app.emu.rcon.goOffline()
	})

	it('still serves the layers status, with no next layer to report', async () => {
		const first = await firstYield((signal) => client.squadServer.watchLayersStatus({ serverId: app.serverId }, { signal }), {
			timeoutMs: 10_000,
			label: 'the layers status',
		})

		expect(first.code).toBe('ok')
		expect(first.code === 'ok' && first.data.currentLayer).toBeTruthy()
		expect(first.code === 'ok' && first.data.nextLayer).toBeNull()
	})

	it('reports the rcon failure for server info rather than going silent', async () => {
		const first = await firstYield((signal) => client.squadServer.watchServerInfo({ serverId: app.serverId }, { signal }), {
			timeoutMs: 10_000,
			label: 'the server info',
		})

		expect(first.code).toBe('err:rcon')
	})
})
