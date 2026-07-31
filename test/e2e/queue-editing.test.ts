import { createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue, queueItem, voteQueueItem } from '../harness/arrange'
import { expect, test } from './fixtures'

// Editing the queue in the browser: the client applies each edit optimistically as an operation and
// only commits on save, so this is the path where an op that replays differently on the server shows
// up as a queue that disagrees with what the user saw.

test.describe('editing the queue', () => {
	test('deleting the head, saving, and pushing the new head to the game server', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.skorpoRaas),
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })

			const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
			const items = queuePanel.getByRole('listitem')
			await page.getByRole('button', { name: 'Start Editing' }).click()

			// the edit is local until saved: the list drops the item, but the server still has it queued
			await items.filter({ hasText: 'Gorodok_RAAS_v1' }).getByRole('button', { name: 'Delete' }).click()
			await expect(items).toHaveCount(2)
			await expect(queuePanel.getByText('Gorodok_RAAS_v1')).toBeHidden()
			expect(app.emu.world.nextLayer?.layer).toBe('Gorodok_RAAS_v1')

			// what remains still repeats a faction (RGF) inside the repeat-rule window, but it did so before the delete
			// too, on items this session never touched. Deleting only took repeats away, so the save commits on the
			// first click instead of asking for a deliberate "Save Anyway"
			await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
			await expect(page.getByText('Repeats Detected')).toHaveCount(0)

			// saved: the queue persists without the deleted item, and the app moves the game server onto
			// the new head
			const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 20_000 })
			expect(setNext.body).toContain('Sumari_Seed_v1')
			await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible()

			await app.waitFor(
				() => {
					const db = app.readDb()
					try {
						const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
						const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
						return list.length === 2 && list[0].layerId === LAYERS.sumariSeed
					} finally {
						db.close()
					}
				},
				{ label: 'saved queue without the deleted head' },
			)
		} finally {
			await app.dispose()
		}
	})

	test('leaving the dashboard with a draft nobody else holds warns first, then discards it', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.skorpoRaas),
		})
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })

			const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
			await page.getByRole('button', { name: 'Start Editing' }).click()
			await queuePanel.getByRole('listitem').filter({ hasText: 'Gorodok_RAAS_v1' }).getByRole('button', { name: 'Delete' }).click()
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
			await expect(queuePanel.getByRole('listitem').filter({ hasText: 'Gorodok_RAAS_v1' })).toBeVisible()
		} finally {
			await app.dispose()
		}
	})

	// the vote item's config popover holds a pending config that is only committed by its own Save, so closing
	// it has to discard what was typed rather than leave it to be picked up the next time it opens
	test('a vote config is discarded when its popover closes, and kept when saved', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: [voteQueueItem([LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.skorpoRaas]), queueItem(LAYERS.harjuRaas)],
		})
		try {
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
		} finally {
			await app.dispose()
		}
	})
})
