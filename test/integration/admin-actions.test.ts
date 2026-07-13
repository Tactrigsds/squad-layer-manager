import { type EmuPlayer, makePlayer } from '@/emulator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// Admin actions taken from in-game chat. Each one has to reach the game over RCON, carry the reason
// text the admin picked, and land on the right targets -- one player for the player commands, every
// member for the squad ones.

const ADMIN_STEAM_ID = '76561198000000003'

const REASONS = [
	{
		label: 'Toxicity',
		aliases: ['tox'],
		actionTexts: {
			warn: 'Cut out the toxicity',
			kick: 'Kicked for toxicity',
			kill: 'Killed for toxicity',
		},
	},
]

let app: AppFixture
const admin = makePlayer({ name: ' action_admin', steam: ADMIN_STEAM_ID, teamId: 1 })
let leader: EmuPlayer
let member: EmuPlayer
let bystander: EmuPlayer

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		globalSettings: (s) => {
			s.adminActionReasons = REASONS as typeof s.adminActionReasons
		},
	})
	app.emu.world.connectPlayer(admin)

	// a squad of two on the admin's team, so `!warnsquad 1` (no team token) resolves against it
	leader = app.emu.world.connectPlayer(makePlayer({ name: ' squad_leader', teamId: 1 }))
	member = app.emu.world.connectPlayer(makePlayer({ name: ' squad_member', teamId: 1 }))
	const squad = app.emu.world.createSquad(leader, 'ALPHA')
	app.emu.world.joinSquad(member, squad)
	// same team, no squad: a squad action must not touch them
	bystander = app.emu.world.connectPlayer(makePlayer({ name: ' bystander', teamId: 1 }))

	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function warnsTo(player: EmuPlayer): string[] {
	return app.emu.rcon.commandLog
		.filter((c) => c.body.startsWith(`AdminWarn "${player.eos}"`))
		.map((c) => c.body)
}

describe('admin actions from in-game chat', () => {
	it('warns a single player with the reason the admin named', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', '!warn squad_member Toxicity')

		await app.waitFor(() => warnsTo(member).length > 0, { label: 'a warn to the player', timeoutMs: 20_000 })
		// the reason's warn text is what the player is told, verbatim
		expect(warnsTo(member)[0]).toContain('Cut out the toxicity')
		// and nobody else was warned for it
		expect(warnsTo(leader)).toHaveLength(0)
	})

	it('warns every member of a squad', async () => {
		app.emu.rcon.commandLog.length = 0
		// no team token: the squad is resolved on the sender's own team
		app.emu.world.chat(admin, 'ChatAdmin', '!warnsquad 1 Toxicity')

		await app.waitFor(
			() =>
				warnsTo(leader).some((w) => w.includes('Cut out the toxicity')) && warnsTo(member).some((w) => w.includes('Cut out the toxicity')),
			{ label: 'a warn to each member of the squad', timeoutMs: 20_000 },
		)
		// ...and only them: a player on the same team but outside the squad is untouched. (The admin does
		// get a copy, as the command's feedback -- admin-directed messages carry the warn prefix.)
		expect(warnsTo(bystander)).toHaveLength(0)
		expect(warnsTo(admin).every((w) => w.includes('SLM: '))).toBe(true)
	})

	it('kicks a single player, with the reason carried on the kick itself', async () => {
		const nuisance = app.emu.world.connectPlayer(makePlayer({ name: ' nuisance', teamId: 2 }))
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', '!kick nuisance Toxicity')

		const kick = await app.emu.expectCommand(new RegExp(`^AdminKick "${nuisance.eos}"`), { timeoutMs: 20_000 })
		// AdminKick delivers the reason itself, so no follow-up warn is needed
		expect(kick.body).toContain('Kicked for toxicity')
		// and the player is gone from the server
		expect(app.emu.world.players.has(nuisance.eos)).toBe(false)
	})

	it('records what was done, and who did it', async () => {
		await app.waitFor(() => {
			const db = app.readDb()
			try {
				const rows = db
					.prepare(`SELECT type, actorType, actorPlayerId FROM appEvents WHERE type LIKE '%ADMIN%' OR type LIKE '%PLAYER%'`)
					.all() as { type: string; actorType: string; actorPlayerId: string | null }[]
				// the admin acted from in game, so they are attributed as the in-game player they are
				return rows.some((r) => r.actorType === 'ingame-user' && r.actorPlayerId === admin.eos)
			} finally {
				db.close()
			}
		}, { label: 'the actions attributed to the admin in the audit log', timeoutMs: 20_000 })
	})
})
