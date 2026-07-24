import * as fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// The server's engine copy costs ~64MB resident for the life of the process, so it is loaded on the first query
// that needs one rather than at boot. What that buys is easy to give back by accident: any handler that resolves a
// layer query context before knowing it will query pulls the artifact in anyway. See "The layer engine" in
// docs/architecture.md.

const ENGINE_LOADED = /Loaded the layer engine/

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture({
		// a queue as long as preferredLength leaves nothing for the generator to fill, so boot has no reason to query
		layerQueue: queue(LAYERS.gorodokRaas),
		// the admin queue reminder checks layer statuses on a timer, which would load the engine on its own schedule
		serverSettings: (s) => {
			s.remindersAndAnnouncementsEnabled = false
		},
	})
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function appLog(): string {
	return fs.readFileSync(app.logFile, 'utf8')
}

describe('the server loads its layer engine lazily', () => {
	it('boots a fully working app without loading it', () => {
		expect(appLog()).not.toMatch(ENGINE_LOADED)
	})

	it('loads it once a roll empties the queue and autogen has to draw a layer', async () => {
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		await app.waitFor(() => ENGINE_LOADED.test(appLog()), { label: 'the layer engine loading on first use', timeoutMs: 30_000 })
	})
})
