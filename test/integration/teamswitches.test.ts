import { makePlayer } from '@/emulator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// Teamswitches, driven from in-game admin chat. `!switchnow` acts immediately over RCON;
// `!switchnext` is held until the map rolls, which is the interesting one: the switch has to survive
// a roll and then be applied against the new match's roster.

const ADMIN_STEAM_ID = '76561198000000002'

let app: AppFixture
const admin = makePlayer({ name: ' switch_admin', steam: ADMIN_STEAM_ID, teamId: 1 })
const target = makePlayer({ name: ' switch_target', teamId: 2 })

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
	})
	app.emu.world.connectPlayer(admin)
	app.emu.world.connectPlayer(target)
	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function forceChangesFor(eosId: string) {
	return app.emu.rcon.commandLog.filter((c) => c.body === `AdminForceTeamChange ${eosId}`)
}

describe('teamswitches', () => {
	it('!switchnow moves the player to the other team immediately', async () => {
		expect(target.teamId).toBe(2)
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', '!switchnow switch_target')

		await app.waitFor(() => forceChangesFor(target.eos).length > 0, {
			label: 'AdminForceTeamChange for the target',
			timeoutMs: 20_000,
		})
		// the emulated server acted on it, so the roster the app polls now disagrees with the old teams
		expect(target.teamId).toBe(1)
	})

	it('!switchnext holds the switch until the map rolls, then applies it', async () => {
		const held = makePlayer({ name: ' switch_later', teamId: 2 })
		app.emu.world.connectPlayer(held)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', '!switchnext switch_later')

		// the app acknowledges the request to the admin, but leaves the player where they are
		await app.waitFor(
			() => app.emu.rcon.commandLog.some((c) => c.body.startsWith('AdminWarn') && c.body.includes(admin.eos)),
			{ label: 'acknowledgement to the admin', timeoutMs: 20_000 },
		)
		expect(forceChangesFor(held.eos)).toHaveLength(0)
		expect(held.teamId).toBe(2)

		// and it survives to the other side of the roll, where it is finally applied. The roll itself
		// moves every player to the other team index (see World.swapTeamsOnRoll), which is what keeps a
		// player's *side* stable across matches -- so honouring the switch means moving them back.
		app.emu.world.endMatch()
		app.emu.world.startNewGame()
		await app.waitForRosterSync()

		await app.waitFor(() => forceChangesFor(held.eos).length > 0, {
			label: 'the held switch applied after the roll',
			timeoutMs: 30_000,
		})
		expect(held.teamId).toBe(2)
	})
})
