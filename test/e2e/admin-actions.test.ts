import { type EmuPlayer, makePlayer } from '@/emulator'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import * as Dash from '../harness/dashboard'
import { expect, test } from './fixtures'

// Admin actions taken from the teams panel: on one player, on a selection of several, on a whole
// squad, and the team swap. Each has to reach the game over RCON carrying the reason the admin
// picked -- the UI saying it happened is not the same as it having happened. One roster carries the
// whole file; the destructive actions (kick, disband) run last.

const REASONS = [
	{
		label: 'Toxicity',
		keywords: ['tox'],
		actionTexts: { warn: 'Cut out the toxicity', kick: 'Kicked for toxicity', kill: 'Killed for toxicity' },
	},
]

let app: AppFixture
let leader: EmuPlayer
let member: EmuPlayer
let loner: EmuPlayer
let swapee: EmuPlayer

test.beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas),
		globalSettings: (s) => {
			s.adminActionReasons = REASONS as typeof s.adminActionReasons
			// only the kick insists on a reason, so the other dialogs keep their immediate confirm
			s.requireReasonFor = ['kick'] as typeof s.requireReasonFor
			// a configured grouping is the mode in effect, so the group column shows parties only once Party is picked
			s.playerGroupings = { Admins: { rules: [{ type: 'server-admin', group: 'Admin' }], groups: {} } } as typeof s.playerGroupings
		},
	})
	leader = app.emu.world.connectPlayer(makePlayer({ name: ' sq_leader', teamId: 1 }))
	member = app.emu.world.connectPlayer(makePlayer({ name: ' sq_member', teamId: 1 }))
	loner = app.emu.world.connectPlayer(makePlayer({ name: ' loner', teamId: 2 }))
	swapee = app.emu.world.connectPlayer(makePlayer({ name: ' e2e_swapee', teamId: 2 }))
	const squad = app.emu.world.createSquad(leader, 'ALPHA')
	app.emu.world.joinSquad(member, squad)
	await app.waitForRosterSync()
})

test.afterAll(async () => {
	await app?.dispose()
})

function warnsTo(eosId: string): string[] {
	return app.emu.rcon.commandLog.filter((c) => c.body.startsWith(`AdminWarn "${eosId}"`)).map((c) => c.body)
}

