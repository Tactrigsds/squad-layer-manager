import * as FB from '@/models/filter-builders'
import { createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, poolFilter, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// The select-layers dialog. What it offers is the product of three things -- the server's pool config,
// the filters the user has applied on top of it, and the filter menu -- and the queue only ever gets a
// layer that survived all three, so this is where a wrong constraint shows up as the wrong layer played.

test.describe('selecting layers', () => {
	test('applies the pool filter by default, narrows through the filter menu, and adds the chosen layer', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			filters: [filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]))],
			serverSettings: (settings) => {
				settings.queue.mainPool.filters = [poolFilter('raas-only')]
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Add Layers' }).click()
			const dialog = page.getByRole('dialog', { name: 'Add Layers' })

			// the server's pool config says this filter applies during layer selection, so the dialog opens
			// with it already on -- nobody has to remember to tick it
			const raasOnly = dialog.getByRole('checkbox', { name: 'RAAS Only' })
			await expect(raasOnly).toHaveAttribute('aria-checked', 'true')

			// narrow to a single map through the filter menu, which makes what the table offers small and exact
			await dialog.getByRole('combobox', { name: 'Map' }).click()
			await page.getByRole('option', { name: 'Sumari', exact: true }).click()

			const rows = dialog.getByRole('row')
			// with the filter applied every row this query can return is a Sumari_RAAS_v1 variant, so its absence is
			// what says the filter withheld the rest, rather than that they are on some other page
			await expect(rows.filter({ hasText: 'Sumari_RAAS_v1' }).first()).toBeVisible()
			await expect(rows.filter({ hasText: 'Sumari_Seed_v1' })).toHaveCount(0)

			// turning the filter off is what lets an admin reach outside the pool
			await raasOnly.click()
			await expect(raasOnly).toHaveAttribute('aria-checked', 'false')

			// and now narrow to the gamemode being asserted on. The table sorts randomly by default (see the layerTable
			// setting) and pages, so "is Sumari_Seed_v1 in the table" without narrowing to it is really "did the shuffle
			// deal it onto page one" -- which it did about five times in six. Sumari_Seed_v1 is Sumari's only seed layer,
			// so once Seed is the gamemode, every row is one of its faction variants whatever the shuffle did.
			await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
			await page.getByRole('option', { name: 'Seed', exact: true }).click()
			await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('Seed')

			const seedRow = rows.filter({ hasText: 'Sumari_Seed_v1' }).first()
			await expect(seedRow).toBeVisible()

			await seedRow.click()
			await dialog.getByRole('button', { name: 'Submit' }).click()
			await expect(dialog).toBeHidden()

			// 'Play Next' is the default position, so it lands at the head
			const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
			await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible()
			await expect(queuePanel.getByRole('listitem').first()).toContainText('Sumari_Seed_v1')
		} finally {
			await app.dispose()
		}
	})

	test('holds the filter menu to one layer at a time, and keeps the queried columns consistent', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Add Layers' }).click()
			const dialog = page.getByRole('dialog', { name: 'Add Layers' })

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
		} finally {
			await app.dispose()
		}
	})
})
