import { getTeamsDisplay } from '@/components/teams-display'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell as ShadcnTableCell, TableHead as ShadcnTableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import type * as MH from '@/models/match-history.models'
import * as DndKit from '@/systems.client/dndkit'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'

import { cn } from '@/lib/utils'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import BalanceTriggerAlert from './balance-trigger-alert'
import { ConstraintMatchesIndicator } from './constraint-matches-indicator'
import LayerSourceDisplay from './layer-source-display'
import { LayerContextMenuItems } from './layer-table-helpers'
import MapLayerDisplay from './map-layer-display'
import { Button } from './ui/button'

const STD_PADDING = 'pl-4'

const MAX_PAGES = 5

export function MatchHistoryPanelContent() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const historyState = MatchHistoryClient.useMatchHistoryState()
	const history = historyState.recentMatches.slice(0, historyState.recentMatches.length - 1)
	const [showFullDay, setShowFullDay] = React.useState(false)
	const currentMatch = historyState.recentMatches ? historyState.recentMatches[historyState.recentMatches.length - 1] : undefined
	const currentMatchOrdinal = currentMatch?.ordinal ?? 0
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
			}
		}

		const availableDates = Array.from(matchesByDate.keys()).sort((a, b) => b.localeCompare(a))
		return [BAL.getCurrentStreak(history), matchesByDate, availableDates]
	}, [history])

	// -------- Page-based navigation --------
	const [currentPage, setCurrentPage] = React.useState(1)

	const totalPages = Math.min(availableDates.length, MAX_PAGES)
	const currentDate = availableDates[currentPage - 1]
	let currentEntries = currentDate ? [...matchesByDate.get(currentDate) || []] : []
	if (!showFullDay) currentEntries = currentEntries.slice(0, 5)
	currentEntries.reverse()

	// -------- Page navigation --------
	const goToFirstPage = () => {
		setCurrentPage(1)
		setShowFullDay(true)
	}
	const goToPrevPage = () => {
		setCurrentPage(prev => Math.max(prev - 1, 1))
		setShowFullDay(true)
	}
	const goToNextPage = () => {
		setCurrentPage(prev => Math.min(prev + 1, totalPages))
		setShowFullDay(true)
	}
	const goToLastPage = () => {
		setCurrentPage(totalPages)
		setShowFullDay(true)
	}

	// -------- Date display helpers --------
	const getDateDisplayText = () => {
		if (!currentDate) return 'No matches'

		const date = new Date(currentDate + 'T00:00:00')
		const today = new Date()
		today.setHours(0, 0, 0, 0)

		if (dateFns.isSameDay(date, today)) {
			return 'Today'
		} else if (dateFns.isSameDay(date, dateFns.subDays(today, 1))) {
			return 'Yesterday'
		} else {
			return dateFns.format(date, 'MMM d, yyyy')
		}
	}

	return (
		<>
			<CardHeader className="flex flex-row justify-between items-start">
				<CardTitle>Match History</CardTitle>
				<div className="flex items-center gap-1">
					<div className="flex items-center">
						<Button
							variant="outline"
							size="sm"
							onClick={goToFirstPage}
							disabled={currentPage === 1}
							className="rounded-r-none px-2"
						>
							<Icons.ChevronsLeft className="h-4 w-4" />
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={goToPrevPage}
							disabled={currentPage === 1}
							className="rounded-l-none border-l-0 px-2"
						>
							<Icons.ChevronLeft className="h-4 w-4" />
						</Button>
					</div>
					<span className="text-sm font-mono min-w-[100px] text-center px-2">
						{getDateDisplayText()}
					</span>
					<div className="flex items-center">
						<Button
							variant="outline"
							size="sm"
							onClick={goToNextPage}
							disabled={currentPage === totalPages}
							className="rounded-r-none px-2"
						>
							<Icons.ChevronRight className="h-4 w-4" />
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={goToLastPage}
							disabled={currentPage === totalPages}
							className="rounded-l-none border-l-0 px-2"
						>
							<Icons.ChevronsRight className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent className="px-1">
				<Table>
					<TableHeader>
						<TableRow className="font-medium">
							<TableHead></TableHead>
							{/*<TableHead className="hidden min-[820px]:table-cell">Time</TableHead>*/}
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
							<TableHead className="text-center px-0.5 flex flex-row justify-end items-center" title="Layer Indicators">
								<Icons.Flag />
							</TableHead>
							<TableHead className="hidden min-[900px]:table-cell pr-0.5">
								<span title="Set By">
									<Icons.User />
								</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentDate && matchesByDate.get(currentDate) && matchesByDate.get(currentDate)!.length > 5 && (
							<TableRow>
								<TableCell colSpan={100} className="p-0">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setShowFullDay(!showFullDay)}
										className="w-full h-7 rounded-none"
									>
										{showFullDay
											? (
												<>
													<Icons.ChevronsDownUp className="h-4 w-4 mr-1" />Show Less
												</>
											)
											: (
												<>
													<Icons.ChevronsUpDown className="h-4 w-4 mr-1" />Show full day
												</>
											)}
									</Button>
								</TableCell>
							</TableRow>
						)}
						{currentEntries.length === 0
							? (
								<TableRow>
									<TableCell colSpan={8} className="text-center text-muted-foreground py-8 hidden min-[900px]:table-cell">
										No matches found
									</TableCell>
									<TableCell
										colSpan={7}
										className="text-center text-muted-foreground py-8 hidden min-[820px]:table-cell min-[900px]:hidden"
									>
										No matches found
									</TableCell>
									<TableCell colSpan={6} className="text-center text-muted-foreground py-8 table-cell min-[820px]:hidden">
										No matches found
									</TableCell>
								</TableRow>
							)
							: currentEntries.map((entry) => {
								const balanceTriggerEvents = historyState.recentBalanceTriggerEvents.filter(
									event => event.matchTriggeredId === entry.historyEntryId,
								)
								return (
									<MatchHistoryRow
										key={entry.historyEntryId}
										entry={entry}
										currentMatchOffset={currentMatchOrdinal - entry.ordinal}
										balanceTriggerEvents={balanceTriggerEvents}
									/>
								)
							})}
					</TableBody>
				</Table>
			</CardContent>
		</>
	)
}

