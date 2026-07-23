import * as FB from '@/models/filter-builders'
import { createAppFixture, type TestUser } from '../harness/app-fixture'
import { filter, LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// The pool filter is the single definition of pool membership: it constrains what layer selection
// offers by default, and out-of-pool layers -- reachable by turning the pinned pool control off --
// can only be selected by users with queue:force-write. These are the two behaviors that would
// silently rot if the membership constraint and the row-disabling it drives ever diverged again.

const WRITER: TestUser = { discordId: 900000000000000021n, username: 'test-writer' }

test.describe('pool filter', () => {
	test('constrains selection to the pool; out-of-pool layers are viewable but unselectable without force-write', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			filters: [filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]))],
			serverSettings: (settings) => {
				settings.queue.mainPool.poolFilter = { filterId: 'raas-only', mode: 'include' }
			},
			// a user the permission system says yes to for editing but no to for force-write, which is
			// what makes "the row is disabled" mean something
			users: [WRITER],
			globalSettings: (settings) => {
				settings.rbac.roles['queue-writer'] = {
					// site:authorized is what lets the session exist at all; queue:write is the capability under test
					permissions: ['site:authorized', 'queue:write'],
					globalSettingsGrants: [],
					serverSettingsGrants: [],
					assignments: {
						discordRoleIds: [],
						discordUserIds: [String(WRITER.discordId)],
						everyMember: false,
						includeIngameAdmins: false,
						adminListGroups: [],
					},
				}
			},
		})
		try {
			await page.goto(app.loginUrl(WRITER))
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Add Layers' }).click()
			const dialog = page.getByRole('dialog', { name: 'Add Layers' })

			// the pool applies by default: the pinned control is on, and only pool layers are offered
			const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
			await expect(poolControl).toHaveAttribute('aria-checked', 'true')

			await dialog.getByRole('combobox', { name: 'Map' }).click()
			await page.getByRole('option', { name: 'Sumari', exact: true }).click()

			const rows = dialog.getByRole('row')
			await expect(rows.filter({ hasText: 'Sumari_RAAS_v1' }).first()).toBeVisible()
			await expect(rows.filter({ hasText: 'Sumari_Seed_v1' })).toHaveCount(0)

			// turning the pool off surfaces out-of-pool layers (see layer-select.test.ts for why the
			// count settling is what makes the filter menu answer for the new pool)
			const matchedCount = dialog.getByText(/matched layers|No layers matched/)
			const countWithPool = await matchedCount.textContent()
			await poolControl.click()
			await expect(poolControl).toHaveAttribute('aria-checked', 'false')
			await expect(matchedCount).not.toHaveText(countWithPool!)

			await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
			await page.getByRole('option', { name: 'Seed', exact: true }).click()
			await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('Seed')

			// the out-of-pool layer is visible but its row refuses selection: clicking it must not arm Submit
			const seedRow = rows.filter({ hasText: 'Sumari_Seed_v1' }).first()
			await expect(seedRow).toBeVisible()
			await seedRow.click()
			await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled()

			// positive control, so the assertion above can't pass for the wrong reason: an in-pool row
			// selected the same way does arm Submit
			await dialog.getByRole('combobox', { name: 'Gamemode' }).click()
			await page.getByRole('option', { name: 'RAAS', exact: true }).click()
			await expect(dialog.getByRole('combobox', { name: 'Gamemode' })).toHaveText('RAAS')
			const raasRow = rows.filter({ hasText: 'Sumari_RAAS_v1' }).first()
			await expect(raasRow).toBeVisible()
			await raasRow.click()
			await expect(dialog.getByRole('button', { name: 'Submit' })).toBeEnabled()
		} finally {
			await app.dispose()
		}
	})

	test('edit dialog applies the pool only when the edited layer is in it', async ({ page }) => {
		const app = await createAppFixture({
			// one in-pool and one out-of-pool queued layer, so both sides of the async membership check run
			layerQueue: queue(LAYERS.harjuRaas, LAYERS.sumariSeed),
			filters: [filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]))],
			serverSettings: (settings) => {
				settings.queue.mainPool.poolFilter = { filterId: 'raas-only', mode: 'include' }
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

			const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
			const items = queuePanel.getByRole('listitem')
			await page.getByRole('button', { name: 'Start Editing' }).click()

			// the in-pool layer: the membership check resolves and switches the pool on
			await items.filter({ hasText: 'Harju_RAAS_v1' }).getByRole('button', { name: 'Edit' }).click()
			const dialog = page.getByRole('dialog', { name: 'Edit Layer' })
			const poolControl = dialog.getByRole('checkbox', { name: 'RAAS Only' })
			await expect(poolControl).toHaveAttribute('aria-checked', 'true')
			await page.keyboard.press('Escape')
			// the dialog unmounts on close; its root is a zero-size positioning node, so visibility
			// assertions must target it existing (or its children), never the root's own visibility
			await expect(dialog).toHaveCount(0)

			// the out-of-pool layer: the pool stays off, so the layer being edited isn't filtered out of
			// its own dialog
			await items.filter({ hasText: 'Sumari_Seed_v1' }).getByRole('button', { name: 'Edit' }).click()
			await expect(dialog.getByRole('heading', { name: 'Edit Layer' })).toBeVisible()
			const rows = dialog.getByRole('row')
			await expect(rows.filter({ hasText: 'Sumari_Seed_v1' }).first()).toBeVisible()
			await expect(poolControl).toHaveAttribute('aria-checked', 'false')
		} finally {
			await app.dispose()
		}
	})
})
