// the activity feed's static render calls this directly, so the react compiler must not inject its memo-cache hook
'use no memo'

import type React from 'react'

import { cn } from '@/lib/utils'

export type VoteTallyRow = { key: React.Key; label: React.ReactNode; votes: number; won: boolean }

// one bar per choice, its length the choice's share of the votes cast
export default function VoteTallyBars(props: { rows: VoteTallyRow[]; total: number; footer: React.ReactNode; className?: string }) {
	return (
		<div className={cn('flex flex-col gap-1.5 rounded-md bg-muted/50 px-2.5 py-2', props.className)}>
			{props.rows.map((row) => {
				const share = props.total > 0 ? (row.votes / props.total) * 100 : 0
				return (
					<div key={row.key}>
						<div className="flex items-baseline gap-2">
							{/* the label wraps rather than running under the count */}
							<span className={cn('min-w-0 flex-1 wrap-anywhere', row.won ? 'font-semibold text-foreground' : undefined)}>
								{row.label}
							</span>
							<span className={cn('shrink-0 tabular-nums', row.won ? 'font-semibold text-primary' : undefined)}>{row.votes}</span>
						</div>
						<div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-background">
							<div className={cn('h-full', row.won ? 'bg-primary' : 'bg-muted-foreground/50')} style={{ width: `${share}%` }} />
						</div>
					</div>
				)
			})}
			<div className="text-[11px]">{props.footer}</div>
		</div>
	)
}
