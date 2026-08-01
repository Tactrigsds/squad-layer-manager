import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as FB from '@/models/filter-builders'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { cmd, filter, LAYERS, queue, role } from '../harness/arrange'
import { appEventTypes, savedBackburner, savedQueue, warnsTo } from '../harness/inspect'

// The layer backburner's in-game surface, and the generation it feeds: /reqlayer requests are validated
// against the pool, queued, listed, evicted at the per-user cap, and consumed by autogeneration when the
// map rolls -- which is also where the pool's repeat rules bind, so a second roll proves the just-played
// maps stay out of what generation draws.

const ADMIN_STEAM_ID = '76561198000000001'
const REQUESTER_STEAM_ID = '76561198000000002'
const REQUESTER: TestUser = { discordId: 900000000000000002n, username: 'requester', steamIds: [REQUESTER_STEAM_ID] }

let app: AppFixture
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID })
const requester = makePlayer({ name: ' test_requester', steam: REQUESTER_STEAM_ID })

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas),
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		users: [REQUESTER],
		filters: [
			// a filter that matches nothing, so an unsatisfiable request can be made deterministically
			filter('impossible', 'Impossible', FB.and([FB.eq('Map', 'Gorodok'), FB.eq('Map', 'Fallujah')])),
			// generation is pinned to three maps so the repeat-rule assertion at the end is deterministic.
			// The emulator boots on Harju, which lands in the repeat window: no map here may collide with it.
			filter('gen-pool', 'Generation Pool', FB.and([FB.inValues('Map', ['Gorodok', 'Skorpo', 'Fallujah'])])),
		],
		globalSettings: (s) => {
			s.rbac.roles['requesters'] = role([], { users: [REQUESTER] }, { maxLayerRequests: 1 })
		},
		serverSettings: (s) => {
			s.queue.mainPool.constrainGeneration = [{ filterId: 'gen-pool', applyAs: 'regular' }]
			s.queue.mainPool.repeatRules = [{ label: 'Map', field: 'Map', within: 4, autogen: true }]
		},
	})
	app.emu.world.connectPlayer(admin)
	app.emu.world.connectPlayer(requester)
	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('layer backburner via chat', () => {
	it('queues a request, lists it, and removes it again', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer fallu'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })
		expect(savedBackburner(app)[0].description).toBe('Fallujah')
		expect(warnsTo(app, admin).join('\n')).toContain('Layer request queued: Fallujah')

		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqs'))
		await app.waitFor(() => warnsTo(app, admin).length > 0 || null, { label: 'the request listing', timeoutMs: 20_000 })
		expect(warnsTo(app, admin).join('\n')).toContain('1. Fallujah (yours)')

		app.emu.world.chat(admin, 'ChatAdmin', cmd('unreqlayer'))
		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'the request being removed', timeoutMs: 20_000 })
	})

	it('rejects a request with no solutions in the pool', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer impossible'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('No layers in the current pool match')) || null, {
			label: 'the rejection reply',
			timeoutMs: 20_000,
		})
		expect(savedBackburner(app)).toHaveLength(0)
	})

	it('suggests a correction for an unknown token', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer gorodokk'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('Unknown request')) || null, {
			label: 'the unknown-token reply',
			timeoutMs: 20_000,
		})
	})

	it('evicts the oldest request when a capped user exceeds their limit', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(requester, 'ChatAll', cmd('reqlayer skorpo'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the first capped request', timeoutMs: 20_000 })

		app.emu.world.chat(requester, 'ChatAll', cmd('reqlayer fallu'))
		await app.waitFor(() => (savedBackburner(app).length === 1 && savedBackburner(app)[0].description === 'Fallujah') || null, {
			label: 'the oldest request being evicted',
			timeoutMs: 20_000,
		})
		expect(warnsTo(app, requester).join('\n')).toContain('dropped')

		// leave a clean slate for the generation test
		app.emu.world.chat(requester, 'ChatAll', cmd('unreqlayer'))
		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'cleanup', timeoutMs: 20_000 })
	})
})

describe('generation on roll', () => {
	it('folds queued requests into the next generated layer and consumes them', async () => {
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer fallu'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })

		// rolling consumes the only queued layer, which forces generation of the next one
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const generated = await app.waitFor(
			() => {
				const q = savedQueue(app)
				return q.length >= 1 && q[0].layerId && q[0].layerId !== LAYERS.gorodokRaas ? q[0] : null
			},
			{ label: 'the generated layer', timeoutMs: 30_000 },
		)
		expect(generated.layerId).toMatch(/^FL-/)

		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'the request being consumed', timeoutMs: 20_000 })
		expect(appEventTypes(app)).toContain('LAYER_REQUEST_CONSUMED')
	})

	it('never generates a map the repeat rule excludes', async () => {
		// the previous roll put the requested Fallujah at the head; this one plays it and forces another
		// generation. The repeat window now holds Fallujah (playing), Gorodok and Harju: of the three maps
		// generation may draw from, only Skorpo remains.
		const fallujah = savedQueue(app)[0].layerId!
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const generated = await app.waitFor(
			() => {
				const q = savedQueue(app)
				return q.length >= 1 && q[0].layerId && q[0].layerId !== fallujah ? q[0] : null
			},
			{ label: 'the generated layer', timeoutMs: 30_000 },
		)
		expect(generated.layerId).toMatch(/^SK-/)
	})
})
