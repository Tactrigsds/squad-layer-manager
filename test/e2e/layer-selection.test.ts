import type { Page } from '@playwright/test'

import * as FB from '@/models/filter-builders'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { filter, LAYERS, queue, role, selectableFilter } from '../harness/arrange'
import { expect, test } from './fixtures'
import { settledText, settledTextAfter } from './settle'

// The select-layers dialog, against one app. What it offers is the product of three things -- the
// server's pool config, the filters the user has applied on top of it, and the filter menu -- and the
// queue only ever gets a layer that survived all three. The pool filter is also the single definition
// of pool membership: out-of-pool layers, reachable by turning the pinned pool control off, can only be
// selected by users with queue:force-write. One pool config carries every case: the pool filter itself,
// a pinned-but-off filter, an unpinned extra, and users on both sides of the force-write line.
//
// Ordering note: tests that add ops to an editing session run last, so every earlier test opens the
// dialog against an unmodified queue.

const POOL_FILTER = 'raas-only'
const PINNED_FILTER = 'seed-only'
const EXTRA_FILTER = 'narva-only'

const WRITER: TestUser = { discordId: 900000000000000021n, username: 'test-writer' }
const FORCE_WRITER: TestUser = { discordId: 900000000000000022n, username: 'test-force-writer' }

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		// one in-pool and one out-of-pool queued layer, so both sides of the edit dialog's membership check run
		layerQueue: queue(LAYERS.harjuRaas, LAYERS.sumariSeed),
		filters: [
			filter(POOL_FILTER, 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
			filter(PINNED_FILTER, 'Seed Only', FB.and([FB.eq('Gamemode', 'Seed')])),
			filter(EXTRA_FILTER, 'Narva Only', FB.and([FB.eq('Map', 'Narva')])),
		],
		serverSettings: (settings) => {
			const pool = settings.queue.mainPool
			pool.poolFilter = { filterId: POOL_FILTER, mode: 'include' }
			// pinned but off: Seed contradicts the RAAS pool, and an empty result set would make the
			// count assertions below pass for the wrong reason
			selectableFilter(pool, PINNED_FILTER, { applyAs: 'disabled' })
		},
		// a user the permission system says yes to for editing but no to for force-write, which is
		// what makes "the row is disabled" mean something -- and one holding force-write, for the
		// permission-simulation test
		users: [WRITER, FORCE_WRITER],
		globalSettings: (settings) => {
			// site:authorized is what lets the session exist at all; queue:write is the capability under test
			settings.rbac.roles['queue-writer'] = role(['site:authorized', 'queue:write'], { users: [WRITER] })
			settings.rbac.roles['queue-force-writer'] = role(['site:authorized', 'queue:write', 'queue:force-write'], {
				users: [FORCE_WRITER],
			})
		},
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

async function openAddLayers(page: Page) {
	await page.getByRole('button', { name: 'Start Editing' }).click()
	await page.getByRole('button', { name: 'Add Layers' }).click()
	return page.getByRole('dialog', { name: 'Add Layers' })
}

// opens a fresh Add Layers dialog, turns the pool off to surface out-of-pool layers, and clicks Sumari_Seed_v1.
// whether Submit arms is the answer to "did the row accept the selection"
async function clickOutOfPoolRow(page: Page) {
	await page.getByRole('button', { name: 'Add Layers' }).click()
	const dialog = page.getByRole('dialog', { name: 'Add Layers' })

	await dialog.getByRole('combobox', { name: 'Map' }).click()
	await page.getByRole('option', { name: 'Sumari', exact: true }).click()

	// see the settling notes below for why the count is what makes the filter menu answer for the new pool
	const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
	const matchedCount = dialog.getByText(/matched layers|No layers matched/)
	const countWithPool = await settledText(matchedCount)
	await poolControl.click()
	await expect(poolControl).toHaveAttribute('aria-checked', 'false')
	await settledTextAfter(matchedCount, countWithPool)

	await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
	await page.getByRole('option', { name: 'Seed', exact: true }).click()
	await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('Seed')

	const seedRow = dialog.getByRole('row').filter({ hasText: 'Sumari_Seed_v1' }).first()
	await expect(seedRow).toBeVisible()
	await seedRow.click()
	return dialog
}

// switches the permissions dialog's simulation on or off. Leaving it on is what the assertions below read
async function setForceWriteSimulatedAway(page: Page, simulatedAway: boolean) {
	await page.getByLabel('User menu').click()
	await page.getByRole('menuitem', { name: 'Permissions' }).click()
	const dialog = page.getByRole('dialog', { name: 'User Permissions' })
	const simulate = dialog.getByRole('switch', { name: 'Simulate' })

	if (simulatedAway) {
		await simulate.click()
		await expect(simulate).toHaveAttribute('aria-checked', 'true')
		await dialog.getByRole('tab', { name: 'All Permissions' }).click()
		const permCheckbox = dialog.getByRole('checkbox', { name: 'queue:force-write' })
		await permCheckbox.click()
		await expect(permCheckbox).toHaveAttribute('aria-checked', 'false')
	} else {
		// switching simulation off clears every toggle inside it, so the permission comes back with it
		await simulate.click()
		await expect(simulate).toHaveAttribute('aria-checked', 'false')
	}

	await page.keyboard.press('Escape')
	await expect(dialog).toHaveCount(0)
}

// Runs before the tests that edit the queue: it reloads the page, which would drop an editing session.
test.describe('the explore-layers collection', () => {
	async function openExplore(page: Page) {
		await page.getByRole('button', { name: 'Explore Layers' }).click()
		return page.getByRole('dialog', { name: 'Layers' })
	}

	test('opens on the default collection, then on whatever the user last picked', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

		const dialog = await openExplore(page)
		const collection = dialog.getByRole('combobox', { name: 'Collection' })
		await expect(collection).toHaveText('OWI')

		await collection.click()
		await page.getByRole('option', { name: 'GC', exact: true }).click()
		await expect(collection).toHaveText('GC')

		await page.reload()
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
		const reopened = await openExplore(page)
		await expect(reopened.getByRole('combobox', { name: 'Collection' })).toHaveText('GC')
	})

	test('leaves the collection cleared once the user clears it', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

		const dialog = await openExplore(page)
		const collection = dialog.getByRole('combobox', { name: 'Collection' })
		await collection.click()
		await page.getByRole('option', { name: '-', exact: true }).click()
		await expect(collection).toHaveText('Select Collection...')

		await page.reload()
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
		const reopened = await openExplore(page)
		await expect(reopened.getByRole('combobox', { name: 'Collection' })).toHaveText('Select Collection...')
	})
})

