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
// layer the emulator boots on is a session breaker and never counts.

const ADMIN_STEAM_ID = '76561198000000001'

let app: AppFixture
let client: TestOrpcClient
// in game so the post-roll reminder the plugin contributes has somewhere to land
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID })

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.narvaRaas),
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

		await app.waitFor(
			() =>
				readRows<{ actorPluginId: string }>(
					`SELECT actorPluginId FROM appEvents WHERE type = 'PLUGIN_EVENT' AND actorType = 'plugin'`,
				).find((r) => r.actorPluginId === 'balance-triggers'),
			{ label: 'the PLUGIN_EVENT audit row attributed to the plugin' },
		)
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
