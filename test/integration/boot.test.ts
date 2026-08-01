import * as fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'

// First end-to-end milestone: the real app boots against the emulated squad server, holds an
// RCON session, ingests the log stream, and persists state to its db.

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('app boot against emulator', () => {
	it('polls server state over RCON', async () => {
		await app.emu.expectCommand(/^ShowCurrentMap$/, { timeoutMs: 20_000 })
		await app.emu.expectCommand(/^ShowNextMap$/, { timeoutMs: 20_000 })
		await app.emu.expectCommand(/^ListPlayers$/, { timeoutMs: 20_000 })
		await app.emu.expectCommand(/^ListSquads$/, { timeoutMs: 20_000 })
	})

	it('persists APP_STARTED to the db', async () => {
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT count(*) as n FROM appEvents WHERE type = 'APP_STARTED'`).get() as { n: number }
					return row.n > 0
				} finally {
					db.close()
				}
			},
			{ label: 'APP_STARTED app event' },
		)
	})

	it("the app consumes the emulated server's log file", async () => {
		expect(fs.existsSync(app.squadLogPath)).toBe(true)

		// PLAYER_CONNECTED only ever comes from the log (the teams poll produces PLAYER_RECONCILED
		// instead), so its presence proves the local-file source is wired end to end
		const player = makePlayer({ name: ' log_source_probe' })
		app.emu.world.connectPlayer(player)
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT count(*) as n FROM serverEvents WHERE type = 'PLAYER_CONNECTED'`).get() as { n: number }
					return row.n > 0
				} finally {
					db.close()
				}
			},
			{ label: 'PLAYER_CONNECTED server event from the log', timeoutMs: 25_000 },
		)
	})

	it('ingests log events: a server roll ends the match and starts the next one', async () => {
		// wait for the boot-time state to settle: a current match row exists
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					return (db.prepare(`SELECT count(*) as n FROM matchHistory`).get() as { n: number }).n > 0
				} finally {
					db.close()
				}
			},
			{ label: 'initial match row', timeoutMs: 20_000 },
		)

		// roll to whatever the server's next layer is (which the app's queue set via AdminSetNextLayer).
		// The app pre-creates the upcoming match's row when it sets the next layer, and promotes it on
		// roll, so we assert on the lifecycle fields rather than the row count: the ended match gains an
		// outcome, and the new current match has a startTime and none.
		app.emu.world.endMatch()
		app.emu.world.startNewGame()
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const rows = db.prepare(`SELECT outcome, startTime FROM matchHistory ORDER BY ordinal ASC`).all() as {
						outcome: string | null
						startTime: number | null
					}[]
					const last = rows[rows.length - 1]
					return rows.length >= 2 && rows[0].outcome !== null && last.outcome === null && last.startTime !== null
				} finally {
					db.close()
				}
			},
			{ label: 'match roll reflected in match history', timeoutMs: 20_000 },
		)
	})

	it('a player joining shows up via teams polling', async () => {
		const p = makePlayer({ name: ' integ_player', role: 'PLA_Rifleman_01' })
		app.emu.world.connectPlayer(p)
		// the app polls ListPlayers on a 5s TTL; once it has seen the player, the emulator has
		// necessarily served a response containing them
		app.emu.rcon.commandLog.length = 0
		await app.emu.expectCommand(/^ListPlayers$/, { timeoutMs: 20_000 })
	})
})

// The engine is loaded at boot and held for the life of the process: a load costs 110-125MB of RSS while it runs,
// against ~64MB to hold it flat. See "The layer engine" in docs/architecture.md.
describe('the server holds its layer engine for the life of the process', () => {
	const LOADED = /Loaded the layer engine/

	function appLog(): string {
		return fs.readFileSync(app.logFile, 'utf8')
	}

	it('loads it during boot, before anything queries', () => {
		expect(appLog()).toMatch(LOADED)
	})

	it('never releases it, and never loads a second copy', async () => {
		// the roll in the match-history test above drew a layer, which needs the engine
		await app.waitFor(() => /squad-server:onNewGame/.test(appLog()), {
			label: 'a roll, which draws a layer and so needs the engine',
			timeoutMs: 30_000,
		})

		expect(appLog()).not.toMatch(/released the layer engine/)
		expect(appLog().match(new RegExp(LOADED.source, 'g'))).toHaveLength(1)
	}, 60_000)
})
