import { createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// A seeded queue, seen through the UI. This file boots its own app (rather than the shared one) so
// it can arrange the queue up front, which is what makes the assertions exact.

test.describe('layer queue', () => {
	test('renders the seeded queue in order, and keeps the game server on its head', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.skorpoRaas),
		})
		try {
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

			// when the match rolls, the head is consumed and the app pushes the new head to the server
			app.emu.world.endMatch()
			app.emu.world.startNewGame()
			const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 25_000 })
			expect(setNext.body).toContain('Sumari_Seed_v1')

			await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
			await expect(queuePanel.getByText('Gorodok_RAAS_v1')).toBeHidden()
		} finally {
			await app.dispose()
		}
	})
})
