import * as Http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as DemoToken from '@/lib/demo-login-token'
import * as DP from '@/models/discord-proxy.models'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { createOrpcClientWithCookie, type TestOrpcClient } from '../harness/orpc-client'

// A demo-fleet guild instance, booted the way the spawner boots one: DISCORD_MODE=proxy against a stub control
// plane, the broker's public key in the environment, and -- the part that only this configuration exercises -- an
// EMPTY globalSettings table, so the app's own fresh-install seeding runs with the fleet roles merged in. That
// seeding once produced a settings object the schema could not encode, which crashed every guild instance on its
// first boot; the beforeAll here is the regression test for it.

const GUILD_ID = '910000000000000001'
const OTHER_GUILD_ID = '910000000000000002'
const ADMIN_ROLE_ID = '920000000000000001'
const PROXY_SECRET = 'test-proxy-secret-0123456789'
const BROKER_URL = 'http://broker.localtest.me'

type StubMember = { id: string; username: string; roleIds: string[]; holdsManageGuild: boolean }
const INSTALLER: StubMember = { id: '900000000000000201', username: 'installer', roleIds: [ADMIN_ROLE_ID], holdsManageGuild: true }
const MEMBER: StubMember = { id: '900000000000000202', username: 'plain-member', roleIds: [], holdsManageGuild: false }

// The control plane's guild-scoped api, reduced to what this instance asks of it. Everything the app knows about
// its guild flows through here, which is also what makes membership assertable: whoever this stub answers for is
// a member, everyone else is not.
function startStubControlPlane(): Promise<{ port: number; close: () => void }> {
	const members = new Map([INSTALLER, MEMBER].map((m) => [m.id, m]))
	const server = Http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(body))
		}
		if (req.headers[DP.SECRET_HEADER] !== PROXY_SECRET) return send(401, { code: 'err:unauthorized' })
		switch (url.pathname) {
			case `${DP.API_PREFIX}guild`:
				return send(200, { id: GUILD_ID, name: 'Fleet Test Guild' } satisfies DP.Guild)
			case `${DP.API_PREFIX}guild/member`: {
				const member = members.get(url.searchParams.get('id') ?? '')
				if (!member) return send(404, { code: 'err:not-found' })
				return send(200, {
					id: member.id,
					username: member.username,
					globalName: null,
					displayName: member.username,
					avatarUrl: 'https://cdn.example.com/avatar.png',
					displayHexColor: null,
					roleIds: member.roleIds,
					holdsManageGuild: member.holdsManageGuild,
				} satisfies DP.Member)
			}
			case `${DP.API_PREFIX}guild/roles`:
				return send(200, { roles: [{ id: ADMIN_ROLE_ID, name: 'Admins', color: null }] })
			default:
				return send(404, { code: 'err:not-found' })
		}
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port
			resolve({ port, close: () => server.close() })
		})
	})
}

let app: AppFixture
let stub: { port: number; close: () => void }
let keys: DemoToken.Keypair

function mintToken(member: StubMember, opts: { guildId?: string; now?: number } = {}): string {
	return DemoToken.sign(
		keys.privateKey,
		{ guildId: opts.guildId ?? GUILD_ID, discordId: member.id, username: member.username, canConfigure: member.holdsManageGuild },
		opts.now,
	)
}

async function redeemToken(token: string) {
	const res = await fetch(`${app.appUrl}/login/token?t=${encodeURIComponent(token)}`, {
		redirect: 'manual',
		signal: AbortSignal.timeout(10_000),
	})
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)
	return { res, cookie }
}

beforeAll(async () => {
	keys = DemoToken.generateKeypair()
	stub = await startStubControlPlane()
	app = await createAppFixture({
		// the subject of this suite: the app must seed its own settings, fleet roles included
		seedGlobalSettings: false,
		// with the settings unseeded, seedSandboxServer keeps its default and this app would boot a whole second
		// in-process squad server -- RCON load the rest of the suite's poll timings were not tuned against.
		// Registering the fixture's own server under the sandbox's id makes that seeding skip itself.
		serverId: 'sandbox',
		// the harness's admin list lives in the global settings this suite deliberately does not write
		serverSettings: (settings) => {
			settings.adminLists = []
		},
		// what the spawner hands a guild instance (see demo-control/spawner buildEnv), minus what the fixture
		// already provides. Empty strings unset the fixture's own discord defaults: env setup drops them, and
		// proxy mode both fills the credentials in and refuses a bot token outright.
		env: {
			DISCORD_MODE: 'proxy',
			DISCORD_ENABLED: '',
			DISCORD_CLIENT_ID: '',
			DISCORD_CLIENT_SECRET: '',
			DISCORD_BOT_TOKEN: '',
			DISCORD_HOME_GUILD_ID: GUILD_ID,
			DISCORD_PROXY_URL: `http://127.0.0.1:${stub.port}`,
			DISCORD_PROXY_SECRET: PROXY_SECRET,
			DEMO_BROKER_URL: BROKER_URL,
			DEMO_LOGIN_TOKEN_PUBKEY: keys.publicKey,
			QUERY_PARAM_AUTH_BYPASS: 'false',
			// nobody deploys a guild instance, so nobody sets this; Manage Guild in the stub is the anti-lockout
			SUPER_USERS: '',
		},
	})
}, 120_000)

