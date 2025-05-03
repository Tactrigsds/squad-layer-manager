import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/hooks/use-toast'
import * as DH from '@/lib/display-helpers'
import * as SM from '@/lib/rcon/squad-models'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as dateFns from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'

export default function MatchHistoryPanel() {
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

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					Match History<span className="ml-1 font-light">(most recent {allEntries.length} layers)</span>
				</CardTitle>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="font-medium"></TableHead>
							<TableHead className="font-medium"></TableHead>
							<TableHead className="font-medium">Layer</TableHead>
							<TableHead className="font-medium">Team 1</TableHead>
							<TableHead className="font-medium">Team 2</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentEntries.map((entry, index) => {
							const layer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(entry.layerId))
							const subfaction1 = layer.SubFac_1 ? DH.toShortSubfaction(layer.SubFac_1 ?? null) : undefined
							const subfaction2 = layer.SubFac_2 ? DH.toShortSubfaction(layer.SubFac_2 ?? null) : undefined
							const team1TicketDisp = entry.outcome.type !== 'draw' ? `(${entry.outcome.team1Tickets})` : undefined
							const team2TicketDisp = entry.outcome.type !== 'draw' ? `(${entry.outcome.team2Tickets})` : undefined
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

							return (
								<ContextMenu key={entry.historyEntryId}>
									<ContextMenuTrigger asChild>
										<TableRow>
											<TableCell className="font-mono text-xs">{idx.toString().padStart(2, '0')}</TableCell>
											<TableCell className="font-mono text-xs font-light">
												{formatTimeLeftWithZeros(gameRuntime)}
												<span className="ml-1 text-muted-foreground">
													(-{Math.floor(dateFns.differenceInHours(new Date(), entry.endTime))}h)
												</span>
											</TableCell>
											<TableCell className="font-mono text-sm">{layer.Layer}</TableCell>
											<TableCell className={`${entry.outcome.type === 'team1' ? 'underline' : ''}`}>
												{entry.outcome.type === 'team1' ? <span className="font-bold text-green-600">(W)</span> : ''}
												{entry.outcome.type === 'draw' ? <span className="font-medium text-amber-600">(D)</span> : ''}
												{layer.Faction_1} <span className="text-sm text-secondary-foreground">{subfaction1}</span>
												<span className="text-sm">{team1TicketDisp}</span>
											</TableCell>
											<TableCell>
												{entry.outcome.type === 'team2' ? <span className="font-bold text-green-600">(W)</span> : ''}
												{entry.outcome.type === 'draw' ? <span className="font-medium text-amber-600">(D)</span> : ''}
												{layer.Faction_2} <span className="text-sm text-secondary-foreground">{subfaction2}</span>
												<span className="text-sm">{team2TicketDisp}</span>
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
										<ContextMenuItem onClick={() => copyAdminSetNextLayerCommand()}>
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
