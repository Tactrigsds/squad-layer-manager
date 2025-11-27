import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type * as SM from '@/models/squad.models'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'

interface PlayerItemProps {
	player: SM.Player
	matchId: number
}

function PlayerItem({ player, matchId }: PlayerItemProps) {
	return (
		<div className="flex items-center gap-1.5 py-0.5 px-2 hover:bg-accent/50 rounded">
			{player.isLeader && (
				<span title="Squad Leader">
					<Icons.Star className="h-3 w-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />
				</span>
			)}
			{player.isAdmin && (
				<span title="Admin">
					<Icons.ShieldCheckIcon className="w-3 h-3 text-background fill-blue-300 flex-shrink-0" />
				</span>
			)}
			<span className="text-xs font-medium truncate">{player.ids.username}</span>
			{player.role && <span className="text-xs text-muted-foreground truncate">- {player.role}</span>}
		</div>
	)
}

interface SquadSectionProps {
	squad: SM.Squad | null
	players: SM.Player[]
	matchId: number
}

function SquadSection({ squad, players, matchId }: SquadSectionProps) {
	const [isOpen, setIsOpen] = React.useState(true)

	if (players.length === 0) return null

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-3">
			<CollapsibleTrigger className="flex items-center gap-1.5 w-full py-1 px-2 hover:bg-accent/30 rounded">
				<Icons.ChevronRight className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
				<Icons.Users className="h-3 w-3 text-muted-foreground" />
				{squad
					? (
						<span className="text-xs font-semibold">
							<SquadDisplay squad={squad} matchId={matchId} showName={true} showTeam={false} />
						</span>
					)
					: <span className="text-xs font-semibold">Unassigned</span>}
				<span className="text-xs text-muted-foreground">({players.length})</span>
				{squad?.locked && (
					<span title="Squad is locked">
						<Icons.Lock className="h-3 w-3 text-muted-foreground" />
					</span>
				)}
			</CollapsibleTrigger>
			<CollapsibleContent>
				{players.map((player) => <PlayerItem key={player.ids.username} player={player} matchId={matchId} />)}
			</CollapsibleContent>
		</Collapsible>
	)
}

interface TeamSectionProps {
	teamId: SM.TeamId
	squads: SM.Squad[]
	players: SM.Player[]
	matchId: number
}

function TeamSection({ teamId, squads, players, matchId }: TeamSectionProps) {
	const [isOpen, setIsOpen] = React.useState(true)

	const teamPlayers = players.filter(p => p.teamId === teamId)
	const teamSquads = squads.filter(s => s.teamId === teamId)

	if (teamPlayers.length === 0) return null

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-4">
			<CollapsibleTrigger className="flex items-center gap-1.5 w-full py-1.5 px-2 hover:bg-accent/20 rounded border-b">
				<Icons.ChevronRight className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
				<span className="text-xs font-bold flex items-center flex-nowrap gap-1">
					Team {teamId} <MatchTeamDisplay matchId={matchId} teamId={teamId} />
				</span>
				<span className="text-xs text-muted-foreground">({teamSquads.length} squads, {teamPlayers.length} players)</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-2">
				{teamSquads.map((squad) => {
					const squadPlayers = teamPlayers.filter(p => p.squadId === squad.squadId)
					return (
						<SquadSection
							key={squad.squadId}
							squad={squad}
							players={squadPlayers}
							matchId={matchId}
						/>
					)
				})}
				<SquadSection
					squad={null}
					players={teamPlayers.filter(p => p.squadId === null)}
					matchId={matchId}
				/>
			</CollapsibleContent>
		</Collapsible>
	)
}

export default function ServerStatePanel() {
	const interpolatedState = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.interpolatedState)
	const eventBuffer = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.eventBuffer)

	// Get the most recent matchId from the event buffer
	const currentMatchId = React.useMemo(() => {
		if (eventBuffer.length === 0) return 0
		return eventBuffer[eventBuffer.length - 1].matchId
	}, [eventBuffer])

	const { players, squads } = interpolatedState

	const unassignedPlayers = players.filter(p => p.teamId === null)

	return (
		<Card className="flex flex-col h-full min-w-[350px]">
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm">
					<Icons.Users className="h-4 w-4" />
					Server State
					<span className="text-xs text-muted-foreground font-normal">
						({players.length} players)
					</span>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden pt-0">
				<ScrollArea className="h-[600px]">
					<div className="flex flex-col pr-4">
						{players.length === 0
							? (
								<div className="text-muted-foreground text-xs text-center py-8">
									No players connected
								</div>
							)
							: (
								<>
									<TeamSection
										teamId={1}
										squads={squads}
										players={players}
										matchId={currentMatchId}
									/>
									<TeamSection
										teamId={2}
										squads={squads}
										players={players}
										matchId={currentMatchId}
									/>
									{unassignedPlayers.length > 0 && (
										<div className="border-t pt-3 mt-2">
											<div className="text-xs font-semibold text-muted-foreground mb-2 px-2">
												Unassigned ({unassignedPlayers.length})
											</div>
											{unassignedPlayers.map((player) => <PlayerItem key={player.ids.username} player={player} matchId={currentMatchId} />)}
										</div>
									)}
								</>
							)}
					</div>
				</ScrollArea>
			</CardContent>
		</Card>
	)
}
