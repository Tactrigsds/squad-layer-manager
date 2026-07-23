import { type EmuPlayer, makePlayer } from '@/emulator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'

// The in-game timeout command is gated by SM.Grants.satisfyingTimeout: an admin may only issue a timeout up to the
// maximum duration their roles grant. "up to N" is a comparator, not an equality match, and an unlimited (super user)
// grant has to satisfy any duration -- a regression there silently blocks the people who should be able to do the most.

const HOUR = 60 * 60 * 1000

// a super user (via the default admin's SUPER_USERS bootstrap): unlimited timeout duration
const SUPER_STEAM_ID = '76561198000000010'
// a plain admin whose only rbac grant is a role capped at 2h
const CAPPED_STEAM_ID = '76561198000000011'
const CAPPED_USER: TestUser = { discordId: 900000000000000031n, username: 'capped-admin', steamIds: [CAPPED_STEAM_ID] }

let app: AppFixture
const superAdmin = makePlayer({ name: ' super_admin', steam: SUPER_STEAM_ID, teamId: 1 })
const capped = makePlayer({ name: ' capped_admin', steam: CAPPED_STEAM_ID, teamId: 1 })
let target1h: EmuPlayer
let target6hCapped: EmuPlayer
let target6hSuper: EmuPlayer

// the timeout command's admin scope needs in-game admin status; the duration cap comes from rbac. Both admins are in
// the Admins.cfg (so both pass the scope), but only the super user's account is a SUPER_USER, and the capped admin's
// only grant is the 2h role assigned to their linked account.
beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas),
		admins: [SUPER_STEAM_ID, CAPPED_STEAM_ID],
		adminSteamIds: [SUPER_STEAM_ID],
		users: [CAPPED_USER],
		globalSettings: (s) => {
			s.rbac.roles['capped-timeouter'] = {
				permissions: [],
				maxTimeout: 2 * HOUR,
				globalSettingsGrants: [],
				serverSettingsGrants: [],
				assignments: {
					discordRoleIds: [],
					discordUserIds: [CAPPED_USER.discordId.toString()],
					everyMember: false,
					includeIngameAdmins: false,
					adminListGroups: [],
				},
			}
		},
	})
	app.emu.world.connectPlayer(superAdmin)
	app.emu.world.connectPlayer(capped)
	target1h = app.emu.world.connectPlayer(makePlayer({ name: ' target_onehr', teamId: 2 }))
	target6hCapped = app.emu.world.connectPlayer(makePlayer({ name: ' target_capped', teamId: 2 }))
	target6hSuper = app.emu.world.connectPlayer(makePlayer({ name: ' target_super', teamId: 2 }))
	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

function warnsTo(player: EmuPlayer): string[] {
	return app.emu.rcon.commandLog.filter((c) => c.body.startsWith(`AdminWarn "${player.eos}"`)).map((c) => c.body)
}

describe('in-game timeout duration cap', () => {
	it('allows a capped admin to issue a timeout within their cap', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(capped, 'ChatAdmin', '!timeout target_onehr 1h')

		await app.waitFor(() => warnsTo(capped).some((w) => w.includes('Timed out')), {
			label: 'the timeout confirmation to the capped admin',
			timeoutMs: 20_000,
		})
		expect(app.emu.world.players.has(target1h.eos)).toBe(false)
	})

	it('denies a capped admin a timeout beyond their cap', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(capped, 'ChatAdmin', '!timeout target_capped 6h')

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
		app.emu.world.chat(superAdmin, 'ChatAdmin', '!timeout target_super 6h')

		await app.waitFor(() => warnsTo(superAdmin).some((w) => w.includes('Timed out')), {
			label: 'the timeout confirmation to the super user',
			timeoutMs: 20_000,
		})
		expect(app.emu.world.players.has(target6hSuper.eos)).toBe(false)
	})
})
