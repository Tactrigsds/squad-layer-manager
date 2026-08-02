import * as FB from '@/models/filter-builders'

import { createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, queue, selectableFilter } from '../harness/arrange'
import { expect, test } from './fixtures'

// The generation weights (globalSettings.layerGeneration) take a long path to the Generate Vote dialog:
// global settings -> public config -> the client's query worker, which does the weighted picking. Each
// weighting scheme is a different app config, so each test boots its own app. The dialog's basic flow --
// generate from the pool, submit, save -- lives in queue-lifecycle.test.ts.

test.describe('generation weights', () => {
	// Gamemode is safe to assert on because only Map has to be unique across choices
	// (V.GenVote.DEFAULT_CHOICE_COMPARISONS).
	test('weights the columns it picks by the configured generation weights', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas),
			// mod layer names spell their gamemode unpredictably, so the pool pins the vanilla collections; the
			// weights, not a filter, still have to be what narrows the gamemode
			filters: [filter('vanilla', 'Vanilla', FB.and([FB.eq('Collection', 'OWI')]))],
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
				selectableFilter(settings.queue.mainPool, 'vanilla')
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
