import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { latestMatch, warnsTo } from '../harness/inspect'
import { createOrpcClient, type TestOrpcClient } from '../harness/orpc-client'

// The builtin plugins, end to end, against one app. The emulator boots on a seed layer, where afk-kicker does nothing,
// so the setup rolls onto the queued RAAS layer first. teamkill-warns is enabled with an empty enabledServers, so
// every warn it sends proves the host contract that a config edit reaches an already-running plugin without a
// restart. The disable step is last, since it leaves teamkill-warns stopped. Packaged plugins, and the parts of the
// host only a package exercises (migrations, rpc, post-roll reminders), are covered in plugin-packages.test.ts.

const ADMIN_STEAM_ID = '76561198000000001'

let app: AppFixture
let client: TestOrpcClient

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.skorpoRaas),
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
	})
	client = await createOrpcClient(app)
	await rollToNext()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function readRows<T>(query: string, ...params: unknown[]): T[] {
	const db = app.readDb()
	try {
		return db.prepare(query).all(...params) as T[]
	} finally {
		db.close()
	}
}

// Ends the current match and rolls. The roll waits for the recorded outcome first: ending and rolling back-to-back
// can land the ROUND_ENDED in the same ingest batch as the new match, which attributes it to the wrong match.
async function rollToNext() {
	const oldMatch = latestMatch(app)
	app.emu.world.endMatch()
	await app.waitFor(
		() => readRows<{ outcome: string | null }>(`SELECT outcome FROM matchHistory WHERE id = ?`, oldMatch.id)[0]?.outcome ?? undefined,
		{ label: `match ${oldMatch.id} recording its outcome` },
	)
	app.emu.world.startNewGame()
	await app.waitFor(() => (latestMatch(app).id > oldMatch.id ? true : undefined), {
		label: 'the roll producing a new match history row',
	})
	// let the roll settle (post-roll roster RESET) before a test acts on the new match
	await app.waitForRosterSync()
}

