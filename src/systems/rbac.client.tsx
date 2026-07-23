import * as Obj from '@/lib/object'
import { useStable } from '@/lib/react'
import * as RSel from '@/lib/reselect'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as Messages from '@/messages'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import * as Zus from 'zustand'

export function handlePermissionDenied(res: RBAC.PermissionDeniedResponse) {
	UsersClient.invalidateLoggedInUser()
	toast.error(Messages.WARNS.permissionDenied(res))
}

export function usePermsCheck<T extends RBAC.PermissionType>(
	req: RBAC.PermitChecker<T> | RBAC.PermitChecker<T>[] | RBAC.PermissionReq<T>,
): RBAC.PermissionDeniedResponse | null {
	return ZusUtils.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.permsCheck(useStable(req)))
}

// the logged-in user's effective (non-negated) permissions, for the aggregate settings-access checks below
export function useSuspendableLoggedInUserPerms(): RBAC.Permission[] {
	return ZusUtils.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.loggedInUserPerms)
}

export type GlobalSettingsAccess = { canRead: boolean; write: RBAC.SettingsWriteAccess }
export function useGlobalSettingsAccess(): GlobalSettingsAccess {
	return ZusUtils.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.globalSettingsAccess)
}

export type ServerSettingsAccess = { canRead: boolean; write: RBAC.SettingsWriteAccess; sensitive: boolean }
export function useServerSettingsAccess(serverId: string): ServerSettingsAccess {
	return ZusUtils.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.serverSettingsAccess(serverId))
}

export function useUserDefinedRoles() {
	return useQuery(RPC.orpc.rbac.getUserDefinedRoles.queryOptions())
}

// the user's own roles. Can't be derived from their permissions' traces, since a role granting nothing appears in none
export function useMyRoles() {
	return useQuery(RPC.orpc.rbac.getMyRoles.queryOptions())
}

// roles the user doesn't hold but may simulate holding, along with the permissions each would grant
export type SimulatableRole = { role: RBAC.Role; perms: RBAC.TracedPermission[] }
export function useSimulatableRoles() {
	return useQuery(RPC.orpc.rbac.getSimulatableRoles.queryOptions())
}

// simulation can only ever narrow what the user can do: roles and permissions may be switched off, and roles may only
// be switched on when the server has vouched that they grant nothing the user doesn't already have.
export type RbacStore = {
	simulate: boolean
	setSimulate: (simulate: boolean) => void
	disabledRoles: RBAC.Role[]
	disableRole: (role: RBAC.Role) => void
	enableRole: (role: RBAC.Role) => void
	// simulatable roles the user has opted into, carrying the perms the server attributed to them
	addedRoles: SimulatableRole[]
	addRole: (added: SimulatableRole) => void
	removeRole: (role: RBAC.Role) => void
	// permissions switched off individually, independent of the roles granting them
	disabledPerms: RBAC.Permission[]
	disablePerm: (perm: RBAC.Permission) => void
	enablePerm: (perm: RBAC.Permission) => void
}

export const RbacStore = Zus.createStore<RbacStore>((set, get) => ({
	simulate: false,
	setSimulate: (simulate: boolean) => {
		if (!simulate) {
			set({ simulate, disabledRoles: [], addedRoles: [], disabledPerms: [] })
			return
		}
		set({ simulate })
	},

	disabledRoles: [],
	disableRole: (roleToDisable) => {
		const disabledRoles = get().disabledRoles
		if (disabledRoles.some(r => Obj.deepEqual(roleToDisable, r))) return
		set({ disabledRoles: [...disabledRoles, roleToDisable] })
	},
	enableRole: (role) => set({ disabledRoles: get().disabledRoles.filter(r => !Obj.deepEqual(r, role)) }),

	addedRoles: [],
	addRole: (added) => {
		const addedRoles = get().addedRoles
		if (addedRoles.some(a => Obj.deepEqual(a.role, added.role))) return
		set({ addedRoles: [...addedRoles, added], disabledRoles: get().disabledRoles.filter(r => !Obj.deepEqual(r, added.role)) })
	},
	removeRole: (role) => set({ addedRoles: get().addedRoles.filter(a => !Obj.deepEqual(a.role, role)) }),

	disabledPerms: [],
	disablePerm: (perm) => {
		const disabledPerms = get().disabledPerms
		if (disabledPerms.some(p => RBAC.isSamePerm(p, perm))) return
		set({ disabledPerms: [...disabledPerms, Obj.selectProps(perm, ['type', 'scope', 'args'])] })
	},
	enablePerm: (perm) => set({ disabledPerms: get().disabledPerms.filter(p => !RBAC.isSamePerm(p, perm)) }),
}))

export namespace Sel {
	// indirected rather than passed straight in: users.client and this module import each other, so reading
	// UsersClient.Sel at module-init time would depend on which of the two the bundler evaluates first
	const loggedInUser = (...args: [user: RBAC.UserWithRbac, rbacStore: RbacStore]) => UsersClient.Sel.loggedInUser(...args)

	export const permsCheck = RSel.memoizeFactory(
		<T extends RBAC.PermissionType>(req: RBAC.PermitChecker<T> | RBAC.PermitChecker<T>[] | RBAC.PermissionReq<T>) =>
			RSel.createDeepSelector([loggedInUser], (user) => RBAC.tryDenyPermissionsForRbacUser(user, req)),
	)

	export const loggedInUserPerms = RSel.createDeepSelector(
		[loggedInUser],
		(user): RBAC.Permission[] => RBAC.fromTracedPermissions(user.perms),
	)

	export const globalSettingsAccess = RSel.createDeepSelector(
		[loggedInUserPerms],
		(perms): GlobalSettingsAccess => ({
			canRead: RBAC.canReadGlobalSettings(perms),
			write: RBAC.globalSettingsWriteAccess(perms),
		}),
	)

	export const serverSettingsAccess = RSel.memoizeFactory((serverId: string) =>
		RSel.createDeepSelector([loggedInUserPerms], (perms): ServerSettingsAccess => ({
			canRead: RBAC.canReadServerSettings(perms, serverId),
			write: RBAC.serverSettingsWriteAccess(perms, serverId),
			sensitive: RBAC.canWriteSensitiveServerSettings(perms, serverId),
		}))
	)
}
