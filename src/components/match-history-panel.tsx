import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/hooks/use-toast'
import * as Arr from '@/lib/array'
import { getTeamsDisplay, teamColors } from '@/lib/display-helpers-teams'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as dateFns from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import React from 'react'
import * as Zus from 'zustand'
import LayerSourceDisplay from './layer-source-display'
import { Badge } from './ui/badge'

export default function MatchHistoryPanel() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const history = MatchHistoryClient.useRecentMatches()
	const allEntries = React.useMemo(() => [...history].reverse(), [history])
	const currentMatch = MatchHistoryClient.useCurrentMatchDetails()

	// -------- Pagination state --------
	const [currentPage, setCurrentPage] = useState(1)
	const itemsPerPage = 15
	const totalPages = Math.ceil(allEntries.length / itemsPerPage)

	// -------- Get current entries --------
	const indexOfLastEntry = currentPage * itemsPerPage
	const indexOfFirstEntry = indexOfLastEntry - itemsPerPage
	const currentEntries = allEntries.slice(indexOfFirstEntry, indexOfLastEntry)

	// -------- Page navigation --------
	const goToNextPage = () => setCurrentPage(prev => Math.min(prev + 1, totalPages))
	const goToPrevPage = () => setCurrentPage(prev => Math.max(prev - 1, 1))

	// -------- calculate streaks --------
	let streaker: 'teamA' | 'teamB' | null = null
	let streak = 0
	// console.table(currentEntries.map(SM.matchHistoryEntryFromMatchDetails))
	for (let i = 0; i < allEntries.length; i++) {
		const entry = allEntries[i]
		if (M.isHistoryLookbackExcludedLayer(entry.layerId)) break
		if (entry.status === 'in-progress' && i === 0) continue
		if (entry.status === 'in-progress') break
		const outcomeNorm = SM.getTeamNormalizedOutcome(entry)
		if (outcomeNorm.type === 'draw') break
		if (!streaker) {
			streaker = outcomeNorm.type
		}
		if (outcomeNorm.type !== streaker) {
			break
		}
		streak++
	}

	let streakerElt: React.ReactNode
	if (!streaker) {
		streakerElt = null
	} else {
		const streakerTitle = streaker === 'teamA' ? 'Team A' : 'Team B'
		let streakerFaction: string
		if (!currentMatch) streakerFaction = ''
		else {
			const layer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(currentMatch.layerId))
			streakerFaction = layer[M.getTeamNormalizedFactionProp(currentMatch.ordinal, streaker === 'teamA' ? 'A' : 'B')] ?? 'Unknown'
			streakerFaction = `(${streakerFaction})`
		}
		streakerElt = (
			<>
				<span className="text-right">Current Streak{'  '}:{' '}</span>
				<span className="text-lg font-bold">
					<span>
						{streakerTitle}
					</span>
					{streakerFaction}
				</span>
				<span>
					{streak} Game{streak > 1 ? 's' : ''}
				</span>
			</>
		)
	}

	// -------- calculate ticket differences --------
	let ticketDiff = 0
	let matchCount = 0

	{
		const fiveHoursAgo = new Date()
		fiveHoursAgo.setTime(fiveHoursAgo.getTime() - 5 * 60 * 60 * 1000)

		for (let i = 0; i < allEntries.length && matchCount < 4; i++) {
			const entry = allEntries[i]
			if (M.isHistoryLookbackExcludedLayer(entry.layerId)) break
			if (entry.status === 'post-game' && entry.endTime < fiveHoursAgo) break
			if (entry.status !== 'post-game') continue
			const outcome = SM.getTeamNormalizedOutcome(entry)
			if (outcome.type !== 'draw') {
				ticketDiff += outcome.teamATickets - outcome.teamBTickets
			}
			matchCount++
		}
	}

	let diffFor: React.ReactNode
	if (ticketDiff > 0) {
		diffFor = 'Team A'
	} else if (ticketDiff < 0) {
		diffFor = 'Team B'
	} else {
		diffFor = null
	}
	let ticketDiffElt: React.ReactNode = null
	if (matchCount > 0) {
		ticketDiffElt = (
			<>
				<span className="text-right">Last {matchCount} games ticket diff :{' '}</span>
				<span className="text-lg font-bold">{diffFor}</span>
				<span>{Math.abs(ticketDiff)} ticket{Math.abs(ticketDiff) === 1 ? '' : 's'}</span>
			</>
		)
	}

	let leftTeamLabel: string
	let rightTeamLabel: string
	if (globalSettings.displayTeamsNormalized) {
		leftTeamLabel = 'Team A'
		rightTeamLabel = 'Team B'
	} else {
		leftTeamLabel = 'Team 1'
		rightTeamLabel = 'Team 2'
	}

	return (
		<Card>
			<CardHeader className="flex flex-row justify-between items-center">
				<CardTitle>Match History</CardTitle>
				<div className="grid grid-cols-[auto,auto,auto] gap-x-2">
					{streakerElt}
					{ticketDiffElt}
				</div>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow className="font-medium">
							<TableHead></TableHead>
							<TableHead></TableHead>
							<TableHead>Layer</TableHead>
							<TableHead>{leftTeamLabel}</TableHead>
							<TableHead className="text-center">Outcome</TableHead>
							<TableHead>{rightTeamLabel}</TableHead>
							<TableHead>Set By</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentEntries.map((entry, index) => {
							if (entry.historyEntryId === currentMatch?.historyEntryId) {
								return
							}
							const layer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(entry.layerId))
							let outcomeDisp: React.ReactNode
							if (entry.status === 'in-progress') {
								outcomeDisp = '-'
							} else if (entry.outcome.type === 'draw') {
								outcomeDisp = 'draw'
							} else {
								// Determine win/loss status
								let team1Status = entry.outcome.type === 'team1' ? 'W' : 'L'
								let team2Status = entry.outcome.type === 'team2' ? 'W' : 'L'
								let team1Tickets = entry.outcome.team1Tickets
								let team2Tickets = entry.outcome.team2Tickets

								if (globalSettings.displayTeamsNormalized && entry.ordinal % 2 === 1) {
									// Swap status if normalized
									;[team1Status, team2Status] = [team2Status, team1Status]
									;[team1Tickets, team2Tickets] = [team2Tickets, team1Tickets]
								}

								outcomeDisp = `${team1Tickets} ${team1Status} - ${team2Status} ${team2Tickets}`
							}
							const gameRuntime = (entry.startTime && entry.status === 'post-game')
								? entry.endTime.getTime() - entry.startTime.getTime()
								: undefined
							const idx = index + (currentPage - 1) * itemsPerPage

							const copyHistoryEntryId = () => {
								navigator.clipboard.writeText(entry.historyEntryId.toString())
								toast({
									title: 'Copied History Entry ID',
									description: (
										<div className="flex flex-col">
											<span>The history entry ID has been copied to your clipboard.</span>
											<span className="font-mono text-xs">({entry.historyEntryId})</span>
										</div>
									),
								})
							}
							const copyLayerId = () => {
								navigator.clipboard.writeText(entry.layerId)
								toast({
									title: 'Copied Layer ID',
									description: (
										<div className="flex flex-col">
											<span>The layer ID has been copied to your clipboard.</span>
											<span className="font-mono text-xs">({entry.layerId})</span>
										</div>
									),
								})
							}
							const copyAdminSetNextLayerCommand = () => {
								const cmd = M.getSetNextLayerCommandFromId(entry.layerId)
								navigator.clipboard.writeText(cmd)
								toast({
									title: 'Copied Admin Set Next Layer Command',
									description: (
										<div className="flex flex-col">
											<span>The admin set next layer command has been copied to your clipboard.</span>
											<span className="font-mono text-xs">({cmd})</span>
										</div>
									),
								})
							}
							let differenceDisp: React.ReactNode = null
							if (entry.status === 'post-game') {
								const difference = dateFns.differenceInHours(new Date(), entry.endTime)
								if (difference === 0) {
									differenceDisp = `(-${Math.floor(dateFns.differenceInMinutes(new Date(), entry.endTime)).toString()}m)`
								} else {
									differenceDisp = `(-${Math.floor(difference).toString()}h)`
								}
							}

							const [leftTeam, rightTeam] = getTeamsDisplay(layer, entry.ordinal % 2, globalSettings.displayTeamsNormalized)

							return (
								<ContextMenu key={entry.historyEntryId}>
									<ContextMenuTrigger asChild>
										<TableRow>
											<TableCell className="font-mono text-xs">{idx.toString().padStart(2, '0')}</TableCell>
											<TableCell className="text-xs ">
												{gameRuntime
													? <span className="font-mono font-light">{formatTimeLeftWithZeros(gameRuntime)}</span>
													: <Badge variant="secondary">incomplete</Badge>}
												<span className="ml-1 text-muted-foreground font-mono font-light">
													{differenceDisp}
												</span>
											</TableCell>
											<TableCell className="font-mono text-sm">{layer.Layer}</TableCell>
											<TableCell>
												{leftTeam}
											</TableCell>
											<TableCell className="text-center">{outcomeDisp}</TableCell>
											<TableCell>
												{rightTeam}
											</TableCell>
											<TableCell>
												<LayerSourceDisplay source={entry.layerSource} />
											</TableCell>
										</TableRow>
									</ContextMenuTrigger>
									<ContextMenuContent>
										<ContextMenuItem onClick={() => copyHistoryEntryId()}>
											copy history entry id
										</ContextMenuItem>
										<ContextMenuItem onClick={() => copyLayerId()}>
											copy layer id
										</ContextMenuItem>
										<ContextMenuItem
											onClick={() => copyAdminSetNextLayerCommand()}
										>
											copy AdminSetNextLayer command
										</ContextMenuItem>
									</ContextMenuContent>
								</ContextMenu>
							)
						})}
					</TableBody>
				</Table>

				{totalPages > 1 && (
					<div className="flex items-center justify-center space-x-2 mt-4">
						<Button
							variant="outline"
							size="sm"
							onClick={goToPrevPage}
							disabled={currentPage === 1}
						>
							<ChevronLeft className="h-4 w-4" />
						</Button>
						<span className="text-sm">
							Page {currentPage} of {totalPages}
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={goToNextPage}
							disabled={currentPage === totalPages}
						>
							<ChevronRight className="h-4 w-4" />
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	)
}

function formatTimeLeftWithZeros(timeLeft: number) {
	const duration = dateFns.intervalToDuration({ start: 0, end: timeLeft })
	const hours = duration.hours || 0
	const minutes = duration.minutes || 0
	const seconds = String(duration.seconds || 0).padStart(2, '0')

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds}`
}
