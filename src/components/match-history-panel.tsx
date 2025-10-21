import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as DH from '@/lib/display-helpers'
import { getTeamsDisplay } from '@/lib/display-helpers-teams'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand.ts'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models.ts'
import * as DndKit from '@/systems.client/dndkit'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import { useState } from 'react'
import React from 'react'
import * as Zus from 'zustand'
import BalanceTriggerAlert from './balance-trigger-alert'
import { ConstraintViolationDisplay } from './constraint-violation-display'
import LayerSourceDisplay from './layer-source-display'
import { LayerContextMenuItems } from './layer-table-helpers'
import MapLayerDisplay from './map-layer-display'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

interface MatchHistoryRowProps {
	entry: MH.MatchDetails
	index: number
	currentMatch: MH.MatchDetails | null
	layerStatusesRes: LQY.LayerItemStatuses | undefined
	constraints: LQY.LayerQueryConstraint[]
	violationDescriptors: Map<string, LQY.ViolationDescriptor[]> | undefined
	hoveredConstraintItemId: string | undefined
	globalSettings: GlobalSettingsStore
	historyState: MH.PublicMatchHistoryState
	_currentStreak: BAL.CurrentStreak | null
	createTriggerAlertsForEntry: (events: BAL.BalanceTriggerEvent[], entry: MH.MatchDetails) => React.ReactNode[]
}

function MatchHistoryRow({
	entry,
	index,
	currentMatch,
	layerStatusesRes,
	constraints,
	violationDescriptors,
	hoveredConstraintItemId,
	globalSettings,
	historyState,
	_currentStreak,
	createTriggerAlertsForEntry,
}: MatchHistoryRowProps) {
	const dragProps = DndKit.useDraggable({
		type: 'history-entry',
		id: entry.historyEntryId,
	})
	if (entry.historyEntryId === currentMatch?.historyEntryId) {
		return null
	}

	const layerItem: LQY.LayerItem = {
		type: 'match-history-entry',
		historyEntryId: entry.historyEntryId,
		layerId: entry.layerId,
	}
	const layerItemId = LQY.toLayerItemId(layerItem)
	const localBlockedConstraints = layerStatusesRes?.blocked.get(layerItemId)
	const localDescriptors = violationDescriptors?.get(layerItemId)
	const isHovered = hoveredConstraintItemId === layerItemId
	const violationDisplayElt = localBlockedConstraints && (
		<ConstraintViolationDisplay
			violated={Array.from(localBlockedConstraints).map(id => constraints.find(c => c.id === id)).filter(c => c !== undefined)}
			violationDescriptors={localDescriptors}
			itemId={layerItemId}
		/>
	)
	const relevantDesciptorsForHovered = (hoveredConstraintItemId
		&& violationDescriptors?.get(hoveredConstraintItemId)?.filter(d => Obj.deepEqual(layerItem, d.reasonItem))) || undefined

	const extraLayerStyles = DH.getAllExtraStyles(
		entry.layerId,
		entry.ordinal,
		globalSettings.displayTeamsNormalized,
		(isHovered ? localDescriptors : undefined) ?? relevantDesciptorsForHovered,
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

	const events = historyState.recentBalanceTriggerEvents.filter(event => event.matchTriggeredId === entry.historyEntryId)
	// Get trigger info for this entry
	const triggerLevel = BAL.getHighestPriorityTriggerEvent(events)?.level
	const entryTriggerAlerts = createTriggerAlertsForEntry(events, entry)

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
					<TableCell className="hidden min-[900px]:table-cell">
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
	const historyState = MatchHistoryClient.useMatchHistoryState()
	const currentMatch = SquadServerClient.useCurrentMatch()
	const layerStatusesRes = LayerQueriesClient.useLayerItemStatuses().data
	const constraints = ZusUtils.useStoreDeep(ServerSettingsClient.Store, s => SS.getPoolConstraints(s.saved.queue.mainPool))
	const violationDescriptors = layerStatusesRes?.violationDescriptors
	const hoveredConstraintItemId = Zus.useStore(LayerQueriesClient.Store, s => s.hoveredConstraintItemId)

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

	// Helper function to create trigger alerts for a specific entry
	const createTriggerAlertsForEntry = (
		events: BAL.BalanceTriggerEvent[],
		entry: MH.MatchDetails,
	): React.ReactNode[] => {
		if (events.length === 0) return []

		const alerts: React.ReactNode[] = ([...events]
			.sort((a, b) => BAL.getTriggerPriority(b.level) - BAL.getTriggerPriority(a.level)))
			.map(
				event => <BalanceTriggerAlert event={event} referenceMatch={entry} />,
			)

		return alerts
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
							: currentEntries.map((entry, index) => (
								<MatchHistoryRow
									key={entry.historyEntryId}
									entry={entry}
									index={index}
									currentMatch={currentMatch}
									layerStatusesRes={layerStatusesRes}
									constraints={constraints}
									violationDescriptors={violationDescriptors}
									hoveredConstraintItemId={hoveredConstraintItemId ?? undefined}
									globalSettings={globalSettings}
									historyState={historyState}
									_currentStreak={currentStreak}
									createTriggerAlertsForEntry={createTriggerAlertsForEntry}
								/>
							))}
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
				{`${formattedStartTime}`}
				<span className="text-muted-foreground">({`${matchLengthMinutes}m`})</span>
			</span>
		)
	}

	return <span title={timeDifferenceText}>{formattedStartTime}</span>
}
