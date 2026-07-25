import Rcon from '@/lib/rcon/core-rcon'
import * as CoreRcon from '@/lib/rcon/core-rcon'
import * as SB from '@/models/sandbox.models'
import * as Env from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Emulator } from './index'
import * as Verbs from './verbs'

// The verb layer is what the dev repl, `pnpm emuctl` and the app's sandbox window all dispatch through, so it is
// exercised against a real World rather than a stub.

let emu: Emulator
let host: Verbs.SandboxHost

beforeAll(() => {
	Env.ensureEnvSetup()
	ensureLoggerSetup()
	CoreRcon.setup()
})

beforeEach(async () => {
	emu = new Emulator({ tickRateIntervalMs: 0 })
	await emu.start()
	host = { emu, players: new Map() }
})

afterEach(() => emu.dispose())

describe('execute', () => {
	it('connects a player the world and the host both know', async () => {
		const out = await Verbs.execute(host, 'join', { name: 'Alice' })
		expect(out).toContain('Alice joined team 1')
		expect(host.players.has('Alice')).toBe(true)
		expect(emu.world.playerList().map((p) => p.name)).toEqual(['Alice'])
	})

	it('alternates teams so a scenario gets two sides without asking', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		await Verbs.execute(host, 'join', { name: 'Bob' })
		expect(host.players.get('Alice')!.teamId).toBe(1)
		expect(host.players.get('Bob')!.teamId).toBe(2)
	})

	it('refuses a duplicate name, since every verb addresses players by it', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		await expect(Verbs.execute(host, 'join', { name: 'Alice' })).rejects.toThrow('already connected')
	})

	it('names the fix when a verb targets someone who is not here', async () => {
		await expect(Verbs.execute(host, 'chat', { name: 'Ghost', message: 'hi' })).rejects.toThrow(/join Ghost/)
	})

	it('drops a leaver from both the world and the host', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		await Verbs.execute(host, 'leave', { name: 'Alice' })
		expect(host.players.has('Alice')).toBe(false)
		expect(emu.world.playerList()).toEqual([])
	})

	// chat reaches the app over the rcon chat stream rather than the log, so this asserts against a real client
	it('puts chat on the wire as the named player', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		const rcon = new Rcon({
			serverId: 'verbs-test',
			transport: new CoreRcon.DirectSocketTransport({ host: '127.0.0.1', port: emu.rconPort, password: emu.password }),
		})
		await rcon.connect()
		try {
			const packet = new Promise<string>((resolve) => rcon.once('server', (_ctx, pkt) => resolve(pkt.body)))
			await Verbs.execute(host, 'chat', { name: 'Alice', message: '!vote 1' })
			expect(await packet).toContain('!vote 1')
		} finally {
			rcon.disconnect()
		}
	})

	// an empty squad is a state a real server never reports, and the app rejects the pair as inconsistent and
	// retries forever. Creating a second squad used to leave the first one behind like that.
	it('never leaves a squad behind with nobody in it', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		for (const squadName of ['Able', 'Baker', 'Charlie']) {
			await Verbs.execute(host, 'squad', { name: 'Alice', squadName })
		}
		const members = (s: { teamId: number; squadId: number }) => emu.world.squadMembers(s).length
		expect(emu.world.squads.filter((s) => members(s) === 0)).toEqual([])
		expect(emu.world.squads).toHaveLength(1)
	})

	it('leaves the old squad standing when it still has members', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		await Verbs.execute(host, 'join', { name: 'Bob' })
		await Verbs.execute(host, 'squad', { name: 'Alice', squadName: 'Able' })
		const able = emu.world.squads[0]
		emu.world.joinSquad(host.players.get('Bob')!, able)
		await Verbs.execute(host, 'squad', { name: 'Alice', squadName: 'Baker' })
		expect(emu.world.squads.map((s) => s.name).sort()).toEqual(['Able', 'Baker'])
		expect(emu.world.squadMembers(able).map((p) => p.name)).toEqual(['Bob'])
	})

	it('writes squad creation to the log, which is where the app reads it', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		const lines: string[] = []
		emu.onLogLine((l) => lines.push(l))
		await Verbs.execute(host, 'squad', { name: 'Alice', squadName: 'Able' })
		expect(lines.join('\n')).toContain('Able')
	})

	it('rejects args that do not fit the verb, rather than acting on a coerced value', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		await expect(Verbs.execute(host, 'end', { winnerTeamId: 3 })).rejects.toThrow()
	})

	it('runs raw rcon against the same world', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		const out = await Verbs.execute(host, 'rcon', { command: 'ListPlayers' })
		expect(out).toContain('Alice')
	})

	it('notifies the host of a join so the dev harness can register the player elsewhere', async () => {
		const seen: string[] = []
		host.onPlayerJoined = (p) => seen.push(p.name)
		await Verbs.execute(host, 'join', { name: 'Alice' })
		expect(seen).toEqual(['Alice'])
	})
})

