import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { cmd, LAYERS, queue, voteQueueItem } from '../harness/arrange'

// In-game admin commands: the emulator sends chat as a player, the app parses it, authorizes the
// sender, and acts back over RCON. This is the path the fixture's arrangement API exists for
// (seeded queue, admin list, steam link), so it doubles as that API's test.

const ADMIN_STEAM_ID = '76561198000000001'

let app: AppFixture
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID })

beforeAll(async () => {
	app = await createAppFixture({
		// a seeded queue is a known queue: nothing generates on top of it
		layerQueue: [voteQueueItem([LAYERS.gorodokRaas, LAYERS.harjuRaas]), ...queue(LAYERS.sumariSeed)],
		// in game this player is an admin (Admins.cfg); out of game he is the seeded superuser
		// (linkedSteamAccounts). Commands need both: the first to be an admin, the second to be allowed.
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		serverSettings: (s) => {
			// so a roll leaves the queue "low" and the app warns every admin about it -- see the last test
			s.queue.lowQueueWarningThreshold = 5
		},
		globalSettings: (s) => {
			// a configured reason, so a mistyped keyword has something to be a near miss of
			s.adminActionReasons = [
				{ label: 'Teamkilling', keywords: ['tk'], actionTexts: { warn: 'Do not teamkill' } },
				{ label: 'Seeding Rules', keywords: ['seedrules'], actionTexts: { broadcast: 'Middle flag only' } },
			]
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

	it('answers shownext in admin chat, over rcon, to the sender', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('shownext'))

		await app.waitFor(() => warnsToAdmin().length > 0, { label: 'a reply to shownext', timeoutMs: 20_000 })
		// the queue head is the seeded vote, so the preview names its choices
		expect(warnsToAdmin().join('\n')).toMatch(/Gorodok/i)
	})

	it('starts a vote from admin chat, broadcasting the choices in game', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('startvote'))

		const broadcast = await app.emu.expectCommand(/^AdminBroadcast /, { timeoutMs: 20_000 })
		expect(broadcast.body).toMatch(/Gorodok/i)
		expect(broadcast.body).toMatch(/Harju/i)

		// and the app records the vote against the queued item
		await app.waitFor(() => JSON.stringify(savedQueue()).includes('votes'), {
			label: 'vote recorded on the queue item',
			timeoutMs: 20_000,
		})
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
		await app.waitFor(() => warnsToAdmin().some((w) => /queue/i.test(w)), {
			label: 'low-queue warning to the admin',
			timeoutMs: 25_000,
		})
		const warnsToBystander = app.emu.rcon.commandLog.filter(
			(c) => c.body.startsWith('AdminWarn') && c.body.includes(bystander.eos) && /queue/i.test(c.body),
		)
		expect(warnsToBystander).toHaveLength(0)
	})
})

// An argument that doesn't resolve but is close to something that does becomes a question rather than a dead end.
// The pick is spliced back over the words the caller typed and the whole command runs again, so what these assert
// is that the second run reaches the handler with the chosen thing.
describe('choosing between near misses', () => {
	const alice = makePlayer({ name: 'Alice_The_Great' })
	const alicia = makePlayer({ name: 'Alicia' })

	beforeAll(async () => {
		app.emu.world.connectPlayer(alice)
		app.emu.world.connectPlayer(alicia)
		await app.waitForRosterSync()
	}, 60_000)

	// the choice list, which is the only warn that numbers its lines
	async function awaitPrompt(): Promise<string> {
		await app.waitFor(() => warnsToAdmin().some((w) => w.includes('1)')), { label: 'a choice list', timeoutMs: 20_000 })
		return warnsToAdmin().findLast((w) => w.includes('1)'))!
	}

	function warnsTo(player: { eos: string }): string[] {
		return app.emu.rcon.commandLog.filter((c) => c.body.startsWith('AdminWarn') && c.body.includes(player.eos)).map((c) => c.body)
	}

	it('offers the closest players, and runs the command against the one picked', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', `${cmd('warn')} alise stop that`)

		const prompt = await awaitPrompt()
		expect(prompt).toContain('Alice_The_Great')
		expect(prompt).toMatch(/Reply 1-\d, or 0 to cancel/)

		app.emu.world.chat(admin, 'ChatAdmin', '1')
		await app.waitFor(() => warnsTo(alice).some((w) => w.includes('stop that')), { label: 'the warn to Alice', timeoutMs: 20_000 })
		expect(warnsTo(alicia)).toHaveLength(0)
	})

	// a broadcast names a preset the same way an admin action names a reason, so it reaches the same machinery
	it('offers the closest broadcast preset, and sends the one picked', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', `${cmd('broadcast')} seedrulez`)

		const prompt = await awaitPrompt()
		expect(prompt).toContain('Seeding Rules')

		app.emu.world.chat(admin, 'ChatAdmin', '1')
		const broadcast = await app.emu.expectCommand(/^AdminBroadcast .*Middle flag only/, { timeoutMs: 20_000 })
		expect(broadcast.body).toContain('Middle flag only')
	})

	it('asks once per mistyped argument and answers both from one message', async () => {
		app.emu.rcon.commandLog.length = 0
		// "alise" is nearly Alice_The_Great and "tq" is nearly the configured "tk" reason
		app.emu.world.chat(admin, 'ChatAdmin', `${cmd('warn')} alise tq`)

		const first = await awaitPrompt()
		expect(first).toContain('(1/2)')

		app.emu.world.chat(admin, 'ChatAdmin', '1 1')
		await app.waitFor(() => warnsTo(alice).some((w) => /teamkill/i.test(w)), { label: 'the teamkilling warn', timeoutMs: 20_000 })
	})

	it('keeps the question open when the number is out of range', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', `${cmd('warn')} alise stop that`)
		await awaitPrompt()

		app.emu.world.chat(admin, 'ChatAdmin', '9')
		await app.waitFor(() => warnsToAdmin().some((w) => /Pick 1-/.test(w)), { label: 'the out-of-range reply', timeoutMs: 20_000 })

		app.emu.world.chat(admin, 'ChatAdmin', '1')
		await app.waitFor(() => warnsTo(alice).some((w) => w.includes('stop that')), { label: 'the warn to Alice', timeoutMs: 20_000 })
	})

	it('discards the question when the caller runs another command', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', `${cmd('warn')} alise stop that`)
		await awaitPrompt()

		app.emu.world.chat(admin, 'ChatAdmin', cmd('shownext'))
		await app.waitFor(() => warnsToAdmin().some((w) => /Discarded the pending choice/.test(w)), {
			label: 'the discard notice',
			timeoutMs: 20_000,
		})

		// the number now means nothing to the prompt. A later command's reply is the marker that it was read and
		// dropped, rather than a sleep long enough to hope nothing was coming.
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '1')
		app.emu.world.chat(admin, 'ChatAdmin', cmd('shownext'))
		await app.waitFor(() => warnsToAdmin().some((w) => /Gorodok|Sumari|Harju/i.test(w)), {
			label: 'the reply to the command sent after the number',
			timeoutMs: 20_000,
		})
		expect(warnsTo(alice)).toHaveLength(0)
	})
})
