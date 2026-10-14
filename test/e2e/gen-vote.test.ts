import type { Page } from '@playwright/test'

import * as FB from '@/models/filter-builders.models'
import type * as LL from '@/models/layer-list.models'
import type * as RRS from '@/models/repeat-rulesets.models'
import * as SETTINGS from '@/models/settings.models'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, queue, selectableFilter } from '../harness/arrange'
import * as Dash from '../harness/dashboard'
import { rearrange } from '../harness/rearrange'
import { expect, test } from './fixtures'

// The generation weights (globalSettings.layerGeneration) take a long path to the Generate Vote dialog:
// global settings -> public config -> the client's query worker, which does the weighted picking. Each test
// re-arranges one app into its own weighting scheme, pool and rules, and loads the page after, so the client
// starts from that config. The dialog's basic flow -- generate from the pool, submit, save -- lives in
// queue-lifecycle.test.ts.

// the gamemodes of the layer data, less Invasion
const OTHER_GAMEMODES = [
	'AAS',
	'RAAS',
	'Seed',
	'Skirmish',
	'Insurgency',
	'TC',
	'Destruction',
	'Training',
	'FRAAS',
	'GLOP',
	'RINV',
	'Contention',
	'TDM',
	'KOTH',
	'RVAAS',
	'RAAS_PreCap',
	'Frontline',
	'AAS_PreCap',
	'RVAAS_PreCap',
]

const DEFAULT_LAYER_GENERATION = SETTINGS.parseGlobalSettings({}).data!.layerGeneration

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.harjuRaas),
		filters: [
			// mod layer names spell their gamemode unpredictably, so the weighted pools pin the vanilla collections
			filter('vanilla', 'Vanilla', FB.and([FB.eq('Collection', 'OWI')])),
			filter('three-maps', 'Three Maps', FB.and([FB.eq('Collection', 'OWI'), FB.inValues('Map', ['Gorodok', 'Narva', 'Sumari'])])),
		],
		repeatRules: [],
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

async function arrangeAndOpen(
	page: Page,
	opts: {
		layerQueue: LL.List
		layerGeneration: SETTINGS.GlobalSettings['layerGeneration']
		repeatRules: RRS.RepeatRuleConfig[]
		selectable: string
	},
) {
	await rearrange(app, {
		layerQueue: opts.layerQueue,
		repeatRules: opts.repeatRules,
		globalSettings: (settings) => {
			settings.layerGeneration = opts.layerGeneration
		},
		pool: (pool) => selectableFilter(pool, opts.selectable),
	})
	await page.goto(app.loginUrl())
	await expect(Dash.queueLabel(page, 'Queue (1)')).toBeVisible({ timeout: 20_000 })
	await page.getByRole('button', { name: 'Start Editing' }).click()
	await page.getByRole('button', { name: 'Gen Vote' }).click()
	return page.getByRole('dialog', { name: 'Generate Vote' })
}

