import { expect, type Page } from '@playwright/test'

// Holds an interaction to a style-recalc budget: how many elements that were already on the page any one style recalc
// may restyle while it runs. A count, unlike a duration, does not depend on how busy the machine is.
// docs/developers/style-invalidation.md describes what makes one DOM change restyle most of a page.
//
// Chrome counts an element it inserts as restyled, so opening a dialog of 2,000 elements restyles at least 2,000. The
// budget therefore applies to the largest recalc less every element the action inserted, which leaves what the change
// cost the rest of the page.
//
// Read from a DevTools trace, which only Chromium offers. In another browser the action runs unmeasured.

export type StyleCost = {
	// elements restyled by the largest single recalc
	maxElements: number
	// elements the action added to the page, descendants included
	insertedElements: number
	totalElements: number
	recalcs: number
	recalcMs: number
	layoutMs: number
	// paint, pre-paint and layerize
	paintMs: number
}

const PAINT_EVENTS = new Set(['Paint', 'PrePaint', 'Layerize'])

// the recalc a DOM change schedules runs in the next frame, so two frames after the action lets it land in the trace
async function afterTwoFrames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

type Counter = { observer: MutationObserver; inserted: number }
type CounterWindow = Window & { __styleBudgetCounter?: Counter }

async function startInsertCounter(page: Page) {
	await page.evaluate(() => {
		const counter: Counter = { observer: undefined!, inserted: 0 }
		const count = (records: MutationRecord[]) => {
			for (const r of records) {
				for (const n of r.addedNodes) if (n instanceof Element) counter.inserted += 1 + n.getElementsByTagName('*').length
			}
		}
		counter.observer = new MutationObserver(count)
		counter.observer.observe(document, { childList: true, subtree: true })
		;(window as CounterWindow).__styleBudgetCounter = counter
	})
}

async function stopInsertCounter(page: Page): Promise<number> {
	return page.evaluate(() => {
		const counter = (window as CounterWindow).__styleBudgetCounter
		if (!counter) return 0
		for (const r of counter.observer.takeRecords()) {
			for (const n of r.addedNodes) if (n instanceof Element) counter.inserted += 1 + n.getElementsByTagName('*').length
		}
		counter.observer.disconnect()
		delete (window as CounterWindow).__styleBudgetCounter
		return counter.inserted
	})
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
		await startInsertCounter(page)
		await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline'] }, transferMode: 'ReportEvents' })
		let insertedElements = 0
		try {
			await action()
			await afterTwoFrames(page)
		} finally {
			await cdp.send('Tracing.end')
			await complete
			insertedElements = await stopInsertCounter(page)
		}
		const cost: StyleCost = { maxElements: 0, insertedElements, totalElements: 0, recalcs: 0, recalcMs: 0, layoutMs: 0, paintMs: 0 }
		for (const e of events) {
			if (e.ph !== 'X') continue
			const ms = (e.dur ?? 0) / 1000
			if (e.name === 'Layout') cost.layoutMs += ms
			else if (PAINT_EVENTS.has(e.name)) cost.paintMs += ms
			if (e.name !== 'UpdateLayoutTree') continue
			const n = e.args?.elementCount ?? 0
			cost.recalcs++
			cost.totalElements += n
			cost.maxElements = Math.max(cost.maxElements, n)
			cost.recalcMs += ms
		}
		return cost
	} finally {
		await cdp.detach()
	}
}

// Clears what the covered interactions restyled when it was set (at most 194 elements already on the page, for closing
// a context menu) and fails on the regression a settings edit was fixed for (2,232 elements, 2,067 of them
// already on the page).
export const DEFAULT_MAX_ELEMENTS = 500

// Fails when any single style recalc during `action` restyles more than `maxElements` elements that were already on
// the page.
export async function expectStyleBudget(
	page: Page,
	action: () => Promise<void>,
	budget: { maxElements: number } = { maxElements: DEFAULT_MAX_ELEMENTS },
) {
	const cost = await measureStyleCost(page, action)
	if (!cost) return null
	const existing = Math.max(0, cost.maxElements - cost.insertedElements)
	expect(
		existing,
		`a style recalc restyled ${existing} elements that were already on the page, over the budget of ${budget.maxElements} ` +
			`(largest recalc ${cost.maxElements} elements, ${cost.insertedElements} inserted; ${cost.recalcs} recalcs, ` +
			`${cost.recalcMs.toFixed(1)}ms style, ${cost.layoutMs.toFixed(1)}ms layout, ${cost.paintMs.toFixed(1)}ms paint)`,
	).toBeLessThanOrEqual(budget.maxElements)
	return cost
}