test.describe('applied filters', () => {
	// the pool's own filters are already rendered as pinned controls, so offering them again in the
	// extras picker would produce two controls for one constraint
	test('the extras picker offers only filters the pool does not already pin', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
		const dialog = await openAddLayers(page)

		// both pinned controls render, which is what makes their absence from the picker meaningful
		await expect(dialog.getByRole('checkbox', { name: 'RAAS Only' })).toBeVisible()
		await expect(dialog.getByRole('checkbox', { name: 'Seed Only' })).toBeVisible()

		await dialog.getByRole('button', { name: 'Edit extra filters' }).click()
		const options = page.getByRole('listbox')
		await expect(options.getByRole('option', { name: 'Narva Only' })).toBeVisible()
		await expect(options.getByRole('option', { name: 'RAAS Only' })).toHaveCount(0)
		await expect(options.getByRole('option', { name: 'Seed Only' })).toHaveCount(0)
	})

	// an extra arrives disabled and only constrains the query once switched on, so the two steps are
	// asserted separately: adding one must not silently narrow the results
	test('an added extra filter constrains the query only once enabled', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
		const dialog = await openAddLayers(page)

		// the pinned control only renders once its filter entity has arrived, which is what gates the pool
		// entering the query at all. Necessary but not sufficient -- the count it produces lands later still
		await expect(dialog.getByRole('checkbox', { name: 'RAAS Only' })).toBeVisible()
		const matchedCount = dialog.getByText(/matched layers|No layers matched/)
		const poolOnlyCount = await settledText(matchedCount)
		expect(poolOnlyCount).toMatch(/\d+ matched layers/)

		await dialog.getByRole('button', { name: 'Edit extra filters' }).click()
		await page.getByRole('listbox').getByRole('option', { name: 'Narva Only' }).click()
		await page.keyboard.press('Escape')

		// it renders as a control of its own, off, and the result set is untouched
		const extraControl = dialog.getByRole('checkbox', { name: 'Narva Only' })
		await expect(extraControl).toBeVisible()
		await expect(extraControl).toHaveAttribute('aria-checked', 'false')
		await expect(matchedCount).toHaveText(poolOnlyCount)

		await extraControl.click()
		await expect(extraControl).toHaveAttribute('aria-checked', 'true')
		await settledTextAfter(matchedCount, poolOnlyCount)
		await expect(dialog.getByRole('row').filter({ hasText: 'Narva' }).first()).toBeVisible()
	})
})

