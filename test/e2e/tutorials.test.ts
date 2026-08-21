import type { Page } from '@playwright/test'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { role } from '../harness/arrange'
import { expect, test } from './fixtures'

// The tutorial as a reader meets it: the index page starts a run, the tour narrates the real dashboard, and the
// navigation panel moves around the curriculum out of order. The jumps are why this file exists. Provisioning a
// step rebuilds server state through a checkpoint and replays the transitions in between, and nothing below the
// UI can tell you it landed somewhere coherent -- the queue, the edit session and the dialogs have to agree.
//
// Its own app: a run creates a scoped server, its own filters and a second presence identity, and leaves the
// reader mid-edit on a queue no other scenario would expect to find.

const USER: TestUser = { discordId: 900000000000000063n, username: 'test-tutorial-e2e' }

// What the index page calls the scenario. One constant because it is copy, and copy moves.
const TUTORIAL = 'The layer queue'

// Step titles the journey navigates by, from the tutorial's own messages. Titles rather than numbers: the step
// list is edited often, and a number would silently point at a different step.
const STEP = {
	welcome: 'Welcome',
	queueItems: 'Queue items',
	startEditing: 'Start editing',
	addedLayers: 'Your added layers',
	removeItem: 'Remove an item',
	swapTeams: 'Swap the teams',
}

// the two layers the add walkthrough asks for, which a jump into the editing region installs as unsaved additions
const ADDED = ['Chora_TC_v1', 'Yehorivka_TC_v1']

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		users: [USER],
		globalSettings: (settings) => {
			// site access only: starting a tutorial is per-user by construction, not a granted role
			settings.rbac.roles['tutorial-user'] = role(['site:authorized'], { users: [USER] })
		},
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

const overlay = (page: Page) => page.locator('[data-tour-overlay]')

// the card's heading is the step's title, so waiting for it is waiting for that step to be narrated -- a jump
// renders "Preparing..." until its checkpoint and simulates have finished
function onStep(page: Page, title: string) {
	return expect(overlay(page).getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 45_000 })
}

// Jump through the table of contents, the way a reader would. Searching first both narrows the list to one row
// and covers the search box; several steps share a title (three of them say "Start editing"), so the first match
// is the one a reader would also click.
async function jumpTo(page: Page, title: string) {
	await overlay(page).getByRole('button', { name: 'Contents' }).click()
	const contents = overlay(page).getByRole('navigation', { name: 'Tutorial contents' })
	await contents.getByRole('searchbox', { name: 'Search steps' }).fill(title)
	await contents.getByRole('button', { name: title }).first().click()
	await onStep(page, title)
}

// The backburner shares the queue's tabpanel and has controls of its own, so the queue's are reached through the
// region the tour itself treats as the queue.
const queuePanel = (page: Page) => page.locator('[data-tour="queue-panel"]')

// Whether the reader holds an edit session, read the way the page shows it. The save button is not the signal:
// its label is one of five, depending on modifications, editor count and pending warnings. The Start Editing
// button is simply not visible during a session.
const startEditingButton = (page: Page) => queuePanel(page).getByRole('button', { name: 'Start Editing' })
const expectEditing = (page: Page) => expect(startEditingButton(page)).toBeHidden()
const expectNotEditing = (page: Page) => expect(startEditingButton(page)).toBeVisible()

