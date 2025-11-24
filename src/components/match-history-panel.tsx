import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell as ShadcnTableCell, TableHead as ShadcnTableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as DH from '@/lib/display-helpers'
import { getTeamsDisplay } from '@/lib/display-helpers-teams'
import { assertNever } from '@/lib/type-guards'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import type * as MH from '@/models/match-history.models'
import * as DndKit from '@/systems.client/dndkit'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import { useState } from 'react'
import React from 'react'
import * as Zus from 'zustand'
import BalanceTriggerAlert from './balance-trigger-alert'
import { ConstraintMatchesIndicator } from './constraint-matches-indicator'
import LayerSourceDisplay from './layer-source-display'
import { LayerContextMenuItems } from './layer-table-helpers'
import MapLayerDisplay from './map-layer-display'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const STD_PADDING = 'pl-4'

// Wrapper components for consistent styling
function TableHead({ className = '', ...props }: React.ComponentProps<typeof ShadcnTableHead>) {
	return <ShadcnTableHead className={`${STD_PADDING} ${className}`} {...props} />
}

function TableCell({ className = '', ...props }: React.ComponentProps<typeof ShadcnTableCell>) {
	return <ShadcnTableCell className={`${STD_PADDING} ${className}`} {...props} />
}

interface MatchHistoryRowProps {
	entry: MH.MatchDetails
	index: number
	balanceTriggerEvents: BAL.BalanceTriggerEvent[]
}

function MatchHistoryRow({
	entry,
	index,
	balanceTriggerEvents,
}: MatchHistoryRowProps) {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const currentMatch = SquadServerClient.useCurrentMatch()

	const dragProps = DndKit.useDraggable({
		type: 'history-entry',
		id: entry.historyEntryId,
	})
	const statusData = LayerQueriesClient.useLayerItemStatusData(entry.historyEntryId)

	// Get trigger info for this entry
	const triggerLevel = BAL.getHighestPriorityTriggerEvent(balanceTriggerEvents)?.level

	// Create trigger alerts for this entry
	const entryTriggerAlerts = React.useMemo(() => {
		if (balanceTriggerEvents.length === 0) return []

		const alerts: React.ReactNode[] = ([...balanceTriggerEvents]
			.sort((a, b) => BAL.getTriggerPriority(b.level) - BAL.getTriggerPriority(a.level)))
			.map(
				(event) => <BalanceTriggerAlert key={event.id} className="rounded-none" event={event} referenceMatch={entry} />,
			)

		return alerts
	}, [balanceTriggerEvents, entry])

	if (entry.historyEntryId === currentMatch?.historyEntryId) {
		return null
	}

	const violationDisplayElt = statusData && (
		<ConstraintMatchesIndicator
			queriedConstraints={statusData.queriedConstraints}
			matchingConstraintIds={statusData.matchingConstraintIds}
			padEmpty={true}
			itemId={entry.historyEntryId}
		/>
	)

	const extraLayerStyles = DH.getAllExtraStyles(
		entry.layerId,
		entry.ordinal,
		globalSettings.displayTeamsNormalized,
		statusData?.highlightedMatchDescriptors,
	)

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

		outcomeDisp = (
			<span>
				{team1Tickets} <span className={team1Status === 'W' ? 'text-green-500' : 'text-red-500'}>{team1Status}</span> -{' '}
				<span className={team2Status === 'W' ? 'text-green-500' : 'text-red-500'}>{team2Status}</span> {team2Tickets}
			</span>
		)
	}
	const gameRuntime = (entry.startTime && entry.status === 'post-game')
		? entry.endTime.getTime() - entry.startTime.getTime()
		: undefined
	const visibleIndex = index + 1

	const [leftTeam, rightTeam] = getTeamsDisplay(
		layer,
		entry.ordinal,
		globalSettings.displayTeamsNormalized,
		extraLayerStyles,
	)

	// Determine trigger icon
	let TriggerIcon = null
	let triggerIconColor = ''
	if (triggerLevel) {
		switch (triggerLevel) {
			case 'violation':
				TriggerIcon = Icons.AlertOctagon
				triggerIconColor = 'text-red-500'
				break
			case 'warn':
				TriggerIcon = Icons.AlertTriangle
				triggerIconColor = 'text-yellow-500'
				break
			case 'info':
				TriggerIcon = Icons.Info
				triggerIconColor = 'text-blue-500'
				break
			default:
				assertNever(triggerLevel)
		}
	}

	return (
		<ContextMenu key={entry.historyEntryId}>
			<ContextMenuTrigger asChild>
				<TableRow
					ref={dragProps.ref}
					data-is-dragging={dragProps.isDragging}
					className="whitespace-nowrap bg-background data-[is-dragging=true]:outline group rounded"
				>
					<TableCell className="font-mono text-xs relative">
						<div className="opacity-0 group-hover:opacity-100 absolute inset-0 flex items-center justify-center">
							<Icons.GripVertical className="h-4 w-4" />
						</div>
						<div className="group-hover:opacity-0">
							{visibleIndex.toString().padStart(2, '0')}
						</div>
					</TableCell>
					<TableCell className="text-xs hidden min-[820px]:table-cell">
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
						<span className="w-full flex justify-center">
							<LayerSourceDisplay source={entry.layerSource} />
						</span>
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
								<TooltipContent
									side="right"
									className="w-auto overflow-y-auto border-none bg-background rounded-none p-0 text-muted-foreground flex flex-col gap-1"
								>
									{entryTriggerAlerts}
								</TooltipContent>
							</Tooltip>
						)}
						{violationDisplayElt}
					</TableCell>
				</TableRow>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<LayerContextMenuItems selectedLayerIds={[entry.layerId]} selectedHistoryEntryIds={[entry.historyEntryId]} />
			</ContextMenuContent>
		</ContextMenu>
	)
}

