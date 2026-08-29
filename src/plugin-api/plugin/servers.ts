import type * as PLG from '@/models/plugins.models'
import * as PluginsSys from '@/systems/plugins.server'

/**
 * Runs `cb` once per managed server: those running now, and any that appear later. A throwing `cb` is logged
 * and does not stop the other servers.
 *
 * `ctx.cleanup` there is scoped to the (plugin, server) pair and runs when that server goes down or the plugin
 * stops, whichever comes first. The `ctx.cleanup` on the activate ctx is the plugin's own, which outlives any
 * one server.
 */
export function setup<M extends PLG.Manifest<any>>(ctx: PluginsSys.Ctx<M>, cb: (ctx: PluginsSys.ServerCtx<M>) => void) {
	PluginsSys.registerServerSetup(ctx, cb as PluginsSys.ServerSetupFn)
}
