import type * as Msgs from '@/messages/shared'
import type * as RBAC from '@/rbac.models'

export const WARNS = {
	permissionDenied(res: RBAC.PermissionDeniedResponse) {
		return `Permission denied. You need ${res.checkType} of the following: ${res.failures.join(', ')}`
	},
} satisfies Msgs.WarnNode