describe('emulated admin list', () => {
	function withList(): Verbs.SandboxHost {
		const groups = new Map<string, string[]>([['Admin', ['canseeadminchat']]])
		const memberships = new Map<string, Set<string>>()
		return {
			emu,
			players: host.players,
			adminList: {
				isAdmin: (name) => [...(memberships.get(name) ?? [])].some((g) => (groups.get(g) ?? []).includes('canseeadminchat')),
				setPlayerGroups: (name, next) => {
					if (next.length === 0) memberships.delete(name)
					else memberships.set(name, new Set(next))
				},
				defineGroup: (group, perms) => groups.set(group, perms),
				deleteGroup: (group) => {
					groups.delete(group)
					for (const [name, gs] of memberships) {
						if (gs.delete(group) && gs.size === 0) memberships.delete(name)
					}
				},
				groupNames: () => [...groups.keys()],
			},
		}
	}

	it('keeps a non-admin out of admin chat, as a real server does', async () => {
		const h = withList()
		await Verbs.execute(h, 'join', { name: 'Alice' })
		await expect(Verbs.execute(h, 'chat', { name: 'Alice', message: 'hi', channel: 'ChatAdmin' })).rejects.toThrow(/not an admin/)
	})

	it('lets an admin speak in admin chat once they are in an identifying group', async () => {
		const h = withList()
		await Verbs.execute(h, 'join', { name: 'Alice' })
		await Verbs.execute(h, 'set-player-groups', { name: 'Alice', groups: ['Admin'] })
		await expect(Verbs.execute(h, 'chat', { name: 'Alice', message: 'hi', channel: 'ChatAdmin' })).resolves.toContain('ChatAdmin')
	})

	it('refuses a group that does not exist rather than inventing one', async () => {
		const h = withList()
		await Verbs.execute(h, 'join', { name: 'Alice' })
		await expect(Verbs.execute(h, 'set-player-groups', { name: 'Alice', groups: ['Nope'] })).rejects.toThrow(/no such group/)
	})

	it('drops memberships of a group it deletes, so no membership points at nothing', async () => {
		const h = withList()
		await Verbs.execute(h, 'join', { name: 'Alice' })
		await Verbs.execute(h, 'set-player-groups', { name: 'Alice', groups: ['Admin'] })
		await Verbs.execute(h, 'delete-group', { group: 'Admin' })
		expect(h.adminList!.isAdmin('Alice')).toBe(false)
	})

	it('has no admin list on a host that keeps none, rather than silently doing nothing', async () => {
		await Verbs.execute(host, 'join', { name: 'Alice' })
		await expect(Verbs.execute(host, 'set-player-groups', { name: 'Alice', groups: [] })).rejects.toThrow(/no emulated admin list/)
	})
})

describe('bulk join', () => {
	it('connects the requested number under sequential default names', async () => {
		await Verbs.execute(host, 'bulk-join', { count: 3 })
		expect([...host.players.keys()]).toEqual(['Player1', 'Player2', 'Player3'])
	})

	it('skips names already taken rather than colliding', async () => {
		await Verbs.execute(host, 'join', { name: 'Player2' })
		await Verbs.execute(host, 'bulk-join', { count: 2 })
		expect([...host.players.keys()].sort()).toEqual(['Player1', 'Player2', 'Player3'])
	})

	it('fills to the player cap and says how many it turned away', async () => {
		await Verbs.execute(host, 'bulk-join', { count: SB.MAX_PLAYERS - 1 })
		const out = await Verbs.execute(host, 'bulk-join', { count: 5 })
		expect(host.players.size).toBe(SB.MAX_PLAYERS)
		expect(out).toContain('4 refused')
	})

	it('refuses a join into a full server', async () => {
		await Verbs.execute(host, 'bulk-join', { count: SB.MAX_PLAYERS })
		await expect(Verbs.execute(host, 'join', { name: 'Latecomer' })).rejects.toThrow('full')
		await expect(Verbs.execute(host, 'bulk-join', { count: 1 })).rejects.toThrow('full')
		expect(host.players.size).toBe(SB.MAX_PLAYERS)
	})
})

describe('executeTokens', () => {
	it('maps positional tokens onto the same input the router takes', async () => {
		await Verbs.executeTokens(host, ['join', 'Alice'])
		expect(host.players.has('Alice')).toBe(true)
	})

	it('keeps a multi-word message whole', async () => {
		await Verbs.executeTokens(host, ['join', 'Alice'])
		const out = await Verbs.executeTokens(host, ['chat', 'Alice', 'hello', 'there'])
		expect(out).toBe('[ChatAll] Alice: hello there')
	})

	it('reports usage rather than acting on a half-given command', async () => {
		await expect(Verbs.executeTokens(host, ['join'])).rejects.toThrow('usage: join <name>')
	})

	it('rejects an unknown verb by name', async () => {
		await expect(Verbs.executeTokens(host, ['teleport', 'Alice'])).rejects.toThrow(/unknown command 'teleport'/)
	})

	it('lists every verb under help, so the two front ends advertise the same set', async () => {
		const out = await Verbs.executeTokens(host, ['help'])
		for (const verb of ['join', 'leave', 'chat', 'admchat', 'squad', 'cam', 'kill', 'end', 'rcon', 'cycle']) {
			expect(out).toContain(verb)
		}
	})
})
