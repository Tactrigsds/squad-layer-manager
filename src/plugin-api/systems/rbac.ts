import * as RBAC_Msgs from '@/messages/rbac.messages'
import type * as Msgs from '@/models/messages.models'
import type * as SM from '@/models/squad.models'
import type * as RBAC from '@/rbac.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Rbac from '@/systems/rbac.server'

/**
 * Authorization, checked where the identity is: against the player who typed a command, or against the
 * signed-in user behind an rpc call. The host does not gate a plugin's commands for it, because what a
 * command requires can depend on the arguments it was given -- which is also why SLM's own timeout and queue
 * commands check inside their handlers rather than in the dispatcher.
 *
 * Both return the denial, or null when the caller may proceed. Report it with `describe`, which renders it in
 * the server's own language.
 *
 * ```ts
 * handler: async (ctx, input) => {
 *   const denial = await Rbac.checkPlayer(ctx, input.player, RBAC.perm('squad-server:end-match', { serverId: ctx.serverId }))
 *   if (denial) return Rbac.describe(ctx, denial)
 *   ...
 * }
 * ```
 */

type Req<T extends RBAC.PermissionType> = RBAC.PermitChecker<T> | RBAC.PermitChecker<T>[] | RBAC.PermissionReq<T>

/** What the player is entitled to on this server, including anything their linked SLM account carries. */
export async function checkPlayer<T extends RBAC.PermissionType>(
	ctx: PluginsSys.ServerCtx<any>,
	player: SM.Player,
	req: Req<T>,
): Promise<RBAC.PermissionDeniedResponse | null> {
	return await Rbac.tryDenyPermissionsForPlayer({ ...ctx, player }, req)
}

/** What the signed-in user who made this rpc call is entitled to. Only available on an rpc procedure's ctx. */
export async function checkCaller<T extends RBAC.PermissionType>(
	ctx: PluginsSys.RpcCtx<any>,
	req: Req<T>,
): Promise<RBAC.PermissionDeniedResponse | null> {
	return await Rbac.tryDenyPermissionsForUser(ctx, req)
}

export function describe(ctx: Msgs.Ctx, denial: RBAC.PermissionDeniedResponse): string {
	return ctx.tr.text(RBAC_Msgs.permissionDenied(denial))
}
