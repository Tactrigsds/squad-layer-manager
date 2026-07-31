import * as FB from '@/models/filter-builders'

import { createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// The filter entity form (name/id/alert messages), as opposed to the filter tree itself. It is the only
// tanstack-form surface in the app, so it is where a form-library upgrade breaks first: field validation
// and the submit gate are both library-driven, and neither shows up in a typecheck.

test.describe('the filter editor form', () => {
	test('rejects a malformed id with the schema message, and recovers once it is valid', async ({ app, page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/new'))

		const id = page.getByRole('textbox', { name: 'ID' })
		await expect(id).toBeVisible({ timeout: 20_000 })
		await id.fill('Not A Valid Id!!')

		// the schema's own message has to survive to the screen: a validation error the user cannot read
		// is the same as no validation at all
		const error = page.getByRole('alert').filter({ hasText: 'ID:' })
		await expect(error).toContainText('Must contain only lowercase letters, numbers, hyphens, and underscores')
		await expect(error).not.toContainText('[object Object]')

		await id.fill('a-valid-id')
		await expect(error).toBeHidden()
	})

	test('derives the id from the name until the id is edited directly', async ({ app, page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/new'))

		const name = page.getByRole('textbox', { name: 'Name' })
		const id = page.getByRole('textbox', { name: 'ID' })
		await expect(name).toBeVisible({ timeout: 20_000 })

		await name.fill('Armored Layers')
		await expect(id).toHaveValue('armored-layers')

		// once the id is the user's own, the name must stop overwriting it
		await id.fill('custom-id')
		await name.fill('Armored Layers Revised')
		await expect(id).toHaveValue('custom-id')
	})

	test('saves an edited name back to the filter', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			filters: [filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]))],
		})
		try {
			await page.goto(app.loginUrl(app.adminUser, '/filters/raas-only'))

			// the entity fields are behind the details toggle; the tree is what the page opens on
			await page.getByRole('button', { name: 'Edit Details' }).click({ timeout: 20_000 })

			const name = page.getByRole('textbox', { name: 'Name' })
			await expect(name).toHaveValue('RAAS Only')
			await name.fill('RAAS Only (renamed)')

			await page.getByRole('button', { name: 'Save' }).click()

			await app.waitFor(
				() => {
					const row = app.readDb().prepare('select name from filters where id = ?').get('raas-only') as { name: string } | undefined
					return row?.name === 'RAAS Only (renamed)' ? row : null
				},
				{ label: 'renamed filter persisted' },
			)
		} finally {
			await app.dispose()
		}
	})
})

// Deleting a filter something still points at would leave the pool, or another filter, referring to nothing.
// The gate is server-side; what these cover is that the page tells the user what is holding the filter and
// stops offering the delete.
test.describe('filter references', () => {
	test('lists what references a filter and refuses to delete it until nothing does', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			filters: [
				filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
				filter('raas-harju', 'RAAS on Harju', FB.and([FB.includedIn('raas-only'), FB.eq('Map', 'Harju')])),
				filter('unused', 'Unused', FB.and([FB.eq('Gamemode', 'AAS')])),
			],
			serverSettings: (settings) => {
				settings.queue.mainPool.poolFilter = { filterId: 'raas-harju', mode: 'include' }
			},
		})
		try {
			await page.goto(app.loginUrl(app.adminUser, '/filters/raas-only'))

			const references = page.getByRole('region', { name: 'References' })
			await expect(references).toContainText('2 references', { timeout: 20_000 })
			// referenced directly by raas-harju, and transitively by the pool filter that applies it
			await expect(references).toContainText('RAAS on Harju')
			await expect(references).toContainText('Pool filter')
			await expect(references).toContainText('via raas-harju')

			await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled()

			// a filter nothing points at still deletes
			await page.goto(app.loginUrl(app.adminUser, '/filters/unused'))
			await expect(page.getByText('Nothing references this filter')).toBeVisible({ timeout: 20_000 })
			await page.getByRole('button', { name: 'Delete' }).click()
			await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()

			await app.waitFor(
				() => {
					const row = app.readDb().prepare('select id from filters where id = ?').get('unused')
					return row ? null : true
				},
				{ label: 'unreferenced filter deleted' },
			)
		} finally {
			await app.dispose()
		}
	})

	test('refuses to save an edit that would make two filters reference each other', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			filters: [
				filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
				filter('raas-harju', 'RAAS on Harju', FB.and([FB.includedIn('raas-only'), FB.eq('Map', 'Harju')])),
			],
		})
		try {
			await page.goto(app.loginUrl(app.adminUser, '/filters/raas-only'))

			await page.getByRole('button', { name: 'Add condition' }).first().click({ timeout: 20_000 })
			await page.getByRole('button', { name: 'apply existing filter' }).click()
			await page.getByRole('combobox', { name: 'Filter' }).click()
			await page.getByRole('option', { name: 'RAAS on Harju' }).click()

			await expect(page.getByRole('alert')).toContainText('raas-only -> raas-harju -> raas-only')
			await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
		} finally {
			await app.dispose()
		}
	})
})
