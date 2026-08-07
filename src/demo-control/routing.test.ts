import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ControlEnv from './env.ts'
import type * as Registry from './registry.ts'

// Ingress and the reaper decide who a request belongs to and who has stopped being used. Both are pure functions
// over the registry, and both are the kind of thing that is wrong in one direction silently: a host resolved to
// the wrong instance serves somebody else's demo, and a policy that never fires fills the box.
//
// The registry is stubbed rather than opened, so these are the decisions under test and not sqlite.

const guildInstance: Registry.Instance = {
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
const ephemeralInstance: Registry.Instance = { ...guildInstance, id: 't1', kind: 'ephemeral', guildId: null, slug: 'abc123', slot: 1 }

vi.mock('./registry.ts', async (importOriginal) => ({
	...(await importOriginal<typeof Registry>()),
	byGuild: (guildId: string) => (guildId === guildInstance.guildId ? guildInstance : undefined),
	bySlug: (slug: string) => (slug === ephemeralInstance.slug ? ephemeralInstance : undefined),
}))

const Ingress = await import('./ingress.ts')
const Reaper = await import('./reaper.ts')
// the mock replaces only the two lookups; host/origin below are the real ones
const RegistryReal = await import('./registry.ts')

// Per-test rather than once, so a describe needing a differently-addressed fleet cannot depend on running after
// one that does not. Every DEMO_ var is cleared first, so what a test asserts is the schema's defaults and its
// own arguments rather than whatever the shell running it happens to export.
function configure(vars: Record<string, string>) {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('DEMO_')) delete process.env[key]
	}
	Object.assign(process.env, vars)
	ControlEnv.setup()
}

describe('ingress routing', () => {
	beforeEach(() => configure({ DEMO_BASE_DOMAIN: 'demo.example.com' }))

	it.each([
		['demo.example.com', 'apex'],
		['www.demo.example.com', 'apex'],
		['demo.example.com:8080', 'apex'],
		['DEMO.EXAMPLE.COM', 'apex'],
		['g-123456789012345678.demo.example.com', 'instance'],
		['t-abc123.demo.example.com', 'instance'],
		['g-999.demo.example.com', 'no-such-instance'],
		['t-nope.demo.example.com', 'no-such-instance'],
		['unlabelled.demo.example.com', 'no-such-instance'],
		// the fleet answers for its own domain and nothing else, however the request was addressed to it
		['demo.example.com.evil.test', 'unknown-host'],
		['evil.test', 'unknown-host'],
		[undefined, 'unknown-host'],
	])('routes %s to %s', (host, expected) => {
		expect(Ingress.resolve(host, '/servers/sandbox').code).toBe(expected)
	})

	// instances reach the control plane over loopback, where the Host header is an address rather than a name
	it('routes the fleet api by path, whatever the host header says', () => {
		expect(Ingress.resolve('127.0.0.1:8080', '/_fleet/guild/roles').code).toBe('fleet-api')
		expect(Ingress.resolve('t-abc123.demo.example.com', '/_fleet/guild/roles').code).toBe('fleet-api')
	})
})

// A fleet whose instances share an existing wildcard certificate instead of getting one of their own. Its apex
// is a sibling of the instances rather than their parent, and the base domain's own apex belongs to somebody
// else entirely.
describe('ingress routing under a host prefix', () => {
	beforeEach(() =>
		configure({
			DEMO_BASE_DOMAIN: 'example.com',
			DEMO_HOST_PREFIX: 'slm-demo-',
			DEMO_APEX_ORIGIN: 'https://slm-demo.example.com',
		}),
	)

	it.each([
		['slm-demo.example.com', 'apex'],
		['slm-demo-g-123456789012345678.example.com', 'instance'],
		['slm-demo-t-abc123.example.com', 'instance'],
		// the prefix is part of the name, not decoration: without it this is one of the base domain's own hosts
		['g-123456789012345678.example.com', 'no-such-instance'],
		['slm-demo-g-999.example.com', 'no-such-instance'],
		// whoever owns example.com, it is not the fleet
		['example.com', 'unknown-host'],
	])('routes %s to %s', (host, expected) => {
		expect(Ingress.resolve(host, '/').code).toBe(expected)
	})
})

// Every one of these is a url a browser is sent to and has to arrive at. A wrong scheme or a dropped port is a
// login that dead-ends rather than an error anybody sees.
describe('instance origins', () => {
	const guild = { ...guildInstance }

	it('defaults to https on the base domain', () => {
		configure({ DEMO_BASE_DOMAIN: 'demo.example.com' })
		expect(RegistryReal.origin(guild)).toBe('https://g-123456789012345678.demo.example.com')
	})

	// what local testing looks like: plain http on a port, against a wildcard resolver like localtest.me
	it('carries the apex scheme and port onto the instances', () => {
		configure({ DEMO_BASE_DOMAIN: 'localtest.me', DEMO_APEX_ORIGIN: 'http://localhost:8099' })
		expect(RegistryReal.origin(guild)).toBe('http://g-123456789012345678.localtest.me:8099')
	})

	it('includes the host prefix', () => {
		configure({ DEMO_BASE_DOMAIN: 'example.com', DEMO_HOST_PREFIX: 'slm-demo-' })
		expect(RegistryReal.origin(guild)).toBe('https://slm-demo-g-123456789012345678.example.com')
	})

	// the two have to stay inverses of each other, whatever the addressing
	it('resolves back to the instance it names', () => {
		configure({ DEMO_BASE_DOMAIN: 'example.com', DEMO_HOST_PREFIX: 'slm-demo-', DEMO_APEX_ORIGIN: 'http://slm-demo.example.com:8099' })
		const host = new URL(RegistryReal.origin(guild)).host
		expect(Ingress.resolve(host, '/').code).toBe('instance')
	})
})

describe('reaper policy', () => {
	const hour = 60 * 60 * 1000
	const fresh = { ...ephemeralInstance, createdAt: 0, lastActiveAt: 0 }

	// the thresholds asserted below are the schema's defaults, so nothing else is set
	beforeEach(() => configure({ DEMO_BASE_DOMAIN: 'demo.example.com' }))

	it('keeps an ephemeral instance somebody is still using', () => {
		expect(Reaper.judge({ ...fresh, lastActiveAt: 3 * hour }, 3 * hour + 60_000).reap).toBe(false)
	})

	it('reaps an ephemeral instance that went idle', () => {
		expect(Reaper.judge({ ...fresh, lastActiveAt: 0 }, 46 * 60 * 1000).reap).toBe(true)
	})

	// the hard cap is what stops a parked browser tab holding a slot forever: the proxy counts its frames as
	// activity, which is deliberate, so idleness alone would never fire
	it('reaps an ephemeral instance at its lifetime cap even while in use', () => {
		expect(Reaper.judge({ ...fresh, lastActiveAt: 4 * hour }, 4 * hour).reap).toBe(true)
	})

	it('gives a guild instance three days rather than forty-five minutes', () => {
		expect(Reaper.judge({ ...guildInstance, createdAt: 0, lastActiveAt: 0 }, 46 * 60 * 1000).reap).toBe(false)
		expect(Reaper.judge({ ...guildInstance, createdAt: 0, lastActiveAt: 0 }, 72 * hour).reap).toBe(true)
	})

	// a guild instance has no lifetime cap: it is somebody's, for as long as they keep using it
	it('never reaps a guild instance for age alone', () => {
		expect(Reaper.judge({ ...guildInstance, createdAt: 0, lastActiveAt: 365 * 24 * hour }, 365 * 24 * hour).reap).toBe(false)
	})
})
