import type { Locator } from '@playwright/test'

import * as FB from '@/models/filter-builders'

import { createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, queue, selectableFilter } from '../harness/arrange'
import { expect, test } from './fixtures'

// The pool filter is seeded asynchronously (the panel waits for filter entities over the websocket), so the count
// readout first shows a real, larger number for the unconstrained query -- matching /\d+ matched layers/ does not
// mean the baseline is the pool's. The query pipeline additionally throttles at 500ms, so the constrained result
// can land a full throttle window later; the stability window here has to clear that comfortably.
const STABLE_READS = 4
const READ_INTERVAL_MS = 400

async function settledText(locator: Locator) {
	let previous: string | null = null
	let agreements = 0
	await expect
		.poll(
			async () => {
				// the readout unmounts while a query is in flight, so a missing element counts as "not settled"
				const current = (await locator.count()) === 1 ? await locator.textContent() : null
				agreements = current !== null && current === previous ? agreements + 1 : 0
				previous = current
				return agreements
			},
			{ timeout: 30_000, intervals: [READ_INTERVAL_MS] },
		)
		.toBeGreaterThanOrEqual(STABLE_READS)
	return previous!
}

// The applied-filters panel renders two kinds of control from one filter list: the ones the pool config
// pins (its pool filter and its default-selectable filters) and the "extras" a user pulls in themselves.
// What must not drift is which filters land in which bucket -- a pinned filter offered as an extra would
// let the user add a second, independently-toggled control for a constraint that is already applied.

const POOL_FILTER = 'raas-only'
const PINNED_FILTER = 'seed-only'
const EXTRA_FILTER = 'narva-only'

function fixture() {
	return createAppFixture({
		layerQueue: queue(LAYERS.harjuRaas),
		filters: [
			filter(POOL_FILTER, 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
			filter(PINNED_FILTER, 'Seed Only', FB.and([FB.eq('Gamemode', 'Seed')])),
			filter(EXTRA_FILTER, 'Narva Only', FB.and([FB.eq('Map', 'Narva')])),
		],
		serverSettings: (settings) => {
			const pool = settings.queue.mainPool
			pool.poolFilter = { filterId: POOL_FILTER, mode: 'include' }
			// pinned but off: Seed contradicts the RAAS pool, and an empty result set would make the
			// count assertions below pass for the wrong reason
			selectableFilter(pool, PINNED_FILTER, { applyAs: 'disabled' })
		},
	})
}

test.describe('applied filters', () => {
	// the pool's own filters are already rendered as pinned controls, so offering them again in the
	// extras picker would produce two controls for one constraint
	test('the extras picker offers only filters the pool does not already pin', async ({ page }) => {
		const app = await fixture()
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })
			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Add Layers' }).click()
			const dialog = page.getByRole('dialog', { name: 'Add Layers' })

			// both pinned controls render, which is what makes their absence from the picker meaningful
			await expect(dialog.getByRole('checkbox', { name: 'RAAS Only' })).toBeVisible()
			await expect(dialog.getByRole('checkbox', { name: 'Seed Only' })).toBeVisible()

			await dialog.getByRole('button', { name: 'Edit extra filters' }).click()
			const options = page.getByRole('listbox')
			await expect(options.getByRole('option', { name: 'Narva Only' })).toBeVisible()
			await expect(options.getByRole('option', { name: 'RAAS Only' })).toHaveCount(0)
			await expect(options.getByRole('option', { name: 'Seed Only' })).toHaveCount(0)
		} finally {
			await app.dispose()
		}
	})

	// an extra arrives disabled and only constrains the query once switched on, so the two steps are
	// asserted separately: adding one must not silently narrow the results
	test('an added extra filter constrains the query only once enabled', async ({ page }) => {
		const app = await fixture()
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })
			await page.getByRole('button', { name: 'Start Editing' }).click()
			await page.getByRole('button', { name: 'Add Layers' }).click()
			const dialog = page.getByRole('dialog', { name: 'Add Layers' })

			// the pinned control only renders once its filter entity has arrived, which is what gates the pool
			// entering the query at all. Necessary but not sufficient -- the count it produces lands later still
			await expect(dialog.getByRole('checkbox', { name: 'RAAS Only' })).toBeVisible()
			const matchedCount = dialog.getByText(/matched layers|No layers matched/)
			const poolOnlyCount = await settledText(matchedCount)
			expect(poolOnlyCount).toMatch(/\d+ matched layers/)

			await dialog.getByRole('button', { name: 'Edit extra filters' }).click()
			await page.getByRole('listbox').getByRole('option', { name: 'Narva Only' }).click()
			await page.keyboard.press('Escape')

			// it renders as a control of its own, off, and the result set is untouched
			const extraControl = dialog.getByRole('checkbox', { name: 'Narva Only' })
			await expect(extraControl).toBeVisible()
			await expect(extraControl).toHaveAttribute('aria-checked', 'false')
			await expect(matchedCount).toHaveText(poolOnlyCount!)

			await extraControl.click()
			await expect(extraControl).toHaveAttribute('aria-checked', 'true')
			await expect(matchedCount).not.toHaveText(poolOnlyCount!)
			await expect(dialog.getByRole('row').filter({ hasText: 'Narva' }).first()).toBeVisible()
		} finally {
			await app.dispose()
		}
	})
})
