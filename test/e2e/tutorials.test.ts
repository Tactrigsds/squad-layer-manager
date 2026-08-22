import type { Page } from '@playwright/test'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { role } from '../harness/arrange'
import { expect, test } from './fixtures'

// The tutorial as a reader meets it: the index page starts a run, the tour narrates the real dashboard, and the
// navigation panel moves around the curriculum out of order. The jumps are why this file exists. Provisioning a
// step rebuilds server state through a checkpoint and replays the transitions in between, and nothing below the
// UI can tell you it landed somewhere coherent -- the queue, the edit session and the dialogs have to agree.
//
// One test, because the tour is one session: it lives in the page's memory, so a second test with a fresh page
// would find no tour to drive. Its own app, because a run creates a scoped server, its own filters and a second
// presence identity, and leaves the reader mid-edit on a queue no other scenario would expect to find.

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
	warningsOnSave: 'Warnings on save',
}

// the two layers the add walkthrough asks for, which a jump into the editing region installs as unsaved additions
const ADDED = ['Chora_TC_v1', 'Yehorivka_TC_v1']

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		users: [USER],
		// this file is the one that asserts on the prompt, and on the tour keeping it out of its own way
		tutorialPrompts: true,
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

// The backburner shares the queue's tabpanel and has controls of its own, so the queue's are reached through the
// region the tour itself treats as the queue.
const queuePanel = (page: Page) => page.locator('[data-tour="queue-panel"]')

// Whether the reader holds an edit session. The two controls swap places, so each direction gets a control that
// is really on screen rather than an absence, which would also be satisfied by the panel failing to render.
// Their names cannot do this on their own: the save button's label is one of five (modifications, editor count
// and pending warnings all move it), and the idle Start Editing button is visibility:hidden, which takes it out
// of the accessibility tree and out of reach of a role query entirely.
const startEditingButton = (page: Page) => queuePanel(page).getByRole('button', { name: 'Start Editing' })
const saveButton = (page: Page) => queuePanel(page).locator('[data-tour="queue-save"]')

async function expectEditing(page: Page, editing: boolean) {
	if (editing) {
		await expect(saveButton(page)).toBeVisible()
		await expect(startEditingButton(page)).toHaveCount(0)
	} else {
		await expect(startEditingButton(page)).toBeVisible()
		await expect(saveButton(page)).toBeHidden()
	}
}

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

