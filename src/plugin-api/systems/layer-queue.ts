/**
 * Queue reads and edits. dispatchOp is the same op path the web client goes through, so a plugin's
 * edits are ordinary edits. Lifecycle, sync and the router stay with the host.
 */
import type * as L from '@/models/layer.models'
import type * as SLL from '@/models/shared-layer-list.models'
import * as LayerQueue from '@/systems/layer-queue.server'
import type * as PluginsSys from '@/systems/plugins.server'

export { getSavedBackburner, getSavedQueue, getSlmUpdatesEnabled } from '@/systems/layer-queue.server'

type DispatchArgs = Parameters<typeof LayerQueue.dispatchOp>

// `revert` undoes a user's own edits, so it has no place in a plugin's ops
export const dispatchOp: (ctx: DispatchArgs[0], op: Exclude<SLL.Operation, { op: 'revert' }>, opts?: DispatchArgs[2]) => Promise<void> =
	LayerQueue.dispatchOp

/**
 * Resolves once nobody has unsaved queue edits open, straight away when nobody has. Pass it as a blocked job's
 * unblock after an edit is refused with `err:unsaved-edits`.
 */
export async function editsSettled(ctx: PluginsSys.ServerCtx<any>): Promise<void> {
	// as editSaved: the runtime object is the whole managed server, and only ServerCtx's type leaves the queue out
	await LayerQueue.editsSettled(ctx as unknown as Parameters<typeof LayerQueue.editsSettled>[0])
}
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
	mutate: (entries: LayerQueue.QueueEntry[]) => (LayerQueue.QueueEntry | L.LayerId)[],
) {
	// ServerCtx names only the domains slm/* exposes functions over, and the queue's save path reaches the
	// vote payload, which is not one of them. The runtime object is the whole managed server (see
	// plugins.server ServerCtx), so it is there; only the type declines to say so.
	return await LayerQueue.editSaved(
		ctx as unknown as Parameters<typeof LayerQueue.editSaved>[0],
		{ source: { type: 'plugin', pluginId: ctx.plugin.id } },
		mutate,
	)
}
