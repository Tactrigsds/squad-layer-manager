import { globalToast$ } from '@/hooks/use-global-toast'
import * as Obj from '@/lib/object'
import * as Messages from '@/messages'
import * as RBAC from '@/rbac.models'
import * as UsersClient from '@/systems.client/users.client'
import { trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'

import type * as React from 'react'
import * as Zus from 'zustand'

export function handlePermissionDenied(res: RBAC.PermissionDeniedResponse) {
	void UsersClient.invalidateLoggedInUser()
	globalToast$.next({
		title: Messages.WARNS.permissionDenied(res),
	})
}

export const GET_ROLES_QUERY_KEY = ['getRoles']
export function useRoles() {
	return useQuery({
		queryKey: GET_ROLES_QUERY_KEY,
		queryFn: async () => {
			return trpc.rbac.getRoles.query()
		},
	})
}

export type RbacStore = {
	simulateRoles: boolean
	setSimulateRoles: (simulateRoles: boolean) => void
	disabledRoles: RBAC.CompositeRole[]
	disableRole: (role: RBAC.CompositeRole) => void
	enableRole: (role: RBAC.CompositeRole) => void
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
	disableRole: (roleToDisable: RBAC.CompositeRole) => {
		const disabledRoles = get().disabledRoles
		for (const roleToCompare of disabledRoles) {
			if (Obj.deepEqual(roleToDisable, roleToCompare)) {
				return
			}
		}
		set({ disabledRoles: [...disabledRoles, roleToDisable] })
	},
	enableRole: (role: RBAC.CompositeRole) => set({ disabledRoles: get().disabledRoles.filter(r => !Obj.deepEqual(r, role)) }),
}))
