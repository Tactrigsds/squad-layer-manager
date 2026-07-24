import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_USER, type AppFixture, createAppFixture } from '../harness/app-fixture'

// Regression: POST /logout used to deadlock. Sessions.logout awaited clearInvalidSession, which returns the
// FastifyReply, and a reply is a thenable that only settles once the response is sent -- so the handler blocked
// forever waiting for a send it was itself holding up. The request never got a response.

let app: AppFixture

beforeAll(async () => {
	app = await createAppFixture()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('POST /logout', () => {
	it('responds instead of hanging on the thenable reply', async () => {
		const base = `http://127.0.0.1:${app.appPort}`

		// mint a session via the query-param auth bypass (enabled in the test env)
		const login = await fetch(`${base}/check-auth?login=${ADMIN_USER.username}`, { redirect: 'manual' })
		expect(login.status).toBe(200)
		const sessionCookie = login.headers.getSetCookie()
			.map((c) => c.split(';')[0])
			.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)
		expect(sessionCookie).toMatch(/^session-id=.+/)

		// the deadlock never sent a response, so a short timeout is what turns the hang into a failed assertion
		// rather than a stuck test
		const res = await fetch(`${base}/logout`, {
			method: 'POST',
			headers: { cookie: sessionCookie! },
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
		})
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe('/')
		// the session cookie is cleared
		expect(res.headers.getSetCookie().some((c) => c.startsWith('session-id=;') || /Max-Age=0/.test(c))).toBe(true)
	})
})
