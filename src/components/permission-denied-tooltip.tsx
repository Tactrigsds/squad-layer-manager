import React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import type * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'

/**
 * Wraps children in a tooltip showing the permission denied reason when `denied` is non-null.
 * The trigger span is required so the tooltip works even when the child is a disabled button.
 */
export function PermissionDeniedTooltip(props: {
	denied: RBAC.PermissionDeniedResponse | null
	children: React.ReactNode
	triggerClassName?: string
}) {
	if (!props.denied) return props.children
	const { checkType, failures } = props.denied
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className={props.triggerClassName}>{props.children}</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">
				<p className="font-semibold text-destructive mb-1">{tr.text(RBAC_Msgs.permissionDeniedHeading())}</p>
				<p className="text-xs text-muted-foreground mb-1">{tr.text(RBAC_Msgs.permissionsNeeded(checkType, failures.length))}</p>
				<ul className="text-xs space-y-1">
					{failures.map((msg) => (
						<li key={msg} className="p-1.5 bg-muted/50 rounded space-y-0.5">
							<div className="font-mono">{msg}</div>
						</li>
					))}
				</ul>
			</TooltipContent>
		</Tooltip>
	)
}
