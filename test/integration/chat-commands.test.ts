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
// a second in-game admin who runs nothing: he is only here to be a recipient warnAllAdmins would reach
const OTHER_ADMIN_STEAM_ID = '76561198000000002'

let app: AppFixture
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID, teamId: 1 })
const otherAdmin = makePlayer({ name: ' other_admin_player', steam: OTHER_ADMIN_STEAM_ID, teamId: 1 })

beforeAll(async () => {
	app = await createAppFixture({
		// a seeded queue is a known queue: nothing generates on top of it
		layerQueue: [voteQueueItem([LAYERS.gorodokRaas, LAYERS.harjuRaas]), ...queue(LAYERS.sumariSeed)],
		// in game this player is an admin (Admins.cfg); out of game he is the seeded superuser
		// (linkedSteamAccounts). Commands need both: the first to be an admin, the second to be allowed.
		admins: [ADMIN_STEAM_ID, OTHER_ADMIN_STEAM_ID],
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
		app.emu.world.connectPlayer(otherAdmin)
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

		// the command was typed in admin chat, where the other admin already read it, so the swap does not
		// also reach him as a warn. A roster sync is two polls, long enough for a notification to have landed
		await app.waitForRosterSync()
		expect(warnsTo(app, otherAdmin)).toHaveLength(0)
	})

	// The optional destination team is what makes the swap commands safe to run twice: without it they always mean
	// "the other team", so a repeat undoes the first run.
	it(cmd('swapnow with a destination leaves a player already on it alone'), async () => {
		const settled = makePlayer({ name: ' swap_settled', teamId: 1 })
		app.emu.world.connectPlayer(settled)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnow swap_settled 1'))

		await app.waitFor(() => warnsToAdmin().some((w) => /is already on/i.test(w)), {
			label: 'the no-op reply to the admin',
			timeoutMs: 20_000,
		})
		expect(forceChangesFor(settled.eos)).toHaveLength(0)
		expect(settled.teamId).toBe(1)

		// naming the other team still moves him, so the destination is being read rather than ignored
		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnow swap_settled 2'))
		await app.waitFor(() => forceChangesFor(settled.eos).length > 0, {
			label: 'AdminForceTeamChange for the target',
			timeoutMs: 20_000,
		})
		expect(settled.teamId).toBe(2)
	})

	it(cmd('swapnext with a destination reports a repeat instead of failing on it'), async () => {
		const twice = makePlayer({ name: ' swap_twice', teamId: 1 })
		app.emu.world.connectPlayer(twice)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnext swap_twice 2'))
		await app.waitFor(() => warnsToAdmin().some((w) => /^AdminWarn \S+ Queued /.test(w)), {
			label: 'the swap queued',
			timeoutMs: 20_000,
		})

		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnext swap_twice 2'))
		await app.waitFor(() => warnsToAdmin().some((w) => /is already queued to swap/i.test(w)), {
			label: 'the repeat reported as already queued',
			timeoutMs: 20_000,
		})
		expect(warnsToAdmin().join('\n')).not.toMatch(/already marked/i)
		expect(forceChangesFor(twice.eos)).toHaveLength(0)

		// the roll test below queues its own swap and reads what the roll executed, so this one is not left standing
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('clearswaps'))
		await app.waitFor(() => warnsToAdmin().some((w) => /Cleared/i.test(w)), { label: 'the queue cleared', timeoutMs: 20_000 })
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

// The player-initiated switch queue. /switch swaps the sender immediately when their team can spare them, and
// queues them otherwise; the queue drains by mutual swaps, by the population rule, or by moving a fresh connect
// aside. One journey drives it: each test leaves the queue empty for the next, and the roll test runs last.
describe('switch requests', () => {
	let fillerCounter = 0

	function teamCount(teamId: 1 | 2) {
		return app.emu.world.playerList().filter((p) => p.teamId === teamId).length
	}

	// tops up the smaller team with filler players. Only safe while the queue is empty: a fresh connect while
	// someone is waiting is a connector, which is its own test below.
	async function evenTeams() {
		while (teamCount(1) !== teamCount(2)) {
			const smaller = teamCount(1) < teamCount(2) ? 1 : 2
			app.emu.world.connectPlayer(makePlayer({ name: `srq_filler_${fillerCounter++}`, teamId: smaller }))
		}
		await app.waitForRosterSync()
	}

	function forceChangesFor(eosId: string) {
		return app.emu.rcon.commandLog.filter((c) => c.body === `AdminForceTeamChange ${eosId}`)
	}

	function savedSwitchRequests(): string | null {
		const db = app.readDb()
		try {
			const row = db.prepare(`SELECT switchRequests FROM servers`).get() as { switchRequests: string | null } | undefined
			return row?.switchRequests ?? null
		} finally {
			db.close()
		}
	}

	it(cmd('switch swaps immediately when the sender team is larger'), async () => {
		await evenTeams()
		const switcher = app.emu.world.connectPlayer(makePlayer({ name: 'srq_now', teamId: 1 }))
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(switcher, 'ChatAll', cmd('switch'))

		await app.waitFor(() => forceChangesFor(switcher.eos).length > 0, {
			label: 'the immediate switch',
			timeoutMs: 20_000,
		})
		expect(switcher.teamId).toBe(2)
		await app.waitFor(() => appEventTypes(app, latestMatch(app).id).includes('SWITCH_REQUESTS_FULFILLED'), {
			label: 'the fulfillment recorded',
			timeoutMs: 20_000,
		})
	})

	it(cmd('switch queues on even teams, telling the player their spot and how to cancel'), async () => {
		await evenTeams()
		const waiter = app.emu.world.connectPlayer(makePlayer({ name: 'srq_waiter', teamId: 1 }))
		await evenTeams()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(waiter, 'ChatAll', cmd('switch'))

		await app.waitFor(() => warnsTo(app, waiter).some((w) => w.includes('#1 in line')), {
			label: 'the queue confirmation',
			timeoutMs: 20_000,
		})
		const confirmation = warnsTo(app, waiter).find((w) => w.includes('#1 in line'))!
		expect(confirmation).toContain(cmd('cancelswitch'))
		expect(forceChangesFor(waiter.eos)).toHaveLength(0)

		// the queue survives an SLM restart, so it is persisted as it changes
		await app.waitFor(() => (savedSwitchRequests() ?? '').includes(waiter.eos), {
			label: 'the request persisted',
			timeoutMs: 20_000,
		})
	})

	it('pairs a waiter from each side into a mutual swap', async () => {
		// srq_waiter is still queued from the previous test. The opposite-side player must not be a fresh
		// connect (that is the connector rule); a filler from evenTeams has been on team 2 long enough.
		const waiter = app.emu.world.findPlayer('srq_waiter')!
		const opposite = app.emu.world.playerList().find((p) => p.teamId === 2 && p.name.startsWith('srq_filler'))!
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(opposite, 'ChatAll', cmd('switch'))

		await app.waitFor(() => forceChangesFor(waiter.eos).length > 0 && forceChangesFor(opposite.eos).length > 0, {
			label: 'both sides of the mutual swap',
			timeoutMs: 20_000,
		})
		expect(waiter.teamId).toBe(2)
		expect(opposite.teamId).toBe(1)
	})

	it(cmd('cancelswitch drops the request, moving everyone behind up a spot'), async () => {
		await evenTeams()
		const first = app.emu.world.connectPlayer(makePlayer({ name: 'srq_cancel_a', teamId: 1 }))
		const second = app.emu.world.connectPlayer(makePlayer({ name: 'srq_cancel_b', teamId: 1 }))
		await evenTeams()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(first, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, first).some((w) => w.includes('#1 in line')), { label: 'first queued', timeoutMs: 20_000 })
		app.emu.world.chat(second, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, second).some((w) => w.includes('#2 in line')), { label: 'second queued', timeoutMs: 20_000 })

		app.emu.world.chat(first, 'ChatAll', cmd('cancelswitch'))
		await app.waitFor(() => warnsTo(app, first).some((w) => /has been cancelled/.test(w)), {
			label: 'the cancellation confirmed',
			timeoutMs: 20_000,
		})
		await app.waitFor(() => warnsTo(app, second).some((w) => /moved up: now #1/.test(w)), {
			label: 'the second waiter promoted',
			timeoutMs: 20_000,
		})
		expect(forceChangesFor(first.eos)).toHaveLength(0)
		expect(forceChangesFor(second.eos)).toHaveLength(0)

		// leave the queue empty for the next test
		app.emu.world.chat(second, 'ChatAll', cmd('cancelswitch'))
		await app.waitFor(() => warnsTo(app, second).some((w) => /has been cancelled/.test(w)), {
			label: 'the cleanup cancellation',
			timeoutMs: 20_000,
		})
	})

	it('drops a waiter who disconnects, promoting the one behind them', async () => {
		await evenTeams()
		const leaver = app.emu.world.connectPlayer(makePlayer({ name: 'srq_leaver', teamId: 1 }))
		const stays = app.emu.world.connectPlayer(makePlayer({ name: 'srq_stays', teamId: 1 }))
		await evenTeams()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(leaver, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, leaver).some((w) => w.includes('#1 in line')), { label: 'leaver queued', timeoutMs: 20_000 })
		app.emu.world.chat(stays, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, stays).some((w) => w.includes('#2 in line')), { label: 'stays queued', timeoutMs: 20_000 })

		app.emu.world.disconnectPlayer(leaver)

		await app.waitFor(() => warnsTo(app, stays).some((w) => /moved up: now #1/.test(w)), {
			label: 'the remaining waiter promoted',
			timeoutMs: 20_000,
		})

		// the leaver was on the waiter's own team, so the disconnect made that team the smaller one: the
		// promotion changes nothing about whether the waiter may switch
		await app.waitForRosterSync()
		expect(forceChangesFor(stays.eos)).toHaveLength(0)
		expect(stays.teamId).toBe(1)

		app.emu.world.chat(stays, 'ChatAll', cmd('cancelswitch'))
		await app.waitFor(() => warnsTo(app, stays).some((w) => /has been cancelled/.test(w)), {
			label: 'the cleanup cancellation',
			timeoutMs: 20_000,
		})
	})

	it('moves a fresh connect aside to make room for a waiter', async () => {
		await evenTeams()
		const waiter = app.emu.world.connectPlayer(makePlayer({ name: 'srq_conn_waiter', teamId: 1 }))
		await evenTeams()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(waiter, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, waiter).some((w) => w.includes('#1 in line')), { label: 'the waiter queued', timeoutMs: 20_000 })

		// a fresh player lands on the waiter's target team, which would otherwise block the queue forever
		const fresh = app.emu.world.connectPlayer(makePlayer({ name: 'srq_fresh', teamId: 2 }))

		await app.waitFor(() => forceChangesFor(fresh.eos).length > 0 && forceChangesFor(waiter.eos).length > 0, {
			label: 'the connector moved and the waiter fulfilled',
			timeoutMs: 25_000,
		})
		expect(fresh.teamId).toBe(1)
		expect(waiter.teamId).toBe(2)
	})

	it('never yanks a rejoining player to make room', async () => {
		// the disconnect happens before anyone queues, so it can't hand its slot to the queue
		const rejoiner = app.emu.world.connectPlayer(makePlayer({ name: 'srq_rejoiner', teamId: 2 }))
		await app.waitForRosterSync()
		app.emu.world.disconnectPlayer(rejoiner)
		await evenTeams()

		const waiter = app.emu.world.connectPlayer(makePlayer({ name: 'srq_rejoin_waiter', teamId: 1 }))
		await evenTeams()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(waiter, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, waiter).some((w) => w.includes('#1 in line')), { label: 'the waiter queued', timeoutMs: 20_000 })

		// he disconnected this match, so his rejoin onto the waiter's target team is not a free slot
		rejoiner.teamId = 2
		app.emu.world.connectPlayer(rejoiner)
		await app.waitForRosterSync()
		await app.waitForRosterSync()

		expect(forceChangesFor(rejoiner.eos)).toHaveLength(0)
		expect(forceChangesFor(waiter.eos)).toHaveLength(0)

		app.emu.world.chat(waiter, 'ChatAll', cmd('cancelswitch'))
		await app.waitFor(() => warnsTo(app, waiter).some((w) => /has been cancelled/.test(w)), {
			label: 'the cleanup cancellation',
			timeoutMs: 20_000,
		})
	})

	it('resets the queue when the map rolls', async () => {
		await evenTeams()
		const waiter = app.emu.world.connectPlayer(makePlayer({ name: 'srq_roll_waiter', teamId: 1 }))
		await evenTeams()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(waiter, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, waiter).some((w) => w.includes('#1 in line')), { label: 'the waiter queued', timeoutMs: 20_000 })

		app.emu.world.endMatch()
		app.emu.world.startNewGame()
		await app.waitForRosterSync()

		await app.waitFor(() => savedSwitchRequests() === null || !savedSwitchRequests()!.includes(waiter.eos), {
			label: 'the persisted queue cleared',
			timeoutMs: 25_000,
		})

		// a fresh request starts at the front, so nothing of the old queue survived
		await evenTeams()
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(waiter, 'ChatAll', cmd('switch'))
		await app.waitFor(() => warnsTo(app, waiter).some((w) => w.includes('#1 in line')), {
			label: 'a fresh #1 after the roll',
			timeoutMs: 20_000,
		})
	})
})
