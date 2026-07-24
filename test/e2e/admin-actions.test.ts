import { makePlayer } from '@/emulator'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// Admin actions taken from the teams panel: on one player, on a selection of several, and on a
// whole squad. Each has to reach the game over RCON carrying the reason the admin picked -- the UI
// saying it happened is not the same as it having happened.

const REASONS = [
	{
		label: 'Toxicity',
		keywords: ['tox'],
		actionTexts: { warn: 'Cut out the toxicity', kick: 'Kicked for toxicity', kill: 'Killed for toxicity' },
	},
]

async function fixtureWithSquad() {
	const app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas),
		globalSettings: (s) => {
			s.adminActionReasons = REASONS as typeof s.adminActionReasons
		},
	})
	const leader = app.emu.world.connectPlayer(makePlayer({ name: ' sq_leader', teamId: 1 }))
	const member = app.emu.world.connectPlayer(makePlayer({ name: ' sq_member', teamId: 1 }))
	const loner = app.emu.world.connectPlayer(makePlayer({ name: ' loner', teamId: 2 }))
	const squad = app.emu.world.createSquad(leader, 'ALPHA')
	app.emu.world.joinSquad(member, squad)
	await app.waitForRosterSync()
	return { app, leader, member, loner }
}

function warnsTo(app: AppFixture, eosId: string): string[] {
	return app.emu.rcon.commandLog.filter((c) => c.body.startsWith(`AdminWarn "${eosId}"`)).map((c) => c.body)
}

test.describe('admin actions from the teams panel', () => {
	test('warning one player, with a configured reason', async ({ page }) => {
		const { app, member, leader } = await fixtureWithSquad()
		try {
			await page.goto(app.loginUrl())
			await page.getByRole('tab', { name: /^Teams \(3\)/ }).click({ timeout: 25_000 })
			const panel = page.getByRole('tabpanel', { name: /^Teams/ })

			const row = panel.getByRole('row', { name: /sq_member/ })
			await expect(row).toBeVisible({ timeout: 20_000 })
			await row.click({ button: 'right' })
			// warn is a submenu offering the warn box (Custom) or the preset-reason dialog
			await page.getByRole('menuitem', { name: 'Warn' }).hover()
			await page.getByRole('menuitem', { name: 'Preset Reason' }).click()
			const dialog = page.getByRole('alertdialog', { name: 'Warn Player' })
			await dialog.getByRole('combobox', { name: 'Reason' }).click()
			await page.getByRole('option', { name: 'Toxicity', exact: true }).click()
			await dialog.getByRole('button', { name: 'Warn', exact: true }).click()

			await app.waitFor(() => warnsTo(app, member.eos).length > 0, { label: 'the warn reaching the game', timeoutMs: 20_000 })
			expect(warnsTo(app, member.eos)[0]).toContain('Cut out the toxicity')
			expect(warnsTo(app, leader.eos)).toHaveLength(0)
		} finally {
			await app.dispose()
		}
	})

	test('killing a selection of players', async ({ page }) => {
		const { app, member, loner } = await fixtureWithSquad()
		try {
			await page.goto(app.loginUrl())
			await page.getByRole('tab', { name: /^Teams \(3\)/ }).click({ timeout: 25_000 })
			const panel = page.getByRole('tabpanel', { name: /^Teams/ })

			// select two players across both teams
			for (const name of [/sq_member/, /loner/]) {
				const row = panel.getByRole('row', { name })
				await expect(row).toBeVisible({ timeout: 20_000 })
				await row.getByRole('checkbox').first().check()
			}

			await panel.getByRole('row', { name: /loner/ }).click({ button: 'right' })
			await page.getByRole('menuitem', { name: 'Kill' }).click()
			await page.getByRole('button', { name: 'Kill', exact: true }).click()

			// a kill is two force-switches ~1s apart (there is no kill command), so each selected player
			// gets the pair -- and both of them do
			for (const player of [member, loner]) {
				await app.waitFor(
					() => app.emu.rcon.commandLog.filter((c) => c.body === `AdminForceTeamChange ${player.eos}`).length >= 2,
					{ label: `both force-switches for ${player.name.trim()}`, timeoutMs: 25_000 },
				)
			}
		} finally {
			await app.dispose()
		}
	})

	test('disbanding a squad', async ({ page }) => {
		const { app, leader, member } = await fixtureWithSquad()
		try {
			await page.goto(app.loginUrl())
			await page.getByRole('tab', { name: /^Teams \(3\)/ }).click({ timeout: 25_000 })
			const panel = page.getByRole('tabpanel', { name: /^Teams/ })

			// the squad's own row names its creator too ("created by sq_leader"), so exclude it
			const row = panel.getByRole('row', { name: /sq_leader/ }).filter({ hasNotText: 'created by' })
			await expect(row).toBeVisible({ timeout: 20_000 })
			await row.click({ button: 'right' })
			await page.getByRole('menuitem', { name: 'Disband Squad' }).click()
			// disbanding asks first, and offers a reason to attach
			await page.getByRole('button', { name: 'Disband', exact: true }).click()

			await app.emu.expectCommand(/^AdminDisbandSquad /, { timeoutMs: 20_000 })
			// the squad is gone from the game, and its members with it
			expect(app.emu.world.squads).toHaveLength(0)
			expect(leader.squadId).toBeNull()
			expect(member.squadId).toBeNull()
		} finally {
			await app.dispose()
		}
	})
})
