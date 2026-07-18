import * as FB from '@/models/filter-builders'
import { createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, queue, selectableFilter } from '../harness/arrange'
import { expect, test } from './fixtures'

// Generating a vote is the one path where the app picks the layers rather than the admin, so the pool
// config is the only thing keeping the choices playable. This drives the dialog end to end: what it
// generates, and what lands in the queue when it's submitted.

test.describe('generating a vote', () => {
	test('draws choices from the pool and adds them to the queue as a vote', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			filters: [filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]))],
			serverSettings: (settings) => {
				selectableFilter(settings.queue.mainPool, 'raas-only')
				settings.queue.mainPool.repeatRules = []
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Gen Vote' }).click()
			const dialog = page.getByRole('dialog', { name: 'Generate Vote' })

			// generation queries under the same applied filters the dialog shows, so the pool's filter is on
			await expect(dialog.getByRole('checkbox', { name: 'RAAS Only' })).toHaveAttribute('aria-checked', 'true')

			// exact, or this also matches the per-choice 'Generate this choice' buttons
			await dialog.getByRole('button', { name: 'Generate', exact: true }).click()

			const choices = dialog.getByRole('listitem')
			await expect(choices).toHaveCount(3)
			// every choice came out of the pool the filter defines...
			await expect(choices.filter({ hasText: /_RAAS_v\d/ })).toHaveCount(3)

			// ...and Map is a unique choice constraint by default, so no two choices share one
			const maps = (await choices.allInnerTexts()).map((text) => /(\w+?)_RAAS_v\d/.exec(text)?.[1])
			expect(new Set(maps).size).toBe(3)

			await dialog.getByRole('button', { name: 'Submit' }).click()
			await expect(dialog).toBeHidden()

			// the vote goes in as one queue item holding the three choices
			const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
			const voteItem = queuePanel.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Vote' }) })
			await expect(voteItem).toHaveCount(1)
			await expect(voteItem.getByRole('listitem')).toHaveCount(3)

			await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
			const saved = await app.waitFor(() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId?: string; choices?: unknown[] }[]
					return list.length === 2 && list[0].choices?.length === 3 ? list : null
				} finally {
					db.close()
				}
			}, { label: 'saved queue with the generated vote' })
			expect(saved[1].layerId).toBe(LAYERS.harjuRaas)
		} finally {
			await app.dispose()
		}
	})

	// the generation weights (globalSettings.layerGeneration) are the other half of what shapes a generated
	// choice, and they take a long path to get here: global settings -> public config -> the client's query
	// worker, which does the weighted picking. Gamemode is safe to assert on because only Map has to be
	// unique across choices (V.GenVote.DEFAULT_CHOICE_COMPARISONS).
	test('weights the columns it picks by the configured generation weights', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			globalSettings: (settings) => {
				// unlisted values weigh LC.DEFAULT_GENERATION_WEIGHT (0.1), so Invasion outweighs every other
				// gamemode by four orders of magnitude: drawing anything else is a ~0.04% event per choice
				settings.layerGeneration = {
					pickOrder: ['Gamemode'],
					weights: { Gamemode: [{ value: 'Invasion', weight: 1000 }] },
					matchupWeights: { AllianceMatchup: [], FactionMatchup: [], UnitMatchup: [], FactionUnitMatchup: [] },
				}
			},
			serverSettings: (settings) => {
				// no pool filter: the weights, not a filter, have to be what narrows the gamemode
				settings.queue.mainPool.repeatRules = []
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Gen Vote' }).click()
			const dialog = page.getByRole('dialog', { name: 'Generate Vote' })
			await dialog.getByRole('button', { name: 'Generate', exact: true }).click()

			const choices = dialog.getByRole('listitem')
			await expect(choices).toHaveCount(3)
			await expect(choices.filter({ hasText: /_Invasion_v\d/ })).toHaveCount(3)
		} finally {
			await app.dispose()
		}
	})

	// a matchup weighs the two teams as an unordered pair, which is the half of generation that neither a column
	// weight nor a filter can express: it has to hold whichever team ends up fielding which faction
	test('weights the faction matchup it picks, in either team order', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			globalSettings: (settings) => {
				settings.layerGeneration = {
					pickOrder: ['FactionMatchup'],
					weights: {},
					matchupWeights: {
						AllianceMatchup: [],
						// Unlisted pairings weigh LC.DEFAULT_GENERATION_WEIGHT (0.1) EACH, and weights are normalized
						// against the sum of what's in the pool -- not against the largest one. With 17 factions there
						// are ~136 other pairings, so what this competes with is their total (~13.6), not 0.1. At
						// weight 1000 that left each draw ~1.3% likely to miss, i.e. ~4% over three draws: measured at
						// 2 failures in 60 runs before this was raised. The margin has to cover the whole pool.
						FactionMatchup: [{ teams: ['ADF', 'RGF'], weight: 1_000_000 }],
						UnitMatchup: [],
						FactionUnitMatchup: [],
					},
				}
			},
			serverSettings: (settings) => {
				settings.queue.mainPool.repeatRules = []
			},
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Gen Vote' }).click()
			const dialog = page.getByRole('dialog', { name: 'Generate Vote' })
			await dialog.getByRole('button', { name: 'Generate', exact: true }).click()

			const choices = dialog.getByRole('listitem')
			await expect(choices).toHaveCount(3)
			// team order is whatever the layer has, so assert on the pairing rather than on which side is which
			await expect(choices.filter({ hasText: 'ADF' }).filter({ hasText: 'RGF' })).toHaveCount(3)
		} finally {
			await app.dispose()
		}
	})
})
