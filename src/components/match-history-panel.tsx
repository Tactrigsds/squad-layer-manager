import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/hooks/use-toast'
import { getTeamsDisplay } from '@/lib/display-helpers-teams'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import { GENERAL } from '@/messages'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as QD from '@/systems.client/queue-dashboard'
import * as dateFns from 'date-fns'
import { AlertOctagon, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Info } from 'lucide-react'
import { useState } from 'react'
import React from 'react'
import * as Zus from 'zustand'
import { MapLayerDisplay } from './layer-display'
import LayerSourceDisplay from './layer-source-display'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

export default function MatchHistoryPanel() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const history = MatchHistoryClient.useRecentMatchHistory()
	const allEntries = React.useMemo(() => [...(history ?? [])].reverse(), [history])
	const historyState = MatchHistoryClient.useMatchHistoryState()
	const currentMatch = MatchHistoryClient.useCurrentMatchDetails()
	const violationDescriptors = LayerQueriesClient.useLayerStatuses().data?.violationDescriptors
	const hoveredConstraintItemId = Zus.useStore(QD.QDStore, s => s.hoveredConstraintItemId)

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

	// Process trigger alerts
	const triggerAlerts: React.ReactNode[] = []

	// Helper function to get alert priority (destructive > warning > info)
	const getTriggerPriority = (level: string): number => {
		switch (level) {
			case 'violation':
				return 3
			case 'warn':
				return 2
			case 'info':
				return 1
			default:
				return 0
		}
	}

	if (currentMatch) {
		// Map events with their variants
		const eventAlerts: Array<
			{ event: BAL.BalanceTriggerEvent; variant: 'default' | 'destructive' | 'info' | 'warning'; priority: number }
		> = []

		for (const eventId of historyState.activeTriggerEvents) {
			const event = historyState.recentBalanceTriggerEvents.find(e => e.id === eventId)
			if (!event) continue

			let variant: 'default' | 'destructive' | 'info' | 'warning'
			switch (event.level) {
				case 'info':
					variant = 'info'
					break
				case 'violation':
					variant = 'destructive'
					break
				case 'warn':
					variant = 'warning'
					break
				default:
					assertNever(event.level)
			}

			eventAlerts.push({
				event,
				variant,
				priority: getTriggerPriority(event.level),
			})
		}

		// Sort alerts by priority (highest first)
		eventAlerts.sort((a, b) => b.priority - a.priority)

		// Create alert nodes
		for (const { event, variant } of eventAlerts) {
			let AlertIcon
			switch (event.level) {
				case 'violation':
					AlertIcon = AlertOctagon
					break
				case 'warn':
					AlertIcon = AlertTriangle
					break
				case 'info':
					AlertIcon = Info
					break
				default:
					AlertIcon = Info
			}
			if (!BAL.isKnownEventInstance(event)) continue
			const trigger = BAL.TRIGGERS[event.triggerId]

			triggerAlerts.push(
				<Alert variant={variant} key={event.id} className="w-full">
					<AlertTitle className="flex items-center space-x-2">
						<AlertIcon title={event.level} className="h-4 w-4 mr-2" />
						{trigger.name}
					</AlertTitle>
					<AlertDescription>
						{GENERAL.balanceTrigger.showEvent(event, currentMatch)}
					</AlertDescription>
				</Alert>,
			)
		}
	}

	// Determine what to display
	const hasTriggers = triggerAlerts.length > 0
	const hasMultipleTriggers = triggerAlerts.length > 1
	const mostUrgentTrigger = triggerAlerts[0]

	return (
		<Card>
			<CardHeader className="flex flex-row justify-between items-start">
				<CardTitle>Match History</CardTitle>
				{hasTriggers && (
					<div className="flex flex-col space-y-1">
						{hasMultipleTriggers
							? (
								<Popover>
									<div className="flex flex-col space-y-1">
										{mostUrgentTrigger}
										<PopoverTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												className="flex items-center justify-center"
											>
												Show {triggerAlerts.length - 1} more
												<ChevronDown className="ml-1 h-4 w-4" />
											</Button>
										</PopoverTrigger>
									</div>
									<PopoverContent className="w-auto p-2 max-h-80 overflow-y-auto">
										<div className="flex flex-col space-y-2">
											{triggerAlerts.slice(1).map((trigger, i) => <div key={i}>{trigger}</div>)}
										</div>
									</PopoverContent>
								</Popover>
							)
							: mostUrgentTrigger}
					</div>
				)}
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
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow className="font-medium">
							<TableHead></TableHead>
							<TableHead></TableHead>
							<TableHead>Layer</TableHead>
							<TableHead>{globalSettings.displayTeamsNormalized ? 'Team A' : 'Team 1'}</TableHead>
							<TableHead className="text-center">Outcome</TableHead>
							<TableHead>{globalSettings.displayTeamsNormalized ? 'Team B' : 'Team 2'}</TableHead>
							<TableHead>Set By</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentEntries.map((entry, index) => {
							if (entry.historyEntryId === currentMatch?.historyEntryId) {
								return
							}
							const entryDescriptors = (hoveredConstraintItemId && violationDescriptors?.get(hoveredConstraintItemId)?.filter(d =>
								d.reasonItem?.type === 'history-entry' && d.reasonItem.historyEntryId === entry.historyEntryId
							)) || undefined
							let violatedProperties: Set<string> | undefined
							if (entryDescriptors) {
								violatedProperties = LQY.resolveViolatedLayerProperties(entryDescriptors, entry.ordinal % 2)
							}

							const extraLayerStyles: Record<string, string> = {}
							if (violatedProperties) {
								for (const v of violatedProperties.values()) {
									extraLayerStyles[v] = Typo.ConstraintViolationDescriptor
								}
							}
							const layer = L.toLayer(entry.layerId)
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
								const cmd = L.getAdminSetNextLayerCommand(entry.layerId)
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

							const [leftTeam, rightTeam] = getTeamsDisplay(
								layer,
								entry.ordinal % 2,
								globalSettings.displayTeamsNormalized,
								extraLayerStyles,
							)

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
											<TableCell>
												<MapLayerDisplay layer={layer.Layer!} extraLayerStyles={extraLayerStyles} />
											</TableCell>
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
										<ContextMenuItem
											onClick={() =>
												copyHistoryEntryId()}
										>
											copy history entry id
										</ContextMenuItem>
										<ContextMenuItem
											onClick={() =>
												copyLayerId()}
										>
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
			</CardContent>
		</Card>
	)
}

function formatTimeLeftWithZeros(timeLeft: number) {
	const duration = dateFns.intervalToDuration({ start: 0, end: timeLeft })
	const hours = duration.hours || 0
	const minutes = duration.minutes || 0
	const seconds = String(duration.seconds || 0).padStart(2, '0')

	if (hours === 0) {
		return `${String(minutes).padStart(2, '0')}:${seconds}`
	}

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds}`
}
