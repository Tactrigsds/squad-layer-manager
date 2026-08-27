import { useQuery } from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'

import EventFilterSelect from '@/components/event-filter-select'
import HistoricalTeamsView from '@/components/historical-teams-view'
import ServerChatBox from '@/components/server-chat-box'
import { ServerEvent } from '@/components/server-event'
import { SubtreeFindBar } from '@/components/subtree-find-bar'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSubtreeFind } from '@/components/use-subtree-find'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex.ts'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'

import { ServerUnreachable } from './server-offline-display.tsx'
import ShortLayerName from './short-layer-name.tsx'

function ServerChatEvents(props: {
	className?: string
	filteredEvents: CHAT.EventEnriched[] | null
	connectionError?: CHAT.ConnectionErrorEvent | null
	synced: boolean
	isLoadingHistorical: boolean
	stores: SquadServerFrame.KeyProp
}) {
	const selectedMatchOrdinal = Zus.useStore(props.stores.squadServer!, (s) => s.chat.selectedMatchOrdinal)
	const serverId = props.stores.squadServer!.serverId
	const displayMatch = Zus.useStore_Susp(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ChatPrt.Sel.displayMatch,
	)

	const { scrollAreaRef, contentRef: eventsContainerRef, showScrollButton, scrollToBottom } = useTailingScroll()
	const [unseenMessageCount, setNewMessageCount] = React.useState(0)
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

	// the count only means anything while the feed is scrolled away from the bottom
	const newMessageCount = showScrollButton ? unseenMessageCount : 0
	// the loading overlay covers the scroll affordance, not the other way round
	const loaderZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)
	const scrollToBottomZIndex = loaderZIndex - 1
	const find = useSubtreeFind()

	// "Selected Only" has nothing to match against until the teams panel has a selection, so the feed is
	// reduced to the pinned match markers. say why rather than looking broken
	const noPlayersSelected = Zus.useStore(
		props.stores.squadServer!,
		(s: SquadServerFrame.State) => s.chat.selectedOnly && SquadServerFrame.Sel.settledSelectedPlayerIds(s).size === 0,
	)

	return (
		<div ref={find.scopeRef} className={cn(props.className, 'h-full relative flex flex-col @container')}>
			<SubtreeFindBar stores={find.stores} className="absolute right-4 top-1" />
			{!synced && selectedMatchOrdinal === null && (
				<div
					style={{ zIndex: loaderZIndex }}
					className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center"
				>
					<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}
			{selectedMatchOrdinal !== null && props.isLoadingHistorical && (
				<div
					style={{ zIndex: loaderZIndex }}
					className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center"
				>
					<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
				</div>
			)}
			{selectedMatchOrdinal !== null && displayMatch && (
				<div className="flex-shrink-0 text-muted-foreground text-xs py-2 bg-blue-500/10 flex flex-wrap justify-center gap-x-1">
					<span>{tr.text(CHAT_Msgs.viewingHistoricalMatch())}</span>
					<ShortLayerName layerId={displayMatch.layerId} teamParity={displayMatch.ordinal % 2} />
					{displayMatch.startTime && <span>{dateFns.format(displayMatch.startTime, 'MMM d, yyyy HH:mm')}</span>}
				</div>
			)}
			<ScrollArea ref={scrollAreaRef} className="flex-1 min-h-0">
				{/* it's important that the only things which can significantly resize the scrollarea are in this container, otherwise the autoscroll will break */}
				{/*
				  A past match mounts hundreds of rows and only ~30 are ever on screen. content-visibility lets the browser
				  skip style, layout and paint for the rest until they scroll into view; every row stays mounted and in the
				  dom, so find-in-page and the find bar still reach them. The intrinsic size is the measured median row,
				  and `auto` makes the browser keep each row's real height once it has been rendered once, so the scroll
				  height stops being an estimate as the feed is read.
				*/}
				<div
					ref={eventsContainerRef}
					className="flex flex-col gap-0.5 pr-4 min-h-0 w-full [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_29px]"
				>
					{noPlayersSelected && (
						<div className="text-muted-foreground text-sm text-center py-8">{tr.text(CHAT_Msgs.noPlayersSelected())}</div>
					)}
					{!noPlayersSelected && props.filteredEvents && props.filteredEvents.length === 0 && (
						<div className="text-muted-foreground text-sm text-center py-8">
							{tr.text(CHAT_Msgs.noEventsYet(selectedMatchOrdinal === null ? 'current' : 'historical'))}
						</div>
					)}
					{props.filteredEvents &&
						props.filteredEvents.map((event: CHAT.EventEnriched) => (
							<ServerEvent key={event.id} event={event} stores={props.stores} />
						))}
					{connectionError && (
						<div className="flex gap-2 py-1 text-destructive">
							{connectionError.code === 'CONNECTION_LOST' ? (
								<Icons.Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
							) : (
								<Icons.WifiOff className="h-4 w-4 flex-shrink-0" />
							)}
							<span className="text-xs">
								{connectionError.code === 'CONNECTION_LOST'
									? tr.text(CHAT_Msgs.connectionLost())
									: tr.text(CHAT_Msgs.reconnectionFailed())}
							</span>
						</div>
					)}
				</div>
			</ScrollArea>
			{showScrollButton && (
				<Button
					onClick={() => scrollToBottom()}
					variant="secondary"
					style={{ zIndex: scrollToBottomZIndex }}
					className="absolute bottom-0 left-0 right-0 w-full h-8 shadow-lg flex items-center justify-center gap-2 bg-opacity-20! rounded-none backdrop-blur-sm"
					title={tr.text(CHAT_Msgs.scrollToBottom())}
				>
					<Icons.ChevronDown className="h-4 w-4" />
					<span className="text-xs">
						{newMessageCount > 0 ? tr.text(CHAT_Msgs.newEvents(newMessageCount)) : tr.text(CHAT_Msgs.scrollToBottom())}
					</span>
				</Button>
			)}
		</div>
	)
}

