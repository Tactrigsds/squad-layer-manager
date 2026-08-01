import { expect, type Locator } from '@playwright/test'

// The "N matched layers" readout is the only thing in the layer-select dialog that says a query has answered
// for the constraints currently set, so several tests use it to know when it is safe to touch the filter menu
// (see the comment at the toggle in layer-select.test.ts for what goes wrong if they don't). Reading it once
// is not enough: a value can be left over from an earlier constraint whose query is still in flight, and a
// baseline read that way makes "wait for it to change" fire on the wrong transition and pass instantly.
// Only a value that holds still is one this dialog has settled on.
//
// The pool filter is also seeded asynchronously (the panel waits for filter entities over the websocket), so
// the readout first shows a real, larger number for the unconstrained query -- matching /\d+ matched layers/
// does not mean the baseline is the pool's. The query pipeline additionally throttles at 500ms, so the
// constrained result can land a full throttle window later; the stability window has to clear that comfortably.
const STABLE_READS = 4
const READ_INTERVAL_MS = 400

async function pollSettled(locator: Locator, reject: string | null) {
	let previous: string | null = null
	let agreements = 0
	let settled: string | null = null
	await expect
		.poll(
			async () => {
				// the readout unmounts while a query is in flight, so a missing element counts as "not settled"
				const current = (await locator.count()) === 1 ? await locator.textContent() : null
				agreements = current !== null && current !== reject && current === previous ? agreements + 1 : 0
				previous = current
				if (agreements >= STABLE_READS) settled = current
				return agreements
			},
			{ timeout: 30_000, intervals: [READ_INTERVAL_MS] },
		)
		.toBeGreaterThanOrEqual(STABLE_READS)
	return settled!
}

export function settledText(locator: Locator) {
	return pollSettled(locator, null)
}

// the settled value the readout reaches after a constraint changed, which `previous` must be the settled value
// from before it. Waiting for "settled" and "different" together is what keeps a stale intermediate value from
// satisfying either half on its own.
export function settledTextAfter(locator: Locator, previous: string) {
	return pollSettled(locator, previous)
}
