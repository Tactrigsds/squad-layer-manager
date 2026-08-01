import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { cmd, LAYERS, queue, voteQueueItem } from '../harness/arrange'
import { appEventTypes, latestMatch, savedQueue, warnsTo } from '../harness/inspect'

// In-game admin commands: the emulator sends chat as a player, the app parses it, authorizes the
// sender, and acts back over RCON. This is the path the fixture's arrangement API exists for
// (seeded queue, admin list, steam link), so it doubles as that API's test. One admin drives the
// whole file: queue commands, argument disambiguation, and the teamswap commands, whose deferred
// variant has to survive a map roll.

const ADMIN_STEAM_ID = '76561198000000001'

let app: AppFixture
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID, teamId: 1 })

beforeAll(async () => {
	app = await createAppFixture({
		// a seeded queue is a known queue: nothing generates on top of it
		layerQueue: [voteQueueItem([LAYERS.gorodokRaas, LAYERS.harjuRaas]), ...queue(LAYERS.sumariSeed)],
		// in game this player is an admin (Admins.cfg); out of game he is the seeded superuser
		// (linkedSteamAccounts). Commands need both: the first to be an admin, the second to be allowed.
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		serverSettings: (s) => {
			// so a roll leaves the queue "low" and the app warns every admin about it -- see the roll test
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

// every warn the app sent to our admin player, in order
function warnsToAdmin(): string[] {
	return warnsTo(app, admin)
}

describe('in-game admin commands', () => {
	it('starts with exactly the seeded queue', () => {
		const queued = savedQueue(app)
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
		await app.waitFor(() => JSON.stringify(savedQueue(app)).includes('votes'), {
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

	it('offers the closest players, and runs the command against the one picked', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', `${cmd('warn')} alise stop that`)

		const prompt = await awaitPrompt()
		expect(prompt).toContain('Alice_The_Great')
		expect(prompt).toMatch(/Reply 1-\d, or 0 to cancel/)

		app.emu.world.chat(admin, 'ChatAdmin', '1')
		await app.waitFor(() => warnsTo(app, alice).some((w) => w.includes('stop that')), {
			label: 'the warn to Alice',
			timeoutMs: 20_000,
		})
		expect(warnsTo(app, alicia)).toHaveLength(0)
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
		await app.waitFor(() => warnsTo(app, alice).some((w) => /teamkill/i.test(w)), {
			label: 'the teamkilling warn',
			timeoutMs: 20_000,
		})
	})

	it('keeps the question open when the number is out of range', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', `${cmd('warn')} alise stop that`)
		await awaitPrompt()

		app.emu.world.chat(admin, 'ChatAdmin', '9')
		await app.waitFor(() => warnsToAdmin().some((w) => /Pick 1-/.test(w)), { label: 'the out-of-range reply', timeoutMs: 20_000 })

		app.emu.world.chat(admin, 'ChatAdmin', '1')
		await app.waitFor(() => warnsTo(app, alice).some((w) => w.includes('stop that')), {
			label: 'the warn to Alice',
			timeoutMs: 20_000,
		})
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
		expect(warnsTo(app, alice)).toHaveLength(0)
	})
})

// Teamswaps, driven from the same admin chat. `swapnow` acts immediately over RCON; `swapnext` is held
// until the map rolls, which is the interesting one: the swap has to survive a roll and then be applied
// against the new match's roster.
describe('teamswaps', () => {
	const target = makePlayer({ name: ' swap_target', teamId: 2 })

	beforeAll(async () => {
		app.emu.world.connectPlayer(target)
		await app.waitForRosterSync()
	}, 60_000)

	function forceChangesFor(eosId: string) {
		return app.emu.rcon.commandLog.filter((c) => c.body === `AdminForceTeamChange ${eosId}`)
	}

	// the app event a player's team change in the current match was attributed to, if it landed and carried one
	function teamChangeAppEventType(eos: string) {
		const db = app.readDb()
		try {
			const row = db
				.prepare(
					`SELECT ae.type as type FROM serverEvents se
					 JOIN playerEventAssociations pea ON pea.serverEventId = se.id
					 LEFT JOIN appEvents ae ON ae.id = se.appEventId
					 WHERE se.type = 'PLAYER_CHANGED_TEAM' AND se.matchId = ? AND pea.playerId = ?
					 ORDER BY se.id DESC LIMIT 1`,
				)
				.get(latestMatch(app).id, eos) as { type: string | null } | undefined
			return row?.type ?? null
		} finally {
			db.close()
		}
	}

	it(cmd('swapnow moves the player to the other team immediately'), async () => {
		const startingTeam = target.teamId
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnow swap_target'))

		await app.waitFor(() => forceChangesFor(target.eos).length > 0, {
			label: 'AdminForceTeamChange for the target',
			timeoutMs: 20_000,
		})
		// the emulated server acted on it, so the roster the app polls now disagrees with the old teams
		expect(target.teamId).not.toBe(startingTeam)
	})

	it(cmd('swapnext holds the swap until the map rolls, then applies it'), async () => {
		const held = makePlayer({ name: ' swap_later', teamId: 2 })
		app.emu.world.connectPlayer(held)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnext swap_later'))

		// the app acknowledges the request to the admin, but leaves the player where they are
		await app.waitFor(() => warnsToAdmin().length > 0, {
			label: 'acknowledgement to the admin',
			timeoutMs: 20_000,
		})
		expect(forceChangesFor(held.eos)).toHaveLength(0)
		expect(held.teamId).toBe(2)

		// and it survives to the other side of the roll, where it is finally applied. The roll itself
		// moves every player to the other team index (see World.swapTeamsOnRoll), which is what keeps a
		// player's *side* stable across matches -- so honouring the swap means moving them back. It also
		// leaves them unsorted for a poll (World.sortTeamsLateOnRoll): the queue has to live through a
		// roster that lists neither their old team nor their new one.
		app.emu.world.endMatch()
		app.emu.world.startNewGame()
		await app.waitForRosterSync()

		await app.waitFor(() => forceChangesFor(held.eos).length > 0, {
			label: 'the held swap applied after the roll',
			timeoutMs: 30_000,
		})
		expect(held.teamId).toBe(2)

		// draining the queue and forcing the switch are one action, and log one event. A TEAM_CHANGE_FORCED
		// beside the execution's TEAMSWAPS_UPDATED says the same thing twice in the activity feed.
		const eventTypes = appEventTypes(app, latestMatch(app).id)
		expect(eventTypes).toContain('TEAMSWAPS_UPDATED')
		expect(eventTypes).not.toContain('TEAM_CHANGE_FORCED')

		// and the one event still claims the team changes it caused, so they fold into it rather than reading
		// as a player switching sides on their own
		await app.waitForRosterSync()
		await app.waitFor(() => teamChangeAppEventType(held.eos) !== null, {
			label: 'the applied swap attributed to the execution',
			timeoutMs: 20_000,
		})
		expect(teamChangeAppEventType(held.eos)).toBe('TEAMSWAPS_UPDATED')
	})

	// A squad leader crossing teams leaves their old squad behind. The app validates the ListPlayers/ListSquads pair
	// and refetches when they disagree, and a squad with members but no leader never resolves: the retries run out
	// and the server instance is torn down. This is the swap the sandbox panel makes, so it is the one that killed it.
	it('survives the squad leader of a squad with other members changing team', async () => {
		const leader = makePlayer({ name: ' squad_leader_swap', teamId: 1 })
		const member = makePlayer({ name: ' squad_member_stays', teamId: 1 })
		app.emu.world.connectPlayer(leader)
		app.emu.world.connectPlayer(member)
		const squad = app.emu.world.createSquad(leader, 'BRAVO')
		app.emu.world.joinSquad(member, squad)
		await app.waitForRosterSync()

		app.emu.world.setTeam(leader, leader.teamId === 1 ? 2 : 1)

		// the squad outlives them, led by whoever is left
		expect(app.emu.world.squadMembers(squad).map((p) => p.name)).toEqual([member.name])
		expect(member.isLeader).toBe(true)

		// and the app polls straight through it rather than giving up on the server
		await app.waitForRosterSync()
		expect(fs.readFileSync(app.logFile, 'utf8')).not.toContain('tearing the server down')
	})
})
