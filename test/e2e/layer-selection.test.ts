import type { Page } from '@playwright/test'

import * as FB from '@/models/filter-builders'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { filter, LAYERS, layerText, queue, role, selectableFilter } from '../harness/arrange'
import * as DB from '../harness/dashboard'
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
	const countWithPool = await settledText(dialog)
	await poolControl.click()
	await expect(poolControl).toHaveAttribute('aria-checked', 'false')
	await settledTextAfter(dialog, countWithPool)

	await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
	await page.getByRole('option', { name: 'Seed', exact: true }).click()
	await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('Seed')

	const seedRow = dialog
		.getByRole('row')
		.filter({ hasText: layerText('Sumari_Seed_v1') })
		.first()
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
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })

		const dialog = await openExplore(page)
		const collection = dialog.getByRole('combobox', { name: 'Collection' })
		await expect(collection).toHaveText('OWI')

		await collection.click()
		await page.getByRole('option', { name: 'GC', exact: true }).click()
		await expect(collection).toHaveText('GC')

		await page.reload()
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
		const reopened = await openExplore(page)
		await expect(reopened.getByRole('combobox', { name: 'Collection' })).toHaveText('GC')
	})

	test('leaves the collection cleared once the user clears it', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })

		const dialog = await openExplore(page)
		const collection = dialog.getByRole('combobox', { name: 'Collection' })
		await collection.click()
		await page.getByRole('option', { name: '-', exact: true }).click()
		await expect(collection).toHaveText('Select Collection...')

		await page.reload()
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
		const reopened = await openExplore(page)
		await expect(reopened.getByRole('combobox', { name: 'Collection' })).toHaveText('Select Collection...')
	})

	test('focusing a layer sets the collection it is in', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })

		const dialog = await openExplore(page)
		// pinned to the one layer rather than to its map: with the collection cleared below, every mod's Narva
		// layers join the result set and a page of 16 rows no longer reliably holds the vanilla one
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await page.getByRole('option', { name: 'Narva_RAAS_v1', exact: true }).click()

		const collection = dialog.getByRole('combobox', { name: 'Collection' })
		await collection.click()
		await page.getByRole('option', { name: '-', exact: true }).click()
		await expect(collection).toHaveText('Select Collection...')

		// both constraints have to have answered before the row is touched: the table remounts its rows when a
		// query lands, and a right-click that straddles that opens a context menu whose trigger is already gone
		await settledText(dialog)

		const row = dialog
			.getByRole('row')
			.filter({ hasText: layerText('Narva_RAAS_v1') })
			.first()
		await expect(row).toBeVisible()
		await row.click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Focus Layer' }).click()

		await expect(collection).toHaveText('OWI')
	})
})

test.describe('applied filters', () => {
	// the pool's own filters are already rendered as pinned controls, so offering them again in the
	// extras picker would produce two controls for one constraint
	test('the extras picker offers only filters the pool does not already pin', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
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
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
		const dialog = await openAddLayers(page)

		// the pinned control only renders once its filter entity has arrived, which is what gates the pool
		// entering the query at all. Necessary but not sufficient -- the count it produces lands later still
		await expect(dialog.getByRole('checkbox', { name: 'RAAS Only' })).toBeVisible()
		const matchedCount = dialog.getByText(/matched layers|No layers matched/)
		const poolOnlyCount = await settledText(dialog)
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
		await settledTextAfter(dialog, poolOnlyCount)
		await expect(dialog.getByRole('row').filter({ hasText: 'Narva' }).first()).toBeVisible()
	})
})

test.describe('the filter menu', { tag: '@firefox' }, () => {
	test('holds the filter menu to one layer at a time, and keeps the queried columns consistent', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
		const dialog = await openAddLayers(page)

		// picking a Layer backfills the columns it is composed of (see LayerFilterMenuPrt.Actions.setComparison):
		// the menu stays internally consistent rather than letting Map and Layer disagree
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await page.getByRole('option', { name: 'Narva_RAAS_v1', exact: true }).click()

		await expect(dialog.getByRole('combobox', { name: 'Map' })).toHaveText('Narva')
		await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('RAAS')

		const rows = dialog.getByRole('row')
		await expect(rows.filter({ hasText: layerText('Narva_RAAS_v1') }).first()).toBeVisible()
		await expect(rows.filter({ hasText: 'Gorodok' })).toHaveCount(0)

		// Clear All puts every menu item back to empty, so nothing is left constraining the query
		await dialog.getByRole('button', { name: 'Clear All' }).click()
		await expect(dialog.getByRole('combobox', { name: 'Map' })).toHaveText('Select Map...')
		await expect(dialog.getByRole('combobox', { name: 'Layer', exact: true })).toHaveText('Select Layer...')
	})
})

