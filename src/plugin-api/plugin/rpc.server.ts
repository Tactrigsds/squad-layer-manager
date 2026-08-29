import { type AnyRouter, os as orpcOs } from '@orpc/server'

import type * as PLG from '@/models/plugins.models'
import * as PluginsSys from '@/systems/plugins.server'

/**
 * An oRPC builder whose procedures receive this plugin's per-server ctx. Build the plugin's router
 * with it and export the router's type: the client is created from that type, so nothing on the
 * client is annotated by hand.
 *
 * ```ts
 * const os = Rpc.os<typeof manifest>()
 * export const router = { things: os.input(z.object({})).handler(({ context }) => read(context)) }
 * ```
 *
 * A handler that is an async generator is a stream, reached from the client through Rpc.stores; a
 * plain one is reached through Rpc.client.
 *
 * `context` also carries the signed-in user who made the call. The host authorizes nothing beyond site
 * access, so a procedure that acts on the server must check them itself: see slm/systems/rbac.
 */
export function os<M extends PLG.Manifest<any>>() {
	return orpcOs.$context<PluginsSys.RpcCtx<M>>()
}

/** Registers the plugin's router. Unregistered when the plugin stops. */
export function register<M extends PLG.Manifest<any>>(ctx: PluginsSys.Ctx<M>, router: AnyRouter) {
	PluginsSys.registerRouter(ctx, router)
}
