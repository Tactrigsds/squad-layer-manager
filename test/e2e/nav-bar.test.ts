import type { TestUser } from '../harness/app-fixture'
import { createAppFixture } from '../harness/app-fixture'
import { expect, sharedAppTest, test } from './fixtures'

// The nav bar's permission-gated affordances. The Settings link is the interesting one: it is shown when the user can
// reach anything on that page at all -- the server registry, the global settings, or one server's settings -- so a
// user who can see the dashboard and nothing else must not be offered it.

const VIEWER: TestUser = { discordId: 900000000000000051n, username: 'test-nav-viewer' }

test.describe('nav bar', () => {
	test('withholds the Settings link, and names what a restricted user does and does not hold', async ({ page }) => {
		const app = await createAppFixture({
			users: [VIEWER],
			globalSettings: (settings) => {
				settings.rbac.roles['dashboard-only'] = {
					// site:authorized is what lets the session exist at all; squad-server:view gets them the dashboard.
					// nothing here grants any settings access, nor the server registry
					permissions: ['site:authorized', 'squad-server:view'],
					globalSettingsGrants: [],
					serverSettingsGrants: [],
					serverGrants: [],
					assignments: {
						discordRoleIds: [],
						discordUserIds: [String(VIEWER.discordId)],
						everyMember: false,
						ingameAdminLists: [],
						adminListGroups: [],
					},
				}
			},
		})
		try {
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
		} finally {
			await app.dispose()
		}
	})

	sharedAppTest('offers the Settings link to a user who can reach it', async ({ page }) => {
		await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
	})

	// The picker offers every locale this build carries a catalogue for, plus following the browser. With only
	// English shipped that is a two-item menu, which is the honest rendering of what is available.
	sharedAppTest('offers a language, following the browser until one is picked', async ({ page }) => {
		await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
		await page.getByLabel('User menu').click()
		await page.getByRole('menuitem', { name: 'Language' }).click()

		const automatic = page.getByRole('menuitemradio', { name: 'Automatic' })
		await expect(automatic).toBeVisible()
		await expect(automatic).toHaveAttribute('aria-checked', 'true')
		// named in its own language, which is what a reader who cannot read the current one needs
		await expect(page.getByRole('menuitemradio', { name: 'English' })).toBeVisible()
	})
})
