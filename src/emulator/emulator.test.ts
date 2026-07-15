import { matchLog } from '@/lib/log-parsing'
import Rcon from '@/lib/rcon/core-rcon'
import * as CoreRcon from '@/lib/rcon/core-rcon'
import * as SM from '@/models/squad.models'
import * as Env from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Emulator, makePlayer } from './index'

// Self-checks: the emulator is exercised through the app's own RCON client and its output is
// run through the app's own matchers, so emulator and parsers cannot drift apart silently.

let emu: Emulator
let rcon: Rcon

async function collectLogEvents(lines: string[]) {
	async function* chunks() {
		yield lines.join('\n') + '\n'
		// parseLogStream only flushes an entry once the next one starts; a trailing entry with a
		// fresh chainID forces everything before it to complete
		yield '[2026.07.12-23.59.59:999][999]LogSquad: USQGameState: Server Tick Rate: 60.00\n'
	}
	const errors: Error[] = []
	const events: SM.LogEvents.ParseOutputEvent[] = []
	for await (const ev of SM.LogEvents.parseLogStream(chunks(), errors)) {
		if (ev !== null && ev.type !== 'UNKNOWN') events.push(ev)
	}
	expect(errors).toEqual([])
	return events
}

function nextServerPacket(): Promise<string> {
	return new Promise((resolve) => {
		rcon.once('server', (_ctx, pkt) => resolve(pkt.body))
	})
}

beforeAll(async () => {
	Env.ensureEnvSetup()
	ensureLoggerSetup()
	CoreRcon.setup()
	// restricted layer list to exercise the unknown-layer error path; the default accepts anything
	emu = new Emulator({ layerChangeDelayMs: 50, knownLayers: ['Harju_RAAS_v1', 'Sumari_Seed_v1'] })
	await emu.start()
	rcon = new Rcon({
		serverId: 'emu-test',
		transport: new CoreRcon.DirectSocketTransport({ host: '127.0.0.1', port: emu.rconPort, password: emu.password }),
		autoReconnectDelay: 200,
	})
	await rcon.connect()
})

afterAll(() => {
	rcon.disconnect()
	emu.dispose()
})

