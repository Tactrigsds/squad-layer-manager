import { makePlayer } from '@/emulator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// Exercises the full remote log-agent pipeline: the emulator writes its SquadGame.log, the real rust log
// agent (log-agent/agent) tails that file and ships it to the app over the /log-agent websocket, and the
// app parses those lines into server events. If any link is broken the app never sees a NEW_GAME and no
// new match history row appears, which is what these tests assert on.

let app: AppFixture

function latestMatch(): { id: number; layerId: string } {
	const db = app.readDb()
	try {
		return db.prepare(`SELECT id, layerId FROM matchHistory ORDER BY id DESC LIMIT 1`).get() as { id: number; layerId: string }
	} finally {
		db.close()
	}
}

async function waitForNewMatch(oldMatchId: number, timeoutMs?: number): Promise<{ id: number; layerId: string }> {
	return app.waitFor(
		() => {
			const match = latestMatch()
			return match.id > oldMatchId ? match : undefined
		},
		{ label: 'the roll producing a new match history row', timeoutMs },
	)
}

function roll() {
	app.emu.world.endMatch()
	app.emu.world.startNewGame()
}

// Skipped for now: this suite runs the real rust log agent, which resolveAgentBinary() builds with `cargo`
// on first use. The CI test image has no Rust toolchain, so the build fails with `cargo ENOENT`. The hooks
// live inside the (skipped) describe on purpose -- a module-level beforeAll would run, and fail, even when
// the block is skipped. Re-enable once the agent is prebuilt into the test image (or cargo is available).
describe.skip('log receiver', () => {
	beforeAll(async () => {
		app = await createAppFixture({
			logSource: 'log-receiver',
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
			admins: ['76561198000000009'],
			adminSteamIds: ['76561198000000009'],
		})
		// building the agent (release) can happen on first run
	}, 180_000)

	afterAll(async () => {
		await app?.dispose()
	})

	it('ingests log events streamed by the real agent, so a roll advances match history', async () => {
		app.emu.world.connectPlayer(makePlayer({ name: ' agent_player', teamId: 1 }))
		await app.waitForRosterSync()
		const oldMatch = latestMatch()

		roll()
		await app.waitForRosterSync()

		const newMatch = await waitForNewMatch(oldMatch.id)
		expect(newMatch.layerId).toBe(LAYERS.gorodokRaas)
	})

	// A restarted agent process resumes tailing from the current end of the log (it does not persist its
	// byte offset across restarts), so it recovers and keeps ingesting rather than wedging. Lossless resume
	// across a transient websocket drop -- where the agent process stays up -- is a separate property.
	it('recovers after the agent process is restarted and keeps ingesting new events', async () => {
		app.logAgent!.stop()
		app.logAgent!.start()
		await app.waitForRosterSync()

		const oldMatch = latestMatch()
		roll()
		await app.waitForRosterSync()

		const newMatch = await waitForNewMatch(oldMatch.id, 60_000)
		expect(newMatch.id).toBeGreaterThan(oldMatch.id)
	}, 90_000)
})
