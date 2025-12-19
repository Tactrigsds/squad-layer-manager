import { getTeamsDisplay } from '@/components/teams-display'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell as ShadcnTableCell, TableHead as ShadcnTableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import type * as MH from '@/models/match-history.models'
import * as DndKit from '@/systems.client/dndkit'
import * as FeatureFlags from '@/systems.client/feature-flags'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import BalanceTriggerAlert from './balance-trigger-alert'
import { ConstraintMatchesIndicator } from './constraint-matches-indicator'
import LayerSourceDisplay from './layer-source-display'
import { LayerContextMenuItems } from './layer-table-helpers'
import MapLayerDisplay from './map-layer-display'
import { Timer } from './timer'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const STD_PADDING = 'pl-4'

const MAX_PAGES = 30

export function MatchHistoryPanelContent() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const featureFlags = FeatureFlags.useFeatureFlags()
	const historyState = MatchHistoryClient.useMatchHistoryState()
	const history = historyState.recentMatches
	const [showFullDay, setShowFullDay] = React.useState(false)
	type MatchesByDate = [string, MH.MatchDetails[]][]
	const [currentStreak, matchesByDate, currentMatchOrdinal] = React.useMemo(() => {
		const matchesByDate: MatchesByDate = []

		// We can't resolve a day of matches without any previous dates to go by so we just skip those
		let firstMatchIndex = history.findIndex(m => m.startTime)
		if (firstMatchIndex === -1) {
			firstMatchIndex = history.findIndex(m => m.createdAt)
		}

		const firstMatch: MH.MatchDetails | undefined = history[firstMatchIndex]
		const firstMatchDate = firstMatch?.startTime ?? firstMatch?.createdAt ?? new Date()

		const allDaysSinceFirstMatch = dateFns.eachDayOfInterval({ start: firstMatchDate, end: new Date() })
		for (const day of allDaysSinceFirstMatch.slice(Math.max(0, allDaysSinceFirstMatch.length - MAX_PAGES))) {
			const dayString = dateFns.format(day, 'yyyy-MM-dd')
			matchesByDate.push([dayString, []])
		}

		let lastDate = firstMatchDate
		for (const entry of history.slice(firstMatchIndex)) {
			let date = entry.startTime ?? entry.createdAt
			if (date) lastDate = date
			else date = lastDate
			if (!date) {
				console.warn(`entry ${entry.historyEntryId} filtered out due to missing date`)
				continue
			}

			const dateStr = dateFns.format(date, 'yyyy-MM-dd')
			for (const [key, matches] of matchesByDate) {
				if (key === dateStr) {
					matches.push(entry)
					break
				}
			}
		}

		const currentMatchOrdinal = history[history.length - 1]?.ordinal ?? 0
		return [BAL.getCurrentStreak(history), matchesByDate, currentMatchOrdinal]
	}, [history])

	// -------- Page-based navigation --------
	const [currentPage, setCurrentPage] = React.useState(1)

	const [currentDate, currentEntries] = matchesByDate[matchesByDate.length - currentPage]
	const onFirstPage = currentPage === 1
	const totalPages = matchesByDate.length
	const onLastPage = currentPage === totalPages

	// -------- Page navigation --------
	const goToFirstPage = () => {
		setCurrentPage(1)
		setShowFullDay(true)
	}
	const goToPrevPage = () => {
		setCurrentPage((prev) => Math.max(prev - 1, 1))
		setShowFullDay(true)
	}
	const goToNextPage = () => {
		setCurrentPage((prev) => Math.min(prev + 1, totalPages))
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
							disabled={onFirstPage}
							className="rounded-r-none px-2"
						>
							<Icons.ChevronsLeft className="h-4 w-4" />
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={goToPrevPage}
							disabled={onFirstPage}
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
							disabled={onLastPage}
							className="rounded-r-none px-2"
						>
							<Icons.ChevronRight className="h-4 w-4" />
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={goToLastPage}
							disabled={onLastPage}
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
							<TableHead className="text-right px-0.5">
								{currentEntries.length > 5 && (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setShowFullDay(!showFullDay)}
										className="h-6 w-6 p-0"
										title={showFullDay ? 'Show less' : 'Show full day'}
									>
										{showFullDay ? <Icons.ChevronsDownUp className="h-4 w-4" /> : <Icons.ChevronsUpDown className="h-4 w-4" />}
									</Button>
								)}
							</TableHead>
							<TableHead className="hidden min-[820px]:table-cell">
								Time
							</TableHead>
							<TableHead>Layer</TableHead>
							<TableHead>
								{globalSettings.displayTeamsNormalized ? 'Team A' : 'Team 1'}
								{globalSettings.displayTeamsNormalized
									&& currentStreak
									&& currentStreak.length > 1
									&& currentStreak.team === 'teamA' && (
									<span className="text-green-600 font-medium ml-1">
										({currentStreak.length} wins)
									</span>
								)}
							</TableHead>
							<TableHead className="text-center">Outcome</TableHead>
							<TableHead>
								{globalSettings.displayTeamsNormalized ? 'Team B' : 'Team 2'}
								{globalSettings.displayTeamsNormalized
									&& currentStreak
									&& currentStreak.length > 1
									&& currentStreak.team === 'teamB' && (
									<span className="text-green-600 font-medium ml-1">
										({currentStreak.length} wins)
									</span>
								)}
							</TableHead>
							<TableHead
								className="text-center px-0.5"
								title="Layer Indicators"
							>
								<div className="flex flex-row justify-end items-center">
									<Icons.Flag />
								</div>
							</TableHead>
							<TableHead className="hidden min-[900px]:table-cell pr-0.5">
								<span title="Set By">
									<Icons.User />
								</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{currentEntries.length === 0
							? (
								<TableRow>
									<TableCell
										colSpan={8}
										className="text-center text-muted-foreground py-8 hidden min-[900px]:table-cell"
									>
										No matches found
									</TableCell>
									<TableCell
										colSpan={7}
										className="text-center text-muted-foreground py-8 hidden min-[820px]:table-cell min-[900px]:hidden"
									>
										No matches found
									</TableCell>
									<TableCell
										colSpan={6}
										className="text-center text-muted-foreground py-8 table-cell min-[820px]:hidden"
									>
										No matches found
									</TableCell>
								</TableRow>
							)
							: (
								currentEntries.map((entry) => {
									const balanceTriggerEvents = historyState.recentBalanceTriggerEvents.filter(
										(event) => event.matchTriggeredId === entry.historyEntryId,
									)
									return (
										<MatchHistoryRow
											key={entry.historyEntryId}
											entry={entry}
											currentMatchOffset={entry.ordinal - currentMatchOrdinal}
											balanceTriggerEvents={balanceTriggerEvents}
											debug__showBalanceTriggers={featureFlags.showMockBalanceTriggers}
										/>
									)
								})
							)}
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
	debug__showBalanceTriggers?: boolean
}

