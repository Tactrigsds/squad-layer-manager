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

	// A JSON-mode section renders no per-field anchors, so its TOC node has to collapse to a leaf. The TOC reads that
	// mode straight off the section frames now rather than being handed it down, and nothing else exercises the path.
	test('the table of contents follows a section between GUI and JSON mode', async ({ app, page }) => {
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
