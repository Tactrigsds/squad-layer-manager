import * as RBAC from '@/rbac.models'
import * as Messages from '@/messages'
import { useQuery } from '@tanstack/react-query'
import { trpc } from '@/lib/trpc.client'
import { globalToast$ } from '@/hooks/use-global-toast'
export function showPermissionDenied(res: RBAC.PermissionDeniedResponse) {
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
