import EventFilterSelect from '@/components/event-filter-select'
import ServerChatBox from '@/components/server-chat-box'
import { ServerEvent } from '@/components/server-event'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTailingScroll } from '@/hooks/use-tailing-scroll'

import { cn } from '@/lib/utils.ts'

import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ZusUtils from '@/lib/zustand'
import * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useQuery } from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'
import { ServerUnreachable } from './server-offline-display.tsx'
import ShortLayerName from './short-layer-name.tsx'

function ServerChatEvents(
	props: {
		className?: string
		filteredEvents: CHAT.EventEnriched[] | null
		connectionError?: CHAT.ConnectionErrorEvent | null
		synced: boolean
		isLoadingHistorical: boolean
		stores: SquadServerFrame.KeyProp
	},
) {
	const selectedMatchOrdinal = ZusUtils.useStore(
		props.stores.squadServer!,
		s => s.chat.selectedMatchOrdinal,
	)
	const serverId = props.stores.squadServer!.serverId
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const recentMatches = MatchHistoryClient.useRecentMatches(serverId)
	const displayMatch = React.useMemo(() => {
		if (selectedMatchOrdinal === null) return currentMatch
		return recentMatches.find(m => m.ordinal === selectedMatchOrdinal)
	}, [selectedMatchOrdinal, currentMatch, recentMatches])

	const { scrollAreaRef, contentRef: eventsContainerRef, bottomRef, showScrollButton, scrollToBottom } = useTailingScroll()
	const [newMessageCount, setNewMessageCount] = React.useState(0)
	const synced = props.synced
	const connectionError = props.connectionError

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
		<div className={cn(props.className, 'h-full relative @container')}>
			{!synced && selectedMatchOrdinal === null && (
				<div className="absolute inset-0 z-30 bg-background/80 backdrop-blur-sm flex items-center justify-center">
					<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}
			{selectedMatchOrdinal !== null && props.isLoadingHistorical && (
				<div className="absolute inset-0 z-30 bg-background/80 backdrop-blur-sm flex items-center justify-center">
					<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}
			{selectedMatchOrdinal !== null && displayMatch && (
				<div className="text-muted-foreground text-xs py-2 bg-blue-500/10 flex flex-wrap justify-center gap-x-1">
					<span>Viewing historical match</span>
					<ShortLayerName layerId={displayMatch.layerId} teamParity={displayMatch.ordinal % 2} />
					{displayMatch.startTime && <span>{dateFns.format(displayMatch.startTime, 'MMM d, yyyy HH:mm')}</span>}
				</div>
			)}
			<ScrollArea ref={scrollAreaRef} className="h-full">
				{/* it's important that the only things which can significantly resize the scrollarea are in this container, otherwise the autoscroll will break */}
				<div ref={eventsContainerRef} className="flex flex-col gap-0.5 pr-4 min-h-0 w-full">
					{props.filteredEvents && props.filteredEvents.length === 0 && (
						<div className="text-muted-foreground text-sm text-center py-8">
							No events yet for {selectedMatchOrdinal === null ? 'current match' : 'this match'}
						</div>
					)}
					{props.filteredEvents
						&& props.filteredEvents.map((event: CHAT.EventEnriched) => <ServerEvent key={event.id} event={event} stores={props.stores} />)}
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
			</ScrollArea>
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
		</div>
	)
}

function ServerCounts(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer!.serverId
	const serverInfoStatusRes = SquadServerClient.useServerInfoRes(serverId)
	const playerCount = ZusUtils.useStore(
		props.stores.squadServer!,
		s => (s.chat.chatState.synced && !s.chat.chatState.connectionError) ? s.chat.chatState.interpolatedState.players.length : null,
	)

	if (serverInfoStatusRes.code !== 'ok') return <ServerUnreachable statusRes={serverInfoStatusRes} />

	const serverInfo = serverInfoStatusRes.data

	return (
		<div className="inline-flex text-muted-foreground space-x-2 items-baseline text-sm">
			{playerCount ?? '<unknown>'} / {serverInfo.maxPlayerCount} online, {serverInfo.queueLength} / {serverInfo.maxQueueLength} in queue
		</div>
	)
}

export default function ServerActivityPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const stores = props.stores
	const synced = ZusUtils.useStore(stores.squadServer!, s => s.chat.chatState.synced)
	const connectionError = ZusUtils.useStore(stores.squadServer!, s => s.chat.chatState.connectionError)
	const selectedMatchOrdinal = ZusUtils.useStore(
		stores.squadServer!,
		s => s.chat.selectedMatchOrdinal,
	)
	const serverId = stores.squadServer!.serverId
	const recentMatches = MatchHistoryClient.useRecentMatches(serverId)
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	// Fetch historical events when viewing a past match
	const historicalEventsQuery = useQuery({
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), selectedMatchOrdinal],
		queryFn: async () => {
			if (selectedMatchOrdinal === null) return null
			return RPC.orpc.matchHistory.getMatchEvents.call({ serverId, ordinal: selectedMatchOrdinal })
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
			const currentSelectedOrdinal = ZusUtils.getState(stores.squadServer!).chat.selectedMatchOrdinal
			if (hadPreviousMatch && currentSelectedOrdinal !== null) {
				void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, null)
			}
		}
	}, [currentMatch?.historyEntryId, stores.squadServer])

	// Determine which match to display - either selected or current
	const displayMatch = React.useMemo(() => {
		if (selectedMatchOrdinal === null) return currentMatch
		return recentMatches.find(m => m.ordinal === selectedMatchOrdinal)
	}, [selectedMatchOrdinal, currentMatch, recentMatches])

	// Event filtering logic
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

	const eventFilterState = ZusUtils.useStore(stores.squadServer!, s => s.chat.secondaryFilterState)

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

	const liveFilteredEvents = ZusUtils.useStore(
		stores.squadServer!,
		React.useCallback((s: SquadServerFrame.State) => {
			if (selectedMatchOrdinal !== null) return null // Using historical events instead
			if (!s.chat.chatState.synced || displayMatch?.historyEntryId === undefined) return null

			// we have all of this ceremony to prevent having to reallocate the event buffer array every time it's modified. maybe a bit excessive :shrug:
			if (
				displayMatch?.historyEntryId === prevState.current?.matchId
				&& s.chat.eventGeneration === prevState.current?.eventGeneration
				&& s.chat.secondaryFilterState === prevState.current.eventFilterState
			) {
				return prevState.current?.filteredEvents
			}

			const eventFilterState = s.chat.secondaryFilterState
			const eventBuffer = s.chat.chatState.eventBuffer
			const filtered: CHAT.EventEnriched[] = []
			for (const event of eventBuffer) {
				if (event.matchId !== displayMatch?.historyEntryId) continue
				if (!CHAT.isEventFilteredBySecondary(event, eventFilterState)) {
					filtered.push(event)
				}
			}
			prevState.current = {
				eventGeneration: s.chat.eventGeneration,
				filteredEvents: filtered,
				eventFilterState: s.chat.secondaryFilterState,
				matchId: displayMatch?.historyEntryId,
			}
			return filtered
		}, [displayMatch?.historyEntryId, selectedMatchOrdinal]),
	)

	const finalFilteredEvents = selectedMatchOrdinal !== null ? filteredEvents : liveFilteredEvents

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
		const state = ZusUtils.getState(stores.squadServer!)
		const currentOrdinal = state.chat.selectedMatchOrdinal ?? currentMatch.ordinal
		if (currentOrdinal === undefined) return
		const currentIndex = recentMatches.findIndex((m: MH.MatchDetails) => m.ordinal === currentOrdinal)
		if (currentIndex > 0) {
			void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, recentMatches[currentIndex - 1].ordinal)
		}
	}, [currentMatch, recentMatches, stores.squadServer])

	const handleNext = React.useCallback(() => {
		if (!currentMatch || !Array.isArray(recentMatches)) return
		const state = ZusUtils.getState(stores.squadServer!)
		const currentOrdinal = state.chat.selectedMatchOrdinal ?? currentMatch.ordinal
		if (currentOrdinal === undefined) return
		const currentIndex = recentMatches.findIndex((m: MH.MatchDetails) => m.ordinal === currentOrdinal)
		if (currentIndex < recentMatches.length - 1) {
			void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, recentMatches[currentIndex + 1].ordinal)
		} else {
			// Go to current match
			void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, null)
		}
	}, [currentMatch, recentMatches, stores.squadServer])

	const eventFilter = ZusUtils.useStore(
		stores.squadServer!,
		s => s.chat.secondaryFilterState,
	)

	return (
		<Card className="flex flex-col h-full min-h-0 w-full">
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
								onClick={() => ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, null)}
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
						onValueChange={(value) => ChatPrt.Actions.setSecondaryFilterState({ chat: stores.squadServer! }, value)}
					/>
				</div>
				<ServerCounts stores={stores} />
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden min-h-0 flex flex-col">
				<div className="flex-1 min-h-0">
					<ServerChatEvents
						className="min-w-[350px] h-full"
						filteredEvents={finalFilteredEvents}
						connectionError={connectionError}
						synced={synced}
						isLoadingHistorical={historicalEventsQuery.isLoading}
						stores={stores}
					/>
				</div>
				{selectedMatchOrdinal === null && <ServerChatBox stores={stores} />}
			</CardContent>
		</Card>
	)
}
