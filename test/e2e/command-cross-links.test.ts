import { expect, test } from './fixtures'

// The two pages build each other's fragment ids independently -- CMDH.commandsPageAnchor here, the settings form's
// idPrefix plus the dotted path there -- so a rename on either side leaves a link that lands nowhere without failing
// anything. This walks the round trip and checks each hop actually marked its target.
test.describe('command cross-links', () => {
	test('a command links to its settings and back', async ({ app, page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/commands'))

		const entry = page.locator('[id="section:general/command:help"]')
		await expect(entry).toBeVisible({ timeout: 20_000 })
		await entry.getByRole('link', { name: 'settings' }).click()

		const setting = page.locator('[id="setting:commands.help"]')
		await expect(setting).toBeVisible({ timeout: 20_000 })
		await expect(setting).toHaveAttribute('data-anchor-highlight', 'true')

		await setting.getByRole('link', { name: 'commands' }).click()

		await expect(entry).toBeVisible({ timeout: 20_000 })
		await expect(entry).toHaveAttribute('data-anchor-highlight', 'true')
	})
})
