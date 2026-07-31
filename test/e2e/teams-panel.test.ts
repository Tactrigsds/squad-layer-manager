import type { Locator, Page } from '@playwright/test'

import { makePlayer } from '@/emulator'

import type { AppFixture } from '../harness/app-fixture'
import { expect, sharedAppTest as test } from './fixtures'

// The panel's filter bar (search, admins-only, spoilers, the role/group/squad filters and both sort states)
// lives on the squad-server frame rather than in component state. What that has to preserve: filters and
// sorting shared across both team tables, and squad filters that stay per-table.

const ALPHA_LEAD = 'e2e_alpha_lead'
const ALPHA_LOOSE = 'e2e_alpha_loose'
const BRAVO_ONE = 'e2e_bravo_one'
const BRAVO_TWO = 'e2e_bravo_two'

// the app instance is shared across this file, so the roster is seeded once and reused rather than
// reconnecting the same four names per test (which would put duplicate rows in every table)
function seedRoster(app: AppFixture) {
	const connect = (name: string, teamId: 1 | 2) =>
		app.emu.world.playerList().find((p) => p.name === name) ?? app.emu.world.connectPlayer(makePlayer({ name, teamId }))

	const alphaLead = connect(ALPHA_LEAD, 1)
	connect(ALPHA_LOOSE, 1)
	const bravoLead = connect(BRAVO_ONE, 2)
	connect(BRAVO_TWO, 2)
	// both teams get a squad, so filtering one table's squad column would visibly bite the other if the
	// filters were shared
	if (alphaLead.squadId === null) app.emu.world.createSquad(alphaLead, 'Alpha Squad')
	if (bravoLead.squadId === null) app.emu.world.createSquad(bravoLead, 'Bravo Squad')
}

// the name cell, rather than getByText, which also hits the button inside it. Exact, because the squad
// separator row's cell carries the creator's name as part of a longer label.
const playerRow = (table: Locator, name: string) => table.getByRole('cell', { name, exact: true })
// the label qualifies the team with the match's faction ("Team A(current PLA) players"), so it is matched by prefix
const teamTable = (page: Page, team: 'A' | 'B') => page.getByRole('table', { name: new RegExp(`^Team ${team}[( ]`) })
// the name cell stops click propagation on purpose, so selecting a player means its checkbox
const playerCheckbox = (page: Page, table: Locator, name: string) =>
	table
		.locator('tr')
		.filter({ has: page.getByRole('cell', { name, exact: true }) })
		.getByRole('checkbox', { name: 'Select row' })

test.describe('teams panel', () => {
	test.beforeEach(async ({ app, page }) => {
		seedRoster(app)

		await page.getByRole('tab', { name: /^Teams/ }).click()
		// the roster reaches the UI through the app's ListPlayers poll
		await expect(playerRow(teamTable(page, 'A'), ALPHA_LEAD)).toBeVisible({ timeout: 20_000 })
		await expect(playerRow(teamTable(page, 'B'), BRAVO_ONE)).toBeVisible({ timeout: 20_000 })
		// the panel's state outlives any one test, so start each from a known one
		await page.getByRole('button', { name: 'Reset selections, filters, sorting and search' }).click()
	})

	test('the search box filters both team tables', async ({ page }) => {
		const teamA = teamTable(page, 'A')
		const teamB = teamTable(page, 'B')

		// the store write is debounced, so every assertion here has to be the retrying kind
		await page.getByPlaceholder('Search Players...').fill(ALPHA_LEAD)

		await expect(playerRow(teamA, ALPHA_LEAD)).toBeVisible()
		await expect(playerRow(teamA, ALPHA_LOOSE)).toBeHidden()
		// one search box, both tables: team B keeps only its own matches, and it has none
		await expect(playerRow(teamB, BRAVO_ONE)).toBeHidden()

		await page.getByPlaceholder('Search Players...').fill('')
		await expect(playerRow(teamA, ALPHA_LOOSE)).toBeVisible()
		await expect(playerRow(teamB, BRAVO_ONE)).toBeVisible()
	})

	// The reset button clears the panel's own state and the selection, which are owned by two different
	// places, and it has to clear the search box as well -- that input is uncontrolled now, so nothing
	// re-renders it back to empty on its own.
	test('reset clears the search box and restores every row', async ({ page }) => {
		const search = page.getByPlaceholder('Search Players...')
		const teamA = teamTable(page, 'A')

		await search.fill(ALPHA_LEAD)
		await expect(playerRow(teamA, ALPHA_LOOSE)).toBeHidden()

		await page.getByRole('button', { name: 'Reset selections, filters, sorting and search' }).click()

		await expect(search).toHaveValue('')
		await expect(playerRow(teamA, ALPHA_LOOSE)).toBeVisible()
	})

	// Show Selected is disabled while nothing is selected, so an emptied selection has to switch it back off:
	// otherwise the tables keep filtering to a selection the user can no longer see or clear. That clamp used
	// to be a useEffect in the component and is now a subscription on the frame.
	test('show selected switches itself off when the selection is cleared', async ({ page }) => {
		const teamA = teamTable(page, 'A')
		const showSelected = page.getByRole('switch', { name: 'Show Selected' })
		await expect(showSelected).toBeDisabled()

		await playerCheckbox(page, teamA, ALPHA_LEAD).click()
		await expect(showSelected).toBeEnabled()
		await showSelected.click()
		await expect(showSelected).toBeChecked()
		await expect(playerRow(teamA, ALPHA_LOOSE)).toBeHidden()

		// unchecking the only selected player empties the selection
		await playerCheckbox(page, teamA, ALPHA_LEAD).click()
		await expect(showSelected).not.toBeChecked()
		await expect(showSelected).toBeDisabled()
		await expect(playerRow(teamA, ALPHA_LOOSE)).toBeVisible()
	})

	// both per-team tables drive the one 'teams' sort state, so a column sorted on either is sorted on both
	test('sorting one team table sorts the other', async ({ page }) => {
		const nameHeader = (team: 'A' | 'B') => teamTable(page, team).getByRole('columnheader', { name: /Name/ })
		await expect(nameHeader('B')).not.toContainText('↑')

		await nameHeader('A').click()

		await expect(nameHeader('A')).toContainText('↑')
		await expect(nameHeader('B')).toContainText('↑')
	})

	// squad ids only mean something within one team's roster, so each table keeps its own squad filter
	test('the squad filter applies to one team table only', async ({ page }) => {
		const teamA = teamTable(page, 'A')
		const teamB = teamTable(page, 'B')

		await teamA.getByRole('columnheader', { name: /Squad/ }).getByRole('combobox').click()
		await page.getByRole('option', { name: 'Unassigned' }).click()

		// the squadded player drops out of team A, and team B is untouched
		await expect(playerRow(teamA, ALPHA_LEAD)).toBeHidden()
		await expect(playerRow(teamA, ALPHA_LOOSE)).toBeVisible()
		await expect(playerRow(teamB, BRAVO_ONE)).toBeVisible()
		await expect(playerRow(teamB, BRAVO_TWO)).toBeVisible()
	})
})