test.describe('admin actions from the teams panel', () => {
	test.beforeEach(async ({ page }) => {
		app.emu.rcon.commandLog.length = 0
		await page.goto(app.loginUrl())
		await Dash.showTeams(page)
	})

	test('warning one player, with a configured reason', async ({ page }) => {
		const panel = Dash.teamsSection(page)

		const row = panel.getByRole('row', { name: /sq_member/ })
		await expect(row).toBeVisible({ timeout: 20_000 })
		await row.click({ button: 'right' })
		// warn is a submenu offering the warn box (Custom) or the preset-reason dialog
		await page.getByRole('menuitem', { name: 'Warn' }).hover()
		await page.getByRole('menuitem', { name: 'Preset Reason' }).click()
		const dialog = page.getByRole('alertdialog', { name: 'Warn Player' })
		// the reason list opens with the dialog, and warning is held until one is picked
		const confirm = dialog.getByRole('button', { name: 'Warn', exact: true })
		await expect(confirm).toBeDisabled()
		await page.getByRole('option', { name: 'Toxicity', exact: true }).click()
		await expect(confirm).toBeEnabled()
		await confirm.click()

		await app.waitFor(() => warnsTo(member.eos).length > 0, { label: 'the warn reaching the game', timeoutMs: 20_000 })
		expect(warnsTo(member.eos)[0]).toContain('Cut out the toxicity')
		expect(warnsTo(leader.eos)).toHaveLength(0)
	})

	test('killing a selection of players', async ({ page }) => {
		const panel = Dash.teamsSection(page)

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
			await app.waitFor(() => app.emu.rcon.commandLog.filter((c) => c.body === `AdminForceTeamChange ${player.eos}`).length >= 2, {
				label: `both force-switches for ${player.name.trim()}`,
				timeoutMs: 25_000,
			})
		}
	})

	test('swapping a player now', async ({ page }) => {
		const teamsPanel = Dash.teamsSection(page)
		const row = teamsPanel.getByRole('row', { name: /e2e_swapee/ })
		await expect(row).toBeVisible({ timeout: 20_000 })
		const startingTeam = swapee.teamId

		await row.click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Swap Now' }).click()
		// destructive actions ask first
		await page.getByRole('button', { name: 'Swap Now' }).click()

		// the game server actually moved them
		await app.waitFor(() => app.emu.rcon.commandLog.some((c) => c.body === `AdminForceTeamChange ${swapee.eos}`), {
			label: 'AdminForceTeamChange for the player',
			timeoutMs: 20_000,
		})
		expect(swapee.teamId).not.toBe(startingTeam)
	})

	// the name is a delegated window opener (see components/feed/interactions.ts): its click is only handled
	// once it reaches the document, so any row handler that swallowed it would leave the name inert
	test("clicking a name opens that player's details window", async ({ page }) => {
		const panel = Dash.teamsSection(page)

		const row = panel.getByRole('row', { name: /sq_member/ })
		await expect(row).toBeVisible({ timeout: 20_000 })
		await row.getByRole('button', { name: 'sq_member' }).click()

		const window = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /sq_member/ }) })
		await expect(window).toBeVisible({ timeout: 20_000 })
		// the row's own click handler toggles selection, and it has to stay out of this one
		await expect(row.getByRole('checkbox').first()).not.toBeChecked()
		await window.getByRole('button', { name: 'Close window' }).click()
	})

	// a party can span both teams, so a party filter or selection is not limited to one table
	test('the party grouping mode filters, sorts and selects by party, and the vehicle shows behind spoilers', async ({ page }) => {
		leader.partyId = '#3'
		loner.partyId = '#3'
		member.partyId = '#1'
		member.vehicle = 'minsk400 (Driver)'
		const panel = Dash.teamsSection(page)
		// the squad's own row names its creator too ("created by sq_leader"), so exclude it
		const leaderRow = panel.getByRole('row', { name: /sq_leader/ }).filter({ hasNotText: 'created by' })
		const memberRow = panel.getByRole('row', { name: /sq_member/ })
		await expect(leaderRow).toBeVisible({ timeout: 20_000 })
		await panel.locator('[data-tour=teams-grouping]').getByRole('combobox').click()
		await page.getByRole('option', { name: 'Party', exact: true }).click()
		await expect(leaderRow.getByRole('cell', { name: '#3', exact: true })).toBeVisible({ timeout: 20_000 })
		await expect(memberRow.getByRole('cell', { name: '#1', exact: true })).toBeVisible()

		const groupHeader = panel.getByRole('columnheader', { name: /^Group/ }).first()
		await groupHeader.getByRole('combobox').click()
		await page.getByRole('option', { name: '#3', exact: true }).click()
		await expect(memberRow).toBeHidden()
		await expect(panel.getByRole('row', { name: /loner/ })).toBeVisible()
		await groupHeader.getByRole('combobox').click()
		await page.getByRole('option', { name: 'All', exact: true }).click()
		await expect(memberRow).toBeVisible()

		// ascending puts #1 ahead of #3 within team 1
		await groupHeader.getByText('Group', { exact: true }).click()
		const team1Names = panel.getByRole('row').filter({ hasText: /sq_leader|sq_member/ })
		await expect(team1Names).toHaveText([/sq_member/, /sq_leader/])

		await leaderRow.getByRole('cell', { name: '#3', exact: true }).click({ modifiers: ['Shift', 'Control'] })
		await expect(leaderRow.getByRole('checkbox').first()).toBeChecked()
		await expect(panel.getByRole('row', { name: /loner/ }).getByRole('checkbox').first()).toBeChecked()
		await expect(memberRow.getByRole('checkbox').first()).not.toBeChecked()

		await expect(memberRow.getByText('minsk400 (Driver)')).toBeHidden()
		await panel.getByText('Show Spoilers', { exact: true }).click()
		await expect(memberRow.getByText('minsk400 (Driver)')).toBeVisible()
	})

	test("adding a BattleMetrics note, then reading it in the player's details window", async ({ page }) => {
		const panel = Dash.teamsSection(page)
		const row = panel.getByRole('row', { name: /sq_member/ })
		await expect(row).toBeVisible({ timeout: 20_000 })
		await row.click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Add Note...' }).click()

		const dialog = page.getByRole('alertdialog', { name: /Add a BattleMetrics note for/ })
		await expect(dialog.getByRole('button', { name: 'Add Note', exact: true })).toBeDisabled()
		await dialog.getByRole('textbox', { name: 'Note' }).fill('Mic spam in local.')
		await dialog.getByRole('textbox', { name: 'Note' }).press('Control+Enter')
		await expect(dialog).toBeHidden()
		await app.waitFor(
			() => app.bm.notes.some((n) => n.bmPlayerId === app.bm.findByEos(member.eos)?.bmPlayerId && n.note.endsWith('Mic spam in local.')),
			{ label: 'the note reaching BattleMetrics', timeoutMs: 20_000 },
		)

		await row.getByRole('button', { name: 'sq_member' }).click()
		const window = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /sq_member/ }) })
		await window.getByRole('button', { name: 'Load notes' }).click()
		const notes = window.getByRole('region', { name: 'BM notes' })
		await expect(notes.getByRole('listitem').filter({ hasText: 'Mic spam in local.' })).toContainText('SLM')
		await window.getByRole('button', { name: 'Close window' }).click()
	})

	test('a required reason holds the kick dialog shut until one is picked', async ({ page }) => {
		const panel = Dash.teamsSection(page)

		const row = panel.getByRole('row', { name: /loner/ })
		await expect(row).toBeVisible({ timeout: 20_000 })
		await row.click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Kick' }).click()

		const dialog = page.getByRole('alertdialog', { name: 'Kick Player' })
		const confirm = dialog.getByRole('button', { name: 'Kick', exact: true })
		await expect(confirm).toBeDisabled()
		await page.getByRole('option', { name: 'Toxicity', exact: true }).click()
		await expect(confirm).toBeEnabled()
		await confirm.click()

		const kick = await app.emu.expectCommand(new RegExp(`^AdminKick "${loner.eos}"`), { timeoutMs: 20_000 })
		expect(kick.body).toContain('Kicked for toxicity')
	})

	test('disbanding a squad', async ({ page }) => {
		const panel = Dash.teamsSection(page)

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
	})
})