// Pending the tutorials index page: a production bundle has no dev launcher, so there is nothing here that can
// start a run yet. Every assertion below the first has been driven against a real browser on a dev instance.
test.describe.fixme('the layer queue tutorial', () => {
	test('starts from the index page and narrates the dashboard', async ({ page }) => {
		await page.goto(app.loginUrl(USER, '/tutorials'))

		await expect(page.getByRole('heading', { name: 'Tutorials' })).toBeVisible({ timeout: 20_000 })
		const entry = page.getByRole('listitem').filter({ hasText: TUTORIAL })
		await expect(entry).toBeVisible()
		await entry.getByRole('button', { name: /^Start/ }).click()

		// the run stands up its own scoped server and the tour navigates to that dashboard
		await expect(page).toHaveURL(new RegExp(`/servers/tutorial-${USER.discordId}`), { timeout: 45_000 })
		await onStep(page, STEP.welcome)
		await expect(overlay(page).getByText('Step 1 of')).toBeVisible()
	})

	test('advances on the card button and on the control a step points at', async ({ page }) => {
		await page.goto(app.loginUrl(USER, `/servers/tutorial-${USER.discordId}`))
		await onStep(page, STEP.welcome)

		await overlay(page).getByRole('button', { name: 'Next', exact: true }).click()
		await expect(overlay(page).getByText('Step 2 of')).toBeVisible()

		// the do-something beats advance on the real control: its own onClick performs the action, and the tour
		// moves on because that happened, not because a Next was pressed
		await jumpTo(page, STEP.startEditing)
		await expect(overlay(page).getByRole('button', { name: 'Next', exact: true })).toBeHidden()
		await startEditingButton(page).click()
		await expectEditing(page)
		await expect(overlay(page).getByRole('heading', { name: STEP.startEditing, exact: true })).toBeHidden()
	})

	test('a forward jump provisions the state its step is about', async ({ page }) => {
		await page.goto(app.loginUrl(USER, `/servers/tutorial-${USER.discordId}`))
		await jumpTo(page, STEP.addedLayers)

		// the checkpoint installs the reader's two picks as unsaved additions and hands them back an edit session
		await expectEditing(page)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()
		for (const layer of ADDED) await expect(queuePanel(page).getByText(layer)).toBeVisible()
	})

	test('stepping back re-provisions a step the reader has already acted on', async ({ page }) => {
		await page.goto(app.loginUrl(USER, `/servers/tutorial-${USER.discordId}`))
		await jumpTo(page, STEP.removeItem)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()

		// this step points at the delete button and advances on the click, so doing what it asks both shrinks the
		// queue and moves the tour on
		await queuePanel(page).locator('[data-tour="queue-delete"]').first().click()
		await onStep(page, STEP.swapTeams)
		await expect(page.getByRole('tab', { name: 'Queue (4)' })).toBeVisible()

		// going back has to put the item the reader deleted back, or the step is describing a queue that no
		// longer exists
		await overlay(page).getByRole('button', { name: 'Previous step' }).click()
		await onStep(page, STEP.removeItem)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()
		await expectEditing(page)

		// and resetting the step it is already on changes nothing about it
		await overlay(page).getByRole('button', { name: 'Reset this step' }).click()
		await onStep(page, STEP.removeItem)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()
	})

	test('a backward jump undoes what the later steps set up', async ({ page }) => {
		await page.goto(app.loginUrl(USER, `/servers/tutorial-${USER.discordId}`))
		await jumpTo(page, STEP.addedLayers)
		await expectEditing(page)

		// the reading steps come before any editing, so arriving at one has to end the session and drop the draft
		await jumpTo(page, STEP.queueItems)
		await expectNotEditing(page)
		await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible()
	})

	test('exiting ends the run and the index page offers it again', async ({ page }) => {
		await page.goto(app.loginUrl(USER, `/servers/tutorial-${USER.discordId}`))
		await onStep(page, STEP.queueItems)

		await overlay(page).getByRole('button', { name: 'Exit' }).click()
		await expect(overlay(page)).toHaveCount(0)

		await page.goto(app.loginUrl(USER, '/tutorials'))
		const entry = page.getByRole('listitem').filter({ hasText: TUTORIAL })
		await expect(entry.getByRole('button', { name: /^Start/ })).toBeVisible({ timeout: 20_000 })
		await expect(entry.getByRole('button', { name: 'Resume' })).toHaveCount(0)
	})
})
