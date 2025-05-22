import * as AR from '@/app-routes'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/hooks/use-toast'
import * as DH from '@/lib/display-helpers'
import { getTeamsDisplay } from '@/lib/display-helpers-react'
import * as SM from '@/lib/rcon/squad-models'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import React from 'react'
import * as Zus from 'zustand'
import LayerSourceDisplay from './layer-source-display'

export default function MatchHistoryPanel() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const serverStatus = SquadServerClient.useSquadServerStatus()
	const allEntries = MatchHistoryClient.useRecentMatchHistory()
		.filter(entry =>
			(serverStatus.code !== 'ok' || serverStatus.data.currentMatchId !== entry.historyEntryId) && entry.status === 'post-game'
		) as Extract<SM.MatchDetails, { status: 'post-game' }>[]

	// Pagination state
	const [currentPage, setCurrentPage] = useState(1)
	const itemsPerPage = 15
	const totalPages = Math.ceil(allEntries.length / itemsPerPage)

	// Get current entries
	const indexOfLastEntry = currentPage * itemsPerPage
	const indexOfFirstEntry = indexOfLastEntry - itemsPerPage
	const currentEntries = allEntries.slice(indexOfFirstEntry, indexOfLastEntry)

	// Page navigation
	const goToNextPage = () => setCurrentPage(prev => Math.min(prev + 1, totalPages))
	const goToPrevPage = () => setCurrentPage(prev => Math.max(prev - 1, 1))

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
							const layer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(entry.layerId))
							let outcomeDisp: React.ReactNode
							if (entry.outcome.type === 'draw') {
								outcomeDisp = 'draw'
							} else {
								// Determine win/loss status
								let team1Status = entry.outcome.type === 'team1' ? 'W' : 'L'
								let team2Status = entry.outcome.type === 'team2' ? 'W' : 'L'
								let team1Tickets = entry.outcome.team1Tickets
								let team2Tickets = entry.outcome.team2Tickets

								if (globalSettings.displayTeamsNormalized && entry.teamParity === 1) {
									// Swap status if normalized
									;[team1Status, team2Status] = [team2Status, team1Status]
									;[team1Tickets, team2Tickets] = [team2Tickets, team1Tickets]
								}

								outcomeDisp = `${team1Tickets} ${team1Status} - ${team2Status} ${team2Tickets}`
							}
							const gameRuntime = entry.endTime.getTime() - entry.startTime.getTime()
							const idx = index + (currentPage - 1) * itemsPerPage + 1

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
							let differenceDisp = '-' + Math.floor(dateFns.differenceInHours(new Date(), entry.endTime)).toString() + 'h'
							if (differenceDisp === '-0h') {
								differenceDisp = '-' + Math.floor(dateFns.differenceInMinutes(new Date(), entry.endTime)).toString() + 'm'
							}

							const [leftTeam, rightTeam] = getTeamsDisplay(layer, entry.teamParity, globalSettings.displayTeamsNormalized)

							return (
								<ContextMenu key={entry.historyEntryId}>
									<ContextMenuTrigger asChild>
										<TableRow>
											<TableCell className="font-mono text-xs">{idx.toString().padStart(2, '0')}</TableCell>
											<TableCell className="font-mono text-xs font-light">
												{formatTimeLeftWithZeros(gameRuntime)}
												<span className="ml-1 text-muted-foreground">
													({differenceDisp})
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
											Copy Entry ID
										</ContextMenuItem>
										<ContextMenuItem onClick={() => copyLayerId()}>
											Copy Layer ID
										</ContextMenuItem>
										<ContextMenuItem
											onClick={() => copyAdminSetNextLayerCommand()}
										>
											Copy Admin Set Next Layer Command
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
