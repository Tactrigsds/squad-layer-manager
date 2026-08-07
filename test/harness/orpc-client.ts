import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { RouterClient } from '@orpc/server'
import { WebSocket } from 'ws'

import * as AR from '@/app-routes'
import type { OrpcAppRouter } from '@/server/orpc-app-router'

import { ADMIN_USER, type AppFixture, type TestUser } from './app-fixture'

// An oRPC client speaking the same protocol the browser does, for asserting what a procedure does for a given
// user. The permission checks live inside the handlers, so a UI test can only ever show that the client hid a
// button -- this is how a test says the server itself refuses.

export type TestOrpcClient = RouterClient<OrpcAppRouter> & { close: () => void }

// Note on teardown: do NOT close a client while the app is still up. oRPC rejects whatever subscription the
// socket was carrying, nothing is awaiting that promise by then, and vitest reports the unhandled rejection as a
// run-level error even though every test passed. Let the client live for the fixture's lifetime -- disposing the
// app takes the connection down with the process it belonged to. `close` exists for tests that outlive their app.

async function sessionCookie(app: AppFixture, user: TestUser): Promise<string> {
	const res = await fetch(`${app.appUrl}${AR.route('/check-auth')}?login=${encodeURIComponent(user.username)}`, {
		redirect: 'manual',
	})
	if (!res.ok) throw new Error(`login for ${user.username} failed: ${res.status} ${await res.text()}`)
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)
	if (!cookie) throw new Error(`login for ${user.username} returned no session cookie`)
	return cookie
}

export async function createOrpcClient(app: AppFixture, user: TestUser = ADMIN_USER): Promise<TestOrpcClient> {
	return await createOrpcClientWithCookie(app, await sessionCookie(app, user))
}

// For an app whose login is not the query-param bypass (e.g. a demo-fleet guild instance, where the session
// comes from a broker token): the caller obtains the cookie however that app's login works.
export async function createOrpcClientWithCookie(app: AppFixture, cookie: string): Promise<TestOrpcClient> {
	const wsUrl = `${app.appUrl.replace(/^http/, 'ws')}${AR.route('/orpc')}`
	// the browser sends the session cookie automatically; here it has to be set on the upgrade request
	const websocket = new WebSocket(wsUrl, { headers: { cookie } })

	await new Promise<void>((resolve, reject) => {
		websocket.once('open', () => resolve())
		websocket.once('error', reject)
	})

	const link = new RPCLink({ websocket: websocket as unknown as globalThis.WebSocket })
	const client = createORPCClient<RouterClient<OrpcAppRouter>>(link)
	return Object.assign(client, { close: () => websocket.close() })
}

// The first message an event-stream procedure yields, which for the permission-checked ones is the allow/deny
// verdict. Times out rather than hanging: a handler that yields nothing is a failure worth reading as one.
//
// Takes the call rather than the stream so it can hand it a signal and abort it afterwards. A subscription left
// live is torn down by the socket closing instead, and oRPC surfaces that as a rejection nothing is awaiting --
// an unhandled rejection that fails the run from outside any test.
export async function firstYield<T>(
	call: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
	opts?: { timeoutMs?: number; label?: string },
): Promise<T> {
	const timeoutMs = opts?.timeoutMs ?? 15_000
	const ac = new AbortController()
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${opts?.label ?? 'the first yield'}`)), timeoutMs)
	})
	try {
		const stream = await Promise.race([call(ac.signal), timeout])
		const result = await Promise.race([stream[Symbol.asyncIterator]().next(), timeout])
		if (result.done) throw new Error(`${opts?.label ?? 'the stream'} ended without yielding`)
		return result.value
	} finally {
		clearTimeout(timer)
		ac.abort()
	}
}
