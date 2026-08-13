import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { role } from '../harness/arrange'
import { createOrpcClient, firstYield, type TestOrpcClient } from '../harness/orpc-client'

// A scoped server reaches only its owner. The default admin is a super user, so asserting its exclusion is the strong
// case: even the everything-everywhere wildcard grants a super user holds do not reach a scoped server, while the
// owner's implicit grant (which it holds by nothing more than owning the server) does.

const OWNER: TestUser = { discordId: 900000000000000061n, username: 'test-scoped-owner' }
const SCOPED_ID = 'tutorial-owner'

let app: AppFixture
let adminClient: TestOrpcClient
let ownerClient: TestOrpcClient

beforeAll(async () => {
	app = await createAppFixture({
		users: [OWNER],
		scopedServers: [{ id: SCOPED_ID, displayName: 'Owner Tutorial', owner: OWNER }],
		globalSettings: (settings) => {
			// site access only: the owner's control of the scoped server is the implicit grant, not a granted role
			settings.rbac.roles['tutorial-user'] = role(['site:authorized'], { users: [OWNER] })
		},
	})
	adminClient = await createOrpcClient(app)
	ownerClient = await createOrpcClient(app, OWNER)
}, 120_000)

afterAll(async () => {
	// see the teardown note in orpc-client.ts: disposing the app takes the clients' connections with it
	await app?.dispose()
})

async function deliveredServerIds(client: TestOrpcClient): Promise<string[]> {
	const settings = await firstYield((signal) => client.settings.public.watchPublicSettings(undefined, { signal }), {
		label: 'public settings',
	})
	return settings.servers.map((s) => s.id)
}

describe('scoped server visibility', () => {
	it('is delivered to its owner alongside the public server', async () => {
		const ids = await deliveredServerIds(ownerClient)
		expect(ids).toContain(SCOPED_ID)
		expect(ids).toContain(app.serverId)
	})

	it('is withheld from a super user who does not own it', async () => {
		const ids = await deliveredServerIds(adminClient)
		expect(ids).toContain(app.serverId)
		expect(ids).not.toContain(SCOPED_ID)
	})
})

describe('scoped server access', () => {
	it('refuses a super user a server-scoped action on it', async () => {
		const first = await firstYield((signal) => adminClient.serverConsole.watch({ serverId: SCOPED_ID }, { signal }), {
			label: 'the denial',
		})
		expect(first.code).toBe('err:permission-denied')
	})

	it('allows the owner, whose implicit grant names it', async () => {
		const first = await firstYield((signal) => ownerClient.serverConsole.watch({ serverId: SCOPED_ID }, { signal }), {
			label: 'the owner console',
		})
		expect(first.code).toBe('ok')
	})

	it('leaves the super user free on the public server', async () => {
		const first = await firstYield((signal) => adminClient.serverConsole.watch({ serverId: app.serverId }, { signal }), {
			label: 'the public console',
		})
		expect(first.code).toBe('ok')
	})
})