afterAll(async () => {
	await app?.dispose()
	stub?.close()
})

describe('fresh-boot seeding', () => {
	it('seeds the fleet roles into the settings it writes, in the parsed shape', () => {
		const db = app.readDb()
		try {
			const row = db.prepare('SELECT settings FROM globalSettings').get() as { settings: string }
			// the column is superjson-wrapped; the payload is under .json
			const roles = JSON.parse(row.settings).json.rbac.roles
			expect(roles['guild-members'].assignments.everyMember).toBe(true)
			// present and empty, not absent: the row must hold what the schema parses to, or the next boot's
			// decode and every in-memory reader of GLOBAL_SETTINGS breaks
			expect(roles['guild-owners'].assignments.discordRoleIds).toEqual([])
			expect(roles['guild-owners'].permissions).toEqual(['*'])
		} finally {
			db.close()
		}
	})
})

describe('broker token login', () => {
	it('bounces /login to the broker, naming its own guild', async () => {
		const res = await fetch(`${app.appUrl}/login`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`${BROKER_URL}/go/${GUILD_ID}`)
	})

	it('rejects a request with no token', async () => {
		const res = await fetch(`${app.appUrl}/login/token`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
		expect(res.status).toBe(400)
	})

	it('rejects a token minted for another guild', async () => {
		const { res, cookie } = await redeemToken(mintToken(MEMBER, { guildId: OTHER_GUILD_ID }))
		expect(res.status).toBe(403)
		expect(cookie).toBeUndefined()
	})

	it('rejects an expired token', async () => {
		const { res } = await redeemToken(mintToken(MEMBER, { now: Date.now() - DemoToken.TTL_MS - 1000 }))
		expect(res.status).toBe(403)
	})

	it('rejects a token signed by the wrong key', async () => {
		const impostor = DemoToken.generateKeypair()
		const forged = DemoToken.sign(impostor.privateKey, {
			guildId: GUILD_ID,
			discordId: MEMBER.id,
			username: MEMBER.username,
			canConfigure: true,
		})
		const { res } = await redeemToken(forged)
		expect(res.status).toBe(403)
	})

	it('signs a member in exactly once per token', async () => {
		const token = mintToken(MEMBER)
		const first = await redeemToken(token)
		expect(first.res.status).toBe(302)
		expect(first.res.headers.get('location')).toBe('/')
		expect(first.cookie).toMatch(/^session-id=.+/)

		const authed = await fetch(`${app.appUrl}/check-auth`, { headers: { cookie: first.cookie! }, redirect: 'manual' })
		expect(authed.status).toBe(200)

		// the replay: same signature, same nonce, no second session
		const replayed = await redeemToken(token)
		expect(replayed.res.status).toBe(403)
		expect(replayed.cookie).toBeUndefined()
	})
})

// The dialog's whole server side, in the order the fleet expects it to happen: a plain member can look but not
// pick, the Manage Guild holder picks once, and the pick is permanent from this surface.
describe('first-login role pick', () => {
	let memberClient: TestOrpcClient
	let installerClient: TestOrpcClient

	beforeAll(async () => {
		const member = await redeemToken(mintToken(MEMBER))
		const installer = await redeemToken(mintToken(INSTALLER))
		memberClient = await createOrpcClientWithCookie(app, member.cookie!)
		installerClient = await createOrpcClientWithCookie(app, installer.cookie!)
	})

	it('shows a plain member the state but not the choice', async () => {
		const state = await memberClient.demoFleet.setupState(undefined)
		expect(state).toMatchObject({ code: 'ok', applies: true, chosenRoleId: null, canChoose: false })
	})

	it('refuses a pick from a member without Manage Guild', async () => {
		const res = await memberClient.demoFleet.chooseFullAccessRole({ roleId: ADMIN_ROLE_ID })
		expect(res.code).toBe('err:permission-denied')
	})

	it('lets the Manage Guild holder pick the role that runs the instance', async () => {
		const before = await installerClient.demoFleet.setupState(undefined)
		expect(before).toMatchObject({ code: 'ok', applies: true, chosenRoleId: null, canChoose: true })

		const res = await installerClient.demoFleet.chooseFullAccessRole({ roleId: ADMIN_ROLE_ID })
		expect(res.code).toBe('ok')

		const after = await installerClient.demoFleet.setupState(undefined)
		expect(after).toMatchObject({ code: 'ok', applies: true, chosenRoleId: ADMIN_ROLE_ID })
	})

	it('refuses a second pick; the settings page owns the role from here', async () => {
		const res = await installerClient.demoFleet.chooseFullAccessRole({ roleId: ADMIN_ROLE_ID })
		expect(res.code).toBe('err:already-chosen')
	})
})
