import { expect, type Locator } from '@playwright/test'

// The "N matched layers" readout is the only thing in the layer-select dialog that says how many layers the
// constraints currently set match, so several tests read it. On its own it does not say whether it belongs to
// those constraints: a value can be left over from an earlier constraint whose query is still in flight, and a
// baseline read that way makes "wait for it to change" fire on the wrong transition and pass instantly.
//
// The table publishes `data-query-settled` for exactly this (see LayerTablePagination): true only once the
// answer on screen came from the input the constraints currently produce, which covers the query being in
// flight and the throttle window before it starts -- the whole window in which the readout is stale and
// nothing else says so. These take the dialog rather than the readout, because the readout unmounts while a
// query runs and a locator that matches nothing cannot be waited on.
const TIMEOUT_MS = 30_000

const pagination = (dialog: Locator) => dialog.locator('[data-tour="table-pagination"]')
const readout = (dialog: Locator) => dialog.getByText(/matched layers|No layers matched/)

async function settledValue(dialog: Locator) {
	return (await pagination(dialog).getAttribute('data-query-settled')) === 'true' ? await readout(dialog).textContent() : null
}

// the readout, once the table says it answers for the constraints currently set
export async function settledText(dialog: Locator) {
	await expect(pagination(dialog)).toHaveAttribute('data-query-settled', 'true', { timeout: TIMEOUT_MS })
	return (await readout(dialog).textContent())!
}

// the same, for a read taken after a constraint changed. `previous` must be the settled value from before it:
// waiting for "settled" and "different" together is what keeps the pre-change value from satisfying it during
// the window before the store has registered the new constraints at all. An unsettled table reads as the old
// value, so it keeps waiting rather than returning early.
export async function settledTextAfter(dialog: Locator, previous: string) {
	await expect.poll(async () => (await settledValue(dialog)) ?? previous, { timeout: TIMEOUT_MS, intervals: [100] }).not.toBe(previous)
	return (await readout(dialog).textContent())!
}
