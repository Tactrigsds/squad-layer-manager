import type * as Cleanup from '@/lib/cleanup'
import type * as PLG from '@/models/plugins.models'
import * as PluginsSys from '@/systems/plugins.server'

// Runs cb once per managed server, for the servers running now and any that appear later. `cleanup`
// is scoped to the (plugin, server) pair: it runs when that server goes down or the plugin stops,
// whichever comes first.
export function setup<M extends PLG.Manifest<any>>(
	ctx: PluginsSys.Ctx<M>,
	cb: (ctx: PluginsSys.ServerCtx<M>, cleanup: Cleanup.Tasks) => void,
) {
	PluginsSys.registerServerSetup(ctx, cb as PluginsSys.ServerSetupFn)
}
