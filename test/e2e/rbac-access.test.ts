import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { role } from '../harness/arrange'
import { expect, test } from './fixtures'

// What a restricted user is shown, against one app holding both sides of the console line. The Settings
// link is shown when the user can reach anything on that page at all, so a user who can see the dashboard
// and nothing else must not be offered it. squad-server:view-console is deliberately separate from
// squad-server:view, because the console discloses player ids, IPs and admin chat -- these tests are how
// the separation stays real rather than nominal.

const VIEWER: TestUser = { discordId: 900000000000000051n, username: 'test-nav-viewer' }
const READER: TestUser = { discordId: 900000000000000052n, username: 'test-console-reader' }

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		users: [VIEWER, READER],
		globalSettings: (settings) => {
			// site:authorized is what lets the session exist at all; squad-server:view gets them the dashboard.
			// nothing here grants any settings access, the server registry, or the console.
			settings.rbac.roles['dashboard-only'] = role(['site:authorized', 'squad-server:view'], { users: [VIEWER] })
			settings.rbac.roles['console-reader'] = role(['site:authorized', 'squad-server:view', 'squad-server:view-console'], {
				users: [READER],
			})
		},
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

test.describe('a dashboard-only user', () => {
	test('is withheld the Settings link, and shown what they do and do not hold', async ({ page }) => {
		await page.goto(app.loginUrl(VIEWER))
		// they really are on the dashboard, so the missing link below is about permissions and not a dead session
		await expect(page.getByRole('heading', { name: 'Match History' })).toBeVisible({ timeout: 30_000 })
		await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0)

		await page.getByLabel('User menu').click()
		await page.getByRole('menuitem', { name: 'Permissions' }).click()
		const dialog = page.getByRole('dialog', { name: 'User Permissions' })

		// the role they hold, with the permissions attributed to it
		await expect(dialog.getByText('dashboard-only')).toBeVisible()
		await expect(dialog.getByText('squad-server:view')).toBeVisible()

		// the roles they don't hold are listed too, which is what makes the dialog a complete picture
		await expect(dialog.getByText('You have every role.')).toHaveCount(0)

		await dialog.getByRole('tab', { name: 'All Permissions' }).click()
		// the flat permission list, built from the base perms rather than the simulated ones
		await expect(dialog.getByRole('cell', { name: 'squad-server:view', exact: true })).toBeVisible()
		await expect(dialog.getByRole('heading', { name: "Permissions you don't have" })).toBeVisible()
		await expect(dialog.getByText('You have every permission.')).toHaveCount(0)
	})

	test('is withheld the server console', async ({ page }) => {
		await page.goto(app.loginUrl(VIEWER))
		// they really are on the dashboard: the denial below is about the console, not a broken session
		await expect(page.getByRole('heading', { name: 'Match History' })).toBeVisible({ timeout: 30_000 })

		await page.getByRole('button', { name: 'Server Actions' }).click()
		const item = page.getByRole('menuitem', { name: 'Server Console' })
		await expect(item).toBeVisible()
		await expect(item).toBeDisabled()

		// and the gate is not merely the disabled attribute: clicking it opens nothing
		await item.click({ force: true })
		await expect(page.getByRole('tabpanel', { name: /console output$/ })).toHaveCount(0)
	})
})

test.describe('a console-reader user', () => {
	test('is granted the console by the permission alone', async ({ page }) => {
		await page.goto(app.loginUrl(READER))
		await expect(page.getByRole('heading', { name: 'Match History' })).toBeVisible({ timeout: 30_000 })

		await page.getByRole('button', { name: 'Server Actions' }).click()
		await page.getByRole('menuitem', { name: 'Server Console' }).click()
		const output = page.getByRole('tabpanel', { name: /console output$/ })
		await expect(output).toBeVisible({ timeout: 20_000 })
		await expect(output.getByText('rcon <-').first()).toBeVisible({ timeout: 30_000 })
	})
})
