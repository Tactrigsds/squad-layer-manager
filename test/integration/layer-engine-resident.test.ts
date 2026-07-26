import * as fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// The engine is loaded at boot and held for the life of the process: a load costs 110-125MB of RSS while it runs,
// against ~64MB to hold it flat. See "The layer engine" in docs/architecture.md.

const LOADED = /Loaded the layer engine/
const RELEASED = /released the layer engine/

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture({ layerQueue: queue(LAYERS.gorodokRaas) })
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function appLog(): string {
	return fs.readFileSync(app.logFile, 'utf8')
}

describe('the server holds its layer engine for the life of the process', () => {
	it('loads it during boot, before anything queries', () => {
		expect(appLog()).toMatch(LOADED)
	})

	it('never releases it, and never loads a second copy', async () => {
		app.emu.world.endMatch()
		app.emu.world.startNewGame()
		await app.waitFor(() => /squad-server:onNewGame/.test(appLog()), {
			label: 'a roll, which draws a layer and so needs the engine',
			timeoutMs: 30_000,
		})

		expect(appLog()).not.toMatch(RELEASED)
		expect(appLog().match(new RegExp(LOADED.source, 'g'))).toHaveLength(1)
	}, 60_000)
})
