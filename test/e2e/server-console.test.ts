import type { Page } from '@playwright/test'

import { makePlayer } from '@/emulator'

import { expect, sharedAppTest } from './fixtures'

// The console is the one view that claims to show what actually crossed the wire rather than what the app
// concluded from it, so these drive real traffic through the emulator and assert it comes out the other end.
// Who may open it at all is a security boundary, asserted in rbac-access.test.ts.

async function openConsole(page: Page) {
	await page.getByRole('button', { name: 'Server Actions' }).click()
	await page.getByRole('menuitem', { name: 'Server Console' }).click()
	const output = page.getByRole('tabpanel', { name: /console output$/ })
	await expect(output).toBeVisible({ timeout: 20_000 })
	return output
}

sharedAppTest.describe('server console', () => {
	sharedAppTest('shows the rcon commands and responses the app and the server actually exchange', async ({ page, app }) => {
		const output = await openConsole(page)

		// the app polls the server on a timer, so traffic arrives without the test provoking any. Both directions
		// are asserted: a console that only showed what we sent would hide half of every exchange.
		await expect(output.getByText(/^ListPlayers$/).first()).toBeVisible({ timeout: 30_000 })
		await expect(output.getByText(/Active Players/).first()).toBeVisible({ timeout: 30_000 })

		// direction is written from the game server's point of view: it receives our commands and sends replies
		await expect(output.getByText('rcon <-').first()).toBeVisible()
		await expect(output.getByText('rcon ->').first()).toBeVisible()

		// and it is the traffic this server really saw, not a plausible rendering of it
		expect(app.emu.rcon.commandLog.some((c) => c.body === 'ListPlayers')).toBe(true)
	})

	sharedAppTest('carries a player command through to its own channel', async ({ page, app }) => {
		const output = await openConsole(page)

		const talker = makePlayer({ name: ' e2e_talker', teamId: 1 })
		app.emu.world.connectPlayer(talker)
		await app.waitForRosterSync()
		app.emu.world.chat(talker, 'ChatAll', 'hello from the wire')

		// the unified tab carries everything, including what a player typed
		await expect(output.getByText('hello from the wire').first()).toBeVisible({ timeout: 30_000 })

		// and the channel filter narrows to it, attributed to whoever said it
		await page.getByRole('tab', { name: 'Player Commands' }).click()
		const commands = page.getByRole('tabpanel', { name: /Player Commands console output/ })
		await expect(commands.getByText('hello from the wire')).toBeVisible()
		await expect(commands.getByText(/ChatAll.*e2e_talker/)).toBeVisible()
		// the filter is exclusive: rcon traffic does not leak into the player channel
		await expect(commands.getByText('rcon <-')).toHaveCount(0)
	})

	sharedAppTest('hides the repeated polls and the tick rate until asked not to', async ({ page }) => {
		await openConsole(page)

		// the filter is on by default and says how much it is withholding, so it never silently swallows anything
		const hideNoise = page.getByRole('checkbox', { name: 'Hide noise' })
		await expect(hideNoise).toBeChecked()
		await expect(page.getByText(/Hide noise\s*\(\d+\)/)).toBeVisible({ timeout: 30_000 })

		// The tick rate heartbeat is the clearest noise there is. Established first with the filter off, so that
		// asserting its absence afterwards means it was withheld rather than that no log line had arrived yet.
		await page.getByRole('tab', { name: 'Logs' }).click()
		const logs = page.getByRole('tabpanel', { name: /Logs console output/ })
		const tickRate = logs.getByText(/Server Tick Rate/)

		await hideNoise.click()
		await expect(hideNoise).not.toBeChecked()
		await expect(tickRate.first()).toBeVisible({ timeout: 30_000 })

		await hideNoise.click()
		await expect(hideNoise).toBeChecked()
		await expect(tickRate).toHaveCount(0)
	})

	sharedAppTest('follows the tail until the reader scrolls away from it', async ({ page }) => {
		const output = await openConsole(page)
		const viewport = output.locator('[data-radix-scroll-area-viewport]')
		const distanceFromBottom = () => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
		const scrollHeight = () => viewport.evaluate((el) => el.scrollHeight)

		// the polls are what make the console outgrow its panel within the life of a test
		const hideNoise = page.getByRole('checkbox', { name: 'Hide noise' })
		await hideNoise.click()
		await expect.poll(scrollHeight, { timeout: 30_000 }).toBeGreaterThan(await viewport.evaluate((el) => el.clientHeight))
		await expect.poll(distanceFromBottom, { timeout: 30_000 }).toBeLessThan(16)

		// a deliberate scroll up hands the position back to the reader, and says how to give it up again
		await viewport.hover()
		await page.mouse.wheel(0, -600)
		const backToBottom = page.getByRole('button', { name: 'Scroll to bottom' })
		await expect(backToBottom).toBeVisible()
		const parked = await viewport.evaluate((el) => el.scrollTop)

		// traffic arriving while they read must not drag them back down
		const grown = await scrollHeight()
		await expect.poll(scrollHeight, { timeout: 30_000 }).toBeGreaterThan(grown)
		expect(await viewport.evaluate((el) => el.scrollTop)).toBe(parked)

		await backToBottom.click()
		await expect.poll(distanceFromBottom, { timeout: 30_000 }).toBeLessThan(16)
		await expect(backToBottom).toBeHidden()

		await hideNoise.click()
		await expect(hideNoise).toBeChecked()
	})
})
