/**
 * Queue reads and edits. dispatchOp is the same op path the web client goes through, so a plugin's
 * edits are ordinary edits. Lifecycle, sync and the router stay with the host.
 */
import type * as L from '@/models/layer'
import * as LayerQueueSys from '@/systems/layer-queue.server'
import type * as PluginsSys from '@/systems/plugins.server'

export { dispatchOp, getSavedBackburner, getSavedQueue, getSlmUpdatesEnabled } from '@/systems/layer-queue.server'
export type { QueueEntry } from '@/systems/layer-queue.server'

/**
 * Rewrites the saved queue. `mutate` gets the current entries and returns the ones it wants, in order: an
 * entry passed through keeps its original item, so its vote config, tags and notes survive, and a bare layer
 * id becomes a new item attributed to `userId`.
 *
 * Refuses with `err:unsaved-edits` when anyone has edits open rather than resetting over them. Discarding an
 * admin's draft is not a plugin's call; say so and try again later.
 *
 * Items it adds are sourced to the calling plugin, so the queue names the plugin that put a layer there. It
 * needs no user: a plugin acts on its own initiative, and nothing here is a person.
 */
export async function editSaved(
	ctx: PluginsSys.ServerCtx<any>,
	mutate: (entries: LayerQueueSys.QueueEntry[]) => (LayerQueueSys.QueueEntry | L.LayerId)[],
) {
	// ServerCtx names only the domains slm/* exposes functions over, and the queue's save path reaches the
	// vote payload, which is not one of them. The runtime object is the whole managed server (see
	// plugins.server ServerCtx), so it is there; only the type declines to say so.
	return await LayerQueueSys.editSaved(
		ctx as unknown as Parameters<typeof LayerQueueSys.editSaved>[0],
		{ source: { type: 'plugin', pluginId: ctx.plugin.id } },
		mutate,
	)
}
