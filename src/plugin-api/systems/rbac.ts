import * as RBAC_Msgs from '@/messages/rbac.messages'
import type * as Msgs from '@/models/messages.models'
import type * as SM from '@/models/squad.models'
import type * as RBAC from '@/rbac.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Rbac from '@/systems/rbac.server'

/**
 * Authorization a handler does for itself, for what its declared access cannot say up front: what the arguments
 * of a command decide, or what depends on state the handler loads. Checked where the identity is: against the
 * player who typed a command, or against the signed-in user behind an rpc call.
 *
 * Both return the denial, or null when the caller may proceed. Report it with `describe`, which renders it in
 * the server's own language.
 *
 * ```ts
 * handler: async (ctx, input) => {
 *   const denial = await Rbac.checkPlayer(ctx, input.player, RBAC.Req.timeout(ctx.serverId, durationMs))
 *   if (denial) return Rbac.describe(ctx, denial)
 *   ...
 * }
 * ```
 */

/** What the player is entitled to on this server, including anything their linked SLM account carries. */
export async function checkPlayer(
	ctx: PluginsSys.ServerCtx<any>,
	player: SM.Player,
	req: RBAC.ReqInput,
): Promise<RBAC.PermissionDeniedResponse | null> {
	return await Rbac.tryDenyPermissionsForPlayer({ ...ctx, player }, req)
}

/** What the signed-in user who made this rpc call is entitled to. Only available on an rpc procedure's ctx. */
export async function checkCaller(ctx: PluginsSys.RpcCtx<any>, req: RBAC.ReqInput): Promise<RBAC.PermissionDeniedResponse | null> {
	return await Rbac.tryDenyPermissionsForUser(ctx, req)
}

export function describe(ctx: Msgs.Ctx, denial: RBAC.PermissionDeniedResponse): string {
	return ctx.tr.text(RBAC_Msgs.permissionDenied(denial))
}
