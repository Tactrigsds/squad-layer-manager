import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import type * as SC from '@/models/server-console.models'
import type * as SETTINGS from '@/models/settings.models'
import type * as RBAC from '@/rbac.models'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { createOrpcClient, firstYield, type TestOrpcClient } from '../harness/orpc-client'

// The console's permission is what stands between an ordinary dashboard user and every player's IP, steam and eos
// id, the admin chat and every admin action. The e2e tests assert the client hides the entry; these assert the
// server refuses to stream regardless of what the client asked for, which is the half that actually protects it.

const DASHBOARD_ONLY: TestUser = { discordId: 900000000000000051n, username: 'test-dashboard-only' }
const CONSOLE_READER: TestUser = { discordId: 900000000000000052n, username: 'test-console-reader' }

let app: AppFixture
let dashboardOnlyClient: TestOrpcClient
let consoleReaderClient: TestOrpcClient

type RoleConfig = SETTINGS.GlobalSettings['rbac']['roles'][string]

function role(permissions: RBAC.RolePermissionExpression[], user: TestUser): RoleConfig {
	return {
		permissions,
		globalSettingsGrants: [],
		serverSettingsGrants: [],
		serverGrants: [],
		assignments: {
			discordRoleIds: [],
			discordUserIds: [String(user.discordId)],
			everyMember: false,
			ingameAdminLists: [],
			adminListGroups: [],
		},
	}
}

beforeAll(async () => {
	app = await createAppFixture({
		users: [DASHBOARD_ONLY, CONSOLE_READER],
		globalSettings: (settings) => {
			// can see the dashboard, pointedly not the console
			settings.rbac.roles['dashboard-only'] = role(['site:authorized', 'squad-server:view'], DASHBOARD_ONLY)
			settings.rbac.roles['console-reader'] = role(['site:authorized', 'squad-server:view', 'squad-server:view-console'], CONSOLE_READER)
		},
	})
	dashboardOnlyClient = await createOrpcClient(app, DASHBOARD_ONLY)
	consoleReaderClient = await createOrpcClient(app, CONSOLE_READER)
}, 120_000)

afterAll(async () => {
	// deliberately not closing the clients: see the teardown note in orpc-client.ts. Disposing the app takes
	// their connections with it.
	await app?.dispose()
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
		const adminClient = await createOrpcClient(app, app.adminUser)
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
