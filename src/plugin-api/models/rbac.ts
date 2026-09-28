/**
 * The permission vocabulary, for a plugin that guards its own commands and rpc.
 *
 * `perm` builds one permission, and `Req` combines them into a requirement. A server-scoped permission carries the
 * server it applies to, so a grant on one server never satisfies a check against another:
 *
 * ```ts
 * RBAC.Req.any(RBAC.perm('squad-server:end-match', { serverId }), Perms.roll(serverId))
 * ```
 *
 * `Access` declares what a procedure or command requires, for the host to check before it runs. The check itself
 * is in slm/systems/rbac. Nothing here reads any state.
 */
export { Access, describePermit, perm, Req } from '@/rbac.models'
export type {
	GlobalPermissionType,
	Permission,
	PermissionDeniedResponse,
	PermissionType,
	ReqInput,
	ServerPermissionType,
} from '@/rbac.models'
