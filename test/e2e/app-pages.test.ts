import type { Locator, Page } from '@playwright/test'

import { makePlayer } from '@/emulator'

import type { AppFixture } from '../harness/app-fixture'
import { expect, sharedAppTest as test, test as plainTest } from './fixtures'

// Every read-only page one logged-in admin can reach, against a single shared app: the dashboard, the
// teams panel's filter bar, the settings page, and the nav bar. Selectors are role/label-based on
// purpose: a test that can't find an element is telling us the markup isn't semantic yet, which is a
// defect in its own right.

test.describe('server dashboard', () => {
	test('shows the current match and the layer queue', async ({ page, app }) => {
		await expect(page.getByRole('heading', { name: 'Match History' })).toBeVisible()

		// the emulator's current layer, surfaced by the app's own RCON poll
		await expect(page.getByRole('row', { name: /Harju_RAAS_v1/ })).toBeVisible()
		await expect(page.getByRole('row', { name: /In progress/ })).toBeVisible()

		// the app generates queue items on boot and pushes the first one to the server as next layer
		const queueTab = page.getByRole('tab', { name: /^Queue/ })
		await expect(queueTab).toHaveAttribute('aria-selected', 'true')

		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const firstItem = queuePanel.getByText(/^\w+_\w+_v\d+$/).first()
		await expect(firstItem).toBeVisible({ timeout: 20_000 })
		const queuedLayer = (await firstItem.textContent())!.trim()

		// asserted from the UI's current state outwards rather than from the first command the emulator
		// happened to receive: the queue can regenerate, which supersedes an earlier AdminSetNextLayer
		await expect
			.poll(() => app.emu.rcon.commandLog.some((c) => c.body.startsWith(`AdminSetNextLayer ${queuedLayer}`)), {
				timeout: 20_000,
				message: `emulator never received AdminSetNextLayer for the queued layer ${queuedLayer}`,
			})
			.toBe(true)
	})

	test('a player joining in game appears on the teams tab', async ({ page, app }) => {
		const player = makePlayer({ name: ' e2e_joiner', role: 'PLA_Rifleman_01' })
		app.emu.world.connectPlayer(player)

		// the roster reaches the UI through the app's ListPlayers poll, so the tab label counts them
		const teamsTab = page.getByRole('tab', { name: /^Teams \(1\)/ })
		await expect(teamsTab).toBeVisible({ timeout: 20_000 })

		await teamsTab.click()
		await expect(teamsTab).toHaveAttribute('aria-selected', 'true')
		await expect(page.getByRole('tabpanel', { name: /^Teams/ }).getByText('e2e_joiner')).toBeVisible()
	})

	test('the activity feed records what the emulated server did', async ({ page }) => {
		const feed = page.getByRole('region', { name: 'Server Activity' })
		await expect(feed).toBeVisible()
		// the app instance is shared across this file's tests, so the feed accumulates: assert an entry
		// exists rather than that it's the only one
		await expect(feed.getByText(/RCON connection established/i).first()).toBeVisible({ timeout: 20_000 })
		// the layer already set when SLM connected is reported as an observation: nobody set it as far as SLM saw
		await expect(feed.getByText(/Server's next layer is/i).first()).toBeVisible()
	})
})

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

test.describe('nav bar', () => {
	test('offers the Settings link to a user who can reach it', async ({ page }) => {
		await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
	})

	// The picker offers every locale this build carries a catalogue for, plus following the browser. With only
	// English shipped that is a two-item menu, which is the honest rendering of what is available.
	test('offers a language, following the browser until one is picked', async ({ page }) => {
		await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
		await page.getByLabel('User menu').click()
		await page.getByRole('menuitem', { name: 'Language' }).click()

		const automatic = page.getByRole('menuitemradio', { name: 'Automatic' })
		await expect(automatic).toBeVisible()
		await expect(automatic).toHaveAttribute('aria-checked', 'true')
		// named in its own language, which is what a reader who cannot read the current one needs
		await expect(page.getByRole('menuitemradio', { name: 'English' })).toBeVisible()
	})
})

plainTest.describe('settings page', () => {
	plainTest('the new managed server form renders', async ({ app, page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/settings'))

		const addServer = page.getByRole('button', { name: 'Add Managed Server' })
		await expect(addServer).toBeVisible({ timeout: 20_000 })
		await addServer.click()

		await expect(page.getByRole('heading', { name: 'New Managed Server' })).toBeVisible()
		await expect(page.getByLabel('Server ID')).toBeVisible()

		// adminLists is a record in global settings and an array per server. The array-typed control spreads its
		// value, so seeding a record here throws instead of rendering an empty selection.
		const adminLists = page.locator('[id="setting:server:__new__:adminLists"]')
		await expect(adminLists.getByRole('combobox')).toHaveText(/Select admin lists/)
	})

	// The new-server form has no saved baseline to fall back to, so the save panel's Reset has to close it outright
	// rather than blanking its fields and leaving a half-filled form behind.
	plainTest('resetting discards the new managed server form', async ({ app, page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/settings'))

		const addServer = page.getByRole('button', { name: 'Add Managed Server' })
		await expect(addServer).toBeVisible({ timeout: 20_000 })
		await addServer.click()

		const heading = page.getByRole('heading', { name: 'New Managed Server' })
		await expect(heading).toBeVisible()
		await page.getByLabel('Server ID').fill('reset-me')

		await page.getByRole('button', { name: 'Reset', exact: true }).click()

		await expect(heading).toBeHidden()
		await expect(addServer).toBeVisible()
	})

	// A JSON-mode section renders no per-field anchors, so its TOC node has to collapse to a leaf. The TOC reads that
	// mode straight off the section frames now rather than being handed it down, and nothing else exercises the path.
	plainTest('the table of contents follows a section between GUI and JSON mode', async ({ app, page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/settings'))

		// scoped to the section's own toggle: the settings card also carries per-subtree JSON toggles reading the same
		const mode = page.getByRole('group', { name: 'Server settings editor mode' })
		// a node with children carries the expand/collapse control; a leaf renders a spacer instead
		const expander = page.locator(`li[data-toc-id="section:server:${app.serverId}"] > div > button`)
		await expect(expander).toHaveCount(1, { timeout: 20_000 })

		await mode.getByRole('button', { name: 'JSON', exact: true }).click()
		await expect(expander).toHaveCount(0)

		await mode.getByRole('button', { name: 'GUI', exact: true }).click()
		await expect(expander).toHaveCount(1)
	})
})
