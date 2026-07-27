// rendered into the landing pages by the server build, which uses the classic JSX runtime; keep React in scope
import * as React from 'react'

import * as Logo from '@/lib/logo'
import { cn } from '@/lib/utils'

const FILL_CLASS = { tile: 'fill-foreground', letters: 'fill-background' } as const

// decorative: every placement sits next to the wordmark or inside a labelled link, so a label here only
// makes screen readers announce the product name twice
export default function LogoMark({ accent, className }: { accent: string | null; className?: string }) {
	return (
		<svg viewBox={`0 0 ${Logo.VIEW_BOX} ${Logo.VIEW_BOX}`} className={cn('shrink-0', className)} aria-hidden="true">
			{Logo.shapes(accent !== null).map((shape) => (
				<path
					key={shape.role}
					d={shape.d}
					transform={shape.translate ? `translate(${shape.translate.x} ${shape.translate.y})` : undefined}
					className={shape.role === 'accent' ? undefined : FILL_CLASS[shape.role]}
					fill={shape.role === 'accent' ? accent! : undefined}
				/>
			))}
		</svg>
	)
}
