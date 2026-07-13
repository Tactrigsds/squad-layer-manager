import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { anonymizeIps } from './anonymize-ips'

// Captures ground-truth RCON traffic from a real squad server for the emulator corpus.
// Unlike lib/rcon/core-rcon.ts this client records every raw packet (hex + decoded fields),
// so we learn the framing-level behavior (packet ids, terminator sequences, multi-packet
// responses) that the app's client abstracts away.
//
// usage:
//   RCON_HOST=... RCON_PORT=... RCON_PASSWORD=... pnpm run script src/scripts/capture-rcon-corpus.ts [--mutate] [--listen-secs N]
//
// --mutate additionally runs harmless mutating commands (broadcast, warn, set next layer)
// so we capture their responses and any resulting chat-stream (type 1) packets.
// --listen-secs keeps the connection open afterwards to passively capture chat packets.

const HOST = process.env.RCON_HOST!
const PORT = Number(process.env.RCON_PORT!)
const PASSWORD = process.env.RCON_PASSWORD!
if (!HOST || !PORT || !PASSWORD) {
	console.error('RCON_HOST, RCON_PORT, RCON_PASSWORD are required')
	process.exit(1)
}
const MUTATE = process.argv.includes('--mutate')
const listenArgIdx = process.argv.indexOf('--listen-secs')
const LISTEN_SECS = listenArgIdx === -1 ? 0 : Number(process.argv[listenArgIdx + 1])
// runs the commands listed in the file (one per line, # comments) instead of the default batteries
const execFileIdx = process.argv.indexOf('--exec-file')
const EXEC_FILE = execFileIdx === -1 ? null : process.argv[execFileIdx + 1]

const TYPE = { auth: 0x03, command: 0x02, response: 0x00, server: 0x01 } as const

type RawPacket = {
	direction: 'sent' | 'received'
	time: number
	size: number
	id: number
	type: number
	body: string
	hex: string
	note?: string
}

type CommandCapture = {
	command: string
	sentId: number
	packets: RawPacket[]
	assembledBody: string
	durationMs: number
}

const sessionLog: RawPacket[] = []
const captures: CommandCapture[] = []
const serverPackets: RawPacket[] = []

function encode(type: number, id: number, body = ''): Buffer {
	const size = Buffer.byteLength(body) + 14
	const buffer = Buffer.alloc(size)
	buffer.writeInt32LE(size - 4, 0)
	buffer.writeInt32LE(id, 4)
	buffer.writeInt32LE(type, 8)
	buffer.write(body, 12, size - 2, 'utf8')
	buffer.writeInt16LE(0, size - 2)
	return buffer
}

let stream = Buffer.alloc(0)
let currentCapture: CommandCapture | null = null

function record(pkt: RawPacket) {
	sessionLog.push(pkt)
	if (pkt.direction === 'received' && pkt.type === TYPE.server) serverPackets.push(pkt)
	if (currentCapture && pkt.direction === 'received') currentCapture.packets.push(pkt)
	const bodyPreview = pkt.body.length > 120 ? pkt.body.slice(0, 120) + `... (${pkt.body.length} chars)` : pkt.body
	console.log(
		`${pkt.direction === 'sent' ? '>>' : '<<'} type=${pkt.type} id=${pkt.id} size=${pkt.size}${pkt.note ? ` [${pkt.note}]` : ''} body=${
			JSON.stringify(bodyPreview)
		}`,
	)
}

// mirrors core-rcon.ts #decode exactly, including the 7-byte SOH special case
function decodeAll(onPacket: (pkt: RawPacket) => void) {
	while (stream.byteLength >= 7) {
		if (
			stream[0] === 0 && stream[1] === 1 && stream[2] === 0 && stream[3] === 0
			&& stream[4] === 0 && stream[5] === 0 && stream[6] === 0
		) {
			const hex = stream.subarray(0, 7).toString('hex')
			stream = stream.subarray(7)
			onPacket({ direction: 'received', time: Date.now(), size: 7, id: 0, type: TYPE.response, body: '', hex, note: 'SOH-7-byte-sequence' })
			continue
		}
		if (stream.byteLength < 4) break
		const bufSize = stream.readInt32LE(0)
		if (bufSize > 8192 || bufSize < 10) {
			console.error('bad packet, clearing stream. hex:', stream.toString('hex'))
			stream = Buffer.alloc(0)
			break
		}
		if (bufSize > stream.byteLength - 4) break
		const bufId = stream.readInt32LE(4)
		const bufType = stream.readInt32LE(8)
		const raw = stream.subarray(0, bufSize + 4)
		const body = stream.toString('utf8', 12, bufSize + 2)
		stream = stream.subarray(bufSize + 4)
		onPacket({ direction: 'received', time: Date.now(), size: bufSize, id: bufId, type: bufType, body, hex: raw.toString('hex') })
	}
}

