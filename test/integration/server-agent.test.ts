import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture, SERVER_AGENT_TOKEN } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { latestMatch } from '../harness/inspect'

// The /server-agent transport. First the handshake, driven directly rather than through the rust agent: an
// agent declares which data sources it can supply and the app accepts it only if that covers both the log
// and RCON, since an agent-mode server has no other route to either. Then (skipped, see below) the full
// pipeline through the real rust agent.

let app: AppFixture

const CLOSE_UNAUTHORIZED = 4001
const CLOSE_INCOMPLETE_SOURCES = 4005
const CLOSE_DUPLICATE = 4009

type HandshakeResult = { accepted: boolean; code?: number; reason?: string }

function connect(frame: string, sources: string | null): { ws: WebSocket; settled: Promise<HandshakeResult> } {
	const query = sources === null ? '' : `?sources=${sources}`
	const ws = new WebSocket(`ws://127.0.0.1:${app.appPort}/server-agent${query}`)
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

function handshake(version = '0.3.0', token = SERVER_AGENT_TOKEN) {
	return `slm-server-agent@${version}:${app.serverId}:${token}`
}

// A server holds one agent slot, and releases it when the app processes the close rather than when we send
// it, so an accepted connection can briefly see the previous one as a duplicate. Only the accepting cases
// reach that check: every rejection here is decided before it.
async function connectAccepted(frame: string, sources: string | null): Promise<HandshakeResult> {
	return app.waitFor(
		async () => {
			const { ws, settled } = connect(frame, sources)
			const result = await settled
			ws.close()
			return result.code === CLOSE_DUPLICATE ? undefined : result
		},
		{ label: 'the agent slot to be free' },
	)
}

beforeAll(async () => {
	app = await createAppFixture({ logSource: 'server-agent', startAgent: false })
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('server agent handshake', () => {
	it('rejects an agent that supplies logs but not rcon', async () => {
		const { ws, settled } = connect(handshake(), 'logs')
		const result = await settled
		ws.close()

		expect(result.accepted).toBe(false)
		expect(result.code).toBe(CLOSE_INCOMPLETE_SOURCES)
		expect(result.reason).toContain('rcon')
	})

	// an agent that predates the field cannot say what it carries, and one already streaming a server is not
	// cut off over a field it was built before
	it('accepts an agent too old to declare its sources', async () => {
		const result = await connectAccepted(handshake('0.2.2'), null)

		expect(result.accepted).toBe(true)
	})

	// an agent new enough to declare does not get the same pass: declaring nothing is the query string
	// having been dropped in transit, not a licence to skip the requirement
	it('rejects a current agent that declares no sources at all', async () => {
		const { ws, settled } = connect(handshake(), null)
		const result = await settled
		ws.close()

		expect(result.accepted).toBe(false)
		expect(result.code).toBe(CLOSE_INCOMPLETE_SOURCES)
		expect(result.reason).toContain('query string')
	})

	// the token is checked first, so an unauthenticated caller learns nothing about what the server wants
	it('rejects a bad token before looking at sources', async () => {
		const { ws, settled } = connect(handshake('0.3.0', 'not-the-token'), 'logs')
		const result = await settled
		ws.close()

		expect(result.code).toBe(CLOSE_UNAUTHORIZED)
	})

	// the frame is what every agent since 0.1.0 has sent: moving the sources into the query string is what
	// keeps an agent that sends this readable by an SLM too old to know about them
	it('accepts an agent supplying both, on the unchanged handshake frame', async () => {
		const result = await connectAccepted(handshake(), 'logs,rcon')

		expect(result.accepted).toBe(true)
	})
})

// The full remote pipeline: the emulator writes its SquadGame.log, the real rust server agent
// (server-agent/agent) tails that file and ships it to the app over the /server-agent websocket, and the
// app parses those lines into server events. If any link is broken the app never sees a NEW_GAME and no
// new match history row appears, which is what these tests assert on.
//
// Skipped for now: this suite runs the real rust server agent, which resolveAgentBinary() builds with `cargo`
// on first use. The CI test image has no Rust toolchain, so the build fails with `cargo ENOENT`. The hooks
// live inside the (skipped) describe on purpose -- a module-level beforeAll would run, and fail, even when
// the block is skipped. Re-enable once the agent is prebuilt into the test image (or cargo is available).
describe.skip('server agent', () => {
	let agentApp: AppFixture

	async function waitForNewMatch(oldMatchId: number, timeoutMs?: number): Promise<{ id: number; layerId: string }> {
		return agentApp.waitFor(
			() => {
				const match = latestMatch(agentApp)
				return match.id > oldMatchId ? match : undefined
			},
			{ label: 'the roll producing a new match history row', timeoutMs },
		)
	}

	function roll() {
		agentApp.emu.world.endMatch()
		agentApp.emu.world.startNewGame()
	}

	beforeAll(async () => {
		agentApp = await createAppFixture({
			logSource: 'server-agent',
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
			admins: ['76561198000000009'],
			adminSteamIds: ['76561198000000009'],
		})
		// building the agent (release) can happen on first run
	}, 180_000)

	afterAll(async () => {
		await agentApp?.dispose()
	})

	it('ingests log events streamed by the real agent, so a roll advances match history', async () => {
		agentApp.emu.world.connectPlayer(makePlayer({ name: ' agent_player', teamId: 1 }))
		await agentApp.waitForRosterSync()
		const oldMatch = latestMatch(agentApp)

		roll()
		await agentApp.waitForRosterSync()

		const newMatch = await waitForNewMatch(oldMatch.id)
		expect(newMatch.layerId).toBe(LAYERS.gorodokRaas)
	})

	// A restarted agent process resumes tailing from the current end of the log (it does not persist its
	// byte offset across restarts), so it recovers and keeps ingesting rather than wedging. Lossless resume
	// across a transient websocket drop -- where the agent process stays up -- is a separate property.
	it('recovers after the agent process is restarted and keeps ingesting new events', async () => {
		agentApp.serverAgent!.stop()
		agentApp.serverAgent!.start()
		await agentApp.waitForRosterSync()

		const oldMatch = latestMatch(agentApp)
		roll()
		await agentApp.waitForRosterSync()

		const newMatch = await waitForNewMatch(oldMatch.id, 60_000)
		expect(newMatch.id).toBeGreaterThan(oldMatch.id)
	}, 90_000)
})
