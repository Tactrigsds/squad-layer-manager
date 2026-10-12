import * as Rx from '@/lib/rxjs'
// Client half of the per-filter shared draft. Subscribing is what provisions the session on the server, so
// opening the stream early (the route loader does) is also how a filter page is preloaded.
import type * as FE from '@/models/filter-edit.models'
import type * as F from '@/models/filter.models'
import * as RPC from '@/orpc.client'

export function watchUpdates$(filterId: F.FilterEntityId, handle?: (update: FE.Update) => void) {
	return RPC.observe(`filterEdit.watchUpdates.${filterId}`, () => RPC.orpc.filterEdit.watchUpdates.call(filterId), {
		apply: handle ? Rx.tap(handle) : undefined,
	})
}

export async function dispatchOps(filterId: F.FilterEntityId, ops: FE.Op[]) {
	return await RPC.orpc.filterEdit.dispatchOps.call({ filterId, ops })
}

// -------- text editor split --------

const ERRORS_FRACTION_KEY = 'slm:filterEditor:errorsFraction'
// the share of the text editor's width given to the errors pane
export const ERRORS_FRACTION = { min: 0.15, max: 0.75, default: 0.35 }

export function clampErrorsFraction(fraction: number) {
	return Math.min(ERRORS_FRACTION.max, Math.max(ERRORS_FRACTION.min, fraction))
}

export function loadErrorsFraction(): number {
	try {
		const stored = localStorage.getItem(ERRORS_FRACTION_KEY)
		const raw = stored === null ? Number.NaN : Number(stored)
		if (!Number.isFinite(raw)) return ERRORS_FRACTION.default
		return clampErrorsFraction(raw)
	} catch {
		return ERRORS_FRACTION.default
	}
}

export function saveErrorsFraction(fraction: number) {
	try {
		localStorage.setItem(ERRORS_FRACTION_KEY, fraction.toFixed(3))
	} catch {
		// a browser with storage denied still resizes, it just does not remember
	}
}
