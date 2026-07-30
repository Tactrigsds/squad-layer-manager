import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { cmd, LAYERS, queue } from '../harness/arrange'

// Teamswaps, driven from in-game admin chat. `swapnow` acts immediately over RCON;
// `swapnext` is held until the map rolls, which is the interesting one: the swap has to survive
// a roll and then be applied against the new match's roster.

const ADMIN_STEAM_ID = '76561198000000002'

let app: AppFixture
const admin = makePlayer({ name: ' swap_admin', steam: ADMIN_STEAM_ID, teamId: 1 })
const target = makePlayer({ name: ' swap_target', teamId: 2 })

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

function latestMatchId(db: ReturnType<AppFixture['readDb']>) {
	return (db.prepare(`SELECT id FROM matchHistory ORDER BY id DESC LIMIT 1`).get() as { id: number }).id
}

function appEventTypesForLatestMatch() {
	const db = app.readDb()
	try {
		const rows = db.prepare(`SELECT type FROM appEvents WHERE matchId = ?`).all(latestMatchId(db)) as { type: string }[]
		return rows.map((r) => r.type)
	} finally {
		db.close()
	}
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
			.get(latestMatchId(db), eos) as { type: string | null } | undefined
		return row?.type ?? null
	} finally {
		db.close()
	}
}

describe('teamswaps', () => {
	it(cmd('swapnow moves the player to the other team immediately'), async () => {
		expect(target.teamId).toBe(2)
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnow swap_target'))

		await app.waitFor(() => forceChangesFor(target.eos).length > 0, {
			label: 'AdminForceTeamChange for the target',
			timeoutMs: 20_000,
		})
		// the emulated server acted on it, so the roster the app polls now disagrees with the old teams
		expect(target.teamId).toBe(1)
	})

	it(cmd('swapnext holds the swap until the map rolls, then applies it'), async () => {
		const held = makePlayer({ name: ' swap_later', teamId: 2 })
		app.emu.world.connectPlayer(held)
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('swapnext swap_later'))

		// the app acknowledges the request to the admin, but leaves the player where they are
		await app.waitFor(() => app.emu.rcon.commandLog.some((c) => c.body.startsWith('AdminWarn') && c.body.includes(admin.eos)), {
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
		const appEventTypes = appEventTypesForLatestMatch()
		expect(appEventTypes).toContain('TEAMSWAPS_UPDATED')
		expect(appEventTypes).not.toContain('TEAM_CHANGE_FORCED')

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
		const squad = app.emu.world.createSquad(leader, 'ALPHA')
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
