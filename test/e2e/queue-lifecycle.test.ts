import * as FB from '@/models/filter-builders'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, layerText, queue, selectableFilter } from '../harness/arrange'
import { savedQueue } from '../harness/inspect'
import { expect, test } from './fixtures'

// One queue, followed through its whole life against a single app: rendered as seeded, edited and
// discarded, edited and saved, consumed by a map roll, refilled by a generated vote, and the vote
// configured. Each test hands the next its starting state, so the order is the scenario.

const MATCHES_POOL = '✅'
const MISSES_POOL = '❌'

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.skorpoRaas),
		filters: [
			// the Collection pin keeps mod layers (which spell their gamemode unpredictably) out of generation
			filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS'), FB.eq('Collection', 'OWI')]), {
				emoji: MATCHES_POOL,
				alertMessage: 'In the RAAS pool',
				invertedEmoji: MISSES_POOL,
				invertedAlertMessage: 'Not in the RAAS pool',
			}),
		],
		serverSettings: (settings) => {
			selectableFilter(settings.queue.mainPool, 'raas-only', { indicate: 'both' })
			settings.queue.mainPool.repeatRules = []
		},
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

test.describe('the queue through its lifecycle', { tag: '@firefox' }, () => {
	test('renders the seeded queue in order, and keeps the game server on its head', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })
		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })

		// the layer names the app renders for the ids we seeded, in the order we seeded them
		await expect(queuePanel.getByText('Gorodok_RAAS_v1')).toBeVisible()
		await expect(queuePanel.getByText('Sumari_Seed_v1')).toBeVisible()
		await expect(queuePanel.getByText('Skorpo_RAAS_v1')).toBeVisible()

		// the fixture starts the server in the steady state SLM maintains: its next layer is the head
		// of the queue. The app has nothing to correct, so it issues no set-next -- asserting the
		// server's state rather than a command is what makes that meaningful.
		expect(app.emu.world.nextLayer?.layer).toBe('Gorodok_RAAS_v1')
	})

	test('leaving the dashboard with a draft nobody else holds warns first, then discards it', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })

		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		await page.getByRole('button', { name: 'Start Editing' }).click()
		await queuePanel
			.getByRole('listitem')
			.filter({ hasText: layerText('Gorodok_RAAS_v1') })
			.getByRole('button', { name: 'Delete' })
			.click()
		await expect(queuePanel.getByRole('listitem')).toHaveCount(2)

		// the draft dies with the editing session, so navigating out asks before it does
		const prompts: string[] = []
		page.on('dialog', (dialog) => {
			prompts.push(dialog.message())
			void dialog.accept()
		})
		await page.getByRole('link', { name: 'Filters' }).click()
		await expect(page).toHaveURL(/\/filters/)
		expect(prompts).toEqual([expect.stringContaining('unsaved edits')])
		await expect(page.getByText('Your unsaved edits have been discarded')).toBeVisible()

		// and it really is gone server-side: the deleted item is back on the way in
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })
		await expect(queuePanel.getByRole('listitem').filter({ hasText: layerText('Gorodok_RAAS_v1') })).toBeVisible()
	})

	test('deleting the head, saving, and pushing the new head to the game server', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })

		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const items = queuePanel.getByRole('listitem')
		await page.getByRole('button', { name: 'Start Editing' }).click()

		// the edit is local until saved: the list drops the item, but the server still has it queued
		await items
			.filter({ hasText: layerText('Gorodok_RAAS_v1') })
			.getByRole('button', { name: 'Delete' })
			.click()
		await expect(items).toHaveCount(2)
		await expect(queuePanel.getByText('Gorodok_RAAS_v1')).toBeHidden()
		expect(app.emu.world.nextLayer?.layer).toBe('Gorodok_RAAS_v1')

		// deleting only took layers away, so the save commits on the first click instead of asking for a
		// deliberate "Save Anyway"
		await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
		await expect(page.getByText('Repeats Detected')).toHaveCount(0)

		// saved: the queue persists without the deleted item, and the app moves the game server onto
		// the new head
		const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 20_000 })
		expect(setNext.body).toContain('Sumari_Seed_v1')
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible()

		await app.waitFor(
			() => {
				const list = savedQueue(app)
				return list.length === 2 && list[0].layerId === LAYERS.sumariSeed
			},
			{ label: 'saved queue without the deleted head' },
		)
	})

	test('a map roll consumes the head and pushes the next one', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		await expect(queuePanel.getByText('Sumari_Seed_v1')).toBeVisible()

		// the save above put the server on Sumari, so that is what this roll plays
		app.emu.rcon.commandLog.length = 0
		app.emu.world.endMatch()
		app.emu.world.startNewGame()
		const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 25_000 })
		expect(setNext.body).toContain('Skorpo')

		await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })
		await expect(queuePanel.getByText('Sumari_Seed_v1')).toBeHidden()
	})

	test('generates a vote from the pool and saves it into the queue', async ({ page }) => {
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

		// a generated choice is indicated against the same filters as any other layer: it came out of the pool,
		// so it indicates as a match, not as a miss
		const indicators = choices.getByRole('button', { name: 'Layer indicators' })
		await expect(indicators).toHaveCount(3)
		await expect(indicators.filter({ hasText: MATCHES_POOL })).toHaveCount(3)
		await expect(indicators.filter({ hasText: MISSES_POOL })).toHaveCount(0)

		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()

		// the vote goes in as one queue item holding the three choices
		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const voteItem = queuePanel.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Vote' }) })
		await expect(voteItem).toHaveCount(1)
		await expect(voteItem.getByRole('listitem')).toHaveCount(3)

		await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
		const saved = await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId?: string; choices?: unknown[] }[]
					return list.length === 2 && list[0].choices?.length === 3 ? list : null
				} finally {
					db.close()
				}
			},
			{ label: 'saved queue with the generated vote' },
		)
		expect(saved[1].layerId).toBe(LAYERS.skorpoRaas)
	})

	// the vote item's config popover holds a pending config that is only committed by its own Save, so closing
	// it has to discard what was typed rather than leave it to be picked up the next time it opens
	test('a vote config is discarded when its popover closes, and kept when saved', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const voteItem = queuePanel.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Vote' }) })
		const duration = page.getByLabel('Vote Duration (seconds)')

		await voteItem.getByRole('button', { name: 'Configure vote' }).click()
		const initialDuration = await duration.inputValue()
		await duration.fill('91')
		await page.keyboard.press('Escape')
		await expect(duration).toBeHidden()

		// reopening reads the item's own config, not the edit that was abandoned
		await voteItem.getByRole('button', { name: 'Configure vote' }).click()
		await expect(duration).toHaveValue(initialDuration)

		await duration.fill('92')
		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await expect(duration).toBeHidden()

		await voteItem.getByRole('button', { name: 'Configure vote' }).click()
		await expect(duration).toHaveValue('92')
	})
})
