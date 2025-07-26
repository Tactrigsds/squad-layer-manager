import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from '@/hooks/use-toast'
import { getTeamsDisplay } from '@/lib/display-helpers-teams'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import { GENERAL } from '@/messages'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as QD from '@/systems.client/queue-dashboard'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as dateFns from 'date-fns'
import deepEqual from 'fast-deep-equal'
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
	const currentMatch = SquadServerClient.useCurrentMatch()
	const violationDescriptors = LayerQueriesClient.useLayerItemStatuses().data?.violationDescriptors
	const hoveredConstraintItemId = Zus.useStore(QD.QDStore, s => s.hoveredConstraintItemId)

	// -------- Pagination state --------
	const [currentPage, setCurrentPage] = useState(1)
	const itemsPerPage = MH.RECENT_HISTORY_ITEMS_PER_PAGE
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

	// Helper function to create trigger alerts for a specific entry
	const createTriggerAlertsForEntry = (
		events: BAL.BalanceTriggerEvent[],
		entry: MH.MatchDetails,
		isCurrent: boolean,
	): React.ReactNode[] => {
		if (events.length === 0) return []

		const eventAlerts: Array<
			{ event: BAL.BalanceTriggerEvent; variant: 'default' | 'destructive' | 'info' | 'warning'; priority: number }
		> = []

		for (const event of events) {
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
					variant = 'default'
			}

			eventAlerts.push({
				event,
				variant,
				priority: BAL.getTriggerPriority(event.level),
			})
		}

		// Sort alerts by priority (highest first)
		eventAlerts.sort((a, b) => b.priority - a.priority)

		// Create alert nodes
		const alerts: React.ReactNode[] = []
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

			alerts.push(
				<Alert variant={variant} key={event.id} className="w-full">
					<AlertTitle className="flex items-center space-x-2">
						<AlertIcon className="h-4 w-4 mr-2" />
						{trigger.name}
					</AlertTitle>
					<AlertDescription>
						{GENERAL.balanceTrigger.showEvent(event, entry, isCurrent)}
					</AlertDescription>
				</Alert>,
			)
		}

		return alerts
	}

	if (currentMatch) {
		// Map events with their variants
		const eventAlerts: Array<
			{ event: BAL.BalanceTriggerEvent; variant: 'default' | 'destructive' | 'info' | 'warning'; priority: number }
		> = []

		for (const event of MH.getActiveTriggerEvents(historyState)) {
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
				priority: BAL.getTriggerPriority(event.level),
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
						<AlertIcon className="h-4 w-4 mr-2" />
						{trigger.name}
					</AlertTitle>
					<AlertDescription>
						{GENERAL.balanceTrigger.showEvent(event, currentMatch, true)}
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
							<TableHead>Time</TableHead>
							<TableHead>Layer</TableHead>
							<TableHead>{globalSettings.displayTeamsNormalized ? 'Team A' : 'Team 1'}</TableHead>
							<TableHead className="text-center">Outcome</TableHead>
							<TableHead>{globalSettings.displayTeamsNormalized ? 'Team B' : 'Team 2'}</TableHead>
							<TableHead>Set By</TableHead>
							<TableHead className="text-center">Alerts</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentEntries.map((entry, index) => {
							if (entry.historyEntryId === currentMatch?.historyEntryId) {
								return
							}
							const layerItem: LQY.LayerItem = {
								type: 'match-history-entry',
								historyEntryId: entry.historyEntryId,
								layerId: entry.layerId,
							}
							const entryDescriptors = (hoveredConstraintItemId
								&& violationDescriptors?.get(hoveredConstraintItemId)?.filter(d => deepEqual(layerItem, d.reasonItem))) || undefined

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
							const visibleIndex = index + 1 + (currentPage - 1) * itemsPerPage

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

							const [leftTeam, rightTeam] = getTeamsDisplay(
								layer,
								entry.ordinal % 2,
								globalSettings.displayTeamsNormalized,
								extraLayerStyles,
							)

							const events = historyState.recentBalanceTriggerEvents.filter(event => event.matchTriggeredId === entry.historyEntryId)
							// Get trigger info for this entry
							const triggerLevel = BAL.getHighestPriorityTriggerEvent(events)?.level
							const entryTriggerAlerts = createTriggerAlertsForEntry(events, entry, false)

							// Determine trigger icon
							let TriggerIcon = null
							let triggerIconColor = ''
							if (triggerLevel) {
								switch (triggerLevel) {
									case 'violation':
										TriggerIcon = AlertOctagon
										triggerIconColor = 'text-red-500'
										break
									case 'warn':
										TriggerIcon = AlertTriangle
										triggerIconColor = 'text-yellow-500'
										break
									case 'info':
										TriggerIcon = Info
										triggerIconColor = 'text-blue-500'
										break
								}
							}

							return (
								<ContextMenu key={entry.historyEntryId}>
									<ContextMenuTrigger asChild>
										<TableRow>
											<TableCell className="font-mono text-xs">{visibleIndex.toString().padStart(2, '0')}</TableCell>
											<TableCell className="text-xs ">
												{entry.startTime
													? <span className="font-mono font-light">{formatMatchTimeAndDuration(entry.startTime, gameRuntime)}</span>
													: <Badge variant="secondary">incomplete</Badge>}
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
											<TableCell className="text-center">
												{TriggerIcon && entryTriggerAlerts.length > 0 && (
													<Tooltip delayDuration={0}>
														<TooltipTrigger asChild>
															<Button
																variant="ghost"
																size="sm"
																className={`h-6 w-6 p-0 ${triggerIconColor}`}
															>
																<TriggerIcon className="h-4 w-4" />
															</Button>
														</TooltipTrigger>
														<TooltipContent side="right" className="w-auto p-2 max-h-80 overflow-y-auto bg-background">
															<div className="flex flex-col space-y-2">
																{entryTriggerAlerts.map((alert, i) => <div key={i}>{alert}</div>)}
															</div>
														</TooltipContent>
													</Tooltip>
												)}
											</TableCell>
										</TableRow>
									</ContextMenuTrigger>
									<ContextMenuContent>
										<ContextMenuItem
											onClick={() => copyHistoryEntryId()}
										>
											copy history entry id
										</ContextMenuItem>
										<ContextMenuItem
											onClick={() => copyLayerId()}
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

function formatMatchTimeAndDuration(startTime: Date, gameRuntime?: number) {
	// Format the start time as HH:mm:ss (24-hour format)
	const formattedStartTime = dateFns.format(startTime, 'HH:mm:ss')

	// Calculate time difference from now
	const difference = dateFns.differenceInHours(new Date(), startTime)
	let timeDifferenceText = ''
	if (difference === 0) {
		timeDifferenceText = `${Math.floor(dateFns.differenceInMinutes(new Date(), startTime))} minutes ago`
	} else {
		timeDifferenceText = `${Math.floor(difference)} hours ago`
	}

	// Calculate match length in minutes if runtime is available
	if (gameRuntime) {
		// Convert milliseconds to minutes and round to nearest whole number
		const matchLengthMinutes = Math.round(gameRuntime / (1000 * 60))
		return (
			<span title={timeDifferenceText}>
				{`${formattedStartTime}`}
				<span className="text-muted-foreground">({`${matchLengthMinutes}m`})</span>
			</span>
		)
	}

	return <span title={timeDifferenceText}>{formattedStartTime}</span>
}
