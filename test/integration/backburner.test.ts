import { makePlayer } from '@/emulator'
import * as BB from '@/models/backburner.models'
import * as FB from '@/models/filter-builders'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { filter, LAYERS, queue } from '../harness/arrange'

// The layer backburner's in-game surface: /reqlayer requests are validated against the pool, queued,
// listed, evicted at the per-user cap, and consumed by autogeneration when the map rolls.

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
		// a filter that matches nothing, so an unsatisfiable request can be made deterministically
		filters: [filter('impossible', 'Impossible', FB.and([FB.eq('Map', 'Gorodok'), FB.eq('Map', 'Fallujah')]))],
		globalSettings: (s) => {
			s.rbac.roles['requesters'] = {
				permissions: [],
				maxLayerRequests: 1,
				globalSettingsGrants: [],
				serverSettingsGrants: [],
				assignments: { discordRoleIds: [], discordUserIds: [REQUESTER.discordId.toString()], everyMember: false },
			}
		},
		serverSettings: (s) => {
			s.queue.mainPool.repeatRules = []
		},
	})
	app.emu.world.connectPlayer(admin)
	app.emu.world.connectPlayer(requester)
	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function savedBackburner(): { itemId: string; description: string }[] {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT backburner FROM servers WHERE id = ?`).get(app.serverId) as { backburner: string }
		const items = JSON.parse(row.backburner).json as { itemId: string; filter: Parameters<typeof BB.describeTemplate>[0] }[]
		return items.map(item => ({ itemId: item.itemId, description: BB.describeTemplate(item.filter) }))
	} finally {
		db.close()
	}
}

function savedQueue(): { type: string; layerId?: string }[] {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
		return JSON.parse(row.layerQueue).json
	} finally {
		db.close()
	}
}

function appEventTypes(): string[] {
	const db = app.readDb()
	try {
		return (db.prepare(`SELECT type FROM appEvents`).all() as { type: string }[]).map(r => r.type)
	} finally {
		db.close()
	}
}

function warnsTo(player: { eos: string }): string[] {
	return app.emu.rcon.commandLog
		.filter((c) => c.body.startsWith('AdminWarn') && c.body.includes(player.eos))
		.map((c) => c.body)
}

describe('layer backburner via chat', () => {
	it('queues a request, lists it, and removes it again', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '!reqlayer fallu')
		await app.waitFor(() => savedBackburner().length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })
		expect(savedBackburner()[0].description).toBe('Fallujah')
		expect(warnsTo(admin).join('\n')).toContain('Layer request queued: Fallujah')

		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '!reqs')
		await app.waitFor(() => warnsTo(admin).length > 0 || null, { label: 'the request listing', timeoutMs: 20_000 })
		expect(warnsTo(admin).join('\n')).toContain('1. Fallujah (yours)')

		app.emu.world.chat(admin, 'ChatAdmin', '!unreqlayer')
		await app.waitFor(() => savedBackburner().length === 0 || null, { label: 'the request being removed', timeoutMs: 20_000 })
	})

	it('rejects a request with no solutions in the pool', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '!reqlayer impossible')
		await app.waitFor(
			() => warnsTo(admin).some(w => w.includes('No layers in the current pool match')) || null,
			{ label: 'the rejection reply', timeoutMs: 20_000 },
		)
		expect(savedBackburner()).toHaveLength(0)
	})

	it('suggests a correction for an unknown token', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '!reqlayer gorodokk')
		await app.waitFor(
			() => warnsTo(admin).some(w => w.includes('Unknown request')) || null,
			{ label: 'the unknown-token reply', timeoutMs: 20_000 },
		)
	})

	it('evicts the oldest request when a capped user exceeds their limit', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(requester, 'ChatAll', '!reqlayer goro')
		await app.waitFor(() => savedBackburner().length === 1 || null, { label: 'the first capped request', timeoutMs: 20_000 })

		app.emu.world.chat(requester, 'ChatAll', '!reqlayer harju')
		await app.waitFor(
			() => (savedBackburner().length === 1 && savedBackburner()[0].description === 'Harju') || null,
			{ label: 'the oldest request being evicted', timeoutMs: 20_000 },
		)
		expect(warnsTo(requester).join('\n')).toContain('dropped')

		// leave a clean slate for the generation test
		app.emu.world.chat(requester, 'ChatAll', '!unreqlayer')
		await app.waitFor(() => savedBackburner().length === 0 || null, { label: 'cleanup', timeoutMs: 20_000 })
	})

	it('folds queued requests into the next generated layer and consumes them', async () => {
		app.emu.world.chat(admin, 'ChatAdmin', '!reqlayer fallu')
		await app.waitFor(() => savedBackburner().length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })

		// rolling consumes the only queued layer, which forces generation of the next one
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const generated = await app.waitFor(() => {
			const q = savedQueue()
			return q.length >= 1 && q[0].layerId && q[0].layerId !== LAYERS.gorodokRaas ? q[0] : null
		}, { label: 'the generated layer', timeoutMs: 30_000 })
		expect(generated.layerId).toMatch(/^FL-/)

		await app.waitFor(() => savedBackburner().length === 0 || null, { label: 'the request being consumed', timeoutMs: 20_000 })
		expect(appEventTypes()).toContain('LAYER_REQUEST_CONSUMED')
	})
})
