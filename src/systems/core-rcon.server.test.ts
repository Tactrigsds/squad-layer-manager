import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import * as Env from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'
import Rcon, { type RconTransport, type RconTransportHandlers } from '@/systems/core-rcon.server'
import * as CoreRcon from '@/systems/core-rcon.server'

beforeAll(() => {
	Env.ensureEnvSetup()
	ensureLoggerSetup()
	CoreRcon.setup()
})

const TYPE_RESPONSE = 0x00
const TYPE_COMMAND = 0x02

function encode(type: number, id: number, body = ''): Buffer {
	const size = Buffer.byteLength(body) + 14
	const buf = Buffer.alloc(size)
	buf.writeInt32LE(size - 4, 0)
	buf.writeInt32LE(id, 4)
	buf.writeInt32LE(type, 8)
	buf.write(body, 12, 'utf8')
	return buf
}

const SOH = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00])

// A tunnel-style transport: the test plays the game server, answering the commands Rcon writes.
class FakeTransport implements RconTransport {
	readonly label = 'fake'
	handlers: RconTransportHandlers | null = null
	commands: { id: number; body: string }[] = []
	get writable() {
		return this.handlers !== null
	}
	connect(handlers: RconTransportHandlers) {
		this.handlers = handlers
	}
	write(buf: Buffer) {
		if (buf.readInt32LE(8) !== TYPE_COMMAND) return
		const body = buf.toString('utf8', 12, buf.readInt32LE(0) + 2)
		if (body !== '') this.commands.push({ id: buf.readInt32LE(4), body })
	}
	destroy() {
		this.handlers = null
	}
	lastCommand() {
		return this.commands[this.commands.length - 1]
	}
	// what Squad sends for a command: the body, the probe echoed twice, then the SOH sequence
	respond(id: number, body: string) {
		this.handlers!.onData(
			Buffer.concat([encode(TYPE_RESPONSE, id, body), encode(TYPE_RESPONSE, id + 2), encode(TYPE_RESPONSE, id + 2), SOH]),
		)
	}
}

function connectedRcon() {
	const transport = new FakeTransport()
	const rcon = new Rcon({ serverId: 'test', transport, autoReconnectDelay: 60_000 })
	rcon.ensureConnected()
	transport.handlers!.onReady()
	return { transport, rcon }
}

async function sent(transport: FakeTransport, count: number) {
	await vi.waitFor(() => expect(transport.commands.length).toBe(count))
}

afterEach(() => {
	vi.useRealTimers()
})

describe('Rcon', () => {
	test('sends at most 61 commands at once, and times each from when the server reaches it', async () => {
		vi.useFakeTimers()
		const { transport, rcon } = connectedRcon()
		const results = Array.from({ length: 100 }, (_, i) => rcon.execute(`ShowCommandInfo Cmd${i}`))
		await sent(transport, 61)
		for (let i = 0; i < 100; i++) {
			await vi.advanceTimersByTimeAsync(30)
			const cmd = transport.commands[i]
			transport.respond(cmd.id, `info for ${cmd.body}`)
			expect(transport.commands.length).toBe(Math.min(100, 62 + i))
		}

		const bodies = (await Promise.all(results)).map((r) => (r.code === 'ok' ? r.data : r.msg))
		expect(bodies).toEqual(Array.from({ length: 100 }, (_, i) => `info for ShowCommandInfo Cmd${i}`))
		expect(transport.commands.every((cmd) => cmd.id >= 20 && cmd.id <= 80)).toBe(true)
		rcon.disconnect()
	})

	test('times out a command whose response never arrives, and then times the next one', async () => {
		vi.useFakeTimers()
		const { transport, rcon } = connectedRcon()
		const lost = rcon.execute('ShowCurrentMap')
		const next = rcon.execute('ShowNextMap')
		await sent(transport, 2)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(await lost).toEqual({ code: 'err:rcon', msg: 'Rcon response timed out' })

		transport.respond(transport.commands[1].id, 'Next level is Harju')
		expect(await next).toEqual({ code: 'ok', data: 'Next level is Harju' })
		rcon.disconnect()
	})

	test('fails unanswered commands as soon as the connection closes', async () => {
		const { transport, rcon } = connectedRcon()
		const result = rcon.execute('ShowCurrentMap')
		await sent(transport, 1)
		transport.handlers!.onClose()
		expect(await result).toEqual({ code: 'err:rcon', msg: 'RCON connection closed' })
		rcon.disconnect()
	})

	test('drops a response cut off by a reconnect instead of prepending it to the next one', async () => {
		const transport = new FakeTransport()
		const rcon = new Rcon({ serverId: 'test', transport, autoReconnectDelay: 60_000 })
		rcon.ensureConnected()
		transport.handlers!.onReady()

		const abandoned = new AbortController()
		const cutOff = rcon.execute('ShowNextMap', { signal: abandoned.signal }).catch(() => null)
		transport.handlers!.onData(encode(TYPE_RESPONSE, transport.lastCommand().id, 'Next level is Harju, layer is Harju_RAAS_v1'))
		transport.handlers!.onClose()
		abandoned.abort()
		await cutOff

		transport.handlers!.onReady()
		const serverInfo = rcon.execute('ShowServerInfo')
		transport.respond(transport.lastCommand().id, '{"MaxPlayers":100}')

		expect(await serverInfo).toEqual({ code: 'ok', data: '{"MaxPlayers":100}' })
		rcon.disconnect()
	})
})