function ServerCounts(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer!.serverId
	const serverInfoStatusRes = SquadServerClient.useServerInfoRes(serverId)
	const playerCount = Zus.useStore(props.stores.squadServer!, (s) =>
		s.chat.chatState.synced && !s.chat.chatState.connectionError ? s.chat.chatState.interpolatedState.players.size : null,
	)
	const tickRate = SquadServerClient.useTickRate(serverId)
	const tickRateThresholds = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.tickRateThresholds)

	if (serverInfoStatusRes.code !== 'ok') return <ServerUnreachable statusRes={serverInfoStatusRes} />

	const serverInfo = serverInfoStatusRes.data
	// flag degraded tick rate with color, using the admin-configured thresholds
	const tickRateColor =
		tickRate == null || !tickRateThresholds
			? undefined
			: tickRate >= tickRateThresholds.good
				? 'text-green-500'
				: tickRate >= tickRateThresholds.warning
					? 'text-yellow-500'
					: 'text-red-500'

	return (
		<div className="inline-flex shrink-0 text-muted-foreground gap-x-2 items-center text-sm tabular-nums">
			{/* online over queue while the panel is narrow, side by side once there is room */}
			<div className="flex flex-col items-end leading-tight @[760px]:flex-row @[760px]:items-center @[760px]:gap-2">
				<span
					className="inline-flex items-center gap-1"
					title={tr.text(CHAT_Msgs.playersOnline())}
					aria-label={tr.text(CHAT_Msgs.playersOnline())}
				>
					<Icons.Users className="h-3.5 w-3.5" />
					{playerCount ?? '?'}/{serverInfo.maxPlayerCount}
				</span>
				<span
					className="inline-flex items-center gap-1"
					title={tr.text(CHAT_Msgs.playersInQueue())}
					aria-label={tr.text(CHAT_Msgs.playersInQueue())}
				>
					<Icons.Hourglass className="h-3.5 w-3.5" />
					{serverInfo.queueLength}/{serverInfo.maxQueueLength}
				</span>
			</div>
			{tickRate != null && (
				<span
					className="inline-flex items-center gap-1"
					title={tr.text(CHAT_Msgs.serverTickRate())}
					aria-label={tr.text(CHAT_Msgs.serverTickRate())}
				>
					<Icons.Activity className="h-3.5 w-3.5" />
					<span className={tickRateColor}>{tickRate.toFixed(1)}</span>
				</span>
			)}
		</div>
	)
}

