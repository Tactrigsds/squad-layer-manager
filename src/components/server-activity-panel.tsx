import EventFilterSelect from '@/components/event-filter-select'
import { ServerEvent } from '@/components/server-event'
import ServerPlayerList from '@/components/server-player-list.tsx'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import * as DH from '@/lib/display-helpers'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand'
import * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useQuery } from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { ServerUnreachable } from './server-offline-display.tsx'

function ServerChatEvents(
	props: {
		className?: string
		onToggleStatePanel?: () => void
		isStatePanelOpen?: boolean
	},
) {
	const synced = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.synced)
	const connectionError = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.connectionError)
	const currentMatch = MatchHistoryClient.useCurrentMatch()
	const recentMatches = MatchHistoryClient.useRecentMatches()
	const selectedMatchOrdinal = Zus.useStore(
		SquadServerClient.ChatStore,
		s => s.selectedMatchOrdinal,
	)

	// Fetch historical events when viewing a past match
	const historicalEventsQuery = useQuery({
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), selectedMatchOrdinal],
		queryFn: async () => {
			if (selectedMatchOrdinal === null) return null
			return RPC.orpc.matchHistory.getMatchEvents.call(selectedMatchOrdinal)
		},
		enabled: selectedMatchOrdinal !== null && selectedMatchOrdinal !== undefined,
		staleTime: Infinity,
	})

	// Reset to current match when a new match starts
	const prevCurrentMatchId = React.useRef<number | undefined>(undefined)

	React.useEffect(() => {
		if (currentMatch?.historyEntryId !== prevCurrentMatchId.current && currentMatch?.historyEntryId !== undefined) {
			const hadPreviousMatch = prevCurrentMatchId.current !== undefined
			prevCurrentMatchId.current = currentMatch?.historyEntryId
			// Reset to current match when a new match begins (but not on initial load)
			const currentSelectedOrdinal = SquadServerClient.ChatStore.getState().selectedMatchOrdinal
			if (hadPreviousMatch && currentSelectedOrdinal !== null) {
				SquadServerClient.ChatStore.getState().setSelectedMatchOrdinal(null)
			}
		}
	}, [currentMatch?.historyEntryId])

	// Determine which match to display - either selected or current
	const displayMatch = React.useMemo(() => {
		if (selectedMatchOrdinal === null) return currentMatch
		return recentMatches.find(m => m.ordinal === selectedMatchOrdinal)
	}, [selectedMatchOrdinal, currentMatch, recentMatches])

	const { scrollAreaRef, contentRef: eventsContainerRef, bottomRef, showScrollButton, scrollToBottom } = useTailingScroll()
	const [newMessageCount, setNewMessageCount] = React.useState(0)
	const prevState = React.useRef<
		{ eventGeneration: number; filteredEvents: CHAT.EventEnriched[]; eventFilterState: CHAT.SecondaryFilterState; matchId: number } | null
	>(null)
	const prevHistoricalState = React.useRef<
		| {
			selectedMatchOrdinal: number
			filteredEvents: CHAT.EventEnriched[]
			eventFilterState: CHAT.SecondaryFilterState
			eventsVersion: any
		}
		| null
	>(null)

	// Get filtered events - either from live buffer or historical query
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.secondaryFilterState)

	const filteredEvents = React.useMemo(() => {
		// If viewing a historical match, use the historical query data
		if (selectedMatchOrdinal !== null) {
			if (!historicalEventsQuery.data?.events) return null

			// Cache check for historical events
			if (
				prevHistoricalState.current?.selectedMatchOrdinal === selectedMatchOrdinal
				&& prevHistoricalState.current?.eventFilterState === eventFilterState
				&& prevHistoricalState.current?.eventsVersion === historicalEventsQuery.data
			) {
				return prevHistoricalState.current.filteredEvents
			}

			const filtered = historicalEventsQuery.data.events.filter((event: CHAT.EventEnriched) =>
				!CHAT.isEventFilteredBySecondary(event, eventFilterState)
			)

			prevHistoricalState.current = {
				selectedMatchOrdinal,
				filteredEvents: filtered,
				eventFilterState,
				eventsVersion: historicalEventsQuery.data,
			}
			return filtered
		}

		// Otherwise use live event buffer - handled by separate selector below
		return null
	}, [selectedMatchOrdinal, historicalEventsQuery.data, eventFilterState])

	const liveFilteredEvents = Zus.useStore(
		SquadServerClient.ChatStore,
		React.useCallback(s => {
			if (selectedMatchOrdinal !== null) return null // Using historical events instead
			if (!s.chatState.synced || displayMatch?.historyEntryId === undefined) return null

			// we have all of this ceremony to prevent having to reallocate the event buffer array every time it's modified. maybe a bit excessive :shrug:
			if (
				displayMatch?.historyEntryId === prevState.current?.matchId
				&& s.eventGeneration === prevState.current?.eventGeneration
				&& s.secondaryFilterState === prevState.current.eventFilterState
			) {
				return prevState.current?.filteredEvents
			}

			const eventFilterState = s.secondaryFilterState
			const eventBuffer = s.chatState.eventBuffer
			const filtered: CHAT.EventEnriched[] = []
			for (const event of eventBuffer) {
				if (event.matchId !== displayMatch?.historyEntryId) continue
				if (!CHAT.isEventFilteredBySecondary(event, eventFilterState)) {
					filtered.push(event)
				}
			}
			prevState.current = {
				eventGeneration: s.eventGeneration,
				filteredEvents: filtered,
				eventFilterState: s.secondaryFilterState,
				matchId: displayMatch?.historyEntryId,
			}
			return filtered
		}, [displayMatch?.historyEntryId, selectedMatchOrdinal]),
	)

	const finalFilteredEvents = selectedMatchOrdinal !== null ? filteredEvents : liveFilteredEvents

	React.useEffect(() => {
		if (synced) {
			requestAnimationFrame(() => {
				scrollToBottom()
			})
		}
	}, [synced, scrollToBottom])

	// Auto-scroll to bottom when returning to live match
	const prevSelectedMatchOrdinal = React.useRef<number | null>(selectedMatchOrdinal)
	React.useEffect(() => {
		if (prevSelectedMatchOrdinal.current !== null && selectedMatchOrdinal === null) {
			// Just switched from historical to live
			requestAnimationFrame(() => {
				scrollToBottom()
			})
		}
		prevSelectedMatchOrdinal.current = selectedMatchOrdinal
	}, [selectedMatchOrdinal, scrollToBottom])

	// Reset new message count when scrolled to bottom
	React.useEffect(() => {
		if (!showScrollButton) {
			setNewMessageCount(0)
		}
	}, [showScrollButton])

	return (
		<div className={cn(props.className, 'h-full relative')}>
			{!synced && selectedMatchOrdinal === null && (
				<div className="absolute inset-0 z-30 bg-background/80 backdrop-blur-sm flex items-center justify-center">
					<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}
			{selectedMatchOrdinal !== null && historicalEventsQuery.isLoading && (
				<div className="absolute inset-0 z-30 bg-background/80 backdrop-blur-sm flex items-center justify-center">
					<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}
			{props.onToggleStatePanel && (
				<Button
					variant="ghost"
					size="sm"
					onClick={props.onToggleStatePanel}
					className="h-8 w-6 p-0 absolute top-0 right-0 z-20"
					title={`${props.isStatePanelOpen ? 'Hide' : 'Show'} player list`}
				>
					{props.isStatePanelOpen ? <Icons.ChevronRight className="h-3 w-3" /> : <Icons.ChevronLeft className="h-3 w-3" />}
				</Button>
			)}
			<ScrollArea ref={scrollAreaRef} className="h-full">
				{/* it's important that the only things which can significantly resize the scrollarea are in this container, otherwise the autoscroll will break */}
				<div ref={eventsContainerRef} className="flex flex-col gap-0.5 pr-4 min-h-0 w-full">
					{selectedMatchOrdinal !== null && displayMatch && (
						<div className="text-muted-foreground text-xs text-center py-2 bg-blue-500/10">
							Viewing historical match: {displayMatch.startTime && <>{dateFns.format(displayMatch.startTime, 'MMM d, yyyy HH:mm')}</>}
						</div>
					)}
					{finalFilteredEvents && finalFilteredEvents.length === 0 && (
						<div className="text-muted-foreground text-sm text-center py-8">
							No events yet for {selectedMatchOrdinal === null ? 'current match' : 'this match'}
						</div>
					)}
					{finalFilteredEvents && finalFilteredEvents.map((event: CHAT.EventEnriched) => <ServerEvent key={event.id} event={event} />)}
					{connectionError && (
						<div className="flex gap-2 py-1 text-destructive">
							{connectionError.code === 'CONNECTION_LOST'
								? <Icons.Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
								: <Icons.WifiOff className="h-4 w-4 flex-shrink-0" />}
							<span className="text-xs">
								{connectionError.code === 'CONNECTION_LOST'
									? 'Connection lost - attempting to reconnect...'
									: 'Reconnection failed - unable to reconnect to the server. Please refresh the page.'}
							</span>
						</div>
					)}
				</div>
				<div ref={bottomRef} />
				{showScrollButton && (
					<Button
						onClick={() => scrollToBottom()}
						variant="secondary"
						className="absolute bottom-0 left-0 right-0 w-full h-8 shadow-lg flex items-center justify-center gap-2 z-10 bg-opacity-20! rounded-none backdrop-blur-sm"
						title="Scroll to bottom"
					>
						<Icons.ChevronDown className="h-4 w-4" />
						<span className="text-xs">
							{newMessageCount > 0 ? `${newMessageCount} new event${newMessageCount === 1 ? '' : 's'}` : 'Scroll to bottom'}
						</span>
					</Button>
				)}
			</ScrollArea>
		</div>
	)
}

function ServerCounts() {
	const serverInfoStatusRes = SquadServerClient.useServerInfoRes()
	const playerCount = SquadServerClient.usePlayerCount()

	if (serverInfoStatusRes.code !== 'ok') return <ServerUnreachable statusRes={serverInfoStatusRes} />

	const serverInfo = serverInfoStatusRes.data

	return (
		<div className="inline-flex text-muted-foreground space-x-2 items-baseline text-sm">
			{playerCount ?? '<unknown>'} / {serverInfo.maxPlayerCount} online, {serverInfo.queueLength} / {serverInfo.maxQueueLength} in queue
		</div>
	)
}

const AUTO_CLOSE_WIDTH_THRESHOLD = 1350 // pixels
const AUTO_OPEN_WIDTH_THRESHOLD = AUTO_CLOSE_WIDTH_THRESHOLD * 1.2 // 20% above threshold (1620 pixels)

export default function ServerActivityPanel() {
	const [isStatePanelOpen, setIsStatePanelOpen] = React.useState(window.innerWidth >= AUTO_CLOSE_WIDTH_THRESHOLD)
	const synced = Zus.useStore(SquadServerClient.ChatStore, s => s.chatState.synced)
	const selectedMatchOrdinal = Zus.useStore(
		SquadServerClient.ChatStore,
		s => s.selectedMatchOrdinal,
	)
	const recentMatches = MatchHistoryClient.useRecentMatches()
	const currentMatch = MatchHistoryClient.useCurrentMatch()

	const canGoPrevious = React.useMemo(() => {
		if (!recentMatches.length) return false
		const currentOrdinal = selectedMatchOrdinal ?? currentMatch?.ordinal
		if (currentOrdinal === undefined) return false
		return recentMatches[0].ordinal < currentOrdinal
	}, [selectedMatchOrdinal, currentMatch, recentMatches])

	const canGoNext = React.useMemo(() => {
		if (!currentMatch) return false
		const currentOrdinal = selectedMatchOrdinal ?? currentMatch.ordinal
		return currentOrdinal < currentMatch.ordinal
	}, [selectedMatchOrdinal, currentMatch])

	const handlePrevious = React.useCallback(() => {
		if (!currentMatch || !Array.isArray(recentMatches)) return
		const state = SquadServerClient.ChatStore.getState()
		const currentOrdinal = state.selectedMatchOrdinal ?? currentMatch.ordinal
		if (currentOrdinal === undefined) return
		const currentIndex = recentMatches.findIndex((m: MH.MatchDetails) => m.ordinal === currentOrdinal)
		if (currentIndex > 0) {
			state.setSelectedMatchOrdinal(recentMatches[currentIndex - 1].ordinal)
		}
	}, [currentMatch, recentMatches])

	const handleNext = React.useCallback(() => {
		if (!currentMatch || !Array.isArray(recentMatches)) return
		const state = SquadServerClient.ChatStore.getState()
		const currentOrdinal = state.selectedMatchOrdinal ?? currentMatch.ordinal
		if (currentOrdinal === undefined) return
		const currentIndex = recentMatches.findIndex((m: MH.MatchDetails) => m.ordinal === currentOrdinal)
		if (currentIndex < recentMatches.length - 1) {
			state.setSelectedMatchOrdinal(recentMatches[currentIndex + 1].ordinal)
		} else {
			// Go to current match
			state.setSelectedMatchOrdinal(null)
		}
	}, [currentMatch, recentMatches])

	// Track viewport width state for auto-closing/opening the panel
	const hasBeenAboveThresholdRef = React.useRef(window.innerWidth >= AUTO_CLOSE_WIDTH_THRESHOLD)
	const userManuallyClosed = React.useRef(false)

	React.useEffect(() => {
		const handleResize = () => {
			const currentWidth = window.innerWidth
			const isAboveThreshold = currentWidth >= AUTO_CLOSE_WIDTH_THRESHOLD
			const isAboveAutoOpenThreshold = currentWidth >= AUTO_OPEN_WIDTH_THRESHOLD

			// Auto-open if we're 20% above the threshold, panel is closed, and user hasn't manually closed it
			if (isAboveAutoOpenThreshold && !isStatePanelOpen && !userManuallyClosed.current) {
				setIsStatePanelOpen(true)
				hasBeenAboveThresholdRef.current = true
				return
			}

			// If we've crossed above the threshold, mark it
			if (isAboveThreshold) {
				hasBeenAboveThresholdRef.current = true
			}

			// Only auto-close if:
			// 1. We're below the threshold
			// 2. We've been above the threshold at some point (this prevents auto-close if user manually opened while below)
			// 3. The panel is currently open
			if (!isAboveThreshold && hasBeenAboveThresholdRef.current && isStatePanelOpen) {
				setIsStatePanelOpen(false)
				// Reset the flag so if user manually opens, we won't auto-close again until they resize above threshold
				hasBeenAboveThresholdRef.current = false
				// Reset manual close flag when we auto-close
				userManuallyClosed.current = false
			}
		}

		const resize$ = Rx.fromEvent(window, 'resize').pipe(Rx.debounceTime(150))
		const sub = resize$.subscribe(handleResize)

		handleResize()

		return () => {
			sub.unsubscribe()
		}
	}, [isStatePanelOpen])
	const eventFilter = Zus.useStore(
		SquadServerClient.ChatStore,
		s => s.secondaryFilterState,
	)

	const displayMatch = React.useMemo(() => {
		if (selectedMatchOrdinal === null) return currentMatch
		return recentMatches.find(m => m.ordinal === selectedMatchOrdinal)
	}, [selectedMatchOrdinal, currentMatch, recentMatches])

	return (
		<Card className="flex flex-col min-h-0 w-fit">
			<CardHeader className="flex flex-row justify-between flex-shrink-0 items-center pb-3">
				<div className="flex items-center gap-4">
					<CardTitle className="flex items-center gap-2">
						<Icons.Server className="h-5 w-5" />
						Server Activity
					</CardTitle>
					<ButtonGroup>
						<Button
							variant="ghost"
							size="sm"
							onClick={handlePrevious}
							disabled={!canGoPrevious}
							className="h-8 w-8 p-0"
							title="Previous match"
						>
							<Icons.ChevronLeft className="h-4 w-4" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={handleNext}
							disabled={!canGoNext}
							className="h-8 w-8 p-0"
							title="Next match"
						>
							<Icons.ChevronRight className="h-4 w-4" />
						</Button>
						{selectedMatchOrdinal !== null && (
							<Button
								variant="default"
								size="sm"
								onClick={() => SquadServerClient.ChatStore.getState().setSelectedMatchOrdinal(null)}
								className="h-8 px-3 bg-green-500 hover:bg-green-600 text-white"
								title="Return to live events"
							>
								<Icons.Radio className="h-4 w-4 mr-1" />
								Return to Live
							</Button>
						)}
					</ButtonGroup>
					<EventFilterSelect
						value={eventFilter}
						onValueChange={(value) => SquadServerClient.ChatStore.getState().setSecondaryFilterState(value)}
					/>
				</div>
				<ServerCounts />
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden min-h-0">
				<div className="flex gap-0.5 h-full">
					<ServerChatEvents
						className="flex-1 min-w-[350px] h-full"
						onToggleStatePanel={() => {
							const newState = !isStatePanelOpen
							setIsStatePanelOpen(newState)
							// Track if user manually closed the panel while above auto-open threshold
							if (!newState && window.innerWidth >= AUTO_OPEN_WIDTH_THRESHOLD) {
								userManuallyClosed.current = true
							} else if (newState) {
								// User manually opened it, reset the flag
								userManuallyClosed.current = false
							}
						}}
						isStatePanelOpen={isStatePanelOpen}
					/>
					{isStatePanelOpen && synced && (
						<div className="w-[240px] flex-shrink-0">
							<ServerPlayerList />
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	)
}
