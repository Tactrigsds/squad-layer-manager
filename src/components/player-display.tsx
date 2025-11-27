import { MatchTeamDisplay } from '@/components/teams-display'
import { TEAM_COLORS } from '@/lib/display-helpers'
import { cn } from '@/lib/utils'
import * as SM from '@/models/squad.models'
import * as Icons from 'lucide-react'

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
			<span className="flex items-center gap-0.5">
				{player.isAdmin && (
					<span title="This player is an Admin">
						<Icons.ShieldCheckIcon className="w-4 h-4 text-background fill-blue-300" />
					</span>
				)}
				<span className="font-semibold">{player.ids.username}</span>
			</span>
			{showTeam && player.teamId && (
				<span className="flex flex-nowrap items-center gap-0">
					(<MatchTeamDisplay matchId={matchId} teamId={player.teamId} />)
				</span>
			)}
			{showSquad && player.squadId !== null && (
				<span className="text-muted-foreground text-xs">
					{player.squadId}
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
