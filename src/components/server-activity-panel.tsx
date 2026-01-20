import EventFilterSelect from '@/components/event-filter-select'
import { ServerEvent } from '@/components/server-event'
import ServerPlayerList from '@/components/server-player-list.tsx'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as DH from '@/lib/display-helpers'
import { cn } from '@/lib/utils.ts'
import * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useInfiniteQuery } from '@tanstack/react-query'
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
	const bottomRef = React.useRef<HTMLDivElement>(null)
	const scrollAreaRef = React.useRef<HTMLDivElement>(null)
	// are we following the latest events by autoscrolling down
	const tailing = React.useRef(true)
	const eventsContainerRef = React.useRef<HTMLDivElement>(null)
	const [showScrollButton, setShowScrollButton] = React.useState(false)
	const [newMessageCount, setNewMessageCount] = React.useState(0)
	const prevState = React.useRef<
		{ eventGeneration: number; filteredEvents: CHAT.EventEnriched[]; eventFilterState: CHAT.SecondaryFilterState; matchId: number } | null
	>(null)
	const filteredEvents = Zus.useStore(
		SquadServerClient.ChatStore,
		React.useCallback(s => {
			if (!s.chatState.synced || currentMatch?.historyEntryId === undefined) return null
			// we have all of this ceremony to prevent having to reallocate the event buffer array every time it's modified. maybe a bit excessive :shrug:
			if (
				currentMatch?.historyEntryId === prevState.current?.matchId
				&& s.eventGeneration === prevState.current?.eventGeneration
				&& s.secondaryFilterState === prevState.current.eventFilterState
			) {
				return prevState.current?.filteredEvents
			}

			const eventFilterState = s.secondaryFilterState
			const eventBuffer = s.chatState.eventBuffer
			const filtered: CHAT.EventEnriched[] = []
			for (const event of eventBuffer) {
				if (event.matchId !== currentMatch?.historyEntryId) continue
				if (!CHAT.isEventFilteredBySecondary(event, eventFilterState)) {
					filtered.push(event)
				}
			}
			prevState.current = {
				eventGeneration: s.eventGeneration,
				filteredEvents: filtered,
				eventFilterState: s.secondaryFilterState,
				matchId: currentMatch?.historyEntryId,
			}
			return filtered
		}, [currentMatch?.historyEntryId]),
	)

	const scrollToBottom = () => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (scrollElement) {
			scrollElement.scrollTop = scrollElement.scrollHeight
		}
		tailing.current = true
		setNewMessageCount(0)
	}

	const checkIfAtBottom = () => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return false

		const threshold = 10 // pixels from bottom to consider "at bottom"
		const { scrollHeight, scrollTop, clientHeight } = scrollElement
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight

		const isAtBottom = distanceFromBottom < threshold
		return isAtBottom
	}

	// Scroll to bottom on initial render and when new events arrive if already tailing
	// Scroll to bottom when scroll area content changes (via ResizeObserver)
	// Scroll to bottom when window becomes visible again if already tailing
	React.useEffect(() => {
		const scrollElement = eventsContainerRef.current
		if (!scrollElement) return

		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				if (tailing.current && !checkIfAtBottom()) {
					scrollToBottom()
				}
			})
		})

		const sub = Rx.fromEvent(document, 'visibilitychange').subscribe(() => {
			if (document.hidden || !tailing.current) return
			scrollToBottom()
		})

		requestAnimationFrame(() => {
			scrollToBottom()
		})

		resizeObserver.observe(scrollElement)

		return () => {
			resizeObserver.disconnect()
			sub.unsubscribe()
		}
	}, [])

	React.useEffect(() => {
		if (synced) {
			requestAnimationFrame(() => {
				scrollToBottom()
			})
		}
	}, [synced])

	// Listen to scroll events to show/hide button
	React.useEffect(() => {
		const scrollElement = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return

		const handleScroll = () => {
			const atBottom = checkIfAtBottom()
			setShowScrollButton(!atBottom)
			if (atBottom) {
				setNewMessageCount(0)
				tailing.current = true
			} else {
				tailing.current = false
			}
		}

		scrollElement.addEventListener('scroll', handleScroll)
		handleScroll() // Initial check

		return () => scrollElement.removeEventListener('scroll', handleScroll)
	}, [])

	return (
		<div className={cn(props.className, 'h-full relative')}>
			{!synced && (
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
					<PreviousMatchEvents />
					{filteredEvents && filteredEvents.length === 0 && (
						<div className="text-muted-foreground text-sm text-center py-8">
							No events yet for current match
						</div>
					)}
					{filteredEvents && filteredEvents.map((event) => <ServerEvent key={event.id} event={event} />)}
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

function PreviousMatchEvents() {
	const currentMatch = MatchHistoryClient.useCurrentMatch()
	const recentMatches = MatchHistoryClient.useRecentMatches()
	const eventFilterState = Zus.useStore(SquadServerClient.ChatStore, s => s.secondaryFilterState)

	const containerRef = React.useRef<HTMLDivElement>(null)
	const prevScrollHeightRef = React.useRef<number>(0)
	const [revealedPageCount, setRevealedPageCount] = React.useState(0)
	const revealedPageMatches: MH.MatchDetails[] = []
	for (let i = 0; i < revealedPageCount; i++) {
		if (!currentMatch) break
		const currentMatchIndex = recentMatches.length - 1
		revealedPageMatches.push(recentMatches[currentMatchIndex - i - 1])
	}

	type Page = {
		events: CHAT.EventEnriched[]
		previousOrdinal?: number
	}

	const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isError } = useInfiniteQuery({
		// we start at the current match but we don't actually load any events for it
		initialPageParam: currentMatch?.ordinal !== undefined ? currentMatch.ordinal - 1 : 0,
		enabled: !!currentMatch,
		// when the current match changes we want to unload these
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), currentMatch?.ordinal],
		staleTime: Infinity,
		queryFn: async ({ pageParam }): Promise<Page> => {
			try {
				if (pageParam === currentMatch!.ordinal) return { events: [], previousOrdinal: pageParam - 1 }
				const res = await RPC.orpc.matchHistory.getMatchEvents.call(pageParam)
				if (!res?.events) return { events: [] as CHAT.EventEnriched[], previousOrdinal: res?.previousOrdinal }

				return { events: res.events, previousOrdinal: res.previousOrdinal }
			} catch (err) {
				console.error('Failed to fetch match events for ordinal', pageParam, err)
				throw err
			}
		},
		getNextPageParam: (lastPage: Page) => lastPage?.previousOrdinal,
		maxPages: MH.MAX_RECENT_MATCHES - 1,
	})

	const totalPages = data?.pages.length ?? 0

	const prevCurrentMatchId = React.useRef(-1)
	// reset  pages when a new game starts
	React.useEffect(() => {
		if (!currentMatch?.historyEntryId) return
		if (prevCurrentMatchId.current === currentMatch.historyEntryId) return
		prevCurrentMatchId.current = currentMatch.historyEntryId
		setRevealedPageCount(0)
	}, [currentMatch?.historyEntryId])

	// Maintain scroll position when loading previous matches
	React.useEffect(() => {
		if (!containerRef.current) return
		const scrollElement = containerRef.current.closest('[data-radix-scroll-area-viewport]')
		if (!scrollElement) return

		const currentScrollHeight = scrollElement.scrollHeight
		const prevScrollHeight = prevScrollHeightRef.current

		if (prevScrollHeight > 0 && currentScrollHeight > prevScrollHeight) {
			// Content was added above, adjust scroll position
			const heightDifference = currentScrollHeight - prevScrollHeight
			scrollElement.scrollTop += heightDifference
		}

		prevScrollHeightRef.current = currentScrollHeight
	}, [revealedPageCount])

	let loadElt: React.ReactNode = null

	if (revealedPageCount < totalPages) {
		loadElt = (
			<Button
				onClick={() => {
					setRevealedPageCount(prev => prev + 1)
					void fetchNextPage()
				}}
				variant="secondary"
				disabled={isFetchingNextPage}
				className="w-full h-8 shadow-lg flex items-center justify-center gap-2 bg-opacity-20! rounded-none backdrop-blur-sm"
			>
				<Icons.ChevronUp className="h-4 w-4" />
				<span className="text-xs">Show Previous Match</span>
			</Button>
		)
	} else if (revealedPageCount >= totalPages && isError) {
		loadElt = (
			<Button
				onClick={() => fetchNextPage()}
				variant="destructive"
				className="w-full h-8 shadow-lg flex items-center justify-center gap-2 bg-opacity-20! rounded-none backdrop-blur-sm"
			>
				<Icons.AlertCircle className="h-4 w-4" />
				<span className="text-xs">Failed to load - Click to retry</span>
			</Button>
		)
	} else if (revealedPageCount >= totalPages && isFetchingNextPage) {
		loadElt = (
			<Button
				variant="secondary"
				disabled={isFetchingNextPage}
				className="w-full h-8 shadow-lg flex items-center justify-center gap-2 bg-opacity-20! rounded-none backdrop-blur-sm"
			>
				<Icons.Loader2 className="h-4 w-4 animate-spin" />
				<span className="text-xs">Loading...</span>
			</Button>
		)
	} else if (revealedPageCount >= totalPages && !hasNextPage) {
		loadElt = (
			<div className="text-muted-foreground text-xs text-center py-2">
				No previous matches available for {totalPages === MH.MAX_RECENT_MATCHES - 1 ? ' (max already loaded)' : ''}
			</div>
		)
	} else {
		loadElt = <span data-whelp="idk"></span>
	}

	return (
		<div ref={containerRef}>
			{loadElt}
			{data?.pages.slice(0, revealedPageCount).map((page, pageIndex) => {
				const match = revealedPageMatches[pageIndex]
				const filteredEvents = page?.events?.filter(event => !CHAT.isEventFilteredBySecondary(event, eventFilterState))

				return (
					<div key={page.events[0]?.id ?? `empty-${page.previousOrdinal}`}>
						{filteredEvents && filteredEvents.length === 0 && match && (
							<div className="text-muted-foreground text-xs py-2">
								No events for {DH.displayLayer(match.layerId)}
							</div>
						)}
						{filteredEvents?.map((event) => <ServerEvent key={event.id} event={event} />)}
					</div>
				)
			}).reverse()}
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

	return (
		<Card className="flex flex-col min-h-0 w-fit">
			<CardHeader className="flex flex-row justify-between flex-shrink-0 items-center pb-3">
				<div className="flex items-center gap-4">
					<CardTitle className="flex items-center gap-2">
						<Icons.Server className="h-5 w-5" />
						Server Activity
					</CardTitle>
					<EventFilterSelect />
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