export default function ServerActivityPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const stores = props.stores
	const synced = Zus.useStore(stores.squadServer!, (s) => s.chat.chatState.synced)
	const connectionError = Zus.useStore(stores.squadServer!, (s) => s.chat.chatState.connectionError)
	const selectedMatchOrdinal = Zus.useStore(stores.squadServer!, (s) => s.chat.selectedMatchOrdinal)
	const historicalView = Zus.useStore(stores.squadServer!, ChatPrt.Sel.historicalView)
	const serverId = stores.squadServer!.serverId
	const recentMatches = MatchHistoryClient.useRecentMatches(serverId)
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	// Fetch historical events when viewing a past match
	const historicalEventsQuery = useQuery(MatchHistoryClient.matchEventsQueryOptions(serverId, selectedMatchOrdinal))

	// Reset to current match when a new match starts
	const prevCurrentMatchId = React.useRef<number | undefined>(undefined)
	React.useEffect(() => {
		if (currentMatch?.historyEntryId !== prevCurrentMatchId.current && currentMatch?.historyEntryId !== undefined) {
			const hadPreviousMatch = prevCurrentMatchId.current !== undefined
			prevCurrentMatchId.current = currentMatch?.historyEntryId
			// Reset to current match when a new match begins (but not on initial load)
			const currentSelectedOrdinal = Zus.getState(stores.squadServer!).chat.selectedMatchOrdinal
			if (hadPreviousMatch && currentSelectedOrdinal !== null) {
				void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, null)
			}
		}
	}, [currentMatch?.historyEntryId, stores.squadServer])

	const displayMatch = Zus.useStore_Susp(
		stores.squadServer!,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ChatPrt.Sel.displayMatch,
	)

	// Event filtering logic
	const prevState = React.useRef<{
		eventGeneration: number
		filteredEvents: CHAT.EventEnriched[]
		eventFilterState: CHAT.SecondaryFilterState
		selectedOnly: boolean
		selectedPlayerIds: ReadonlySet<SM.PlayerId>
		matchId: number
	} | null>(null)
	const prevHistoricalState = React.useRef<{
		selectedMatchOrdinal: number
		filteredEvents: CHAT.EventEnriched[]
		eventFilterState: CHAT.SecondaryFilterState
		selectedOnly: boolean
		selectedPlayerIds: ReadonlySet<SM.PlayerId>
		eventsVersion: any
	} | null>(null)

	const eventFilterState = Zus.useStore(stores.squadServer!, (s) => s.chat.secondaryFilterState)
	const selectedOnly = Zus.useStore(stores.squadServer!, ChatPrt.Sel.selectedOnly)
	const selectedPlayerIds = Zus.useStore(stores.squadServer!, SquadServerFrame.Sel.settledSelectedPlayerIds)

	const filteredEvents = React.useMemo(() => {
		// If viewing a historical match, use the historical query data
		if (selectedMatchOrdinal !== null) {
			if (!historicalEventsQuery.data?.events) return null

			// Cache check for historical events. the selection only enters the filter when selectedOnly is set, so
			// selection churn doesn't invalidate the cache otherwise
			if (
				prevHistoricalState.current?.selectedMatchOrdinal === selectedMatchOrdinal &&
				prevHistoricalState.current?.eventFilterState === eventFilterState &&
				prevHistoricalState.current?.selectedOnly === selectedOnly &&
				prevHistoricalState.current?.eventsVersion === historicalEventsQuery.data &&
				(!selectedOnly || prevHistoricalState.current.selectedPlayerIds === selectedPlayerIds)
			) {
				return prevHistoricalState.current.filteredEvents
			}

			const filtered = historicalEventsQuery.data.events.filter((event: CHAT.EventEnriched) =>
				CHAT.showEventInFeed(event, eventFilterState, { selectedPlayerIds, selectedOnly }),
			)

			prevHistoricalState.current = {
				selectedMatchOrdinal,
				filteredEvents: filtered,
				eventFilterState,
				selectedOnly,
				selectedPlayerIds,
				eventsVersion: historicalEventsQuery.data,
			}
			return filtered
		}

		// Otherwise use live event buffer - handled by separate selector below
		return null
	}, [selectedMatchOrdinal, historicalEventsQuery.data, eventFilterState, selectedOnly, selectedPlayerIds])

	const liveFilteredEvents = Zus.useStore(
		stores.squadServer!,
		React.useCallback(
			(s: SquadServerFrame.State) => {
				if (selectedMatchOrdinal !== null) return null // Using historical events instead
				if (!s.chat.chatState.synced || displayMatch?.historyEntryId === undefined) return null

				const eventFilterState = s.chat.secondaryFilterState
				const selectedOnly = s.chat.selectedOnly
				const selectedPlayerIds = SquadServerFrame.Sel.settledSelectedPlayerIds(s)

				// we have all of this ceremony to prevent having to reallocate the event buffer array every time it's modified. maybe a bit excessive :shrug:
				if (
					displayMatch?.historyEntryId === prevState.current?.matchId &&
					s.chat.eventGeneration === prevState.current?.eventGeneration &&
					eventFilterState === prevState.current.eventFilterState &&
					selectedOnly === prevState.current.selectedOnly &&
					(!selectedOnly || prevState.current.selectedPlayerIds === selectedPlayerIds)
				) {
					return prevState.current?.filteredEvents
				}

				const eventBuffer = s.chat.chatState.eventBuffer
				const filtered: CHAT.EventEnriched[] = []
				for (const event of eventBuffer) {
					if (event.matchId !== displayMatch?.historyEntryId) continue
					if (CHAT.showEventInFeed(event, eventFilterState, { selectedPlayerIds, selectedOnly })) {
						filtered.push(event)
					}
				}
				prevState.current = {
					eventGeneration: s.chat.eventGeneration,
					filteredEvents: filtered,
					eventFilterState,
					selectedOnly,
					selectedPlayerIds,
					matchId: displayMatch?.historyEntryId,
				}
				return filtered
			},
			[displayMatch?.historyEntryId, selectedMatchOrdinal],
		),
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
		const state = Zus.getState(stores.squadServer!)
		const currentOrdinal = state.chat.selectedMatchOrdinal ?? currentMatch.ordinal
		if (currentOrdinal === undefined) return
		const currentIndex = recentMatches.findIndex((m: MH.MatchDetails) => m.ordinal === currentOrdinal)
		if (currentIndex > 0) {
			void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, recentMatches[currentIndex - 1].ordinal)
		}
	}, [currentMatch, recentMatches, stores.squadServer])

	const handleNext = React.useCallback(() => {
		if (!currentMatch || !Array.isArray(recentMatches)) return
		const state = Zus.getState(stores.squadServer!)
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

	return (
		// a labelled region so the feed is a landmark users (and tests) can jump to, rather than an anonymous div
		// that only reads as a pile of text. Named directly rather than by its title, which is down to the icon
		// alone once the panel is narrow.
		<Card role="region" aria-label={tr.text(CHAT_Msgs.activityTitle())} className="flex flex-col h-full min-h-0 w-full @container">
			<CardHeader className="flex flex-row justify-between flex-shrink-0 items-center gap-2 pb-3">
				<div className="flex min-w-0 items-center gap-1.5 @[640px]:gap-4">
					<CardTitle className="flex items-center gap-2 whitespace-nowrap">
						<Icons.Server className="h-5 w-5" />
						<span className="hidden @[640px]:inline">{tr.text(CHAT_Msgs.activityTitle())}</span>
					</CardTitle>
					<ButtonGroup>
						<Button
							variant="ghost"
							size="sm"
							onClick={handlePrevious}
							disabled={!canGoPrevious}
							className="h-8 w-8 p-0"
							title={tr.text(CHAT_Msgs.previousMatch())}
						>
							<Icons.ChevronLeft className="h-4 w-4" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={handleNext}
							disabled={!canGoNext}
							className="h-8 w-8 p-0"
							title={tr.text(CHAT_Msgs.nextMatch())}
						>
							<Icons.ChevronRight className="h-4 w-4" />
						</Button>
						{selectedMatchOrdinal !== null && (
							<Button
								variant="default"
								size="sm"
								onClick={() => ChatPrt.Actions.setSelectedMatchOrdinal({ chat: stores.squadServer! }, null)}
								className="h-8 px-2 whitespace-nowrap @[640px]:px-3 bg-green-500 hover:bg-green-600 text-white"
								title={tr.text(CHAT_Msgs.returnToLiveTooltip())}
							>
								<Icons.Radio className="h-4 w-4 @[640px]:mr-1" />
								<span className="hidden @[640px]:inline">{tr.text(CHAT_Msgs.returnToLive())}</span>
							</Button>
						)}
					</ButtonGroup>
					{selectedMatchOrdinal !== null && (
						<ButtonGroup>
							{(['feed', 'teams'] as const).map((view) => (
								<Button
									key={view}
									variant={historicalView === view ? 'secondary' : 'ghost'}
									size="sm"
									aria-pressed={historicalView === view}
									onClick={() => ChatPrt.Actions.setHistoricalView({ chat: stores.squadServer! }, view)}
									className="h-8 px-2 @[640px]:px-3"
								>
									{view === 'feed' ? (
										<Icons.List className="h-4 w-4 @[640px]:mr-1" />
									) : (
										<Icons.Users className="h-4 w-4 @[640px]:mr-1" />
									)}
									<span className="hidden @[640px]:inline">
										{tr.text(view === 'feed' ? CHAT_Msgs.feedViewLabel() : CHAT_Msgs.teamsViewLabel())}
									</span>
								</Button>
							))}
						</ButtonGroup>
					)}
					<EventFilterSelect
						value={eventFilterState}
						onValueChange={(value) => ChatPrt.Actions.setSecondaryFilterState({ chat: stores.squadServer! }, value)}
						selectedOnly={selectedOnly}
						onSelectedOnlyChange={(value) => ChatPrt.Actions.setSelectedOnly({ chat: stores.squadServer! }, value)}
					/>
				</div>
				{/* live-only readouts, and the historical controls need their header room */}
				{selectedMatchOrdinal === null && <ServerCounts stores={stores} />}
			</CardHeader>
			<CardContent className="flex-1 overflow-hidden min-h-0 flex flex-col">
				<div className="flex-1 min-h-0">
					{selectedMatchOrdinal !== null && historicalView === 'teams' ? (
						<div className="min-w-[350px] h-full flex flex-col">
							{displayMatch && (
								<div className="text-muted-foreground text-xs py-2 bg-blue-500/10 flex flex-wrap justify-center gap-x-1">
									<span>{tr.text(CHAT_Msgs.viewingHistoricalMatch())}</span>
									<ShortLayerName layerId={displayMatch.layerId} teamParity={displayMatch.ordinal % 2} />
									{displayMatch.startTime && <span>{dateFns.format(displayMatch.startTime, 'MMM d, yyyy HH:mm')}</span>}
								</div>
							)}
							{historicalEventsQuery.isLoading ? (
								<div className="flex-1 flex items-center justify-center">
									<Icons.Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
								</div>
							) : (
								<div className="flex-1 min-h-0 pt-2">
									<HistoricalTeamsView stores={stores} events={historicalEventsQuery.data?.events ?? null} />
								</div>
							)}
						</div>
					) : (
						<ServerChatEvents
							className="min-w-[350px] h-full"
							filteredEvents={finalFilteredEvents}
							connectionError={connectionError}
							synced={synced}
							isLoadingHistorical={historicalEventsQuery.isLoading}
							stores={stores}
						/>
					)}
				</div>
				{selectedMatchOrdinal === null && <ServerChatBox stores={stores} />}
			</CardContent>
		</Card>
	)
}
