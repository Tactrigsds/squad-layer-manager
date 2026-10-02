import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { latestMatch, warnsTo } from '../harness/inspect'
import { createOrpcClient, firstYield, type TestOrpcClient } from '../harness/orpc-client'

// The plugin host, end to end, with balance-triggers (auto-enabled by migration 0100) as the subject:
// activation at boot with its migration applied, trigger evaluation off finalized matches, the generic
// rpc stream, and deactivation over oRPC. The disable step kills the plugin's subscriptions, so it is
// last. Two RAAS layers in the queue give the trigger two same-session matches to fire on; the seed
// layer the emulator boots on is a session breaker and never counts. The third pins the match the
// teamkill and afk-kicker tests run on: generation can land on a Training layer, where teamkill-warns
// stays silent and afk-kicker judges by inactivity instead of squad membership.
//
// teamkill-warns rides along as the second subject, for the one thing balance-triggers cannot show: it
// is enabled here with an empty enabledServers, so every warn it sends proves the host contract that a
// config edit reaches an already-running plugin without a restart.

const ADMIN_STEAM_ID = '76561198000000001'

let app: AppFixture
let client: TestOrpcClient
// in game so the post-roll reminder the plugin contributes has somewhere to land
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID })

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.narvaRaas, LAYERS.skorpoRaas),
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
	})
	app.emu.world.connectPlayer(admin)
	client = await createOrpcClient(app)
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

// Finalizes the current match with a decided 300-0 outcome, then rolls. The roll waits for the
// finalized outcome first: ending and rolling back-to-back can land the ROUND_ENDED in the same
// ingest batch as the new match, which attributes it to the wrong match and skips finalization.
async function endMatchDecided(winnerTeamId: number) {
	const oldMatch = latestMatch(app)
	app.emu.world.endMatch({ winnerTeamId })
	await app.waitFor(
		() => readRows<{ outcome: string | null }>(`SELECT outcome FROM matchHistory WHERE id = ?`, oldMatch.id)[0]?.outcome ?? undefined,
		{ label: `match ${oldMatch.id} recording its outcome` },
	)
	app.emu.world.startNewGame()
	await app.waitFor(
		() => {
			const match = latestMatch(app)
			return match.id > oldMatch.id ? match : undefined
		},
		{ label: 'the roll producing a new match history row' },
	)
	// let the roll fully settle (post-roll roster RESET) before anything ends the new match: a
	// round-end landing in the roll window can be attributed to the wrong match and skip finalization
	await app.waitForRosterSync()
	return oldMatch.id
}

describe('plugin host', () => {
	it('activates balance-triggers at boot, with its migration applied and its namespaced table created', async () => {
		const [row] = readRows<{ enabled: number }>(`SELECT enabled FROM plugins WHERE id = 'balance-triggers'`)
		expect(row?.enabled).toBe(1)
		expect(readRows(`SELECT 1 FROM _plugin_migrations WHERE pluginId = 'balance-triggers' AND name = '0001_init'`)).toHaveLength(1)
		expect(readRows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'p_balance_triggers_events'`)).toHaveLength(1)

		const next = await firstYield((signal) => client.plugins.watchPlugins(undefined, { signal }), {
			label: 'the plugin list stream',
		})
		expect(next.plugins).toContainEqual(expect.objectContaining({ id: 'balance-triggers', status: 'active', enabled: true }))
	})

	it('fires 150x2 when one side wins two same-session matches by 150+, recording the event and a plugin app event', async () => {
		// consecutive matches swap the team1/team2 <-> A/B mapping, so alternating raw winners is the same
		// normed side winning every time. The emulator's decided outcome is always 300-0.
		await endMatchDecided(1)
		await endMatchDecided(2)
		const firedMatchId = await endMatchDecided(1)

		await app.waitFor(
			() =>
				readRows<{ level: string; matchTriggeredId: number }>(
					`SELECT level, matchTriggeredId FROM p_balance_triggers_events WHERE triggerId = '150x2'`,
				).find((r) => r.matchTriggeredId === firedMatchId),
			{ label: 'the 150x2 trigger event row' },
		)

		const auditRow = await app.waitFor(
			() =>
				readRows<{ actorPluginId: string; matchId: number | null }>(
					`SELECT actorPluginId, matchId FROM appEvents WHERE type = 'PLUGIN_EVENT' AND actorType = 'plugin'`,
				).find((r) => r.actorPluginId === 'balance-triggers'),
			{ label: 'the PLUGIN_EVENT audit row attributed to the plugin' },
		)
		// the feed replays by matchId, so an event without one is live-only and disappears on reload
		expect(auditRow.matchId).not.toBeNull()
	})

	it('contributes its reminder to the post-roll announcements, warned by the host', async () => {
		// the plugin returns messages; core is what reaches the game server, after the roll that just happened
		await app.waitFor(() => warnsTo(app, admin).find((w) => w.includes('[balance]')), {
			label: 'the balance reminder warned to the admin after the roll',
			timeoutMs: 30_000,
		})
		expect(warnsTo(app, admin).join('\n')).toContain('150 tickets x2')
	})

	it('serves the active events over the generic rpc stream', async () => {
		const first = await firstYield(
			(signal) =>
				client.plugins.rpcStream(
					{ pluginId: 'balance-triggers', path: ['activeEvents'], serverId: app.serverId, input: {} },
					{ signal },
				),
			{ label: 'the activeEvents plugin stream' },
		)
		expect(first).toMatchObject({ code: 'ok' })
		const events = (first as { code: 'ok'; data: { events: { triggerId: string }[] } }).data.events
		expect(events.some((e) => e.triggerId === '150x2')).toBe(true)
	})

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
		const kicks = readRows<{ id: string; actorPluginId: string | null }>(
			`SELECT id, actorPluginId FROM appEvents WHERE type = 'PLAYER_KICKED'`,
		)
		expect(kicks.map((k) => k.actorPluginId)).toEqual(['afk-kicker'])
		const kicked = readRows<{ value: string }>(
			`SELECT value FROM appEventAssociations WHERE appEventId = ? AND dimension = 'player'`,
			kicks[0].id,
		)
		expect(kicked.map((r) => r.value)).toEqual([idler.eos])

		await client.plugins.setEnabled({ pluginId: 'afk-kicker', enabled: false })
	})

	it('disabling over oRPC deactivates the plugin and stops evaluation', async () => {
		const res = await client.plugins.setEnabled({ pluginId: 'balance-triggers', enabled: false })
		expect(res).toMatchObject({ code: 'ok', status: 'inactive' })
		const [row] = readRows<{ enabled: number }>(`SELECT enabled FROM plugins WHERE id = 'balance-triggers'`)
		expect(row?.enabled).toBe(0)

		// the finalized$ subscription is torn down synchronously at deactivation, so this end cannot evaluate
		const before = readRows(`SELECT id FROM p_balance_triggers_events`).length
		await endMatchDecided(2)
		expect(readRows(`SELECT id FROM p_balance_triggers_events`).length).toBe(before)

		const rpcRes = await firstYield(
			(signal) =>
				client.plugins.rpcStream(
					{ pluginId: 'balance-triggers', path: ['activeEvents'], serverId: app.serverId, input: {} },
					{ signal },
				),
			{ label: 'the plugin stream after deactivation' },
		)
		expect(rpcRes).toMatchObject({ code: 'err:unknown-rpc' })
	})
})
