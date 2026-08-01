import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type EmuPlayer, makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture, TEST_ADMIN_LIST, type TestUser } from '../harness/app-fixture'
import { cmd, LAYERS, queue, role } from '../harness/arrange'
import { warnsTo as warnsFrom } from '../harness/inspect'

// Everything an in-game admin does through chat, and everything that stops them. One roster of admins
// and targets carries both halves: the action commands (warn/kick and their templated triggers, squad
// fanout, reasons, audit attribution) and the rbac gates in front of them (duration caps, the
// super-user unlimited grant, admin-list-derived role assignment, the identifying-permission gate).

const HOUR = 60 * 60 * 1000

const ACTION_STEAM_ID = '76561198000000003'
// a super user (via the default admin's SUPER_USERS bootstrap): unlimited timeout duration
const SUPER_STEAM_ID = '76561198000000010'
// a plain admin whose only rbac grant is a role capped at 2h
const CAPPED_STEAM_ID = '76561198000000011'
const CAPPED_USER: TestUser = { discordId: 900000000000000031n, username: 'capped-admin', steamIds: [CAPPED_STEAM_ID] }
// an in-game admin whose only rbac grant comes from an includeIngameAdmins role (the admin-list-derived path, not a
// discord-user assignment): a distinct resolver that the same Role.push bug also silently broke
const INGAME_STEAM_ID = '76561198000000012'
const INGAME_USER: TestUser = { discordId: 900000000000000032n, username: 'ingame-only', steamIds: [INGAME_STEAM_ID] }
// in the admin list, but only via a reserve-slot group with no admin-identifying permission: getPlayerGroups sees them,
// getIsAdmin must not, so an includeIngameAdmins role must not reach them. Linked (the timeout command requires a linked
// account before the rbac check) but assigned no role, so includeIngameAdmins is their only possible grant path.
const RESERVE_STEAM_ID = '76561198000000013'
const RESERVE_USER: TestUser = { discordId: 900000000000000033n, username: 'reserve-only', steamIds: [RESERVE_STEAM_ID] }

const REASONS = [
	{
		label: 'Toxicity',
		keywords: ['tox'],
		actionTexts: {
			warn: 'Cut out the toxicity',
			kick: 'Kicked for toxicity',
			kill: 'Killed for toxicity',
		},
	},
]

let app: AppFixture
const admin = makePlayer({ name: ' action_admin', steam: ACTION_STEAM_ID, teamId: 1 })
const superAdmin = makePlayer({ name: ' super_admin', steam: SUPER_STEAM_ID, teamId: 1 })
const capped = makePlayer({ name: ' capped_admin', steam: CAPPED_STEAM_ID, teamId: 1 })
const ingameAdmin = makePlayer({ name: ' ingame_admin', steam: INGAME_STEAM_ID, teamId: 1 })
const reserveAdmin = makePlayer({ name: ' reserve_admin', steam: RESERVE_STEAM_ID, teamId: 1 })
let leader: EmuPlayer
let member: EmuPlayer
let bystander: EmuPlayer
let target1h: EmuPlayer
let target6hCapped: EmuPlayer
let target6hSuper: EmuPlayer
let targetIngame: EmuPlayer
let targetReserve: EmuPlayer

