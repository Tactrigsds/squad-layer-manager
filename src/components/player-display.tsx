import { MatchTeamDisplay } from '@/components/teams-display'

import { cn } from '@/lib/utils'
import type * as SM from '@/models/squad.models'
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
		<span className={cn('', className)}>
			{player.isAdmin && (
				<span title="This player is an Admin" className="inline-block">
					<Icons.ShieldCheckIcon className="h-[1em] w-[1em] text-background fill-blue-300" />
				</span>
			)}
			<span className="font-bold">
				{player.ids.username}
			</span>
			{showTeam && player.teamId !== null && (
				<span className="inline-flex flex-nowrap">
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