test('the layer queue tutorial, started and navigated out of order', async ({ page, browser }) => {
	// a run creates a server and every jump rebuilds its state, so this is minutes of real work
	test.setTimeout(300_000)

	page.on('console', (m) => {
		if (m.text().includes('[progress]')) console.log(m.text().slice(0, 200))
	})
	await test.step('the dashboard offers the tutorial until it is told not to', async () => {
		// Its own context, as the admin: the prompt needs a dashboard the reader can actually see, and this
		// file's tutorial user holds site access and nothing on that server. ?login= does not switch a session
		// that already exists, so sharing the journey's page would leave the tour running as the wrong user.
		const promptCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
		const promptPage = await promptCtx.newPage()
		try {
			await promptPage.goto(app.loginUrl(app.adminUser, `/servers/${app.serverId}`))
			const prompt = promptPage.getByRole('dialog').filter({ hasText: TUTORIAL })
			await expect(prompt).toBeVisible({ timeout: 60_000 })

			// dismissing is per user rather than per browser, so a reload does not bring it back
			await prompt.getByRole('checkbox', { name: "Don't show this again" }).click()
			await prompt.getByRole('button', { name: 'Not now' }).click()
			await promptPage.reload()
			// the queue is behind the modal's aria-hidden while it is open, so reaching it is also proof it closed
			await expect(promptPage.getByRole('tab', { name: /^Queue/ })).toBeVisible({ timeout: 60_000 })
			await expect(prompt).toHaveCount(0)
		} finally {
			await promptCtx.close()
		}
	})

	await test.step('the index page starts a run', async () => {
		await page.goto(app.loginUrl(USER, '/tutorials'))
		await expect(page.getByRole('heading', { name: 'Tutorials' })).toBeVisible({ timeout: 20_000 })
		const entry = page.getByRole('listitem').filter({ hasText: TUTORIAL })
		await entry.getByRole('button', { name: 'Start', exact: true }).click()

		// the run stands up its own scoped server and the tour navigates to that dashboard
		await expect(page).toHaveURL(new RegExp(`/servers/tutorial-${USER.discordId}`), { timeout: 60_000 })
		await onStep(page, STEP.welcome)
		await expect(overlay(page).getByText('Step 1 of')).toBeVisible()
	})

	await test.step('the card button advances', async () => {
		await overlay(page).getByRole('button', { name: 'Next', exact: true }).click()
		await expect(overlay(page).getByText('Step 2 of')).toBeVisible()
	})

	await test.step('a forward jump provisions the state its step is about', async () => {
		await jumpTo(page, STEP.addedLayers)
		// the checkpoint installs the reader's two picks as unsaved additions and hands them an edit session
		await expectEditing(page, true)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()
		for (const layer of ADDED) await expect(queuePanel(page).getByText(layer).first()).toBeVisible()
	})

	await test.step('stepping back rebuilds a step the reader has already acted on', async () => {
		await jumpTo(page, STEP.removeItem)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()

		// this step points at the delete button and advances on the click, so doing what it asks both shrinks the
		// queue and moves the tour on
		await queuePanel(page).locator('[data-tour="queue-delete"]').first().click()
		await onStep(page, STEP.swapTeams)
		await expect(page.getByRole('tab', { name: 'Queue (4)' })).toBeVisible()

		// going back has to put the deleted item back, or the step describes a queue that no longer exists
		await overlay(page).getByRole('button', { name: 'Previous step' }).click()
		await onStep(page, STEP.removeItem)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()
		await expectEditing(page, true)

		// and resetting the step it is already on leaves that state alone
		await overlay(page).getByRole('button', { name: 'Reset this step' }).click()
		await onStep(page, STEP.removeItem)
		await expect(page.getByRole('tab', { name: 'Queue (5)' })).toBeVisible()
	})

	await test.step('the save-warnings step surfaces warnings the reader caused', async () => {
		// The one step whose subject is computed rather than installed: the picks the checkpoint adds repeat a
		// faction, and the card has nothing to point at unless the statuses have caught up and the panel agrees
		// the edit session introduced them.
		await jumpTo(page, STEP.warningsOnSave)
		await expect(page.locator('[data-tour="save-warnings"]').first()).toBeVisible()
	})

	await test.step('a backward jump undoes what the later steps set up', async () => {
		// the reading steps come before any editing, so arriving at one ends the session and drops the draft
		await jumpTo(page, STEP.queueItems)
		await expectEditing(page, false)
		await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible()
	})

	await test.step('the control a step points at is what advances it', async () => {
		await jumpTo(page, STEP.startEditing)
		await expect(overlay(page).getByRole('button', { name: 'Next', exact: true })).toHaveCount(0)
		await startEditingButton(page).click()
		await expectEditing(page, true)
		await expect(overlay(page).getByRole('heading', { name: STEP.startEditing, exact: true })).toBeHidden()
	})

	await test.step('a reload loses the tour, and resume rebuilds where the reader left off', async () => {
		// progress is per user, not per browser, so the page that comes back has nothing of its own to go on
		const before = await overlay(page).getByRole('heading').first().innerText()
		await page.goto(app.loginUrl(USER, '/tutorials'))
		const entry = page.getByRole('listitem').filter({ hasText: TUTORIAL })
		await entry.getByRole('button', { name: 'Resume' }).click({ timeout: 20_000 })
		await onStep(page, before)
		// and the state that step is about came back with it
		await expectEditing(page, true)
	})

	await test.step('exiting ends the run but keeps the place', async () => {
		await overlay(page).getByRole('button', { name: 'Exit' }).click()
		await expect(overlay(page)).toHaveCount(0)

		await page.goto(app.loginUrl(USER, '/tutorials'))
		const entry = page.getByRole('listitem').filter({ hasText: TUTORIAL })
		// the run is gone, so there is nothing left to leave; where the reader got to is theirs and survives it
		await expect(entry.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 20_000 })
		await expect(entry.getByRole('button', { name: 'Leave' })).toHaveCount(0)
	})
})
