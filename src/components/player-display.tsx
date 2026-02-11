import { MatchTeamDisplay } from '@/components/teams-display'
import { cn } from '@/lib/utils'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import { usePlayerFlagColor } from '@/systems/battlemetrics.client'
import * as Icons from 'lucide-react'
import React from 'react'
import { PlayerDetailsWindowProps } from './player-details-window.helpers'
import { OpenWindowInteraction } from './ui/draggable-window'

void import('@/components/player-details-window')

export interface PlayerDisplayProps {
	player: SM.Player
	showTeam?: boolean
	showSquad?: boolean
	showRole?: boolean
	className?: string
	matchId: number
}

function PlayerButton(
	{ username, ref, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { username: string; ref?: React.Ref<HTMLButtonElement> },
) {
	return (
		<button ref={ref} type="button" className="font-bold hover:underline cursor-pointer" {...props}>
			{username}
		</button>
	)
}

export function PlayerDisplay({ player, showTeam, showSquad, showRole, className, matchId }: PlayerDisplayProps) {
	const playerId = SM.PlayerIds.getPlayerId(player.ids)
	const windowProps: PlayerDetailsWindowProps = { playerId }
	const flagColor = usePlayerFlagColor(playerId)

	return (
		<span className={cn('inline-flex items-baseline', className)}>
			{player.isAdmin && (
				<span title="This player is an Admin" className="inline-block">
					<Icons.ShieldCheckIcon className="h-[1em] w-[1em] text-background fill-blue-300" />
				</span>
			)}
			{player.isLeader && (
				<span title="Squad Leader">
					<Icons.Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
				</span>
			)}
			<OpenWindowInteraction
				windowId={WINDOW_ID.enum['player-details']}
				windowProps={windowProps}
				preload="intent"
				render={PlayerButton}
				username={player.ids.username}
				style={flagColor ? { color: flagColor } : undefined}
			/>
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
