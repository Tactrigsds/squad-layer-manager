import type { Page } from '@playwright/test'

import { LAYERS, queue } from '../harness/arrange'
import { gotoReady } from '../harness/ready'
import { rearrange } from '../harness/rearrange'
import { expect, sharedAppTest as test } from './fixtures'

// On a phone, each open overlay holds a history entry, so back closes the top overlay rather than leaving the page.

test.use({ viewport: { width: 390, height: 800 } })

const overlayDepth = (page: Page) => page.evaluate(() => (history.state?.__slmOverlay?.depth as number | undefined) ?? 0)

async function openPoolConfig(page: Page) {
	await page.getByRole('button', { name: 'Pool Configuration' }).click()
	const window = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Pool Configuration' }) })
	await expect(window).toBeVisible({ timeout: 20_000 })
	await expect.poll(() => overlayDepth(page)).toBe(1)
	return window
}

test.describe('back on a phone', () => {
	test('closes a draggable window and keeps the page', async ({ page }) => {
		const window = await openPoolConfig(page)
		const url = page.url()

		await page.goBack()
		await expect(window).toBeHidden()
		expect(page.url()).toBe(url)
		expect(await overlayDepth(page)).toBe(0)
	})

	test('closes nested overlays one at a time, top first', async ({ page }) => {
		const window = await openPoolConfig(page)
		const url = page.url()
		await window.getByRole('combobox').first().click()
		const sheet = page.locator('[data-combobox-sheet]')
		await expect(sheet).toBeVisible()
		await expect.poll(() => overlayDepth(page)).toBe(2)

		await page.goBack()
		await expect(sheet).toBeHidden()
		await expect(window).toBeVisible()
		expect(await overlayDepth(page)).toBe(1)

		await page.goBack()
		await expect(window).toBeHidden()
		expect(page.url()).toBe(url)
	})

	test('leaves no entry behind an overlay closed from inside the app', async ({ page }) => {
		const window = await openPoolConfig(page)
		await window.getByRole('button', { name: 'Close window' }).click()
		await expect(window).toBeHidden()
		await expect.poll(() => overlayDepth(page)).toBe(0)

		// the entries stay in step: the next overlay opens one entry deep, and back closes it
		const reopened = await openPoolConfig(page)
		await page.goBack()
		await expect(reopened).toBeHidden()
		expect(await overlayDepth(page)).toBe(0)
	})

	test('with unsaved queue edits, closing a dialog or switching tabs does not ask to discard them', async ({ app, page }) => {
		const confirms: string[] = []
		page.on('dialog', (dialog) => {
			confirms.push(dialog.message())
			void dialog.dismiss()
		})
		await rearrange(app, { layerQueue: queue(LAYERS.harjuRaas) })
		await gotoReady(page, app.loginUrl(), { signals: ['layer-engine'] })
		await page.getByRole('button', { name: 'Start Editing' }).click()

		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })
		const heading = dialog.getByRole('heading', { name: 'Add Layers' })
		await expect(heading).toBeVisible()
		await expect.poll(() => overlayDepth(page)).toBe(1)
		await dialog.getByRole('checkbox').nth(1).click()
		await dialog.getByRole('button', { name: /^Continue with/ }).click()
		await dialog.getByRole('button', { name: /^Submit/ }).click()
		await expect(heading).toBeHidden()
		await expect.poll(() => overlayDepth(page)).toBe(0)
		await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled()

		await page.getByRole('button', { name: /Teams$/ }).click()
		await expect(page).toHaveURL(/tab=teams/)
		expect(confirms).toEqual([])
	})
})