// The timeout command's admin scope needs in-game admin status; the duration cap comes from rbac. Every admin here
// is in the Admins.cfg (so all pass the scope), but only the action admin's and super user's linked account is a
// SUPER_USER; the capped admin's only grant is the 2h role assigned to their linked account.
beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
		admins: [ACTION_STEAM_ID, SUPER_STEAM_ID, CAPPED_STEAM_ID, INGAME_STEAM_ID],
		reserveAdmins: [RESERVE_STEAM_ID],
		adminSteamIds: [ACTION_STEAM_ID, SUPER_STEAM_ID],
		users: [CAPPED_USER, INGAME_USER, RESERVE_USER],
		globalSettings: (s) => {
			s.adminActionReasons = REASONS as typeof s.adminActionReasons
			// shortcuts onto warn: one pins the reason outright, the other only supplies it when the caller
			// leaves it out
			s.commands.warn.triggers.push(
				{ string: cmd('warntox'), args: '{{arg1}} tox' },
				{ string: cmd('warnsp'), args: '{{arg1}} {{^rest2}}tox{{/rest2}}{{rest2}}' },
			)
			s.rbac.roles['capped-timeouter'] = role([], { users: [CAPPED_USER] }, { maxTimeout: 2 * HOUR })
			// granted to whoever is an in-game admin, with no discord-user assignment at all
			s.rbac.roles['ingame-timeouter'] = role([], { ingameAdminLists: [TEST_ADMIN_LIST] }, { maxTimeout: 1 * HOUR })
		},
	})
	app.emu.world.connectPlayer(admin)
	app.emu.world.connectPlayer(superAdmin)
	app.emu.world.connectPlayer(capped)
	app.emu.world.connectPlayer(ingameAdmin)
	app.emu.world.connectPlayer(reserveAdmin)

	// a squad of two on the admin's team, so `warnsquad 1` (no team token) resolves against it
	leader = app.emu.world.connectPlayer(makePlayer({ name: ' squad_leader', teamId: 1 }))
	member = app.emu.world.connectPlayer(makePlayer({ name: ' squad_member', teamId: 1 }))
	const squad = app.emu.world.createSquad(leader, 'ALPHA')
	app.emu.world.joinSquad(member, squad)
	// same team, no squad: a squad action must not touch them
	bystander = app.emu.world.connectPlayer(makePlayer({ name: ' bystander', teamId: 1 }))

	target1h = app.emu.world.connectPlayer(makePlayer({ name: ' target_onehr', teamId: 2 }))
	target6hCapped = app.emu.world.connectPlayer(makePlayer({ name: ' target_capped', teamId: 2 }))
	target6hSuper = app.emu.world.connectPlayer(makePlayer({ name: ' target_super', teamId: 2 }))
	targetIngame = app.emu.world.connectPlayer(makePlayer({ name: ' target_ingame', teamId: 2 }))
	targetReserve = app.emu.world.connectPlayer(makePlayer({ name: ' target_reserve', teamId: 2 }))

	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function warnsTo(player: EmuPlayer): string[] {
	return warnsFrom(app, player)
}

describe('admin actions from in-game chat', () => {
	it('warns a single player with the reason the admin named', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('warn squad_member tox'))

		await app.waitFor(() => warnsTo(member).length > 0, { label: 'a warn to the player', timeoutMs: 20_000 })
		// the reason's warn text is what the player is told, verbatim
		expect(warnsTo(member)[0]).toContain('Cut out the toxicity')
		// and nobody else was warned for it
		expect(warnsTo(leader)).toHaveLength(0)
	})

	// the templated-trigger path: the words typed after the trigger are rendered into its args template, and
	// the result is dispatched as if the admin had typed the command out in full
	it('warns through a trigger that pins the reason', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('warntox squad_member'))

		await app.waitFor(() => warnsTo(member).length > 0, { label: 'a warn through the shortcut', timeoutMs: 20_000 })
		// the pinned token went through reason resolution, not just into the message: `tox` is a keyword
		expect(warnsTo(member)[0]).toContain('Cut out the toxicity')
		expect(warnsTo(leader)).toHaveLength(0)
	})

	it('fills an omitted word from the template default, and yields to one that is typed', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('warnsp squad_member'))

		await app.waitFor(() => warnsTo(member).length > 0, { label: 'a warn using the default reason', timeoutMs: 20_000 })
		expect(warnsTo(member)[0]).toContain('Cut out the toxicity')

		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('warnsp squad_member being rude'))

		await app.waitFor(() => warnsTo(member).length > 0, { label: 'a warn with the reason the caller typed', timeoutMs: 20_000 })
		expect(warnsTo(member)[0]).toContain('being rude')
	})

	it('warns every member of a squad', async () => {
		app.emu.rcon.commandLog.length = 0
		// no team token: the squad is resolved on the sender's own team
		app.emu.world.chat(admin, 'ChatAdmin', cmd('warnsquad 1 tox'))

		await app.waitFor(
			() =>
				warnsTo(leader).some((w) => w.includes('Cut out the toxicity')) &&
				warnsTo(member).some((w) => w.includes('Cut out the toxicity')),
			{ label: 'a warn to each member of the squad', timeoutMs: 20_000 },
		)
		// ...and only them: a player on the same team but outside the squad is untouched. (The admin does
		// get a copy, as the command's feedback.)
		expect(warnsTo(bystander)).toHaveLength(0)
	})

	it('kicks a single player, with the reason carried on the kick itself', async () => {
		const nuisance = app.emu.world.connectPlayer(makePlayer({ name: ' nuisance', teamId: 2 }))
		await app.waitForRosterSync()
		app.emu.rcon.commandLog.length = 0

		app.emu.world.chat(admin, 'ChatAdmin', cmd('kick nuisance tox'))

		const kick = await app.emu.expectCommand(new RegExp(`^AdminKick "${nuisance.eos}"`), { timeoutMs: 20_000 })
		// AdminKick delivers the reason itself, so no follow-up warn is needed
		expect(kick.body).toContain('Kicked for toxicity')
		// and the player is gone from the server
		expect(app.emu.world.players.has(nuisance.eos)).toBe(false)
	})

	it('records what was done, and who did it', async () => {
		await app.waitFor(
			() => {
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
			},
			{ label: 'the actions attributed to the admin in the audit log', timeoutMs: 20_000 },
		)
	})
})