test.describe('the filter menu', { tag: '@firefox' }, () => {
	test('holds the filter menu to one layer at a time, and keeps the queried columns consistent', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
		const dialog = await openAddLayers(page)

		// picking a Layer backfills the columns it is composed of (see LayerFilterMenuPrt.Actions.setComparison):
		// the menu stays internally consistent rather than letting Map and Layer disagree
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await page.getByRole('option', { name: 'Narva_RAAS_v1', exact: true }).click()

		await expect(dialog.getByRole('combobox', { name: 'Map' })).toHaveText('Narva')
		await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('RAAS')

		const rows = dialog.getByRole('row')
		await expect(rows.filter({ hasText: 'Narva_RAAS_v1' }).first()).toBeVisible()
		await expect(rows.filter({ hasText: 'Gorodok' })).toHaveCount(0)

		// Clear All puts every menu item back to empty, so nothing is left constraining the query
		await dialog.getByRole('button', { name: 'Clear All' }).click()
		await expect(dialog.getByRole('combobox', { name: 'Map' })).toHaveText('Select Map...')
		await expect(dialog.getByRole('combobox', { name: 'Layer', exact: true })).toHaveText('Select Layer...')
	})
})

test.describe('pool membership and force-write', () => {
	test('out-of-pool layers are viewable but unselectable without force-write', async ({ page }) => {
		await page.goto(app.loginUrl(WRITER))
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })

		// the pool applies by default: the pinned control is on, and only pool layers are offered
		const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
		await expect(poolControl).toHaveAttribute('aria-checked', 'true')

		await dialog.getByRole('combobox', { name: 'Map' }).click()
		await page.getByRole('option', { name: 'Sumari', exact: true }).click()

		const rows = dialog.getByRole('row')
		await expect(rows.filter({ hasText: 'Sumari_RAAS_v1' }).first()).toBeVisible()
		await expect(rows.filter({ hasText: 'Sumari_Seed_v1' })).toHaveCount(0)

		// turning the pool off surfaces out-of-pool layers. The checkbox flips immediately but the query
		// behind it does not, and the same response that refills the table is what tells the filter menu
		// which gamemodes are still reachable -- until it lands, an out-of-pool option swallows the click
		// that would select it. The count only renders on a settled query, so waiting for it to change is
		// what makes the menu below answer for the pool we actually have.
		const matchedCount = dialog.getByText(/matched layers|No layers matched/)
		const countWithPool = await settledText(matchedCount)
		await poolControl.click()
		await expect(poolControl).toHaveAttribute('aria-checked', 'false')
		await settledTextAfter(matchedCount, countWithPool)

		await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
		await page.getByRole('option', { name: 'Seed', exact: true }).click()
		await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('Seed')

		// the out-of-pool layer is visible but its row refuses selection: clicking it must not arm Submit
		const seedRow = rows.filter({ hasText: 'Sumari_Seed_v1' }).first()
		await expect(seedRow).toBeVisible()
		await seedRow.click()
		await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled()

		// positive control, so the assertion above can't pass for the wrong reason: an in-pool row
		// selected the same way does arm Submit
		await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
		await page.getByRole('option', { name: 'RAAS', exact: true }).click()
		await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('RAAS')
		const raasRow = rows.filter({ hasText: 'Sumari_RAAS_v1' }).first()
		await expect(raasRow).toBeVisible()
		await raasRow.click()
		await expect(dialog.getByRole('button', { name: 'Submit' })).toBeEnabled()
	})

	// row disabling used to be computed from the real permissions when the page was queried, so the permissions
	// dialog's simulation could not narrow it: an admin simulating the loss of force-write still got selectable
	// out-of-pool rows, which is the one thing the simulation is there to show them
	test('simulating away force-write disables out-of-pool rows', async ({ page }) => {
		await page.goto(app.loginUrl(FORCE_WRITER))
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
		await page.getByRole('button', { name: 'Start Editing' }).click()

		await setForceWriteSimulatedAway(page, true)
		const simulatedDialog = await clickOutOfPoolRow(page)
		await expect(simulatedDialog.getByRole('button', { name: 'Submit' })).toBeDisabled()
		// this one ignores Escape, so the close button is the only way back out to the user menu
		await simulatedDialog.getByRole('button', { name: 'Close' }).click()
		await expect(simulatedDialog.getByRole('heading', { name: 'Add Layers' })).toHaveCount(0)

		// positive control: the same row, same clicks, with simulation off. Without this the assertion above
		// would also pass if the row were unselectable for some reason unrelated to the permission
		await setForceWriteSimulatedAway(page, false)
		const realDialog = await clickOutOfPoolRow(page)
		await expect(realDialog.getByRole('button', { name: 'Submit' })).toBeEnabled()
	})

	test('edit dialog applies the pool only when the edited layer is in it', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const items = queuePanel.getByRole('listitem')
		await page.getByRole('button', { name: 'Start Editing' }).click()

		// the in-pool layer: the membership check resolves and switches the pool on
		await items.filter({ hasText: 'Harju_RAAS_v1' }).getByRole('button', { name: 'Edit' }).click()
		const dialog = page.getByRole('dialog', { name: 'Edit Layer' })
		const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
		await expect(poolControl).toHaveAttribute('aria-checked', 'true')
		await page.keyboard.press('Escape')
		// the dialog unmounts on close; its root is a zero-size positioning node, so visibility
		// assertions must target it existing (or its children), never the root's own visibility
		await expect(dialog).toHaveCount(0)

		// the out-of-pool layer: the pool stays off, so the layer being edited isn't filtered out of
		// its own dialog
		await items.filter({ hasText: 'Sumari_Seed_v1' }).getByRole('button', { name: 'Edit' }).click()
		await expect(dialog.getByRole('heading', { name: 'Edit Layer' })).toBeVisible()
		const rows = dialog.getByRole('row')
		await expect(rows.filter({ hasText: 'Sumari_Seed_v1' }).first()).toBeVisible()
		await expect(poolControl).toHaveAttribute('aria-checked', 'false')
	})

	test('adds a chosen out-of-pool layer to the head of the queue', { tag: '@firefox' }, async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

		await page.getByRole('button', { name: 'Start Editing' }).click()
		// the admin is a superuser, so the out-of-pool row accepts the selection and Submit arms
		const dialog = await clickOutOfPoolRow(page)
		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()

		// 'Play Next' is the default position, so it lands at the head
		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible()
		await expect(queuePanel.getByRole('listitem').first()).toContainText('Sumari_Seed_v1')
	})
})
