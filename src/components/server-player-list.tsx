import { MatchTeamDisplay } from '@/components/teams-display'

import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type * as SM from '@/models/squad.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import { GlobalSettingsStore } from '@/systems/global-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { PlayerDisplay } from './player-display'

interface PlayerItemProps {
	player: SM.Player
	matchId: number
}

function PlayerItem({ player, matchId }: PlayerItemProps) {
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.secondaryFilterState)
	return (
		<div className="flex items-center gap-1.5 py-0.5 px-2 hover:bg-accent/50 rounded">
			<PlayerDisplay className="text-xs" player={player} matchId={matchId} />
			{player.role && eventFilterState === 'ALL' && <span className="text-xs text-muted-foreground truncate">- {player.role}</span>}
		</div>
	)
}

interface SquadSectionProps {
	squad: SM.Squad | null
	players: SM.Player[]
	matchId: number
}

function SquadSection({ squad, players, matchId }: SquadSectionProps) {
	if (players.length === 0) return null

	return (
		<div className="mb-3 rounded border border-border/50">
			<div className="flex items-center gap-1.5 w-full py-1 text-xs px-2 bg-accent/20 rounded-t">
				{squad
					? (
						<>
							<b>{squad.squadId}</b>
							<span className="font-semibold">{squad.squadName}</span>
						</>
					)
					: <span className="text-xs font-semibold">Unassigned</span>}
				<span className="text-xs text-muted-foreground">({players.length})</span>
				{squad?.locked && (
					<span title="Squad is locked">
						<Icons.Lock className="h-3 w-3 text-muted-foreground" />
					</span>
				)}
			</div>
			<div className="py-0.5">
				{players.toSorted((a, b) => a.isLeader ? -1 : b.isLeader ? 1 : 0).map((player) => (
					<PlayerItem key={player.ids.steam} player={player} matchId={matchId} />
				))}
			</div>
		</div>
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
				<Icons.ChevronRight className={cn('h-3 w-3 transition-transform shrink-0', isOpen && 'rotate-90')} />
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
				<Icons.ChevronRight className={cn('h-3 w-3 transition-transform shrink-0', isOpen && 'rotate-90')} />
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
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.secondaryFilterState)
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, s => s.displayTeamsNormalized)

	const slsOnly = Zus.useStore(BattlemetricsClient.Store, s => s.slsOnly)
	const setSlsOnly = Zus.useStore(BattlemetricsClient.Store, s => s.setSlsOnly)

	// Get the most recent matchId from the event buffer
	const currentMatchId = eventBuffer.length === 0 ? 0 : eventBuffer[eventBuffer.length - 1].matchId

	const recentMatches = MatchHistoryClient.useRecentMatches()
	const match = recentMatches.find(m => m.historyEntryId === currentMatchId)
	if (!match) {
		return null
	}

	let firstTeamIndex = (+displayTeamsNormalized + match.ordinal + 0) % 2
	let secondTeamIndex = (+displayTeamsNormalized + match.ordinal + 1) % 2
	const firstTeamId = firstTeamIndex + 1 as SM.TeamId
	const secondTeamId = secondTeamIndex + 1 as SM.TeamId

	const { players, squads } = interpolatedState

	// Filter players based on eventFilterState and slsOnly
	const filteredPlayers = React.useMemo(() => {
		let result = players
		if (eventFilterState === 'ADMIN') {
			result = result.filter(p => p.isAdmin)
		}
		if (slsOnly) {
			result = result.filter(p => p.isLeader)
		}
		return result
	}, [players, eventFilterState, slsOnly])

	const unassignedPlayers = filteredPlayers.filter(p => p.teamId === null)

	return (
		<div className="flex h-full relative flex-col">
			<div className="flex items-center gap-2 px-4 py-1.5 border-b border-l shrink-0">
				<label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
					<Checkbox checked={slsOnly} onCheckedChange={v => setSlsOnly(v === true)} className="h-3.5 w-3.5" />
					SLs only
				</label>
			</div>
			<div className="flex-1 overflow-hidden border-l pl-4">
				<ScrollArea className="h-full">
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
