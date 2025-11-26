import { MatchTeamDisplay } from '@/components/teams-display'
import { TEAM_COLORS } from '@/lib/display-helpers'
import { cn } from '@/lib/utils'
import * as SM from '@/models/squad.models'

export interface PlayerDisplayProps {
	player: SM.Player
	showTeam?: boolean
	showSquad?: boolean
	showRole?: boolean
	className?: string
	matchId: number
}

export function PlayerDisplay({ player, showTeam, showSquad, showRole, className, matchId }: PlayerDisplayProps) {
	return (
		<span className={cn('inline-flex items-center gap-1', className)}>
			<span className="font-semibold">{player.ids.username}</span>
			{showTeam && player.teamID && (
				<span className="flex flex-nowrap items-center gap-0">
					(<MatchTeamDisplay matchId={matchId} teamId={player.teamID} />)
				</span>
			)}
			{showSquad && player.squadID !== null && (
				<span className="text-muted-foreground text-xs">
					{player.squadID}
				</span>
			)}
			{showRole && player.role && (
				<span className="text-muted-foreground text-xs">
					[{player.role}]
				</span>
			)}
		</span>
	)
}
