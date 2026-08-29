/**
 * The permission vocabulary, for a plugin that guards its own commands and rpc.
 *
 * `perm` builds one requirement, `permReq('any' | 'all', [...])` combines several. A server-scoped permission
 * carries the server it applies to, so a grant on one server never satisfies a check against another:
 *
 * ```ts
 * RBAC.perm('squad-server:end-match', { serverId: ctx.serverId })
 * ```
 *
 * The check itself is in slm/systems/rbac. Nothing here reads any state.
 */
export { describePermit, perm, permReq } from '@/rbac.models'
export type {
	GlobalPermissionType,
	Permission,
	PermissionDeniedResponse,
	PermissionReq,
	PermissionType,
	PermitChecker,
	ServerPermissionType,
} from '@/rbac.models'
