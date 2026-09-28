import type { AnyRouter } from '@orpc/server'

import type * as PLG from '@/models/plugins.models'
import * as PluginsSys from '@/systems/plugins.server'

/**
 * An oRPC builder whose procedures receive this plugin's per-server ctx. Build the plugin's router
 * with it and export the router's type: the client is created from that type, so nothing on the
 * client is annotated by hand.
 *
 * Every procedure declares what its caller needs in `.meta({ access })`, and the host checks it before
 * the handler runs. A refused call answers with the permission denial; a refused stream yields it and ends.
 * The host has already checked that the caller may view the server, so `Access.PUBLIC` means anyone who can.
 *
 * ```ts
 * const os = Rpc.os<typeof manifest>()
 * export const router = {
 *   things: os.meta({ access: RBAC.Access.PUBLIC }).input(z.object({})).handler(({ context }) => read(context)),
 *   roll: os
 *     .meta({ access: RBAC.Access.req(({ serverId }) => Perms.roll(serverId)) })
 *     .input(z.object({}))
 *     .handler(({ context }) => roll(context)),
 * }
 * ```
 *
 * A handler that is an async generator is a stream, reached from the client through Rpc.stores; a
 * plain one is reached through Rpc.client. `context` also carries the signed-in user who made the call.
 */
export function os<M extends PLG.Manifest<any>>() {
	return PluginsSys.procedureBuilder<M>()
}

/** Registers the plugin's router. Unregistered when the plugin stops. */
export function register<M extends PLG.Manifest<any>>(ctx: PluginsSys.Ctx<M>, router: AnyRouter) {
	PluginsSys.registerRouter(ctx, router)
}
