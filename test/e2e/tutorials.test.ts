import type { Page } from '@playwright/test'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { role } from '../harness/arrange'
import * as DB from '../harness/dashboard'
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
// and covers the search box. Three steps open an edit session and their titles all begin "Start editing", so the
// first match is the one a reader searching for it would also click.
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
			await expect(DB.queueLabel(promptPage, /^Queue/)).toBeVisible({ timeout: 60_000 })
			await expect(prompt).toHaveCount(0)
		} finally {
			await promptCtx.close()
		}
	})

	await test.step('the index page starts a run', async () => {
		// A reader who last left the dashboard on the Teams tab arrives here on it, since the tab is a persisted
		// preference. Seeded through storage because this file's user has no dashboard to click it on. Guarded so
		// the later navigations in this journey do not re-apply it over the tab the tour selects.
		await page.addInitScript(() => {
			const key = 'settings:v1'
			if (!localStorage.getItem(key)) {
				localStorage.setItem(key, JSON.stringify({ state: { primaryPanelTab: 'VIEWING_TEAMS' }, version: 0 }))
			}
		})
		await page.goto(app.loginUrl(USER, '/tutorials'))
		await expect(page.getByRole('heading', { name: 'Tutorials' })).toBeVisible({ timeout: 20_000 })
		const entry = page.getByRole('listitem').filter({ hasText: TUTORIAL })
		await entry.getByRole('button', { name: 'Start', exact: true }).click()

		// the run stands up its own scoped server and the tour navigates to that dashboard
		await expect(page).toHaveURL(new RegExp(`/servers/tutorial-${USER.discordId}`), { timeout: 60_000 })
		await onStep(page, STEP.welcome)
		await expect(overlay(page).getByText('Step 1 of')).toBeVisible()
		// both panels stay mounted in one grid cell, so a tour left on Teams would narrate a queue nothing shows
		await expect(DB.queueSection(page)).toBeVisible()
	})

	await test.step('the card button advances', async () => {
		await overlay(page).getByRole('button', { name: 'Next', exact: true }).click()
		await expect(overlay(page).getByText('Step 2 of')).toBeVisible()
	})

	await test.step('a forward jump provisions the state its step is about', async () => {
		await jumpTo(page, STEP.addedLayers)
		// the checkpoint installs the reader's two picks as unsaved additions and hands them an edit session
		await expectEditing(page, true)
		await expect(DB.queueLabel(page, 'Queue (5)')).toBeVisible()
		for (const layer of ADDED) await expect(queuePanel(page).getByText(layer).first()).toBeVisible()
	})

	await test.step('stepping back rebuilds a step the reader has already acted on', async () => {
		await jumpTo(page, STEP.removeItem)
		await expect(DB.queueLabel(page, 'Queue (5)')).toBeVisible()

		// this step points at the delete button and advances on the click, so doing what it asks both shrinks the
		// queue and moves the tour on
		await queuePanel(page).locator('[data-tour="queue-delete"]').first().click()
		await onStep(page, STEP.swapTeams)
		await expect(DB.queueLabel(page, 'Queue (4)')).toBeVisible()

		// going back has to put the deleted item back, or the step describes a queue that no longer exists
		await overlay(page).getByRole('button', { name: 'Previous step' }).click()
		await onStep(page, STEP.removeItem)
		await expect(DB.queueLabel(page, 'Queue (5)')).toBeVisible()
		await expectEditing(page, true)

		// and resetting the step it is already on leaves that state alone
		await overlay(page).getByRole('button', { name: 'Reset this step' }).click()
		await onStep(page, STEP.removeItem)
		await expect(DB.queueLabel(page, 'Queue (5)')).toBeVisible()
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
		await expect(DB.queueLabel(page, 'Queue (3)')).toBeVisible()
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

// The player management tutorial on the same app, after the layer queue journey has exited its run. Its sections act
// on the roster for real (kicks, timeouts, swaps, a switch request), so what this checks is that doing what a card
// asks moves the tour on, and that a jump into a section undoes what the earlier ones did to the roster.
test('the player management tutorial, acted on and navigated out of order', async ({ page }) => {
	test.setTimeout(300_000)

	const PM_TUTORIAL = 'Player management'
	const row = (name: string) => page.locator(`[data-tour="teams-panel"] [data-tour="player-row"][data-tour-player="${name}"]`)
	// several titles contain another ("Timeouts", "Active timeouts"), so an entry, named "<number> <title>", is
	// matched whole
	async function jumpToExact(title: string) {
		await overlay(page).getByRole('button', { name: 'Contents' }).click()
		const contents = overlay(page).getByRole('navigation', { name: 'Tutorial contents' })
		await contents.getByRole('searchbox', { name: 'Search steps' }).fill(title)
		await contents
			.getByRole('button', { name: new RegExp(`^\\d+ ${title}$`) })
			.first()
			.click()
		await onStep(page, title)
	}
	// right-clicks a cell that is not the name, which would open the player's own menu rather than the row's
	async function playerAction(name: string, item: string) {
		await row(name).locator('td').nth(3).click({ button: 'right' })
		await page.getByRole('menuitem', { name: item, exact: true }).click()
	}

	await test.step('the index page starts a run', async () => {
		await page.goto(app.loginUrl(USER, '/tutorials'))
		const entry = page.getByRole('listitem').filter({ hasText: PM_TUTORIAL })
		await entry.getByRole('button', { name: 'Start', exact: true }).click({ timeout: 20_000 })
		await expect(page).toHaveURL(new RegExp(`/servers/tutorial-${USER.discordId}`), { timeout: 60_000 })
		await onStep(page, 'Welcome')
	})

	await test.step('the match history holds the matches played before the reader arrived', async () => {
		await jumpToExact('Look back at a match')
		const rows = page.locator('[data-tour="mh-row"]')
		// the two the run played during setup, and the reader's own
		await expect(rows).toHaveCount(3)
		await expect(rows.first().locator('[data-tour="mh-time"]')).toContainText('m)')
		await page.locator('[data-tour="mh-row"]:has(+ [data-tour-current])').click()
		await onStep(page, 'Viewing a past match')
		await jumpToExact('Back to live')
		await page.locator('[data-tour="activity-live"]').click()
		await onStep(page, 'Earlier days')
		await expect(page.locator('[data-tour="activity-live"]')).toHaveCount(0)
	})

	await test.step('kicking from the actions menu moves the tour on', async () => {
		await jumpToExact('Kick')
		await expect(row('Novak')).toBeVisible()
		await playerAction('Novak', 'Kick')
		await page.getByRole('alertdialog').getByRole('button', { name: 'Kick', exact: true }).click()
		await onStep(page, 'Kicking from in game')
		await expect(row('Novak')).toHaveCount(0)
		// the in-game commands link to their own entries on the commands page
		const link = overlay(page).getByRole('link').first()
		await expect(link).toHaveAttribute('href', `/commands#${encodeURIComponent('section:moderation/command:kick')}`)
		await expect(link).toHaveAttribute('target', '_blank')
	})

	await test.step('a jump replays the timeout, and cancelling it moves the tour on', async () => {
		await jumpToExact('Timeouts')
		const timeouts = page.locator('[data-tour="timeouts-window"]')
		await expect(timeouts.getByText('Ruiz')).toBeVisible()
		await timeouts
			.getByRole('button', { name: /cancel/i })
			.first()
			.click()
		await onStep(page, 'Timeouts from in game')
		await expect(timeouts.getByText('Ruiz')).toHaveCount(0)
	})

	await test.step('jumping back into the section undoes the kick', async () => {
		await jumpToExact('Kick')
		await expect(row('Novak')).toBeVisible()
		await expect(row('Ruiz')).toBeVisible()
	})

	await test.step('swap next opens an edit that saving ends', async () => {
		await jumpToExact('Swap next')
		await playerAction('Tanaka', 'Swap Next')
		await onStep(page, 'Team swaps')
		const swaps = page.locator('[data-tour="swaps-panel"]')
		await expect(swaps.locator('[data-tour="swap-badge"]').filter({ hasText: 'Tanaka' })).toBeVisible()
		await jumpToExact('Save')
		await swaps.locator('[data-tour="swaps-save"]').click()
		await expect(overlay(page).getByRole('heading', { name: 'Swap now', exact: true })).toBeVisible({ timeout: 45_000 })
		await expect(swaps.locator('[data-tour="swap-badge"]').filter({ hasText: 'Tanaka' })).toBeVisible()
	})

	await test.step('a player waiting to switch is moved by switch now', async () => {
		// the checkpoint clears the saved swap and has a sandbox player type the switch command
		await jumpToExact('Switch now')
		const requests = page.locator('[data-tour="switch-requests-window"]')
		await expect(requests.getByText('Brightwater')).toBeVisible()
		await expect(page.locator('[data-tour="swaps-panel"]')).toHaveCount(0)
		await requests.locator('[data-tour="switch-now"]').first().click()
		await onStep(page, 'Switching from in game')
		await expect(requests.getByText('No switch requests.')).toBeVisible()
	})

	await test.step('exiting ends the run', async () => {
		await overlay(page).getByRole('button', { name: 'Exit' }).click()
		await expect(overlay(page)).toHaveCount(0)
	})
})

// Every step of every tutorial the index page lists, reached the way a reader jumping around the contents would:
// each jump rebuilds the step's state through its checkpoint and the replays before it, and the card then has to
// show that step with its anchor on screen. The journeys above act on a handful of steps; this is what catches an
// anchor that no longer resolves, or a checkpoint that no longer sets a step up, anywhere else. Failures are soft,
// so one run reports every broken step.
test('every step of every tutorial sets up and finds its anchor', async ({ page }) => {
	test.setTimeout(20 * 60_000)

	await page.goto(app.loginUrl(USER, '/tutorials'))
	const entries = page.getByRole('listitem')
	await expect(entries.first()).toBeVisible({ timeout: 20_000 })
	const names = (await entries.locator('span.font-medium').allInnerTexts()).map((name) => name.trim())
	expect(names.length).toBeGreaterThan(0)

	for (const name of names) {
		await test.step(name, async () => {
			await page.goto(app.loginUrl(USER, '/tutorials'))
			const entry = page.getByRole('listitem').filter({ hasText: name })
			await entry
				.getByRole('button', { name: /^(Start|Replay)$/ })
				.first()
				.click({ timeout: 20_000 })
			const counter = overlay(page).getByText(/^Step 1 of \d+$/)
			await expect(counter).toBeVisible({ timeout: 90_000 })
			const total = Number(/of (\d+)/.exec(await counter.innerText())![1])

			for (let stepNo = 1; stepNo <= total; stepNo++) {
				await overlay(page).getByRole('button', { name: 'Contents' }).click()
				const contents = overlay(page).getByRole('navigation', { name: 'Tutorial contents' })
				const entryButton = contents.getByRole('button', { name: new RegExp(`^${stepNo} `) })
				const title = (await entryButton.innerText()).replace(/^\d+\s*/, '').trim()
				await entryButton.click()

				const card = overlay(page).locator('[data-tour-anchor]')
				await expect(card.getByText(`Step ${stepNo} of ${total}`)).toBeVisible({ timeout: 60_000 })
				await expect(card.getByText('Preparing…')).toHaveCount(0, { timeout: 60_000 })
				const where = `${name}, step ${stepNo} "${title}"`
				// a failed or not-ready stage both leave a Retry on the card
				await expect.soft(card.getByRole('button', { name: 'Retry' }), `${where} could not be set up`).toHaveCount(0)
				await expect.soft(card, `${where} lost its anchor`).toHaveAttribute('data-tour-anchor', /^(found|none)$/, { timeout: 15_000 })
			}

			await overlay(page).getByRole('button', { name: 'Exit' }).click()
			await expect(overlay(page)).toHaveCount(0)
		})
	}
})
