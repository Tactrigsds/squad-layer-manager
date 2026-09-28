import type React from 'react'

import * as PA from '@/models/procedure-access.models'
import type * as RBAC from '@/rbac.models'
import * as PageAccess from '@/systems/page-access.client'
import * as RbacClient from '@/systems/rbac.client'

// what to check: a procedure's entry (with the fields it reads), a page's entry, or a requirement of its own
type Target =
	| {
			[P in PA.CheckablePath]: { access: P } & (PA.AccessInput<P> extends void ? { input?: never } : { input: PA.AccessInput<P> })
	  }[PA.CheckablePath]
	| { page: PageAccess.ParamlessPage }
	| { req: RBAC.ReqInput }

type RequireAccessProps = Target & {
	children: React.ReactNode
	// rendered instead of the children when the user is refused, e.g. PermissionDeniedPanel. Nothing by default
	fallback?: React.ComponentType<{ denied: RBAC.PermissionDeniedResponse }>
}

/**
 * Mounts its children only when the user holds what the target requires, so nothing inside runs for a user who
 * would be refused: not its hooks, not its queries. Use it for a subtree that is hidden or replaced on a denial.
 * A control that stays rendered and is only disabled takes `RbacClient.useAccess` instead.
 */
export function RequireAccess(props: RequireAccessProps) {
	const denied = RbacClient.usePermsCheck(targetReq(props))
	if (!denied) return props.children
	const Fallback = props.fallback
	return Fallback ? <Fallback denied={denied} /> : null
}

function targetReq(target: Target): RBAC.ReqInput {
	if ('access' in target) return PA.checkedReq(target.access, target.input as never)
	if ('page' in target) return PageAccess.pageReq(target.page)
	return target.req
}
