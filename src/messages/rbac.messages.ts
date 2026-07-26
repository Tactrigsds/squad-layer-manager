import * as Msgs from '@/messages/shared'
import type * as RBAC from '@/rbac.models'

// Delivered in-game as a warn and in the web client as an error toast, which is why it declares both.
export const permissionDenied = Msgs.def((res: RBAC.PermissionDeniedResponse) => {
	const text = `Permission denied. You need ${res.checkType} of the following: ${res.failures.join(', ')}`
	return {
		warn: () => text,
		toast: () => text,
		text: () => text,
	}
})
