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

export type RbacStore = {
	simulateRoles: boolean
	setSimulateRoles: (simulateRoles: boolean) => void
	disabledRoles: RBAC.Role[]
	disableRole: (role: RBAC.Role) => void
	enableRole: (role: RBAC.Role) => void
}

export const RbacStore = Zus.createStore<RbacStore>((set, get) => ({
	simulateRoles: false,
	setSimulateRoles: (simulateRoles: boolean) => {
		set({ simulateRoles })
		if (!simulateRoles) {
			set({ disabledRoles: [] })
		}
	},

	disabledRoles: [],
	disableRole: (roleToDisable) => {
		const disabledRoles = get().disabledRoles
		for (const roleToCompare of disabledRoles) {
			if (Obj.deepEqual(roleToDisable, roleToCompare)) {
				return
			}
		}
		set({ disabledRoles: [...disabledRoles, roleToDisable] })
	},
	enableRole: (role) => set({ disabledRoles: get().disabledRoles.filter(r => !Obj.deepEqual(r, role)) }),
}))
