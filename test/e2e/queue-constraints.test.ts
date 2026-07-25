import * as FB from '@/models/filter-builders'
import { createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, layerTag, queue, queueItem, selectableFilter } from '../harness/arrange'
import { expect, test } from './fixtures'

// What a queued layer violates has to be visible on the item itself: the indicators are the only thing
// standing between an admin and saving a queue that repeats a map or leaves the pool. They come from two
// independent sources -- the pool's repeat rules and its filters -- so both are exercised here, on a queue
// arranged so that each item carries a different combination of them.

test.describe('queue item constraints', () => {
	test('indicates repeat-rule violations and filter matches on the items that carry them', async ({ page }) => {
		const app = await createAppFixture({
			// Gorodok twice, two apart: within the Map repeat rule's window of 4
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.gorodokAas),
			filters: [
				filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]), { alertMessage: 'RAAS layers are in the pool' }),
			],
			serverSettings: (settings) => {
				selectableFilter(settings.queue.mainPool, 'raas-only')
				// just the one rule, so an item's indicators are attributable to it and nothing else
				settings.queue.mainPool.repeatRules = [{ label: 'Map', field: 'Map', within: 4, autogen: true }]
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })

			const items = page.getByRole('tabpanel', { name: /^Queue/ }).getByRole('listitem')
			const indicators = (layerName: string) => items.filter({ hasText: layerName }).getByRole('button', { name: 'Layer indicators' })

			// the second Gorodok repeats the first, two matches later
			await indicators('Gorodok_AAS_v1').hover()
			const repeatTooltip = page.getByRole('tooltip')
			await expect(repeatTooltip).toContainText('Repeats Detected')
			await expect(repeatTooltip).toContainText('Map')
			await expect(repeatTooltip).toContainText('Gorodok was played 2 matches prior')
			// AAS is not RAAS: the pool filter doesn't match it, so it is not indicated as one that does
			await expect(repeatTooltip).not.toContainText('RAAS Only')

			// dismiss the open tooltip before opening the next, so the assertions below can't read this one
			await page.keyboard.press('Escape')
			await expect(page.getByRole('tooltip')).toHaveCount(0)

			// the first Gorodok is RAAS, so it matches the pool filter -- and nothing precedes it to repeat
			await indicators('Gorodok_RAAS_v1').hover()
			const filterTooltip = page.getByRole('tooltip')
			await expect(filterTooltip).toContainText('Matching Filters')
			await expect(filterTooltip).toContainText('RAAS Only')
			await expect(filterTooltip).toContainText('RAAS layers are in the pool')
			await expect(filterTooltip).not.toContainText('Repeats Detected')

			// Sumari matches nothing and repeats nothing, so it carries no indicator at all
			await expect(indicators('Sumari_Seed_v1')).toHaveCount(0)
		} finally {
			await app.dispose()
		}
	})

	test('warns before saving a queue that violates a repeat rule the pool warns on', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
			serverSettings: (settings) => {
				settings.queue.mainPool.repeatRules = [{ label: 'Map', field: 'Map', within: 4, warn: true }]
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Add Layers' }).click()
			const dialog = page.getByRole('dialog', { name: 'Add Layers' })

			// add a second Gorodok layer, which repeats the head
			await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
			await page.getByRole('option', { name: 'Gorodok_AAS_v1', exact: true }).click()
			await dialog.getByRole('row').filter({ hasText: 'Gorodok_AAS_v1' }).first().click()
			await dialog.getByRole('button', { name: 'Submit' }).click()
			await expect(dialog).toBeHidden()

			// the warnings are only as fresh as the item statuses, which the server recomputes for the edited
			// queue; the repeat showing up on the item it applies to is what says they have landed
			const items = page.getByRole('tabpanel', { name: /^Queue/ }).getByRole('listitem')
			await expect(items.filter({ hasText: 'Gorodok_RAAS_v1' }).getByRole('button', { name: 'Layer indicators' })).toBeVisible()

			// the first save attempt surfaces the warning instead of committing, and the button changes to
			// say that saving now means saving anyway
			await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
			await expect(page.getByText('Repeats Detected')).toBeVisible()
			const saveAnyway = page.getByRole('button', { name: 'Save Anyway' })
			await expect(saveAnyway).toBeVisible()

			await saveAnyway.click()
			await app.waitFor(
				() => {
					const db = app.readDb()
					try {
						const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
						const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
						// the row clicked in the table is whichever Gorodok AAS layer sorts first, so match the layer
						// rather than a particular faction matchup of it
						return list.length === 3 && list[0].layerId.startsWith('GD-AAS-')
					} finally {
						db.close()
					}
				},
				{ label: 'queue saved over the repeat warning' },
			)
		} finally {
			await app.dispose()
		}
	})

	// The counterpart to the test above: the same violating queue saves without a word once the offending item carries
	// a tag the pool skips warnings for. The indicator is deliberately left alone -- the exemption silences the warning,
	// it doesn't hide what the layer does.
	test("skips warnings for an item tagged with one of the pool's skipWarningsForTags", async ({ page }) => {
		const planned = layerTag('planned', 'aaaaaa')
		const app = await createAppFixture({
			layerQueue: [queueItem(LAYERS.gorodokRaas), queueItem(LAYERS.sumariSeed), queueItem(LAYERS.gorodokAas, { tags: [planned.id] })],
			globalSettings: (settings) => {
				settings.layerTags = [planned]
			},
			serverSettings: (settings) => {
				settings.queue.mainPool.repeatRules = [{ label: 'Map', field: 'Map', within: 4, warn: true }]
				settings.queue.mainPool.skipWarningsForTags = [planned.id]
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })

			const items = page.getByRole('tabpanel', { name: /^Queue/ }).getByRole('listitem')
			// the repeat is still detected and still indicated on the item; only the warning is suppressed
			await expect(items.filter({ hasText: 'Gorodok_AAS_v1' }).getByRole('button', { name: 'Layer indicators' })).toBeVisible()

			// warnings only surface for a queue this user has edited, so make one that violates nothing itself: Narva
			// repeats neither the queue nor the match the emulated server is playing
			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Add Layers' }).click()
			const dialog = page.getByRole('dialog', { name: 'Add Layers' })
			await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
			await page.getByRole('option', { name: 'Narva_RAAS_v1', exact: true }).click()
			await dialog.getByRole('row').filter({ hasText: 'Narva_RAAS_v1' }).first().click()
			await dialog.getByRole('button', { name: 'Submit' }).click()
			await expect(dialog).toBeHidden()
			// the added layer carries no indicator, so the only repeat in this queue is the tagged one
			const narva = items.filter({ hasText: 'Narva_RAAS_v1' })
			await expect(narva).toHaveCount(1)
			await expect(narva.getByRole('button', { name: 'Layer indicators' })).toHaveCount(0)

			// the save commits on the first attempt: had the tagged repeat still warned, this would have surfaced the
			// warning and waited for a second click instead
			await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
			await app.waitFor(
				() => {
					const db = app.readDb()
					try {
						const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
						const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
						return list.length === 4 && list.some((item) => item.layerId.startsWith('NV-RAAS-'))
					} finally {
						db.close()
					}
				},
				{ label: 'queue saved without a repeat warning' },
			)
			await expect(page.getByRole('button', { name: 'Save Anyway' })).toHaveCount(0)
			await expect(page.getByText('Repeats Detected')).toHaveCount(0)
		} finally {
			await app.dispose()
		}
	})

	// The exemption is only useful if an admin can set it up without editing settings by hand, so the pool
	// configuration window has to both render the control and persist what is picked in it.
	test('configures skipWarningsForTags from the pool configuration window', async ({ page }) => {
		const planned = layerTag('planned', 'aaaaaa')
		const app = await createAppFixture({
			globalSettings: (settings) => {
				settings.layerTags = [planned]
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('button', { name: 'Pool Configuration' })).toBeVisible({ timeout: 20_000 })
			await page.getByRole('button', { name: 'Pool Configuration' }).click()

			const section = page.getByRole('region', { name: 'Skip warnings for' })
			await expect(section).toBeVisible()
			await section.getByRole('button', { name: /add tag/i }).click()
			await page.getByRole('menuitem', { name: 'planned' }).click()
			await expect(section.getByText('planned')).toBeVisible()

			await page.getByRole('button', { name: 'Save Changes' }).click()
			await app.waitFor(
				() => {
					const db = app.readDb()
					try {
						const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(app.serverId) as { settings: string }
						const pool = JSON.parse(row.settings).json.queue.mainPool as { skipWarningsForTags?: string[] }
						return pool.skipWarningsForTags?.includes(planned.id) ?? false
					} finally {
						db.close()
					}
				},
				{ label: 'skipWarningsForTags persisted' },
			)
		} finally {
			await app.dispose()
		}
	})
})
