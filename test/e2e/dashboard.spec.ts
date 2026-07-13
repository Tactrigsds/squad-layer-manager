import { makePlayer } from '@/emulator'
import { expect, test } from './fixtures'

// Drives the real client against a real app instance backed by the squad server emulator.
// Selectors are role/label-based on purpose: a test that can't find an element is telling us the
// markup isn't semantic yet, which is a defect in its own right.

test.describe('server dashboard', () => {
	test('shows the current match and the layer queue', async ({ page, app }) => {
		await expect(page.getByRole('heading', { name: 'Match History' })).toBeVisible()

		// the emulator's current layer, surfaced by the app's own RCON poll
		await expect(page.getByRole('row', { name: /Harju_RAAS_v1/ })).toBeVisible()
		await expect(page.getByRole('row', { name: /In progress/ })).toBeVisible()

		// the app generates queue items on boot and pushes the first one to the server as next layer
		const queueTab = page.getByRole('tab', { name: /^Queue/ })
		await expect(queueTab).toHaveAttribute('aria-selected', 'true')

		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const firstItem = queuePanel.getByText(/^\w+_\w+_v\d+$/).first()
		await expect(firstItem).toBeVisible({ timeout: 20_000 })
		const queuedLayer = (await firstItem.textContent())!.trim()

		// asserted from the UI's current state outwards rather than from the first command the emulator
		// happened to receive: the queue can regenerate, which supersedes an earlier AdminSetNextLayer
		await expect.poll(
			() => app.emu.rcon.commandLog.some((c) => c.body.startsWith(`AdminSetNextLayer ${queuedLayer}`)),
			{ timeout: 20_000, message: `emulator never received AdminSetNextLayer for the queued layer ${queuedLayer}` },
		).toBe(true)
	})

	test('a player joining in game appears on the teams tab', async ({ page, app }) => {
		const player = makePlayer({ name: ' e2e_joiner', role: 'PLA_Rifleman_01' })
		app.emu.world.connectPlayer(player)

		// the roster reaches the UI through the app's ListPlayers poll, so the tab label counts them
		const teamsTab = page.getByRole('tab', { name: /^Teams \(1\)/ })
		await expect(teamsTab).toBeVisible({ timeout: 20_000 })

		await teamsTab.click()
		await expect(teamsTab).toHaveAttribute('aria-selected', 'true')
		await expect(page.getByRole('tabpanel', { name: /^Teams/ }).getByText('e2e_joiner')).toBeVisible()
	})

	test('the activity feed records what the emulated server did', async ({ page }) => {
		const feed = page.getByRole('region', { name: 'Server Activity' })
		await expect(feed).toBeVisible()
		// the app instance is shared across this file's tests, so the feed accumulates: assert an entry
		// exists rather than that it's the only one
		await expect(feed.getByText(/RCON connection established/i).first()).toBeVisible({ timeout: 20_000 })
		await expect(feed.getByText(/Next layer set to/i).first()).toBeVisible()
	})
})
