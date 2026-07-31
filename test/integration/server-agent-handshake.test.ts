import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type AppFixture, createAppFixture, SERVER_AGENT_TOKEN } from '../harness/app-fixture'

// The /server-agent handshake, driven directly rather than through the rust agent (see server-agent.test.ts
// for that): an agent declares which data sources it can supply and the app accepts it only if that covers
// both the log and RCON, since an agent-mode server has no other route to either.

let app: AppFixture

const CLOSE_UNAUTHORIZED = 4001
const CLOSE_INCOMPLETE_SOURCES = 4005

type HandshakeResult = { accepted: boolean; code?: number; reason?: string }

function connect(frame: string): { ws: WebSocket; settled: Promise<HandshakeResult> } {
	const ws = new WebSocket(`ws://127.0.0.1:${app.appPort}/server-agent`)
	const settled = new Promise<HandshakeResult>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no reply to handshake: ${frame}`)), 15_000)
		ws.on('open', () => ws.send(frame))
		ws.on('message', (data) => {
			clearTimeout(timer)
			resolve({ accepted: Buffer.isBuffer(data) && data.toString('utf8') === 'ok' })
		})
		ws.on('close', (code, reason) => {
			clearTimeout(timer)
			resolve({ accepted: false, code, reason: reason.toString() })
		})
		// a rejected socket can also surface as an error; the close that follows is what we report on
		ws.on('error', () => {})
	})
	return { ws, settled }
}

function handshake(sources: string | null, token = SERVER_AGENT_TOKEN) {
	const sourcesField = sources === null ? '' : `sources=${sources}:`
	return `slm-server-agent@0.3.0:${app.serverId}:${sourcesField}${token}`
}

beforeAll(async () => {
	app = await createAppFixture({ logSource: 'server-agent', startAgent: false })
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('server agent handshake', () => {
	it('rejects an agent that supplies logs but not rcon', async () => {
		const { ws, settled } = connect(handshake('logs'))
		const result = await settled
		ws.close()

		expect(result.accepted).toBe(false)
		expect(result.code).toBe(CLOSE_INCOMPLETE_SOURCES)
		expect(result.reason).toContain('rcon')
	})

	it('rejects an agent too old to declare its sources', async () => {
		const { ws, settled } = connect(handshake(null))
		const result = await settled
		ws.close()

		expect(result.accepted).toBe(false)
		expect(result.code).toBe(CLOSE_INCOMPLETE_SOURCES)
	})

	// the token is checked first, so an unauthenticated caller learns nothing about what the server wants
	it('rejects a bad token before looking at sources', async () => {
		const { ws, settled } = connect(handshake('logs', 'not-the-token'))
		const result = await settled
		ws.close()

		expect(result.code).toBe(CLOSE_UNAUTHORIZED)
	})

	it('accepts an agent supplying both', async () => {
		const { ws, settled } = connect(handshake('logs,rcon'))
		const result = await settled
		ws.close()

		expect(result.accepted).toBe(true)
	})
})
