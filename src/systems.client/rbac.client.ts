import { globalToast$ } from '@/hooks/use-global-toast'
import * as Obj from '@/lib/object'
import * as Messages from '@/messages'
import * as RPC from '@/orpc.client'
import type * as RBAC from '@/rbac.models'
import * as UsersClient from '@/systems.client/users.client'
import { useQuery } from '@tanstack/react-query'
import * as Zus from 'zustand'

export function handlePermissionDenied(res: RBAC.PermissionDeniedResponse) {
	UsersClient.invalidateLoggedInUser()
	globalToast$.next({
		variant: 'destructive',
		title: Messages.WARNS.permissionDenied(res),
	})
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