describe('plugin host', () => {
	it('teamkill-warns picks up enabledServers and template edits without restarting', async () => {
		const victim = app.emu.world.connectPlayer(makePlayer({ name: ' tk_victim', teamId: 1 }))
		const attacker = app.emu.world.connectPlayer(makePlayer({ name: ' tk_attacker', teamId: 1 }))
		await app.waitForRosterSync()

		// activated with no servers configured, so the subscription it warns from predates every edit below
		expect(await client.plugins.setEnabled({ pluginId: 'teamkill-warns', enabled: true })).toMatchObject({
			code: 'ok',
			status: 'active',
		})
		await client.plugins.updateSettings({
			pluginId: 'teamkill-warns',
			config: { enabledServers: [app.serverId], template: 'ALPHA {{attacker}} / {{weapon}}' },
		})

		app.emu.world.woundPlayer(victim, attacker, 'BP_M4_M68')
		await app.waitFor(() => warnsTo(app, victim).find((w) => w.includes('ALPHA')), {
			label: 'the teamkill warn, on a server added to enabledServers after activation',
		})
		expect(warnsTo(app, victim).join('\n')).toContain('ALPHA tk_attacker / BP_M4_M68')

		await client.plugins.updateSettings({
			pluginId: 'teamkill-warns',
			config: { enabledServers: [app.serverId], template: 'BRAVO {{attacker}}' },
		})
		app.emu.world.woundPlayer(victim, attacker, 'BP_M4_M68')
		await app.waitFor(() => warnsTo(app, victim).find((w) => w.includes('BRAVO')), {
			label: 'the teamkill warn rendered from the edited template',
		})
	})

	it('afk-kicker warns and then kicks the squadless player a full server needs gone, and leaves an unkickable one', async () => {
		const world = app.emu.world
		const idler = world.connectPlayer(makePlayer({ name: ' afk_idler', teamId: 1 }))
		const developer = world.connectPlayer(makePlayer({ name: ' afk_developer', teamId: 2 }))
		world.unkickable.add(developer.eos)
		// everyone else in a squad, so the idler and the developer are the only candidates
		for (const teamId of [1, 2]) {
			const members = world.playerList().filter((p) => p !== idler && p !== developer && p.teamId === teamId)
			const [leader, ...rest] = members
			if (!leader) continue
			const squad = world.createSquad(leader, `AFK_TEST_${teamId}`)
			for (const p of rest) world.joinSquad(p, squad)
		}
		await app.waitForRosterSync()
		const squadded = world.playerList().filter((p) => p !== idler && p !== developer)

		await client.plugins.setEnabled({ pluginId: 'afk-kicker', enabled: true })
		await client.plugins.updateSettings({
			pluginId: 'afk-kicker',
			config: { enabledServers: [app.serverId], squadlessWindow: '2s', warnInterval: '1h', warning: 'PERIODIC', finalWarning: 'FINAL' },
		})
		try {
			// full with nobody waiting: warned, not kicked
			world.maxPlayers = world.players.size
			await app.waitFor(() => warnsTo(app, idler).find((w) => w.includes('PERIODIC')), { label: 'the periodic AFK warning' })
			expect(world.players.has(idler.eos)).toBe(true)

			// both are selected in one round, and only the idler's kick lands
			world.publicQueue = 2
			await app.waitFor(() => (world.players.has(idler.eos) ? undefined : true), { label: 'the AFK player being kicked' })
		} finally {
			world.publicQueue = 0
			world.maxPlayers = 100
		}

		expect(warnsTo(app, idler).at(-1)).toContain('FINAL')
		expect(world.players.has(developer.eos)).toBe(true)
		expect(warnsTo(app, developer).filter((w) => w.includes('FINAL'))).toHaveLength(1)
		for (const p of squadded) expect(world.players.has(p.eos)).toBe(true)
		// the emulator drops a player as soon as AdminKick arrives, but the app event is written only once SLM has read the
		// roster back and confirmed the kick
		const kicks = await app.waitFor(
			() => {
				const rows = readRows<{ id: string; actorPluginId: string | null }>(
					`SELECT id, actorPluginId FROM appEvents WHERE type = 'PLAYER_KICKED'`,
				)
				return rows.length > 0 ? rows : undefined
			},
			{ label: 'the PLAYER_KICKED app event' },
		)
		expect(kicks.map((k) => k.actorPluginId)).toEqual(['afk-kicker'])
		const kicked = readRows<{ value: string }>(
			`SELECT value FROM appEventAssociations WHERE appEventId = ? AND dimension = 'player'`,
			kicks[0].id,
		)
		expect(kicked.map((r) => r.value)).toEqual([idler.eos])

		await client.plugins.setEnabled({ pluginId: 'afk-kicker', enabled: false })
	})

	it('disabling over oRPC deactivates the plugin and stops its subscriptions', async () => {
		const victim = app.emu.world.connectPlayer(makePlayer({ name: ' tk_victim_after', teamId: 1 }))
		const attacker = app.emu.world.connectPlayer(makePlayer({ name: ' tk_attacker_after', teamId: 1 }))
		await app.waitForRosterSync()

		const res = await client.plugins.setEnabled({ pluginId: 'teamkill-warns', enabled: false })
		expect(res).toMatchObject({ code: 'ok', status: 'inactive' })
		const [row] = readRows<{ enabled: number }>(`SELECT enabled FROM plugins WHERE id = 'teamkill-warns'`)
		expect(row?.enabled).toBe(0)

		// the server.event$ subscription is torn down synchronously at deactivation. A warn would have gone out by the
		// time the wound is recorded and one more roster poll has completed.
		const wounds = () => readRows(`SELECT 1 FROM serverEvents WHERE type = 'PLAYER_WOUNDED'`).length
		const before = wounds()
		app.emu.world.woundPlayer(victim, attacker, 'BP_M4_M68')
		await app.waitFor(() => (wounds() > before ? true : undefined), { label: 'the wound recorded after deactivation' })
		await app.waitForRosterSync()
		expect(warnsTo(app, victim)).toEqual([])
	})
})
