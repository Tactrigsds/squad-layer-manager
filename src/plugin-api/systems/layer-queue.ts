// queue reads and edits (dispatchOp is the same op path the web client goes through), plus the
// plugin post-roll reminder hook. Lifecycle, sync and the router stay with the host.
export { dispatchOp, getSavedBackburner, getSavedQueue, getSlmUpdatesEnabled } from '@/systems/layer-queue.server'

import type * as PLG from '@/models/plugins.models'
import * as LayerQueueSys from '@/systems/layer-queue.server'
import type * as PluginsSys from '@/systems/plugins.server'

// Runs after each roll as part of the post-roll announcement chain (only while reminders are
// enabled for the server), with the plugin's per-server ctx. Errors are isolated per task.
export function addPostRollReminder<M extends PLG.Manifest<any>>(
	ctx: PluginsSys.Ctx<M>,
	task: (ctx: PluginsSys.ServerCtx<M>) => Promise<void>,
) {
	LayerQueueSys.addPostRollTask(ctx.cleanup, (serverCtx) =>
		task({
			...serverCtx,
			plugin: ctx.plugin,
			log: ctx.log.child({ serverId: serverCtx.serverId }),
			cleanup: ctx.cleanup,
		}),
	)
}