test.describe('generation weights', () => {
	// Gamemode is safe to assert on because only Map has to be unique across choices
	// (V.GenVote.DEFAULT_CHOICE_COMPARISONS).
	test('weights the columns it picks by the configured generation weights', async ({ page }) => {
		const dialog = await arrangeAndOpen(page, {
			layerQueue: queue(LAYERS.harjuRaas),
			// every other gamemode is listed at weight 0, so the draw cannot land outside Invasion. An unlisted one
			// would weigh LC.DEFAULT_GENERATION_WEIGHT (0.1) and win a draw now and then. A name the layer data lacks
			// is dropped from the weights. The weights, not a filter, have to be what narrows the gamemode.
			layerGeneration: {
				pickOrder: ['Gamemode'],
				weights: {
					Gamemode: [{ value: 'Invasion', weight: 1000 }, ...OTHER_GAMEMODES.map((value) => ({ value, weight: 0 }))],
				},
				matchupWeights: { AllianceMatchup: [], FactionMatchup: [], UnitMatchup: [], FactionUnitMatchup: [] },
			},
			repeatRules: [],
			selectable: 'vanilla',
		})
		await dialog.getByRole('button', { name: 'Generate', exact: true }).click()

		const choices = dialog.getByRole('listitem')
		await expect(choices).toHaveCount(3)
		await expect(choices.filter({ hasText: /_Invasion_v\d/ })).toHaveCount(3)
	})

	// a matchup weighs the two teams as an unordered pair, which is the half of generation that neither a column
	// weight nor a filter can express: it has to hold whichever team ends up fielding which faction
	test('weights the faction matchup it picks, in either team order', async ({ page }) => {
		const dialog = await arrangeAndOpen(page, {
			layerQueue: queue(LAYERS.harjuRaas),
			// mod layers bring thousands of pairings of their own, which together outweighed even 1,000,000 about once
			// in 900 draws (always to a GC mod layer). The vanilla pool holds ~136, and 3000 draws never missed.
			layerGeneration: {
				pickOrder: ['FactionMatchup'],
				weights: {},
				matchupWeights: {
					AllianceMatchup: [],
					// Unlisted pairings weigh LC.DEFAULT_GENERATION_WEIGHT (0.1) EACH, and weights are normalized
					// against the sum of what's in the pool, not against the largest one. What this competes with is
					// the total of every other pairing in the pool (~13.6 for the vanilla pool), not 0.1, so the
					// margin has to cover the whole pool.
					FactionMatchup: [{ teams: ['ADF', 'RGF'], weight: 1_000_000 }],
					UnitMatchup: [],
					FactionUnitMatchup: [],
				},
			},
			repeatRules: [],
			selectable: 'vanilla',
		})
		await dialog.getByRole('button', { name: 'Generate', exact: true }).click()

		const choices = dialog.getByRole('listitem')
		await expect(choices).toHaveCount(3)
		// team order is whatever the layer has, so assert on the pairing rather than on which side is which
		await expect(choices.filter({ hasText: 'ADF' }).filter({ hasText: 'RGF' })).toHaveCount(3)
	})
})

test.describe('repeat rules', () => {
	// Three maps for three choices that each need a different map, after a queue ending on one of them: hiding
	// repeats leaves one choice nothing to draw, and showing them forces Gorodok in, indicated as the repeat.
	test('hides repeats by default, and indicates them once shown', async ({ page }) => {
		const dialog = await arrangeAndOpen(page, {
			layerQueue: queue(LAYERS.gorodokRaas),
			layerGeneration: DEFAULT_LAYER_GENERATION,
			repeatRules: [{ label: 'Map', field: 'Map', within: 1, warn: false, indicate: true }],
			selectable: 'three-maps',
		})
		// after the queued Gorodok, so it is the layer the rule looks back on
		await dialog.getByRole('button', { name: 'Add to end' }).click()
		const hideRepeats = dialog.getByRole('checkbox', { name: 'Hide Repeats' })
		await expect(hideRepeats).toHaveAttribute('aria-checked', 'true')

		await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
		const choices = dialog.getByRole('listitem')
		await expect(choices.filter({ hasText: 'No suitable layer found' })).toHaveCount(1)
		await expect(choices.filter({ hasText: 'Narva_' })).toHaveCount(1)
		await expect(choices.filter({ hasText: 'Sumari_' })).toHaveCount(1)
		await expect(choices.filter({ hasText: 'Gorodok_' })).toHaveCount(0)

		await hideRepeats.click()
		await expect(hideRepeats).toHaveAttribute('aria-checked', 'false')
		await dialog.getByRole('button', { name: 'Regenerate All' }).click()
		const gorodok = choices.filter({ hasText: 'Gorodok_' })
		await expect(gorodok).toHaveCount(1)
		await gorodok.getByRole('button', { name: 'Layer indicators' }).hover()
		await expect(page.getByRole('tooltip')).toContainText('Map Gorodok repeats')
	})
})
