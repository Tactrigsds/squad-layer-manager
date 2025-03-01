import { globalToast$ } from '@/hooks/use-global-toast'
import { trpc } from '@/lib/trpc.client'
import * as Messages from '@/messages'
import * as RBAC from '@/rbac.models'
import { useQuery } from '@tanstack/react-query'
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
