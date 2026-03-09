import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import type * as RBAC from '@/rbac.models'
import React from 'react'

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
	const { check, permits } = props.denied
	const qualifier = check === 'all' ? 'all' : 'one'
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className={props.triggerClassName}>{props.children}</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">
				<p className="font-semibold text-destructive mb-1">Permission denied</p>
				<p className="text-xs text-muted-foreground mb-1">
					{permits.length === 1 ? 'You need the following permission:' : `You need ${qualifier} of the following permissions:`}
				</p>
				<ul className="text-xs space-y-1">
					{permits.map((p) => (
						<li key={p.type} className="p-1.5 bg-muted/50 rounded space-y-0.5">
							<div className="font-mono">{p.type}</div>
						</li>
					))}
				</ul>
			</TooltipContent>
		</Tooltip>
	)
}
