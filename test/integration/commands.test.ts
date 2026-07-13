import { makePlayer } from '@/emulator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue, voteQueueItem } from '../harness/arrange'

// In-game admin commands: the emulator sends chat as a player, the app parses it, authorizes the
// sender, and acts back over RCON. This is the path the fixture's arrangement API exists for
// (seeded queue, admin list, steam link), so it doubles as that API's test.

const ADMIN_STEAM_ID = '76561198000000001'

let app: AppFixture
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID })

beforeAll(async () => {
	app = await createAppFixture({
		// a seeded queue is a known queue: nothing generates on top of it
		layerQueue: [
			voteQueueItem([LAYERS.gorodokRaas, LAYERS.harjuRaas]),
			...queue(LAYERS.sumariSeed),
		],
		// in game this player is an admin (Admins.cfg); out of game he is the seeded superuser
		// (linkedSteamAccounts). Commands need both: the first to be an admin, the second to be allowed.
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		globalSettings: (s) => {
			// so a roll leaves the queue "low" and the app warns every admin about it -- see the last test
			s.layerQueue.lowQueueWarningThreshold = 5
		},
	})
	app.emu.world.connectPlayer(admin)
	// commands resolve their sender against the app's roster, which comes from a polled ListPlayers
	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function savedQueue(): { type: string; layerId?: string }[] {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
		return JSON.parse(row.layerQueue).json
	} finally {
		db.close()
	}
}

// every warn the app sent to our admin player, in order
function warnsToAdmin(): string[] {
	return app.emu.rcon.commandLog
		.filter((c) => c.body.startsWith('AdminWarn') && (c.body.includes(ADMIN_STEAM_ID) || c.body.includes(admin.eos)))
		.map((c) => c.body)
}

describe('in-game admin commands', () => {
	it('starts with exactly the seeded queue', () => {
		const queued = savedQueue()
		expect(queued.map((i) => i.type)).toEqual(['vote-list-item', 'single-list-item'])
		expect(queued[1].layerId).toBe(LAYERS.sumariSeed)
	})

	it('answers !shownext in admin chat, over rcon, to the sender', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '!shownext')

		await app.waitFor(() => warnsToAdmin().length > 0, { label: 'a reply to !shownext', timeoutMs: 20_000 })
		// the queue head is the seeded vote, so the preview names its choices
		expect(warnsToAdmin().join('\n')).toMatch(/Gorodok/i)
	})

	it('starts a vote from admin chat, broadcasting the choices in game', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '!startvote')

		const broadcast = await app.emu.expectCommand(/^AdminBroadcast /, { timeoutMs: 20_000 })
		expect(broadcast.body).toMatch(/Gorodok/i)
		expect(broadcast.body).toMatch(/Harju/i)

		// and the app records the vote against the queued item
		await app.waitFor(
			() => JSON.stringify(savedQueue()).includes('votes'),
			{ label: 'vote recorded on the queue item', timeoutMs: 20_000 },
		)
	})

	it('warns admins (and only admins) about a low queue after a roll', async () => {
		const bystander = makePlayer({ name: ' not_an_admin' })
		app.emu.world.connectPlayer(bystander)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		// warnAllAdmins picks its targets by matching the roster against the Admins.cfg, so this only
		// arrives if the local admin list source was read and matched to this player's steam id
		await app.waitFor(
			() => warnsToAdmin().some((w) => /queue/i.test(w)),
			{ label: 'low-queue warning to the admin', timeoutMs: 25_000 },
		)
		const warnsToBystander = app.emu.rcon.commandLog.filter((c) =>
			c.body.startsWith('AdminWarn') && c.body.includes(bystander.eos) && /queue/i.test(c.body)
		)
		expect(warnsToBystander).toHaveLength(0)
	})
})