// A layer whose mod the server does not have cannot load at all, so no permission makes it selectable. The
// default installedMods is OWI alone, and the user here holds force-write, which is what separates this from
// the pool tests below.
// A layer whose mod the server does not have cannot load at all, so no permission makes it selectable, and the
// Installed Mods setting is the only thing that changes the answer.
test.describe('installed mods', () => {
	// Opens Add Layers with the pool off and the filter menu pinned to `collection`. The pool is RAAS-only and the
	// mod collections spell their gamemodes their own way, so turning it off is what keeps these tests about the
	// mod rather than about pool membership. The count is what says a query settled (see the pool tests below).
	async function openAddLayersOn(page: Page, collection: string) {
		const dialog = await openAddLayers(page)
		const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
		await expect(poolControl).toHaveAttribute('aria-checked', 'true')
		let lastCount = await settledText(dialog)
		await poolControl.click()
		await expect(poolControl).toHaveAttribute('aria-checked', 'false')
		lastCount = await settledTextAfter(dialog, lastCount)

		const collectionMenu = dialog.getByRole('combobox', { name: 'Collection' })
		await collectionMenu.click()
		await page.getByRole('option', { name: collection, exact: true }).click()
		await expect(collectionMenu).toHaveText(collection)
		await settledTextAfter(dialog, lastCount)
		return dialog
	}

	// the collection alone does not pin a layer, so the assertions read the first body row (index 0 is the header)
	const firstRow = (dialog: ReturnType<Page['getByRole']>) => dialog.getByRole('row').nth(1)

	// Adds or removes a collection in this server's Installed Mods, through the settings page rather than the
	// fixture, so the path an operator actually takes is what the dialog below is answering to.
	async function setModInstalled(page: Page, collection: string, installed: boolean) {
		await page.goto(app.loginUrl(app.adminUser, '/settings'))
		const field = page.locator(`[id="setting:server:${app.serverId}:installedMods"]`)
		await expect(field).toBeVisible({ timeout: 20_000 })
		const picker = field.getByRole('combobox')
		await expect(picker).toContainText('OWI')

		await picker.click()
		await page.getByRole('option', { name: collection, exact: true }).click()
		await page.keyboard.press('Escape')
		if (installed) await expect(picker).toContainText(collection)
		else await expect(picker).not.toContainText(collection)

		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await page.getByRole('alertdialog').getByRole('button', { name: 'Save', exact: true }).click()
		await expect(page.getByText('Settings saved')).toBeVisible()
	}

	test('a layer from a mod the server does not have is listed but unselectable, force-write included', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })

		// the constraint does not narrow the query, so a SuperMod layer is still listed -- with no checkbox on it
		const dialog = await openAddLayersOn(page, 'SuperMod')
		await expect(firstRow(dialog)).toBeVisible()
		await expect(firstRow(dialog).getByRole('checkbox', { name: 'Select row' })).toHaveCount(0)
		await firstRow(dialog).click()
		await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled()

		// positive control: a vanilla row, reached the same way with the pool still off, does arm Submit
		const collectionMenu = dialog.getByRole('combobox', { name: 'Collection' })
		const beforeSwitch = await settledText(dialog)
		await collectionMenu.click()
		await page.getByRole('option', { name: 'OWI', exact: true }).click()
		await expect(collectionMenu).toHaveText('OWI')
		await settledTextAfter(dialog, beforeSwitch)

		await expect(firstRow(dialog).getByRole('checkbox', { name: 'Select row' })).toHaveCount(1)
		await firstRow(dialog).click()
		await expect(dialog.getByRole('button', { name: 'Submit' })).toBeEnabled()
	})

	// The setting is the whole of it: installing the mod makes the same row selectable, and uninstalling it takes
	// that back. Ends where it started, so the tests after this one see the server they were written against.
	test('installing the mod in settings makes its layers selectable, and uninstalling them takes it back', async ({ page }) => {
		await setModInstalled(page, 'SuperMod', true)

		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
		const installed = await openAddLayersOn(page, 'SuperMod')
		await expect(firstRow(installed).getByRole('checkbox', { name: 'Select row' })).toHaveCount(1)
		await firstRow(installed).click()
		await expect(installed.getByRole('button', { name: 'Submit' })).toBeEnabled()

		await setModInstalled(page, 'SuperMod', false)

		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
		const uninstalled = await openAddLayersOn(page, 'SuperMod')
		await expect(firstRow(uninstalled).getByRole('checkbox', { name: 'Select row' })).toHaveCount(0)
		await firstRow(uninstalled).click()
		await expect(uninstalled.getByRole('button', { name: 'Submit' })).toBeDisabled()
	})
})

test.describe('pasting a rotation', () => {
	test('reports the unusable lines inline, keeps the text, and adds nothing until they are gone', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Paste Rotation' }).click()
		const dialog = page.getByRole('dialog', { name: 'Paste Rotation' })

		const textarea = dialog.getByRole('textbox')
		const pasted = 'Narva_RAAS_v1 RGF USMC\nnot a layer at all\nSU_Sanxian_Invasion_v2 SU_ADF SU_BAF'
		await textarea.fill(pasted)

		const errors = dialog.getByRole('alert')
		await expect(errors).toContainText('2 lines cannot be added')
		await expect(errors).toContainText('Line 2')
		await expect(errors).toContainText('no such layer')
		await expect(errors).toContainText('Line 3')
		await expect(errors).toContainText('SuperMod is not installed on this server')

		// the one good line is counted, but nothing is added while a bad one is left, and the text stays put
		await expect(dialog.getByRole('button', { name: 'Add 1 Layer' })).toBeDisabled()
		await expect(textarea).toHaveValue(pasted)

		// dropping the two bad lines is all it takes
		await textarea.fill('Narva_RAAS_v1 RGF USMC')
		await expect(errors).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Add 1 Layer' })).toBeEnabled()

		await dialog.getByRole('button', { name: 'Cancel' }).click()
		await expect(dialog).toHaveCount(0)
	})
})

