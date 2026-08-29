import * as Icons from 'lucide-react'
import type * as React from 'react'

// a stored id that no longer resolves to a live entity (a deleted Discord role, a departed member, a removed
// managed server): surface the raw id with a warning rather than a confusing blank, and explain the situation
// below the picker

export function UnresolvedLabel({ id }: { id: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-500">
			<Icons.TriangleAlert className="h-3 w-3 shrink-0" />
			<span className="font-mono">{id}</span>
		</span>
	)
}

export function UnresolvedNote({ children }: { children: React.ReactNode }) {
	return <p className="text-xs text-amber-600 dark:text-amber-500">{children}</p>
}
