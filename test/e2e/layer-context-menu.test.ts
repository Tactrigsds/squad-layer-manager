import { expect, sharedAppTest as test } from './fixtures'

// The layer actions are shared between the queue's layer display and the match history rows, and the queue
// item carries a menu of its own. The interesting case is the overlap: a right-click on the layer inside a
// queue item has to reach exactly one of the two menus.

test.describe('the layer context menu', () => {
	test('right-clicking a queued layer offers the layer actions, not the item actions', async ({ page }) => {
		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const item = queuePanel.getByRole('listitem').first()
		await expect(item).toBeVisible({ timeout: 20_000 })

		await item
			.getByText(/^\w+_\w+_v\d+$/)
			.first()
			.click({ button: 'right' })

		await expect(page.getByRole('menuitem', { name: 'Show details' })).toBeVisible()
		await expect(page.getByRole('menuitem', { name: 'Show scores' })).toBeVisible()
		await expect(page.getByRole('menuitem', { name: 'Open in SquadCalc' })).toBeVisible()
		// the item's menu stays shut: the layer display claims this right-click
		await expect(page.getByRole('menuitem', { name: 'Clone' })).toHaveCount(0)

		await page.getByRole('menuitem', { name: 'Copy...' }).hover()
		await expect(page.getByRole('menuitem', { name: 'Copy layer id' })).toBeVisible()
		await expect(page.getByRole('menuitem', { name: 'Copy AdminSetNextLayer command' })).toBeVisible()

		await page.keyboard.press('Escape')
	})

	test('right-clicking a queue item away from its layer still opens the item actions', async ({ page }) => {
		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const item = queuePanel.getByRole('listitem').first()
		await expect(item).toBeVisible({ timeout: 20_000 })

		// the item number, left of the layer display
		await item.click({ button: 'right', position: { x: 4, y: 8 } })

		await expect(page.getByRole('menuitem', { name: 'Clone' })).toBeVisible()
		await expect(page.getByRole('menuitem', { name: 'Show details' })).toHaveCount(0)

		await page.keyboard.press('Escape')
	})

	test('the current match row heads the layer actions with a Layer label, apart from the server actions', async ({ page }) => {
		// dnd-kit marks the row aria-disabled while it isn't draggable, so the right-click goes to the layer cell
		const layerCell = page.getByRole('row', { name: /Harju_RAAS_v1/ }).getByText('Harju_RAAS_v1')
		await expect(layerCell).toBeVisible({ timeout: 20_000 })
		await layerCell.click({ button: 'right' })

		// this row acts on the match too, so a heading says which entries are about the layer
		await expect(page.getByRole('menuitem', { name: 'Server Console' })).toBeVisible()
		await expect(page.getByRole('menu').getByText('Layer', { exact: true })).toBeVisible()
		await expect(page.getByRole('menuitem', { name: 'Show details' })).toBeVisible()
		await expect(page.getByRole('menuitem', { name: 'Open in SquadCalc' })).toBeVisible()

		await page.getByRole('menuitem', { name: 'Copy...' }).hover()
		await expect(page.getByRole('menuitem', { name: 'Copy history entry id' })).toBeVisible()

		await page.keyboard.press('Escape')
	})

	test('show details opens the layer info window on the details tab', async ({ page }) => {
		const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
		const item = queuePanel.getByRole('listitem').first()
		await expect(item).toBeVisible({ timeout: 20_000 })

		await item
			.getByText(/^\w+_\w+_v\d+$/)
			.first()
			.click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Show details' }).click()

		await expect(page.getByRole('button', { name: 'Scores' })).toBeVisible({ timeout: 20_000 })
		await expect(page.getByText('Team 1 Vehicles')).toBeVisible()
	})
})
