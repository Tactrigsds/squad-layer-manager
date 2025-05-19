import { globalToast$ } from '@/hooks/use-global-toast'
import * as Messages from '@/messages'
import * as RBAC from '@/rbac.models'
import * as UsersClient from '@/systems.client/users.client'
import { trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'

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
