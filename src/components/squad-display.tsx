import { cn } from '@/lib/utils'
import type * as SM from '@/models/squad.models'
import { MatchTeamDisplay } from './teams-display'

interface SquadDisplayProps {
	squad: Pick<SM.Squad, 'squadId' | 'squadName' | 'teamId'>
	className?: string
	showName?: boolean
	showTeam?: boolean
	matchId: number
}

export function SquadDisplay({ squad, matchId, className, showName = true, showTeam = false }: SquadDisplayProps) {
	const isDefaultName = squad.squadName === `Squad ${squad.squadId}`
	const shouldShowName = showName && squad.squadName && !isDefaultName

	return (
		<span className={cn('inline-flex flex-nowrap items-center gap-1', className)}>
			{isDefaultName
				? (
					<span className="text-xs">
						Squad {squad.squadId}
					</span>
				)
				: <span className="font-semibold">Squad {squad.squadId} "{squad.squadName}"</span>}
			{showTeam && (
				<span className="inline-flex flex-nowrap">
					(
					<MatchTeamDisplay teamId={squad.teamId} matchId={matchId} />)
				</span>
			)}
		</span>
	)
}
