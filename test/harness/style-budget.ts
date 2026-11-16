import { expect, type Page } from '@playwright/test'

// Holds an interaction to a style-recalc budget: the most elements any one style recalc may restyle while it runs.
// A count, unlike a duration, does not depend on how busy the machine is. docs/developers/style-invalidation.md
// describes what makes one DOM change restyle most of a page.
//
// Read from a DevTools trace, which only Chromium offers. In another browser the action runs unmeasured.

export type StyleCost = {
	// elements restyled by the largest single recalc
	maxElements: number
	totalElements: number
	recalcs: number
	recalcMs: number
}

// the recalc a DOM change schedules runs in the next frame, so two frames after the action lets it land in the trace
async function afterTwoFrames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

// Runs `action`, which must await the UI state it produces, and returns the style recalcs it caused.
export async function measureStyleCost(page: Page, action: () => Promise<void>): Promise<StyleCost | null> {
	if (page.context().browser()?.browserType().name() !== 'chromium') {
		await action()
		return null
	}
	const cdp = await page.context().newCDPSession(page)
	try {
		const events: { name: string; ph: string; dur?: number; args?: { elementCount?: number } }[] = []
		cdp.on('Tracing.dataCollected', (e) => events.push(...(e.value as unknown as typeof events)))
		const complete = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()))
		await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline'] }, transferMode: 'ReportEvents' })
		try {
			await action()
			await afterTwoFrames(page)
		} finally {
			await cdp.send('Tracing.end')
			await complete
		}
		const cost: StyleCost = { maxElements: 0, totalElements: 0, recalcs: 0, recalcMs: 0 }
		for (const e of events) {
			if (e.ph !== 'X' || e.name !== 'UpdateLayoutTree') continue
			const n = e.args?.elementCount ?? 0
			cost.recalcs++
			cost.totalElements += n
			cost.maxElements = Math.max(cost.maxElements, n)
			cost.recalcMs += (e.dur ?? 0) / 1000
		}
		return cost
	} finally {
		await cdp.detach()
	}
}

// Clears what the covered interactions cost when it was set (263 elements for a first settings edit, hover and focus
// included; 105 for a queue drag) and fails on the regressions they were fixed for (1,104 to 2,123 elements).
export const DEFAULT_MAX_ELEMENTS = 500

// Fails when any single style recalc during `action` restyles more than `maxElements` elements.
export async function expectStyleBudget(
	page: Page,
	action: () => Promise<void>,
	budget: { maxElements: number } = { maxElements: DEFAULT_MAX_ELEMENTS },
) {
	const cost = await measureStyleCost(page, action)
	if (!cost) return null
	expect(
		cost.maxElements,
		`a style recalc restyled ${cost.maxElements} elements, over the budget of ${budget.maxElements} ` +
			`(${cost.recalcs} recalcs, ${cost.totalElements} elements, ${cost.recalcMs.toFixed(1)}ms in all)`,
	).toBeLessThanOrEqual(budget.maxElements)
	return cost
}