async function main() {
	const socket = net.createConnection({ host: HOST, port: PORT })
	socket.setNoDelay(true)

	const packetQueue: RawPacket[] = []
	let notify: (() => void) | null = null
	socket.on('data', (data) => {
		stream = Buffer.concat([stream, data])
		decodeAll((pkt) => {
			record(pkt)
			packetQueue.push(pkt)
			notify?.()
		})
	})
	socket.on('error', (err) => {
		console.error('socket error:', err)
		process.exit(1)
	})

	function send(type: number, id: number, body = '', note?: string) {
		const buf = encode(type, id, body)
		// never record credentials: the auth packet's body and raw bytes are redacted
		const isAuth = type === TYPE.auth
		record({
			direction: 'sent',
			time: Date.now(),
			size: buf.byteLength,
			id,
			type,
			body: isAuth ? '<REDACTED>' : body,
			hex: isAuth ? '<REDACTED>' : buf.toString('hex'),
			note,
		})
		socket.write(buf)
	}

	async function waitFor(pred: (pkt: RawPacket) => boolean, timeoutMs: number): Promise<RawPacket | null> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const idx = packetQueue.findIndex(pred)
			if (idx !== -1) return packetQueue.splice(idx, 1)[0]
			await new Promise<void>((res) => {
				notify = res
				setTimeout(res, Math.min(100, deadline - Date.now()))
			})
			notify = null
		}
		return null
	}

	await new Promise<void>((res) => socket.once('connect', res))
	console.log(`connected to ${HOST}:${PORT}`)

	send(TYPE.auth, 2147483647, PASSWORD, 'auth')
	const authRes = await waitFor((p) => p.type === TYPE.command, 5000)
	if (!authRes) {
		console.error('auth failed or timed out')
		process.exit(1)
	}
	console.log('authenticated. auth response id:', authRes.id)

	let msgId = 20
	async function execute(command: string, quiesceMs = 1200): Promise<CommandCapture> {
		packetQueue.length = 0
		const capture: CommandCapture = { command, sentId: msgId, packets: [], assembledBody: '', durationMs: 0 }
		currentCapture = capture
		const start = Date.now()
		send(TYPE.command, msgId, command)
		send(TYPE.command, msgId + 2, '', 'empty-probe')
		msgId += 4

		// collect until we see an empty response packet (the terminator convention) and then
		// a short quiet period, so trailing packets (if any) are captured too
		await waitFor((p) => p.type === TYPE.response && p.body === '', quiesceMs * 4)
		await new Promise((res) => setTimeout(res, 300))

		capture.durationMs = Date.now() - start
		capture.assembledBody = capture.packets
			.filter((p) => p.type === TYPE.response && p.body !== '' && p.note !== 'SOH-7-byte-sequence')
			.map((p) => p.body)
			.join('')
		currentCapture = null
		captures.push(capture)
		return capture
	}

	const readOnlyBattery = [
		'ShowServerInfo',
		'ShowCurrentMap',
		'ShowNextMap',
		'ListPlayers',
		'ListSquads',
		'AdminListDisconnectedPlayers',
		'ListCommands 1',
		'ListLayers',
		'ListLevels',
		// error/edge cases: how does the server answer garbage?
		'ThisCommandDoesNotExist',
		'AdminWarn',
		'AdminSetNextLayer',
		'ShowCommandInfo AdminWarn',
	]

	if (EXEC_FILE) {
		const cmds = fs.readFileSync(EXEC_FILE, 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('#'))
		for (const cmd of cmds) {
			console.log(`\n===== ${cmd} =====`)
			await execute(cmd)
		}
	} else {
		for (const cmd of readOnlyBattery) {
			console.log(`\n===== ${cmd} =====`)
			await execute(cmd)
		}
	}

	if (MUTATE && !EXEC_FILE) {
		console.log('\n===== mutating battery =====')
		const listPlayers = captures.find((c) => c.command === 'ListPlayers')?.assembledBody ?? ''
		const playerIdMatch = listPlayers.match(/^ID: (\d+) \|/m)

		await execute('AdminBroadcast SLM corpus capture test broadcast')
		if (playerIdMatch) {
			await execute(`AdminWarn "${playerIdMatch[1]}" SLM corpus capture test warn`)
		} else {
			console.log('no player found to warn')
		}
		// capture both the "unable to find" and success shapes for set-next-layer
		await execute('AdminSetNextLayerWorkflow bogus_layer_name')
		await execute('AdminSetNextLayer BogusLayer_Bogus_v1')
		const currentMap = captures.find((c) => c.command === 'ShowCurrentMap')?.assembledBody ?? ''
		console.log('current map response was:', currentMap)
		await execute('AdminSetNextLayer Sumari_Seed_v1')
		await execute('ShowNextMap')
		await execute('AdminSetNextLayer Sumari_Seed_v1 USA USMC') // invalid faction pairing shape
		await execute('AdminSetNextLayer Sumari_Seed_v1 RGF VDV')
		await execute('ShowNextMap')
	}

	if (LISTEN_SECS > 0) {
		console.log(`\nlistening passively for chat/server packets for ${LISTEN_SECS}s...`)
		await new Promise((res) => setTimeout(res, LISTEN_SECS * 1000))
	}

	socket.end()

	const outDir = path.join(import.meta.dirname, '../../test/corpus/rcon')
	fs.mkdirSync(outDir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const outFile = path.join(outDir, `capture-${stamp}.json`)
	fs.writeFileSync(
		outFile,
		anonymizeIps(JSON.stringify(
			{
				capturedAt: new Date().toISOString(),
				host: HOST,
				note: 'raw RCON capture for emulator corpus (ips anonymized). See capture-rcon-corpus.ts',
				captures,
				serverPackets,
				sessionLog,
			},
			null,
			'\t',
		)),
	)
	console.log(`\nwrote ${outFile}`)
	console.log(`commands captured: ${captures.length}, server(chat) packets: ${serverPackets.length}`)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