test.describe('pool membership and force-write', () => {
	test('out-of-pool layers are viewable but unselectable without force-write', async ({ page }) => {
		await page.goto(app.loginUrl(WRITER))
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })

		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })

		// the pool applies by default: the pinned control is on, and only pool layers are offered
		const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
		await expect(poolControl).toHaveAttribute('aria-checked', 'true')

		await dialog.getByRole('combobox', { name: 'Map' }).click()
		await page.getByRole('option', { name: 'Sumari', exact: true }).click()

		const rows = dialog.getByRole('row')
		await expect(rows.filter({ hasText: layerText('Sumari_RAAS_v1') }).first()).toBeVisible()
		await expect(rows.filter({ hasText: layerText('Sumari_Seed_v1') })).toHaveCount(0)

		// turning the pool off surfaces out-of-pool layers. The checkbox flips immediately but the query
		// behind it does not, and the same response that refills the table is what tells the filter menu
		// which gamemodes are still reachable -- until it lands, an out-of-pool option swallows the click
		// that would select it. The count only renders on a settled query, so waiting for it to change is
		// what makes the menu below answer for the pool we actually have.
		const countWithPool = await settledText(dialog)
		await poolControl.click()
		await expect(poolControl).toHaveAttribute('aria-checked', 'false')
		await settledTextAfter(dialog, countWithPool)

		await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
		await page.getByRole('option', { name: 'Seed', exact: true }).click()
		await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('Seed')

		// the out-of-pool layer is visible but its row refuses selection: clicking it must not arm Submit
		const seedRow = rows.filter({ hasText: layerText('Sumari_Seed_v1') }).first()
		await expect(seedRow).toBeVisible()
		await seedRow.click()
		await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled()

		// positive control, so the assertion above can't pass for the wrong reason: an in-pool row
		// selected the same way does arm Submit
		await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
		await page.getByRole('option', { name: 'RAAS', exact: true }).click()
		await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('RAAS')
		const raasRow = rows.filter({ hasText: layerText('Sumari_RAAS_v1') }).first()
		await expect(raasRow).toBeVisible()
		await raasRow.click()
		await expect(dialog.getByRole('button', { name: 'Submit' })).toBeEnabled()
	})

	// row disabling used to be computed from the real permissions when the page was queried, so the permissions
	// dialog's simulation could not narrow it: an admin simulating the loss of force-write still got selectable
	// out-of-pool rows, which is the one thing the simulation is there to show them
	test('simulating away force-write disables out-of-pool rows', async ({ page }) => {
		await page.goto(app.loginUrl(FORCE_WRITER))
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })
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
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })

		const queuePanel = DB.queueSection(page)
		const items = queuePanel.getByRole('listitem')
		await page.getByRole('button', { name: 'Start Editing' }).click()

		// the in-pool layer: the membership check resolves and switches the pool on
		await items
			.filter({ hasText: layerText('Harju_RAAS_v1') })
			.getByRole('button', { name: 'Edit' })
			.click()
		const dialog = page.getByRole('dialog', { name: 'Edit Layer' })
		const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
		await expect(poolControl).toHaveAttribute('aria-checked', 'true')
		await page.keyboard.press('Escape')
		// the dialog unmounts on close; its root is a zero-size positioning node, so visibility
		// assertions must target it existing (or its children), never the root's own visibility
		await expect(dialog).toHaveCount(0)

		// the out-of-pool layer: the pool stays off, so the layer being edited isn't filtered out of
		// its own dialog
		await items
			.filter({ hasText: layerText('Sumari_Seed_v1') })
			.getByRole('button', { name: 'Edit' })
			.click()
		await expect(dialog.getByRole('heading', { name: 'Edit Layer' })).toBeVisible()
		const rows = dialog.getByRole('row')
		await expect(rows.filter({ hasText: layerText('Sumari_Seed_v1') }).first()).toBeVisible()
		await expect(poolControl).toHaveAttribute('aria-checked', 'false')
	})

	test('adds a chosen out-of-pool layer to the head of the queue', { tag: '@firefox' }, async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(DB.queueLabel(page, 'Queue (2)')).toBeVisible({ timeout: 20_000 })

		await page.getByRole('button', { name: 'Start Editing' }).click()
		// the admin is a superuser, so the out-of-pool row accepts the selection and Submit arms
		const dialog = await clickOutOfPoolRow(page)
		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()

		// 'Play Next' is the default position, so it lands at the head
		const queuePanel = DB.queueSection(page)
		await expect(DB.queueLabel(page, 'Queue (3)')).toBeVisible()
		await expect(queuePanel.getByRole('listitem').first()).toContainText('Sumari_Seed_v1')
	})
})
