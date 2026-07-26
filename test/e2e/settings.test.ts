import { expect, test } from './fixtures'

// The settings page renders every field of both settings schemas behind a single error boundary, so one field
// component throwing takes the whole page down. That is how a new-server seed carrying the wrong shape for
// adminLists made creating a server impossible while every other suite stayed green: nothing else opens this
// form, and the seed was cast rather than typed, so the compiler had nothing to say either.

test.describe('settings page', () => {
	test('the new managed server form renders', async ({ app, page }) => {
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
})
