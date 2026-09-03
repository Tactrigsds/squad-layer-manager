import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as FB from '@/models/filter-builders'
import type * as SC from '@/models/server-console.models'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { filter, role } from '../harness/arrange'
import { createOrpcClient, firstYield, type TestOrpcClient } from '../harness/orpc-client'

// Server-side gates, asserted over oRPC with the protocol the browser speaks. The client hides buttons and
// disables entries, but nothing stops a caller from asking anyway -- these assert the handlers themselves
// refuse. Filter integrity first (deletion of a referenced filter, cyclical references), then the console
// stream's permission check, which is what stands between an ordinary dashboard user and every player's IP,
// steam and eos id.

const DASHBOARD_ONLY: TestUser = { discordId: 900000000000000051n, username: 'test-dashboard-only' }
const CONSOLE_READER: TestUser = { discordId: 900000000000000052n, username: 'test-console-reader' }

let app: AppFixture
let adminClient: TestOrpcClient
let dashboardOnlyClient: TestOrpcClient
let consoleReaderClient: TestOrpcClient

beforeAll(async () => {
	app = await createAppFixture({
		filters: [
			filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
			filter('raas-harju', 'RAAS on Harju', FB.and([FB.includedIn('raas-only'), FB.eq('Map', 'Harju')])),
			filter('pool-only', 'Pool Only', FB.and([FB.eq('Gamemode', 'AAS')])),
			filter('unused', 'Unused', FB.and([FB.eq('Gamemode', 'Invasion')])),
		],
		serverSettings: (settings) => {
			settings.queue.mainPool.poolFilter = { filterId: 'pool-only', mode: 'include' }
		},
		users: [DASHBOARD_ONLY, CONSOLE_READER],
		unreachableServer: true,
		globalSettings: (settings) => {
			// can see the dashboard, pointedly not the console
			settings.rbac.roles['dashboard-only'] = role(['site:authorized', 'squad-server:view'], { users: [DASHBOARD_ONLY] })
			settings.rbac.roles['console-reader'] = role(['site:authorized', 'squad-server:view', 'squad-server:view-console'], {
				users: [CONSOLE_READER],
			})
		},
	})
	adminClient = await createOrpcClient(app)
	dashboardOnlyClient = await createOrpcClient(app, DASHBOARD_ONLY)
	consoleReaderClient = await createOrpcClient(app, CONSOLE_READER)
}, 120_000)

afterAll(async () => {
	// deliberately not closing the clients: see the teardown note in orpc-client.ts. Disposing the app takes
	// their connections with it.
	await app?.dispose()
})

describe('deleteFilter', () => {
	it('refuses a filter another filter applies', async () => {
		const res = await adminClient.filters.deleteFilter('raas-only')
		expect(res.code).toBe('err:filter-in-use')
		expect(res.code === 'err:filter-in-use' && res.references).toContainEqual({ type: 'filter-entity', filterId: 'raas-harju' })
	})

	it('refuses a filter a pool is configured with', async () => {
		const res = await adminClient.filters.deleteFilter('pool-only')
		expect(res.code).toBe('err:filter-in-use')
		expect(res.code === 'err:filter-in-use' && res.references).toContainEqual({
			type: 'pool-config',
			serverId: app.serverId,
			key: 'poolFilter',
			via: [],
		})
	})

	it('deletes a filter nothing references', async () => {
		expect((await adminClient.filters.deleteFilter('unused')).code).toBe('ok')
	})
})

describe('cyclical references', () => {
	it('refuses an update that would close a loop', async () => {
		const res = await adminClient.filters.updateFilter(['raas-only', { filter: FB.and([FB.includedIn('raas-harju')]) }])
		expect(res.code).toBe('err:cyclical-reference')
		expect(res.code === 'err:cyclical-reference' && res.cycle).toEqual(['raas-only', 'raas-harju', 'raas-only'])
	})

	it('allows an update that only deepens the chain', async () => {
		const res = await adminClient.filters.updateFilter(['raas-only', { filter: FB.and([FB.includedIn('pool-only')]) }])
		expect(res.code).toBe('ok')
	})
})

