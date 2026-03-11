import { cn } from '@/lib/utils'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as SM from '@/models/squad.models'
import React from 'react'
import type { SquadDetailsWindowProps } from './squad-details-window.helpers'
import { MatchTeamDisplay } from './teams-display'
import { OpenWindowInteraction } from './ui/draggable-window'

void import('@/components/squad-details-window')

interface SquadDisplayProps {
	squad: Pick<SM.Squad, 'squadId' | 'squadName' | 'teamId'> & { uniqueId?: number }
	className?: string
	showName?: boolean
	showTeam?: boolean
	matchId: number
}

function SquadButton(
	{ label, ref, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
		label: string
		ref?: React.Ref<HTMLButtonElement>
	},
) {
	return (
		<button ref={ref} type="button" className={cn('hover:underline cursor-pointer', className)} {...props}>
			{label}
		</button>
	)
}

export function SquadDisplay({ squad, matchId, className, showName = true, showTeam = false }: SquadDisplayProps) {
	const isDefaultName = squad.squadName === `Squad ${squad.squadId}`
	const label = isDefaultName
		? `Squad ${squad.squadId}`
		: `Squad ${squad.squadId}${showName ? ` "${squad.squadName}"` : ''}`
	const labelClass = isDefaultName ? 'font-bold' : 'font-bold'

	const squadLabel = squad.uniqueId !== undefined
		? (
			<OpenWindowInteraction
				windowId={WINDOW_ID.enum['squad-details']}
				windowProps={{ uniqueSquadId: squad.uniqueId } satisfies SquadDetailsWindowProps}
				preload="intent"
				render={SquadButton}
				label={label}
				className={labelClass}
			/>
		)
		: <span className={labelClass}>{label}</span>

	return (
		<span className={cn('inline-flex flex-nowrap items-center gap-1', className)}>
			{squadLabel}
			{showTeam && (
				<span className="inline-flex flex-nowrap">
					(
					<MatchTeamDisplay teamId={squad.teamId} matchId={matchId} />)
				</span>
			)}
		</span>
	)
}
