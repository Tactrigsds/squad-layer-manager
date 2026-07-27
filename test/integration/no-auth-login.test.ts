import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'

// The login portal that stands in for discord oauth when authentication is off (DEMO, or a dev instance's
// QUERY_PARAM_AUTH_BYPASS). A name typed into it is the whole identity, so posting one has to create the user
// and mint a session; DEMO additionally makes that user an administrator, which is what lets this test read an
// authenticated route with a session it invented.

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture({ env: { DEMO: '1' } })
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('no-auth login portal', () => {
	const base = () => `http://127.0.0.1:${app.appPort}`

	it('serves the username form to an unauthenticated visitor', async () => {
		const res = await fetch(`${base()}/`, { redirect: 'manual' })
		expect(res.status).toBe(200)
		const html = await res.text()
		expect(html).toContain('/login/no-auth')
		// the discord flow is not registered at all when authentication is off
		expect(html).not.toContain('Log in with Discord')
	})

	it('signs in a name it has never seen before', async () => {
		const res = await fetch(`${base()}/login/no-auth`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ username: 'Newcomer' }),
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
		})
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe('/')
		const sessionCookie = res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)
		expect(sessionCookie).toMatch(/^session-id=.+/)

		// under DEMO every signed-in user holds every permission, so the new user reaches an authed route
		const authed = await fetch(`${base()}/check-auth`, { headers: { cookie: sessionCookie! }, redirect: 'manual' })
		expect(authed.status).toBe(200)
	})

	it('rejects a username the schema will not take', async () => {
		const res = await fetch(`${base()}/login/no-auth`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ username: '  ' }),
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
		})
		expect(res.status).toBe(400)
		expect(await res.text()).toContain('/login/no-auth')
	})
})