export default function MatchHistoryPanel() {
	return (
		<Card>
			<MatchHistoryPanelContent />
		</Card>
	)
}

interface MatchHistoryRowProps {
	entry: MH.MatchDetails
	currentMatchOffset: number
	balanceTriggerEvents: BAL.BalanceTriggerEvent[]
}

function MatchHistoryRow({
	entry,
	currentMatchOffset,
	balanceTriggerEvents,
}: MatchHistoryRowProps) {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const currentMatch = MatchHistoryClient.useCurrentMatch()

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
			matchDescriptors={statusData.matchingDescriptors}
			padEmpty={true}
			side="right"
			layerItem={LQY.getLayerItemForMatchHistoryEntry(entry)}
			itemParity={entry.ordinal}
		/>
	)

	const extraLayerStyles = React.useMemo(() => {
		return DH.getAllExtraStyles(
			entry.layerId,
			entry.ordinal,
			globalSettings.displayTeamsNormalized,
			statusData?.highlightedMatchDescriptors,
		)
	}, [entry.layerId, entry.ordinal, globalSettings.displayTeamsNormalized, statusData?.highlightedMatchDescriptors])

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
					className={cn(Typo.LayerText, 'whitespace-nowrap bg-background data-[is-dragging=true]:outline group rounded text-xs')}
				>
					<TableCell className="font-mono text-xs relative">
						<div className="opacity-0 group-hover:opacity-100 absolute inset-0 flex items-center justify-center p-0">
							<Icons.GripVertical className="h-4 w-4" />
						</div>
						<div className="group-hover:opacity-0 ">
							-{currentMatchOffset.toString()}
						</div>
					</TableCell>
					{
						/*<TableCell className="text-xs hidden min-[820px]:table-cell">
						{entry.startTime
							? <span className="font-mono font-light">{formatMatchTimeAndDuration(entry.startTime, gameRuntime)}</span>
							: <Badge variant="secondary">incomplete</Badge>}
					</TableCell>*/
					}
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

					<TableCell>
						<span className="w-full flex justify-center">
							<LayerSourceDisplay source={entry.layerSource} />
						</span>
					</TableCell>
				</TableRow>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<LayerContextMenuItems selectedLayerIds={[entry.layerId]} selectedHistoryEntryIds={[entry.historyEntryId]} />
			</ContextMenuContent>
		</ContextMenu>
	)
}

function TableHead({ className = '', ...props }: React.ComponentProps<typeof ShadcnTableHead>) {
	return <ShadcnTableHead className={`${STD_PADDING} ${className}`} {...props} />
}

function TableCell({ className = '', ...props }: React.ComponentProps<typeof ShadcnTableCell>) {
	return <ShadcnTableCell className={`${STD_PADDING} ${className}`} {...props} />
}
