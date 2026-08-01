import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { expect, test } from './fixtures'

// Regression: switching servers left everything outside the route -- the picker's own label, and the actions in
// the Server Actions menu -- pointing at the server you had just left. The route stays matched across a server
// change and only its param moves, so the entry hook that used to set the selected server never fired again.
//
// It reached production because every fixture until now had exactly one server, which is the one arrangement
// where the bug cannot appear. One two-server app carries both tests.

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({ secondServer: true })
})

test.afterAll(async () => {
	await app?.dispose()
})

test.describe('switching servers', () => {
	test('takes the rest of the page with it', async ({ page }) => {
		const second = app.second!
		await page.goto(app.loginUrl())
		await expect(page.getByRole('heading', { name: 'Match History' })).toBeVisible({ timeout: 30_000 })

		// the picker names the server the page is showing, which starts as the default one
		const picker = page.getByRole('button', { name: 'Emulated Server' })
		await expect(picker).toBeVisible()

		await picker.click()
		await page.getByRole('menuitem', { name: second.displayName }).click()

		// the url follows...
		await expect(page).toHaveURL(new RegExp(`/servers/${second.serverId}$`))
		// ...and so does the picker, which is what the bug got wrong: it kept the previous server's name
		await expect(page.getByRole('button', { name: second.displayName })).toBeVisible({ timeout: 20_000 })
		await expect(page.getByRole('button', { name: 'Emulated Server', exact: true })).toHaveCount(0)
	})

	// the same staleness, one layer down: Server Actions read the selected server out of the same store, so before
	// the fix the menu on the new server's page was still acting on the old server
	test('points the server actions at the server now being shown', async ({ page }) => {
		const second = app.second!
		await page.goto(app.loginUrl(app.adminUser, `/servers/${second.serverId}`))
		await expect(page.getByRole('heading', { name: 'Match History' })).toBeVisible({ timeout: 30_000 })

		// arriving directly, the console opened from here is the second server's
		await page.getByRole('button', { name: 'Server Actions' }).click()
		await page.getByRole('menuitem', { name: 'Server Console' }).click()
		await expect(page.getByText(`Server console: ${second.serverId}`)).toBeVisible({ timeout: 20_000 })
		await page.getByRole('button', { name: 'Close' }).first().click()

		// and after switching away, it is the first server's rather than the one we left
		await page.getByRole('button', { name: second.displayName }).click()
		await page.getByRole('menuitem', { name: 'Emulated Server' }).click()
		await expect(page).toHaveURL(new RegExp(`/servers/${app.serverId}$`))

		await page.getByRole('button', { name: 'Server Actions' }).click()
		await page.getByRole('menuitem', { name: 'Server Console' }).click()
		await expect(page.getByText(`Server console: ${app.serverId}`)).toBeVisible({ timeout: 20_000 })
	})
})