export default function MatchHistoryPanel() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const history = MatchHistoryClient.useRecentMatchHistory()
	const historyState = MatchHistoryClient.useMatchHistoryState()
	const [currentStreak, matchesByDate, availableDates] = React.useMemo(() => {
		const allEntries = [...(history ?? [])].reverse()
		const matchesByDate = new Map<string, typeof allEntries>()

		// Add matches with startTime grouped by date
		for (const entry of allEntries) {
			if (entry.startTime) {
				const dateStr = dateFns.format(entry.startTime, 'yyyy-MM-dd')
				if (!matchesByDate.has(dateStr)) {
					matchesByDate.set(dateStr, [])
				}
				matchesByDate.get(dateStr)!.push(entry)
			} else {
				continue
			}
		}

		const availableDates = Array.from(matchesByDate.keys()).sort((a, b) => b.localeCompare(a))
		return [BAL.getCurrentStreak(history), matchesByDate, availableDates]
	}, [history])

	// -------- Date-based pagination --------
	const [currentPage, setCurrentPage] = useState(1)

	const totalPages = Math.max(availableDates.length, 1)
	const currentDate = availableDates[currentPage - 1]
	const currentEntries = currentDate ? matchesByDate.get(currentDate) || [] : []

	// Reset to page 1 if current page is beyond available dates
	React.useEffect(() => {
		if (currentPage > totalPages && totalPages > 0) {
			setCurrentPage(1)
		}
	}, [currentPage, totalPages])

	// -------- Page navigation --------
	const goToNextPage = () => setCurrentPage(prev => Math.min(prev + 1, totalPages))
	const goToPrevPage = () => setCurrentPage(prev => Math.max(prev - 1, 1))

	// -------- Date display helpers --------
	const getDateDisplayText = (dateStr: string) => {
		const today = new Date()
		const date = new Date(dateStr + 'T00:00:00')

		return date.toLocaleDateString() + (dateFns.isSameDay(date, today) ? ' (Today)' : '')
	}

	return (
		<Card>
			<CardHeader className="flex flex-row justify-between items-start">
				<CardTitle>Match History</CardTitle>
				{availableDates.length > 1 && (
					<div className="flex items-center justify-center space-x-2 mt-4">
						<Button
							variant="outline"
							size="sm"
							onClick={goToPrevPage}
							disabled={currentPage === 1}
						>
							<Icons.ChevronLeft className="h-4 w-4" />
						</Button>
						<span className="text-sm font-mono">
							<span>{currentDate ? getDateDisplayText(currentDate) : 'No matches'}</span>
							{availableDates.length > 1 && (
								<span className="text-muted-foreground ml-1">
									({currentPage} of {availableDates.length})
								</span>
							)}
						</span>
						<Button
							variant="outline"
							size="sm"
							onClick={goToNextPage}
							disabled={currentPage === availableDates.length}
						>
							<Icons.ChevronRight className="h-4 w-4" />
						</Button>
					</div>
				)}
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow className="font-medium">
							<TableHead></TableHead>
							<TableHead className="hidden min-[820px]:table-cell">Time</TableHead>
							<TableHead>Layer</TableHead>
							<TableHead>
								{globalSettings.displayTeamsNormalized ? 'Team A' : 'Team 1'}
								{globalSettings.displayTeamsNormalized && currentStreak && currentStreak.length > 1 && currentStreak.team === 'teamA' && (
									<span className="text-green-600 font-medium ml-1">({currentStreak.length} wins)</span>
								)}
							</TableHead>
							<TableHead className="text-center">Outcome</TableHead>
							<TableHead>
								{globalSettings.displayTeamsNormalized ? 'Team B' : 'Team 2'}
								{globalSettings.displayTeamsNormalized && currentStreak && currentStreak.length > 1 && currentStreak.team === 'teamB' && (
									<span className="text-green-600 font-medium ml-1">({currentStreak.length} wins)</span>
								)}
							</TableHead>
							<TableHead className="hidden min-[900px]:table-cell">Set By</TableHead>
							<TableHead className="text-center"></TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentEntries.length === 0
							? (
								<TableRow>
									<TableCell colSpan={8} className="text-center text-muted-foreground py-8 hidden min-[900px]:table-cell">
										{availableDates.length === 0
											? 'No matches found'
											: `No matches for ${currentDate ? getDateDisplayText(currentDate) : 'this date'}`}
									</TableCell>
									<TableCell
										colSpan={7}
										className="text-center text-muted-foreground py-8 hidden min-[820px]:table-cell min-[900px]:hidden"
									>
										{availableDates.length === 0
											? 'No matches found'
											: `No matches for ${currentDate ? getDateDisplayText(currentDate) : 'this date'}`}
									</TableCell>
									<TableCell colSpan={6} className="text-center text-muted-foreground py-8 table-cell min-[820px]:hidden">
										{availableDates.length === 0
											? 'No matches found'
											: `No matches for ${currentDate ? getDateDisplayText(currentDate) : 'this date'}`}
									</TableCell>
								</TableRow>
							)
							: currentEntries.map((entry, index) => {
								const balanceTriggerEvents = historyState.recentBalanceTriggerEvents.filter(
									event => event.matchTriggeredId === entry.historyEntryId,
								)
								return (
									<MatchHistoryRow
										key={entry.historyEntryId}
										entry={entry}
										index={index}
										balanceTriggerEvents={balanceTriggerEvents}
									/>
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
	const formattedStartTime = dateFns.format(startTime, 'HH:mm')

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
				{formattedStartTime}
				<span className="text-muted-foreground">({matchLengthMinutes}m)</span>
			</span>
		)
	}

	return <span title={timeDifferenceText}>{formattedStartTime}</span>
}