// The in-game timeout command is gated by SM.Grants.satisfyingTimeout: an admin may only issue a timeout up to the
// maximum duration their roles grant. "up to N" is a comparator, not an equality match, and an unlimited (super user)
// grant has to satisfy any duration -- a regression there silently blocks the people who should be able to do the most.
describe('in-game timeout duration cap', () => {
	it('allows a capped admin to issue a timeout within their cap', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(capped, 'ChatAdmin', cmd('timeout target_onehr 1h'))

		await app.waitFor(() => warnsTo(capped).some((w) => w.includes('Timed out')), {
			label: 'the timeout confirmation to the capped admin',
			timeoutMs: 20_000,
		})
		expect(app.emu.world.players.has(target1h.eos)).toBe(false)
	})

	it('denies a capped admin a timeout beyond their cap', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(capped, 'ChatAdmin', cmd('timeout target_capped 6h'))

		await app.waitFor(() => warnsTo(capped).some((w) => w.includes('Permission denied')), {
			label: 'the permission-denied warn to the capped admin',
			timeoutMs: 20_000,
		})
		expect(warnsTo(capped).some((w) => w.includes('Timed out'))).toBe(false)
		// the target is untouched: no timeout was applied
		expect(app.emu.world.players.has(target6hCapped.eos)).toBe(true)
	})

	// the regression guard: an unlimited (super user) grant must satisfy any finite duration. The comparator skipping
	// the null case would deny this.
	it('allows a super user to exceed a finite cap', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(superAdmin, 'ChatAdmin', cmd('timeout target_super 6h'))

		await app.waitFor(() => warnsTo(superAdmin).some((w) => w.includes('Timed out')), {
			label: 'the timeout confirmation to the super user',
			timeoutMs: 20_000,
		})
		expect(app.emu.world.players.has(target6hSuper.eos)).toBe(false)
	})
})

describe('role assignment via in-game admin status', () => {
	// the ingame-timeouter role reaches this admin only through includeIngameAdmins (their linked account has no other
	// role), so being able to issue a timeout proves the admin-list-derived assignment actually grants its permissions
	it('grants an includeIngameAdmins role its permissions', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(ingameAdmin, 'ChatAdmin', cmd('timeout target_ingame 30m'))

		await app.waitFor(() => warnsTo(ingameAdmin).some((w) => w.includes('Timed out')), {
			label: 'the timeout confirmation to the ingame admin',
			timeoutMs: 20_000,
		})
		expect(app.emu.world.players.has(targetIngame.eos)).toBe(false)
	})

	// the regression guard for the identifying-permission gate: a player in the admin list only through a
	// reserve-slot group (no admin-identifying permission) is not an in-game admin, so the includeIngameAdmins role
	// must not reach them. The command is in scope (admin chat), so it reaches the rbac check and is denied there --
	// under the pre-fix behavior their steam id counted as an admin and the 30m timeout would have gone through.
	it('withholds an includeIngameAdmins role from a non-identifying-group admin', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(reserveAdmin, 'ChatAdmin', cmd('timeout target_reserve 30m'))

		await app.waitFor(() => warnsTo(reserveAdmin).some((w) => w.includes('Permission denied')), {
			label: 'the permission-denied warn to the reserve admin',
			timeoutMs: 20_000,
		})
		expect(warnsTo(reserveAdmin).some((w) => w.includes('Timed out'))).toBe(false)
		expect(app.emu.world.players.has(targetReserve.eos)).toBe(true)
	})
})