describe('serverConsole.watch', () => {
	it('refuses a user holding squad-server:view but not view-console', async () => {
		const client = dashboardOnlyClient
		const first = await firstYield((signal) => client.serverConsole.watch({ serverId: app.serverId }, { signal }), {
			label: 'the denial',
		})

		expect(first.code).toBe('err:permission-denied')
		// and it denies by refusing to send anything, not by sending the traffic with a flag attached
		expect(first.events).toEqual([])
	})

	it('streams the traffic to a user who holds view-console', async () => {
		const client = consoleReaderClient
		const first = await firstYield((signal) => client.serverConsole.watch({ serverId: app.serverId }, { signal }), {
			label: 'the console backlog',
		})

		expect(first.code).toBe('ok')
		// the app polls the server on a timer, so a slice that has been up has rcon traffic behind it already
		expect(first.events.length).toBeGreaterThan(0)
		expect(first.events.some((e) => e.type === 'rcon')).toBe(true)
	})

	// The console is opened to find out why a server is down, so it has to keep working across the moment it goes
	// down. A stream that ends with the managed server is not retried by the client, so before the channel outlived
	// the server this left every open console frozen at the teardown and dead thereafter, even once it came back.
	it('keeps streaming across a stop and start of the server', async () => {
		const seen: SC.ConsoleEvent[] = []
		const ac = new AbortController()
		const collecting = (async () => {
			for await (const res of await consoleReaderClient.serverConsole.watch({ serverId: app.serverId }, { signal: ac.signal })) {
				if (res.code === 'ok') seen.push(...res.events)
			}
		})().catch(() => {})

		const slmMessages = () => seen.filter((e) => e.type === 'slm').map((e) => e.message)
		try {
			await app.waitFor(() => seen.length > 0 || null, { label: 'the console backlog to arrive' })

			await adminClient.settings.admin.disableServer({ serverId: app.serverId })
			await app.waitFor(() => slmMessages().some((m) => m.includes('stopped')) || null, { label: 'the stop to reach the console' })

			await adminClient.settings.admin.enableServer({ serverId: app.serverId })
			// the same subscription has to see this. Under the old lifetime it had already ended at the stop above.
			await app.waitFor(() => slmMessages().some((m) => m.includes('Starting server')) || null, {
				label: 'the restart to reach the same subscription',
				timeoutMs: 60_000,
			})
		} finally {
			ac.abort()
			await collecting
		}
	}, 120_000)

	it('carries what a player said in game', async () => {
		const client = consoleReaderClient
		const talker = makePlayer({ name: ' integ_talker', teamId: 1 })
		app.emu.world.connectPlayer(talker)
		await app.waitForRosterSync()
		app.emu.world.chat(talker, 'ChatAll', 'said over rcon')

		const seen = await app.waitFor(
			async () => {
				const first = await firstYield((signal) => client.serverConsole.watch({ serverId: app.serverId }, { signal }), {
					label: 'the console backlog',
				})
				if (first.code !== 'ok') return null
				return first.events.find((e) => e.type === 'command' && e.message === 'said over rcon') ?? null
			},
			{ label: 'the chat message to reach the console', timeoutMs: 30_000 },
		)

		expect(seen).toMatchObject({ type: 'command', channel: 'ChatAll', message: 'said over rcon' })
	})
})

// A server whose rcon has never connected has no match in its history. Both of these streams read the current match
// on subscribe, so before they handled its absence each died with a 500 for the whole client and neither retried: no
// filter or repeat indicators on any queue row, and an empty chat feed. Every other fixture seeds a match before a
// client connects, which is what hid it. Both are asserted in one test because the layer status can only answer once
// rcon has exhausted its retries, which takes most of the run time.
describe('a server with no recorded match', () => {
	it('still streams its layer status and its chat events', async () => {
		const serverId = app.unreachableServerId!
		const untilLoaded = async <T>(call: () => Promise<T | null>, label: string) => await app.waitFor(call, { label, timeoutMs: 90_000 })

		const [status, events] = await Promise.all([
			untilLoaded(async () => {
				const res = await firstYield((signal) => adminClient.squadServer.watchLayersStatus({ serverId }, { signal }), {
					label: 'the layers status',
					timeoutMs: 40_000,
				})
				return res.code === 'ok' ? res : null
			}, 'the layers status'),
			untilLoaded(async () => {
				const res = await firstYield((signal) => adminClient.squadServer.watchChatEvents({ serverId }, { signal }), {
					label: 'the chat backlog',
				})
				return Array.isArray(res) ? res : null
			}, 'the chat backlog'),
		])

		expect(status.data.currentLayer).toBeNull()
		expect(status.data.currentMatch).toBeUndefined()
		expect(events.map((e) => e.type)).toContain('SYNCED')
	}, 120_000)
})