describe('rcon frontend via the app client', () => {
	it('answers ShowCurrentMap in the exact live format', async () => {
		const res = await rcon.execute('ShowCurrentMap')
		expect(res).toEqual({
			code: 'ok',
			data: 'Current level is Harju, layer is Harju_RAAS_v1, factions RGF+Mechanized PLA+AirAssault',
		})
	})

	it('answers ShowNextMap and round-trips AdminSetNextLayer', async () => {
		const set = await rcon.execute('AdminSetNextLayer Sumari_Seed_v1 RGF VDV')
		expect(set).toEqual({ code: 'ok', data: 'Set next layer to Sumari_Seed_v1 RGF VDV' })
		const res = await rcon.execute('ShowNextMap')
		expect(res).toEqual({ code: 'ok', data: 'Next level is Sumari, layer is Sumari_Seed_v1, factions RGF VDV' })
	})

	it('rejects unknown layers like the real server', async () => {
		const res = await rcon.execute('AdminSetNextLayer BogusLayer_Bogus_v1')
		expect(res).toEqual({ code: 'ok', data: 'ERROR: Unable to set next layer : layer Not Found : BogusLayer_Bogus_v1' })
	})

	it('returns usage errors for missing arguments', async () => {
		const res = await rcon.execute('AdminWarn')
		expect(res.code).toBe('ok')
		expect((res as { data: string }).data).toBe(
			'Missing argument 0: (NameOrEOSId). Use "ShowCommandInfo AdminWarn" to get info on this command.',
		)
	})

	it('parses ListPlayers with the app regex, including leading-space names', async () => {
		emu.world.connectPlayer(makePlayer({ name: ' grey275', role: 'PLA_Recruit' }))
		const res = await rcon.execute('ListPlayers')
		expect(res.code).toBe('ok')
		const lines = (res as { data: string }).data.split('\n')
		// the exact regex fetchPlayers uses (squad-rcon.server.ts)
		const rx =
			/^ID: (?<playerID>\d+) \| Online IDs:([^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamId>\d|N\/A) \| Squad ID: (?<squadId>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>.+)$/
		const parsed = lines.map((l) => l.match(rx)).filter((m) => m !== null)
		expect(parsed).toHaveLength(1)
		const ids = SM.PlayerIds.parse({ username: parsed[0]!.groups!.name, idsStr: parsed[0]![2] })
		expect(ids.username).toBe('grey275')
		expect(ids.eos).toMatch(/^0002[0-9a-f]{28}$/)
		expect(ids.steam).toMatch(/^7656119\d{10}$/)
	})

	it('parses ListSquads with the app regex', async () => {
		const p = emu.world.playerList()[0]
		emu.world.createSquad(p, 'A SQUAD')
		const res = await rcon.execute('ListSquads')
		expect(res.code).toBe('ok')
		const rx =
			/ID: (?<squadId>\d+) \| Name: (?<squadName>.+) \| Size: (?<size>\d+) \| Locked: (?<locked>True|False) \| Creator Name: (?<creatorName>.+) \| Creator Online IDs:([^|]+)/
		const matches = (res as { data: string }).data.split('\n').map((l) => l.match(rx)).filter((m) => m !== null)
		expect(matches).toHaveLength(1)
		expect(matches[0]!.groups!.squadName).toBe('A SQUAD')
	})

	it('parses ShowServerInfo through the app schema', async () => {
		const res = await rcon.execute('ShowServerInfo')
		expect(res.code).toBe('ok')
		const parsed = SM.ServerRawInfoSchema.safeParse(JSON.parse((res as { data: string }).data))
		expect(parsed.success).toBe(true)
	})

	it('reassembles multi-packet responses', async () => {
		for (let i = 0; i < 200; i++) emu.world.connectPlayer(makePlayer({ name: `filler_player_${i}` }))
		const players = await rcon.execute('ListPlayers')
		expect(players.code).toBe('ok')
		const body = (players as { data: string }).data
		expect(body.length).toBeGreaterThan(4000)
		expect(body.split('\n').filter((l) => l.startsWith('ID: '))).toHaveLength(201 + emu.world.disconnected.length)
		for (let i = 0; i < 200; i++) emu.world.players.delete(emu.world.findPlayer(`filler_player_${i}`)!.eos)
	})
})

describe('chat-stream packets parse via RCON_EVENT_MATCHERS', () => {
	async function expectEvent(action: () => void, type: string) {
		const pktPromise = nextServerPacket()
		action()
		const body = await pktPromise
		const [event, err] = matchLog(body, SM.RCON_EVENT_MATCHERS)
		expect(err).toBeNull()
		expect(event).not.toBeNull()
		expect(event!.type).toBe(type)
		return event!
	}

	it('CHAT_MESSAGE in each channel', async () => {
		const p = emu.world.findPlayer('grey275')!
		for (const channel of ['ChatAll', 'ChatTeam', 'ChatSquad', 'ChatAdmin'] as const) {
			const event = await expectEvent(
				() => emu.world.chat(p, channel, `hello from ${channel}`),
				'CHAT_MESSAGE',
			) as SM.RconEvents.ChatMessage
			expect(event.channelType).toBe(channel)
			expect(event.message).toBe(`hello from ${channel}`)
			expect(event.playerIds.eos).toBe(p.eos)
			expect(event.playerIds.username).toBe('grey275')
		}
	})

	it('PLAYER_WARNED from AdminWarn', async () => {
		const pktPromise = nextServerPacket()
		const res = await rcon.execute(`AdminWarn "${emu.world.findPlayer('grey275')!.eos}" corpus style warn`)
		expect((res as { data: string }).data).toBe('Remote admin has warned player  grey275. Message was "corpus style warn"')
		const [event] = matchLog(await pktPromise, SM.RCON_EVENT_MATCHERS)
		expect(event).toMatchObject({ type: 'PLAYER_WARNED', reason: 'corpus style warn' })
	})

	it('warn on a missing player echoes the error to the chat stream', async () => {
		const pktPromise = nextServerPacket()
		const res = await rcon.execute('AdminWarn "0" nope')
		expect((res as { data: string }).data).toBe('Could not find player 0')
		expect(await pktPromise).toBe('Could not find player 0')
	})

	it('SQUAD_CREATED', async () => {
		const p = emu.world.findPlayer('grey275')!
		emu.world.leaveSquad(p)
		const event = await expectEvent(() => emu.world.createSquad(p, 'BRAVO'), 'SQUAD_CREATED') as SM.RconEvents.SquadCreated
		expect(event.squadName).toBe('BRAVO')
		expect(event.creatorIds.eos).toBe(p.eos)
	})

	it('SQUAD_RENAMED from AdminRenameSquad, with the duplicated response line', async () => {
		const p = emu.world.findPlayer('grey275')!
		const pktPromise = nextServerPacket()
		const res = await rcon.execute(`AdminRenameSquad ${p.teamId} ${p.squadId}`)
		const line = `Remote admin renamed squad ${p.squadId} on team ${p.teamId}, named "BRAVO", to "Squad ${p.squadId}"`
		expect((res as { data: string }).data).toBe(`${line}\n${line}`)
		const [event] = matchLog(await pktPromise, SM.RCON_EVENT_MATCHERS)
		expect(event).toMatchObject({ type: 'SQUAD_RENAMED', oldSquadName: 'BRAVO', newSquadName: `Squad ${p.squadId}` })
	})

	it('POSSESSED/UNPOSSESSED_ADMIN_CAMERA', async () => {
		const p = emu.world.findPlayer('grey275')!
		await expectEvent(() => emu.world.possessAdminCam(p), 'POSSESSED_ADMIN_CAMERA')
		await expectEvent(() => emu.world.unpossessAdminCam(p), 'UNPOSSESSED_ADMIN_CAMERA')
	})
})

describe('log lines parse via LogEvents matchers', () => {
	it('join chain assembles into PLAYER_CONNECTED_CHAIN', async () => {
		const local = new Emulator()
		const p = makePlayer({ name: ' joiner' })
		local.world.connectPlayer(p)
		const events = await collectLogEvents(local.logLines)
		expect(events.map((e) => e.type)).toContain('PLAYER_CONNECTED_CHAIN')
		const chain = events.find((e) => e.type === 'PLAYER_CONNECTED_CHAIN')! as Extract<
			SM.LogEvents.AnyChainEvent,
			{ type: 'PLAYER_CONNECTED_CHAIN' }
		>
		expect(chain.events.PLAYER_CONNECTED.playerIds.eos).toBe(p.eos)
		expect(chain.events.PLAYER_JOIN_SUCCEEDED.player.usernameNoTag).toBe('joiner')
		local.dispose()
	})

	it('disconnect renders the RemoveClientConnection line and parses as PLAYER_DISCONNECTED', async () => {
		const local = new Emulator()
		const p = makePlayer({ name: ' leaver' })
		local.world.connectPlayer(p)
		local.logLines.length = 0
		local.world.disconnectPlayer(p)
		const events = await collectLogEvents(local.logLines)
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: 'PLAYER_DISCONNECTED',
			ip: p.ip,
			playerIds: expect.objectContaining({ eos: p.eos, playerController: p.controllerId }),
		})
		local.dispose()
	})

	it('scenario emits parseable MAP_SET, ADMIN_BROADCAST, LAYER_CHANGED, wounds and deaths', async () => {
		const local = new Emulator()
		const a = local.world.connectPlayer(makePlayer({ name: ' alice' }))
		const b = local.world.connectPlayer(makePlayer({ name: ' bob' }))
		local.logLines.length = 0
		local.world.handleCommand('AdminBroadcast test broadcast')
		local.world.handleCommand('AdminSetNextLayer Sumari_Seed_v1 RGF VDV')
		local.world.handleCommand('AdminChangeLayer Sumari_Seed_v1')
		local.world.woundPlayer(a, b)
		local.world.killPlayer(a, b)
		const events = await collectLogEvents(local.logLines)
		const types = events.map((e) => e.type)
		expect(types).toContain('ADMIN_BROADCAST')
		expect(types).toContain('MAP_SET')
		expect(types).toContain('LAYER_CHANGED')
		expect(types).toContain('PLAYER_WOUNDED')
		expect(types).toContain('PLAYER_DIED')
		// LAYER_CHANGED is typed as chain-member-only (NonChainEvent excludes it), but parseLogStream
		// emits chain members standalone when their group has no primary event
		const layerChanged = events.find((e) => (e.type as string) === 'LAYER_CHANGED')! as unknown as SM.LogEvents.LayerChanged
		expect(layerChanged.layer).toBe('Sumari_Seed_v1')
		expect(layerChanged.source).toEqual({ type: 'rcon' })
		local.dispose()
	})

	it('a roll travels through the transition map before the destination layer', async () => {
		const local = new Emulator()
		local.world.endMatch()
		local.world.startNewGame({
			level: 'Gorodok',
			layer: 'Gorodok_RAAS_v1',
			factions: 'USA+CombinedArms RGF+CombinedArms',
			mapDir: '/Game/Maps/Gorodok/Gameplay_Layers',
		})
		const events = await collectLogEvents(local.logLines)
		const newGames = events.filter((e) => e.type === 'NEW_GAME') as SM.LogEvents.NewGame[]
		// the app snapshots the layer it expects on the transition, and resolves the roll on the second
		expect(newGames.map((e) => e.layerClassname)).toEqual(['TransitionMap', 'Gorodok_RAAS_v1'])
		local.dispose()
	})

	it('AdminEndMatch emits a valid ROUND_ENDED_CHAIN', async () => {
		const local = new Emulator()
		local.world.handleCommand('AdminEndMatch')
		const events = await collectLogEvents(local.logLines)
		expect(events.map((e) => e.type)).toContain('ROUND_ENDED_CHAIN')
		local.dispose()
	})

	it('AdminKick emits KICKING_PLAYER/PLAYER_KICKED chain and a disconnect', async () => {
		const local = new Emulator()
		const p = local.world.connectPlayer(makePlayer({ name: ' kickme' }))
		local.logLines.length = 0
		local.world.handleCommand(`AdminKick "${p.eos}" being a menace`)
		const events = await collectLogEvents(local.logLines)
		const types = events.map((e) => e.type)
		expect(types).toContain('PLAYER_KICKED_CHAIN')
		expect(types).toContain('PLAYER_DISCONNECTED')
		local.dispose()
	})
})
