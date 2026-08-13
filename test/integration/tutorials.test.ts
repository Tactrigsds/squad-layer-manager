import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { role } from '../harness/arrange'
import { savedQueue } from '../harness/inspect'
import { createOrpcClient, firstYield, type TestOrpcClient } from '../harness/orpc-client'

// The tutorial runtime, end to end at the oRPC level: starting a run stands up a scoped, ephemeral emulated server
// seeded for the scenario, delivered only to its owner; abandoning it tears the server down again. The tour client
// (Phase 5) narrates on top of this, and its own journey is an e2e test (Phase 6).

const USER: TestUser = { discordId: 900000000000000062n, username: 'test-tutorial-user' }
const SERVER_ID = `tutorial-${USER.discordId}`

let app: AppFixture
let client: TestOrpcClient

beforeAll(async () => {
	app = await createAppFixture({
		users: [USER],
		globalSettings: (settings) => {
			// site access only: starting a tutorial is per-user by construction, not a granted role
			settings.rbac.roles['tutorial-user'] = role(['site:authorized'], { users: [USER] })
		},
	})
	client = await createOrpcClient(app, USER)
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

async function deliveredServerIds(): Promise<string[]> {
	const settings = await firstYield((signal) => client.settings.public.watchPublicSettings(undefined, { signal }), {
		label: 'public settings',
	})
	return settings.servers.map((s) => s.id)
}

async function runState() {
	return await firstYield((signal) => client.tutorials.watchRun(undefined, { signal }), { label: 'run state' })
}

// ordered: each test hands its state to the next, with the destructive teardown last
describe('tutorial runtime', () => {
	it('advertises the available scenarios', async () => {
		const metas = await client.tutorials.list()
		expect(metas.map((m) => m.id)).toContain('layer-queue-basics')
	})

	it('reports no run before one is started', async () => {
		expect(await runState()).toEqual({ code: 'none' })
		expect(await deliveredServerIds()).not.toContain(SERVER_ID)
	})

	it('stands up a scoped server seeded with the scenario queue', async () => {
		const res = await client.tutorials.start({ scenarioId: 'layer-queue-basics' })
		expect(res).toEqual({ code: 'ok', serverId: SERVER_ID })

		expect(await runState()).toEqual({ code: 'active', scenarioId: 'layer-queue-basics', serverId: SERVER_ID })
		// the scenario's starting queue booted with the server, so the dashboard opens on a populated queue
		expect(savedQueue(app, SERVER_ID)).toHaveLength(3)
		// scoped to its owner: delivered to them alongside the public server
		const ids = await deliveredServerIds()
		expect(ids).toContain(SERVER_ID)
		expect(ids).toContain(app.serverId)
	})

	it('runs a stage green and rejects an unknown one', async () => {
		expect(await client.tutorials.stage({ scenarioId: 'layer-queue-basics', stageId: 'welcome' })).toEqual({ code: 'ok' })
		expect(await client.tutorials.stage({ scenarioId: 'layer-queue-basics', stageId: 'no-such-stage' })).toEqual({
			code: 'err:unknown-stage',
		})
	})

	it('tears the server down on abandon', async () => {
		expect(await client.tutorials.abandon()).toEqual({ code: 'ok' })
		expect(await runState()).toEqual({ code: 'none' })
		expect(await deliveredServerIds()).not.toContain(SERVER_ID)
		// no active run: a stage now reports it rather than acting
		expect(await client.tutorials.stage({ scenarioId: 'layer-queue-basics', stageId: 'welcome' })).toEqual({ code: 'err:no-active-run' })
	})
})