function MatchHistoryRow({
	entry,
	currentMatchOffset,
	balanceTriggerEvents,
	debug__showBalanceTriggers,
}: MatchHistoryRowProps) {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const serverRolling = !!SquadServerClient.useServerRolling()

	const dragProps = DndKit.useDraggable({
		type: 'history-entry',
		id: entry.historyEntryId,
	})
	const statusData = LayerQueriesClient.useLayerItemStatusData(
		entry.historyEntryId,
	)

	// Mock balance triggers for debug mode
	let effectiveBalanceTriggerEvents = balanceTriggerEvents
	if (debug__showBalanceTriggers) {
		const triggerLevels: BAL.TriggerWarnLevel[] = ['violation', 'warn', 'info']
		const mockLevel = triggerLevels[Math.abs(currentMatchOffset) % triggerLevels.length]
		const mockEvent: BAL.BalanceTriggerEvent = {
			id: Math.abs(currentMatchOffset) * 1000 + entry.historyEntryId,
			level: mockLevel,
			matchTriggeredId: entry.historyEntryId,
			triggerId: 'mock-trigger',
			triggerVersion: 1,
			strongerTeam: 'teamA',
			evaluationResult: {
				code: 'triggered',
				strongerTeam: 'teamA',
				messageTemplate: `Mock ${mockLevel} trigger for testing`,
				relevantInput: [],
			},
		}
		effectiveBalanceTriggerEvents = [mockEvent]
	}

	// Get trigger info for this entry
	const triggerLevel = BAL.getHighestPriorityTriggerEvent(
		effectiveBalanceTriggerEvents,
	)?.level

	// Create trigger alerts for this entry
	const entryTriggerAlerts = React.useMemo(() => {
		if (effectiveBalanceTriggerEvents.length === 0) return []

		const alerts: React.ReactNode[] = [...effectiveBalanceTriggerEvents]
			.sort(
				(a, b) => BAL.getTriggerPriority(b.level) - BAL.getTriggerPriority(a.level),
			)
			.map((event) => (
				<BalanceTriggerAlert
					key={event.id}
					className="rounded-none"
					event={event}
					referenceMatch={entry}
				/>
			))

		return alerts
	}, [effectiveBalanceTriggerEvents, entry])

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
	}, [
		entry.layerId,
		entry.ordinal,
		globalSettings.displayTeamsNormalized,
		statusData?.highlightedMatchDescriptors,
	])

	const layer = L.toLayer(entry.layerId)

	// Build status badge and outcome display
	let statusBadge: React.ReactNode = null
	let outcomeDisp: React.ReactNode = null

	if (entry.isCurrentMatch) {
		// Determine status badge (exactly one of: rolling, post-game, in-progress)
		if (serverRolling) {
			statusBadge = (
				<Badge variant="info" className="flex items-center whitespace-nowrap">
					<Icons.Loader2 className="mr-1 h-3 w-3 animate-spin" />
					<span>Switching to New Layer...</span>
				</Badge>
			)
		} else if (entry.status === 'post-game') {
			statusBadge = (
				<Badge
					variant="outline"
					className="flex items-center whitespace-nowrap"
				>
					<span className="pr-1">Post-Game</span>
					{entry.endTime !== 'unknown' && <Timer zeros start={entry.endTime.getTime()} className="font-mono" />}
				</Badge>
			)
		} else if (entry.status === 'in-progress') {
			statusBadge = (
				<Badge
					variant="secondary"
					className="flex items-center whitespace-nowrap"
				>
					<span>In progress</span>
				</Badge>
			)
		}
	}

	// Build outcome display if available
	if (entry.status === 'post-game') {
		if (entry.outcome.type === 'draw') {
			outcomeDisp = <span className="text-sm">Draw</span>
		} else if (entry.outcome.type === 'unknown') {
			outcomeDisp = <span className="text-sm">-</span>
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
				<span className="text-sm">
					{team1Tickets}{' '}
					<span
						className={team1Status === 'W' ? 'text-green-500' : 'text-red-500'}
					>
						{team1Status}
					</span>{' '}
					-{' '}
					<span
						className={team2Status === 'W' ? 'text-green-500' : 'text-red-500'}
					>
						{team2Status}
					</span>{' '}
					{team2Tickets}
				</span>
			)
		}
	} else if (!entry.isCurrentMatch) {
		outcomeDisp = <span className="text-sm">-</span>
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

	const gameRuntime = entry.startTime && entry.status === 'post-game' && entry.endTime !== 'unknown'
		? entry.endTime.getTime() - entry.startTime.getTime()
		: undefined

	// Determine background color and hover state based on trigger level or current match
	let bgColor = ''
	let hoverColor = ''
	if (entry.isCurrentMatch && entry.status === 'in-progress') {
		bgColor = 'bg-green-500/20'
		hoverColor = 'hover:bg-green-500/30'
	} else if (triggerLevel === 'violation') {
		bgColor = 'bg-red-500/10'
		hoverColor = 'hover:bg-red-500/20'
	} else if (triggerLevel === 'warn') {
		bgColor = 'bg-yellow-500/10'
		hoverColor = 'hover:bg-yellow-500/20'
	} else if (triggerLevel === 'info') {
		bgColor = 'bg-blue-500/10'
		hoverColor = 'hover:bg-blue-500/20'
	}

	return (
		<ContextMenu key={entry.historyEntryId}>
			<ContextMenuTrigger asChild>
				<TableRow
					title="Right click for Context Menu, Click+drag to requeue"
					ref={dragProps.ref}
					data-is-dragging={dragProps.isDragging}
					className={cn(
						Typo.LayerText,
						'whitespace-nowrap bg-background data-[is-dragging=true]:outline group rounded text-xs',
						bgColor,
						hoverColor,
					)}
				>
					<TableCell className="font-mono text-xs relative text-right pl-2">
						<div className="opacity-0 group-hover:opacity-100 absolute inset-0 flex items-center justify-end pr-2">
							<Icons.GripVertical className="h-4 w-4" />
						</div>
						<div className="group-hover:opacity-0 flex justify-end items-center pr-2">
							{entry.isCurrentMatch && entry.status === 'in-progress'
								? <Icons.Play className="h-3 w-3 text-green-500" />
								: entry.isCurrentMatch && entry.status === 'post-game'
								? <Icons.Check className="h-3 w-3" />
								: (
									currentMatchOffset.toString()
								)}
						</div>
					</TableCell>
					<TableCell className="text-xs hidden min-[820px]:table-cell pl-2">
						{entry.isCurrentMatch && entry.startTime && entry.status === 'in-progress'
							&& (
								<span className="font-mono font-light">
									<Timer zeros start={entry.startTime.getTime()} />
								</span>
							)}
						{!entry.isCurrentMatch && entry.startTime
							&& (
								<span className="font-mono font-light">
									{formatMatchTimeAndDuration(entry.startTime, gameRuntime)}
								</span>
							)}
						{!entry.startTime && <span>-</span>}
					</TableCell>
					<TableCell>
						<MapLayerDisplay
							layer={layer.Layer!}
							extraLayerStyles={extraLayerStyles}
						/>
					</TableCell>
					<TableCell>{leftTeam}</TableCell>
					<TableCell className="text-center">
						<div className="flex flex-col items-center gap-1">
							{statusBadge}
							{outcomeDisp}
						</div>
					</TableCell>
					<TableCell>{rightTeam}</TableCell>

					<TableCell className="text-center">
						<div className="flex flex-row flex-nowrap group-data-[is-dragging=true]:invisible">
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
						</div>
					</TableCell>

					<TableCell>
						<span className="w-full flex justify-center">
							<LayerSourceDisplay source={entry.layerSource} />
						</span>
					</TableCell>
				</TableRow>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<LayerContextMenuItems
					selectedLayerIds={[entry.layerId]}
					selectedHistoryEntryIds={[entry.historyEntryId]}
				/>
			</ContextMenuContent>
		</ContextMenu>
	)
}

function TableHead({
	className = '',
	...props
}: React.ComponentProps<typeof ShadcnTableHead>) {
	return <ShadcnTableHead className={`${STD_PADDING} ${className}`} {...props} />
}

function TableCell({
	className = '',
	...props
}: React.ComponentProps<typeof ShadcnTableCell>) {
	return <ShadcnTableCell className={`${STD_PADDING} ${className}`} {...props} />
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

	const matchLengthMinutes = gameRuntime !== undefined ? Math.round(gameRuntime / (1000 * 60)) : undefined
	const matchLengthText = matchLengthMinutes ? ` - ${matchLengthMinutes} minutes` : ' - unknown length'
	return (
		<span title={`${timeDifferenceText}${matchLengthText}`}>
			{formattedStartTime}
			<span className="text-muted-foreground">({matchLengthMinutes ? `${matchLengthMinutes}m` : '???'})</span>
		</span>
	)
}
