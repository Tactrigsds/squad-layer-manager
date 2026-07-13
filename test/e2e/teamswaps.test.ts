import { makePlayer } from '@/emulator'
import { createAppFixture } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// Swapping a player's team from the teams panel. The swap is an admin action against a live
// server, so it has to reach the game (AdminForceTeamChange over RCON), not just the UI's own state.

test.describe('teamswaps', () => {
	test('swapping a player now, from the teams panel', async ({ page }) => {
		const app = await createAppFixture({ layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed) })
		try {
			const player = makePlayer({ name: ' e2e_swapee', teamId: 2 })
			app.emu.world.connectPlayer(player)
			app.emu.world.connectPlayer(makePlayer({ name: ' e2e_bystander', teamId: 1 }))

			await page.goto(app.loginUrl())
			await page.getByRole('tab', { name: /^Teams \(2\)/ }).click({ timeout: 25_000 })

			const teamsPanel = page.getByRole('tabpanel', { name: /^Teams/ })
			const row = teamsPanel.getByRole('row', { name: /e2e_swapee/ })
			await expect(row).toBeVisible({ timeout: 20_000 })

			await row.click({ button: 'right' })
			await page.getByRole('menuitem', { name: 'Swap Now' }).click()
			// destructive actions ask first
			await page.getByRole('button', { name: 'Swap Now' }).click()

			// the game server actually moved them
			await app.waitFor(
				() => app.emu.rcon.commandLog.some((c) => c.body === `AdminForceTeamChange ${player.eos}`),
				{ label: 'AdminForceTeamChange for the player', timeoutMs: 20_000 },
			)
			expect(player.teamId).toBe(1)
		} finally {
			await app.dispose()
		}
	})
})
