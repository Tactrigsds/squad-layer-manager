import { createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
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

			// what remains repeats a faction (RGF) inside the repeat-rule window, so the app surfaces the warning and
			// asks for a second, deliberate save ("Save Anyway") rather than committing on the first click
			await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
			await expect(page.getByText('Repeats Detected')).toBeVisible()
			await page.getByRole('button', { name: /^(Save Anyway|Force Save)$/ }).click()

			// saved: the queue persists without the deleted item, and the app moves the game server onto
			// the new head
			const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 20_000 })
			expect(setNext.body).toContain('Sumari_Seed_v1')
			await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible()

			await app.waitFor(() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
					return list.length === 2 && list[0].layerId === LAYERS.sumariSeed
				} finally {
					db.close()
				}
			}, { label: 'saved queue without the deleted head' })
		} finally {
			await app.dispose()
		}
	})
})
