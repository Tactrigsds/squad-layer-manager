import type * as Http from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ControlEnv from './env.ts'
import * as Log from './log.ts'
import type * as Registry from './registry.ts'

// The broker runs two oauth flows against one application: signing in, and adding the app to a server. They share
// a state map, and what keeps them apart is that a state records which flow it was minted for. Getting that wrong
// would let a code obtained from one be redeemed at the other, so it is asserted rather than assumed.
//
// Everything here stops before the token exchange, which is where the network would start.

const instance: Registry.Instance = {
	id: 'g1',
	kind: 'guild',
	guildId: '123456789012345678',
	slug: null,
	slot: 0,
	state: 'running',
	lastActiveAt: 0,
	createdAt: 0,
	crashCount: 0,
	pid: null,
}

vi.mock('./registry.ts', async (importOriginal) => ({
	...(await importOriginal<typeof Registry>()),
	byGuild: (guildId: string) => (guildId === instance.guildId ? instance : undefined),
}))

const Broker = await import('./broker.ts')

function recorder() {
	const seen = { status: 0, location: undefined as unknown, body: '' }
	const res = {
		writeHead(status: number, headers?: Record<string, unknown>) {
			seen.status = status
			seen.location = headers?.location
			return res
		},
		end(body?: string) {
			seen.body = body ?? ''
		},
	}
	return { seen, res: res as unknown as Http.ServerResponse }
}

const req = {} as Http.IncomingMessage
const apex = 'https://demo.example.com'

// the redirect a start-of-flow handler issues, parsed
async function startFlow(kind: 'login' | 'install') {
	const { seen, res } = recorder()
	if (kind === 'login') await Broker.startLogin(req, res, new URL(`${apex}/go/${instance.guildId}`))
	else await Broker.startInstall(req, res, new URL(`${apex}${Broker.INSTALL_PATH}`))
	expect(seen.status).toBe(302)
	return new URL(String(seen.location))
}

function callbackUrl(path: string, state: string) {
	return new URL(`${apex}${path}?code=irrelevant&state=${encodeURIComponent(state)}`)
}

beforeEach(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('DEMO_')) delete process.env[key]
	}
	Object.assign(process.env, {
		DEMO_BASE_DOMAIN: 'demo.example.com',
		DEMO_DISCORD_CLIENT_ID: 'client',
		DEMO_DISCORD_CLIENT_SECRET: 'secret',
		DEMO_DISCORD_BOT_TOKEN: 'token',
	})
	ControlEnv.setup()
	Log.setup()
	Broker.setup()
})

describe('the authorize urls', () => {
	it('asks for the bot scope only when installing, and for no permissions with it', async () => {
		const install = await startFlow('install')
		expect(install.searchParams.get('scope')).toBe('bot identify guilds')
		expect(install.searchParams.get('permissions')).toBe('0')
		expect(install.searchParams.get('redirect_uri')).toBe(`${apex}${Broker.INSTALLED_PATH}`)

		const login = await startFlow('login')
		expect(login.searchParams.get('scope')).toBe('identify guilds')
		expect(login.searchParams.get('permissions')).toBeNull()
		expect(login.searchParams.get('redirect_uri')).toBe(`${apex}${Broker.CALLBACK_PATH}`)
	})

	// discord requires the token exchange to present the same redirect_uri as the authorize request, so the two
	// flows cannot share one
	it('gives the two flows different redirect uris', async () => {
		const install = await startFlow('install')
		const login = await startFlow('login')
		expect(install.searchParams.get('redirect_uri')).not.toBe(login.searchParams.get('redirect_uri'))
	})
})

describe('state', () => {
	it('refuses an install state offered to the login callback', async () => {
		const state = (await startFlow('install')).searchParams.get('state')!
		const { seen } = await complete('login', state)
		expect(seen.status).toBe(400)
	})

	it('refuses a login state offered to the install callback', async () => {
		const state = (await startFlow('login')).searchParams.get('state')!
		const { seen } = await complete('install', state)
		// the install callback sends people to the portal rather than showing an error: by the time they are here
		// the app has been added either way
		expect(seen.status).toBe(302)
		expect(seen.location).toBe(`${apex}/`)
	})

	it('spends a state on the first attempt, whichever flow makes it', async () => {
		const state = (await startFlow('install')).searchParams.get('state')!
		await complete('login', state)
		const { seen } = await complete('install', state)
		expect(seen.status).toBe(302)
		expect(seen.location).toBe(`${apex}/`)
	})

	it('refuses a state nobody minted', async () => {
		const { seen } = await complete('login', 'made-up')
		expect(seen.status).toBe(400)
	})
})

async function complete(kind: 'login' | 'install', state: string) {
	const { seen, res } = recorder()
	if (kind === 'login') await Broker.completeLogin(req, res, callbackUrl(Broker.CALLBACK_PATH, state))
	else await Broker.completeInstall(req, res, callbackUrl(Broker.INSTALLED_PATH, state))
	return { seen }
}
