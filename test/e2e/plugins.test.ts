import { expect, test } from './fixtures'

// The plugins settings section in a browser, driven against the builtin that every app ships with.
// The section renders whether or not it is reachable, so what is worth asserting here is the wiring
// around it: that the table of contents lists it and can navigate to it, that it follows the config
// editor between GUI and YAML the way a server section does, and that the switch actually stops the
// plugin. Installing a package needs an http origin and is covered in test/integration.

const PLUGIN = { id: 'balance-triggers', name: 'Balance Triggers' }

test.describe('plugins settings section', () => {
	test('lists the builtin, and its table of contents entry navigates to it', async ({ page, app }) => {
		await page.goto(app.loginUrl(app.adminUser, '/settings'))

		const entry = page.locator(`li[data-toc-id="section:plugin:${PLUGIN.id}"]`)
		await expect(entry).toHaveCount(1, { timeout: 20_000 })

		await entry.getByRole('link', { name: PLUGIN.name }).click()

		// navigating marks the target, which is what tells us the anchor resolved rather than silently
		// falling back to the top of the page
		const section = page.locator(`[id="section:plugin:${PLUGIN.id}"]`)
		await expect(section).toHaveAttribute('data-anchor-highlight', 'true')
		await expect(section).toBeInViewport()

		// the api range the manifest declares, beside the version, so an incompatible plugin reads as one
		await expect(section.getByText(/^slm api \^/)).toBeVisible()
		await expect(section.getByText(/^v\d+\.\d+\.\d+$/)).toBeVisible()
	})

	// The config editor's mode lives in a module store rather than component state precisely so the TOC can
	// see it: a YAML section renders no per-field anchors, so its node has to collapse to a leaf.
	test('the table of contents drops the plugin fields when its config switches to YAML', async ({ page, app }) => {
		await page.goto(app.loginUrl(app.adminUser, '/settings'))

		const mode = page.getByRole('group', { name: `${PLUGIN.name} configuration editor` })
		await expect(mode).toBeVisible({ timeout: 20_000 })
		// a node with children carries the expand/collapse control; a leaf renders a spacer instead
		const expander = page.locator(`li[data-toc-id="section:plugin:${PLUGIN.id}"] > div > button`)
		await expect(expander).toHaveCount(1)

		await mode.getByRole('button', { name: 'YAML', exact: true }).click()
		await expect(expander).toHaveCount(0)

		await mode.getByRole('button', { name: 'GUI', exact: true }).click()
		await expect(expander).toHaveCount(1)
	})

	// last: it leaves the plugin stopped, and the dashboard's alerts come from it
	test('the switch stops and starts the plugin', async ({ page, app }) => {
		await page.goto(app.loginUrl(app.adminUser, '/settings'))

		const section = page.locator(`[id="section:plugin:${PLUGIN.id}"]`)
		const toggle = section.getByRole('switch', { name: `${PLUGIN.name} enabled` })
		await expect(toggle).toBeVisible({ timeout: 20_000 })
		await expect(section.getByText('Running')).toBeVisible()

		await toggle.click()
		await expect(section.getByText('Stopped')).toBeVisible()
		// the status is the host's, read back over the plugin watch stream rather than set optimistically
		await expect(toggle).toHaveAttribute('aria-checked', 'false')

		await toggle.click()
		await expect(section.getByText('Running')).toBeVisible()
	})
})
