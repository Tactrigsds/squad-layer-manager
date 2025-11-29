import { SquadDisplay } from '@/components/squad-display'
import { MatchTeamDisplay } from '@/components/teams-display'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type * as SM from '@/models/squad.models'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
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
			<CollapsibleTrigger className="flex items-center gap-1.5 w-full py-1 text-xs px-2 hover:bg-accent/30 rounded">
				{squad
					? (
						<>
							<b>{squad.squadId}</b>
							<Icons.ChevronRight className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
							<span className="font-semibold">{squad.squadName}</span>
						</>
					)
					: (
						<>
							<Icons.ChevronRight className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
							<span className="text-xs font-semibold">Unassigned</span>
						</>
					)}
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

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-4">
			<CollapsibleTrigger className="flex items-center gap-1.5 w-full py-1.5 px-2 hover:bg-accent/20 rounded border-b">
				<Icons.ChevronRight className={cn('h-3 w-3 transition-transform flex-shrink-0', isOpen && 'rotate-90')} />
				<span className="text-xs font-bold flex items-center flex-nowrap gap-1 whitespace-nowrap">
					<MatchTeamDisplay matchId={matchId} teamId={teamId} showAltTeamIndicator={true} />
				</span>
				<span className="text-xs text-muted-foreground whitespace-nowrap">({teamPlayers.length})</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-2">
				{teamPlayers.length === 0
					? (
						<div className="text-muted-foreground text-xs text-center py-2 px-2">
							No players on this team
						</div>
					)
					: (
						<>
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
						</>
					)}
			</CollapsibleContent>
		</Collapsible>
	)
}

interface TeamUnassignedSectionProps {
	players: SM.Player[]
	matchId: number
}

function TeamUnassignedSection({ players, matchId }: TeamUnassignedSectionProps) {
	const [isOpen, setIsOpen] = React.useState(true)

	if (players.length === 0) return null

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-4">
			<CollapsibleTrigger className="flex items-center gap-1.5 w-full py-1.5 px-2 hover:bg-accent/20 rounded border-b">
				<Icons.ChevronRight className={cn('h-3 w-3 transition-transform flex-shrink-0', isOpen && 'rotate-90')} />
				<span className="text-xs font-bold text-muted-foreground">Unassigned</span>
				<span className="text-xs text-muted-foreground whitespace-nowrap">({players.length})</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-2">
				{players.map((player) => <PlayerItem key={player.ids.username} player={player} matchId={matchId} />)}
			</CollapsibleContent>
		</Collapsible>
	)
}

export default function ServerPlayerList() {
	const interpolatedState = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.interpolatedState)
	const eventBuffer = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.eventBuffer)
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.eventFilterState)
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, s => s.displayTeamsNormalized)

	// Get the most recent matchId from the event buffer
	const currentMatchId = eventBuffer.length === 0 ? 0 : eventBuffer[eventBuffer.length - 1].matchId

	const recentMatches = MatchHistoryClient.useRecentMatches()
	const match = recentMatches.find(m => m.historyEntryId === currentMatchId)
	if (!match) {
		console.warn('No match found for current match ID', currentMatchId)
		return null
	}

	let firstTeamIndex = (+displayTeamsNormalized + match.ordinal + 0) % 2
	let secondTeamIndex = (+displayTeamsNormalized + match.ordinal + 1) % 2
	const firstTeamId = firstTeamIndex + 1 as SM.TeamId
	const secondTeamId = secondTeamIndex + 1 as SM.TeamId

	const { players, squads } = interpolatedState

	// Filter players based on eventFilterState
	const filteredPlayers = React.useMemo(() => {
		if (eventFilterState === 'ADMIN') {
			return players.filter(p => p.isAdmin)
		}
		return players
	}, [players, eventFilterState])

	const unassignedPlayers = filteredPlayers.filter(p => p.teamId === null)

	return (
		<div className="flex h-full relative">
			<div className="flex-1 overflow-hidden border-l pl-4">
				<ScrollArea className="h-full">
					<div className="flex flex-col pr-4">
						{filteredPlayers.length === 0
							? (
								<div className="text-muted-foreground text-xs text-center py-8">
									No players connected
								</div>
							)
							: (
								<>
									<TeamSection
										teamId={firstTeamId}
										squads={squads}
										players={filteredPlayers}
										matchId={currentMatchId}
									/>
									<TeamSection
										teamId={secondTeamId}
										squads={squads}
										players={filteredPlayers}
										matchId={currentMatchId}
									/>
									<TeamUnassignedSection players={unassignedPlayers} matchId={currentMatchId} />
								</>
							)}
					</div>
				</ScrollArea>
			</div>
		</div>
	)
}
