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

			await app.waitFor(() => {
				const row = app.readDb().prepare('select name from filters where id = ?').get('raas-only') as { name: string } | undefined
				return row?.name === 'RAAS Only (renamed)' ? row : null
			}, { label: 'renamed filter persisted' })
		} finally {
			await app.dispose()
		}
	})
})
