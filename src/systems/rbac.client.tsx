import * as Obj from '@/lib/object'
import { toast } from '@/lib/toast'
import * as Messages from '@/messages'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import React from 'react'
import * as Zus from 'zustand'

export function handlePermissionDenied(res: RBAC.PermissionDeniedResponse) {
	UsersClient.invalidateLoggedInUser()
	toast.error(Messages.WARNS.permissionDenied(res))
}

export function usePermsCheck<T extends RBAC.PermissionType>(
	req: RBAC.Permission<T> | RBAC.Permission<T>[] | RBAC.PermissionReq<T>,
): RBAC.PermissionDeniedResponse<T> | null {
	const user = UsersClient.useLoggedInUser()
	const normReq: RBAC.PermissionReq<T> = 'check' in req ? req : { check: 'all', permits: Array.isArray(req) ? req : [req] }
	if (!user) return RBAC.permissionDenied(normReq)
	return RBAC.tryDenyPermissionsForRbacUser(user, normReq)
}

// the logged-in user's effective (non-negated) permissions, for the aggregate settings-access checks below
export function useLoggedInPerms(): RBAC.Permission[] {
	const user = UsersClient.useLoggedInUser()
	return React.useMemo(() => (user ? RBAC.fromTracedPermissions(user.perms) : []), [user])
}

export type GlobalSettingsAccess = { canRead: boolean; write: RBAC.SettingsWriteAccess }
export function useGlobalSettingsAccess(): GlobalSettingsAccess {
	const perms = useLoggedInPerms()
	return React.useMemo(() => ({
		canRead: RBAC.canReadGlobalSettings(perms),
		write: RBAC.globalSettingsWriteAccess(perms),
	}), [perms])
}

export type ServerSettingsAccess = { canRead: boolean; write: RBAC.SettingsWriteAccess; sensitive: boolean }
export function useServerSettingsAccess(serverId: string): ServerSettingsAccess {
	const perms = useLoggedInPerms()
	return React.useMemo(() => ({
		canRead: RBAC.canReadServerSettings(perms, serverId),
		write: RBAC.serverSettingsWriteAccess(perms, serverId),
		sensitive: RBAC.canWriteSensitiveServerSettings(perms, serverId),
	}), [perms, serverId])
}

export const GET_ROLES_QUERY_KEY = ['getRoles']
export function useUserDefinedRoles() {
	return useQuery(RPC.orpc.rbac.getUserDefinedRoles.queryOptions())
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
