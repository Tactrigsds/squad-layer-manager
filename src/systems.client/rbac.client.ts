import * as RBAC from '@/rbac.models'
import * as Messages from '@/messages'
import { globalToast$ } from '@/hooks/use-global-toast'
export function showPermissionDenied(res: RBAC.PermissionDeniedResponse) {
	globalToast$.next({
		title: Messages.WARNS.permissionDenied(res),
	})
}
