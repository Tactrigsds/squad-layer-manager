// Client half of the per-filter shared draft. Subscribing is what provisions the session on the server, so
// opening the stream early (the route loader does) is also how a filter page is preloaded.
import type * as FE from '@/models/filter-edit.models'
import type * as F from '@/models/filter.models'
import * as RPC from '@/orpc.client'

export function watchUpdates$(filterId: F.FilterEntityId) {
	return RPC.observe(`filterEdit.watchUpdates.${filterId}`, () => RPC.orpc.filterEdit.watchUpdates.call(filterId))
}

export async function dispatchOps(filterId: F.FilterEntityId, ops: FE.Op[]) {
	return await RPC.orpc.filterEdit.dispatchOps.call({ filterId, ops })
}
