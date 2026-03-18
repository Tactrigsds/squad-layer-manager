import { PlayerDisplay } from '@/components/player-display'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import * as ZusUtils from '@/lib/zustand'
import * as CHAT from '@/models/chat.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { ServerEvent } from './server-event'
import type { SquadDetailsWindowProps } from './squad-details-window.helpers'
import { MatchTeamDisplay } from './teams-display'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowPinToggle, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'
import { Separator } from './ui/separator'
import { Spinner } from './ui/spinner'

DraggableWindowStore.getState().registerDefinition<SquadDetailsWindowProps, unknown>({
	type: WINDOW_ID.enum['squad-details'],
	component: SquadDetailsWindow,
	initialPosition: 'left',
	getId: (props) => String(props.uniqueSquadId),
	loadAsync: async ({ props }) => {
		const isLive = SquadServerClient.ChatStore.getState().chatState.interpolatedState.squads.some(
			sq => sq.uniqueId === props.uniqueSquadId,
		)
		if (!isLive) {
			await RPC.queryClient.fetchQuery(
				RPC.orpc.matchHistory.getSquadDetails.queryOptions({ input: { uniqueSquadId: props.uniqueSquadId } }),
			)
		}
	},
})

function SquadDetailsWindow({ uniqueSquadId }: SquadDetailsWindowProps) {
	const currentMatch = MatchHistoryClient.useCurrentMatch()

	const liveSquad = Zus.useStore(
		SquadServerClient.ChatStore,
		s => s.chatState.interpolatedState.squads.find(sq => sq.uniqueId === uniqueSquadId) ?? null,
	)

	const currentMatchEvents = Zus.useStore(
		SquadServerClient.ChatStore,
		ZusUtils.useShallow(s =>
			!currentMatch
				? []
				: s.chatState.eventBuffer.filter(e => {
					if (e.matchId !== currentMatch.historyEntryId || e.type === 'NOOP') return false
					return Array.from(SE.iterAssocSquadUniqueIds(e as SE.Event)).some(k => k === uniqueSquadId)
				})
		),
	)

	const isCurrentMatchSquad = currentMatchEvents.length > 0

	const { data, isPending } = useQuery({
		...RPC.orpc.matchHistory.getSquadDetails.queryOptions({ input: { uniqueSquadId } }),
		enabled: !isCurrentMatchSquad,
	})

	const squad = data?.squad

	const currentPlayers = Zus.useStore(
		SquadServerClient.ChatStore,
		ZusUtils.useShallow(s =>
			liveSquad
				? s.chatState.interpolatedState.players.filter(p => p.squadId === liveSquad.squadId && p.teamId === liveSquad.teamId)
				: []
		),
	)

	const allEvents = React.useMemo(() => (isCurrentMatchSquad
		? currentMatchEvents
		: (data?.events ?? [])), [isCurrentMatchSquad, currentMatchEvents, data?.events])

	const { scrollAreaRef, contentRef, bottomRef, showScrollButton, scrollToBottom } = useTailingScroll()
	useDraggableWindow()

	const creatorId = liveSquad?.creator ?? squad?.creatorId ?? null
	const creatorPlayer = creatorId
		? (currentPlayers.find(p => SM.PlayerIds.getPlayerId(p.ids) === creatorId)
			?? CHAT.findLastPlayerInstance(allEvents, creatorId))
		: null

	const teamId = (liveSquad?.teamId ?? squad?.teamId) as 1 | 2 | undefined
	const ingameSquadId = liveSquad?.squadId ?? squad?.ingameSquadId
	const isDefaultName = !liveSquad || liveSquad.squadName === `Squad ${ingameSquadId}`
	const displayName = liveSquad?.squadName ?? (ingameSquadId != null ? `Squad ${ingameSquadId}` : 'Squad Details')

	return (
		<div className="min-w-0 min-h-0 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>
					{isDefaultName
						? displayName
						: <span className="font-semibold">{displayName}</span>}
					{teamId != null && (
						<span className="text-muted-foreground font-normal ml-1">
							(
							{currentMatch && <MatchTeamDisplay matchId={currentMatch.historyEntryId} teamId={teamId} />}
							{liveSquad?.locked && <Icons.Lock className="h-3 w-3 inline ml-1" aria-label="Squad is locked" />}
							)
						</span>
					)}
				</DraggableWindowTitle>
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>

			<div className="px-3 py-2 space-y-1 text-xs border-b border-border/50">
				{creatorId && (
					<div className="flex items-center gap-1">
						<span className="text-muted-foreground shrink-0">Creator:</span>
						{creatorPlayer
							? <PlayerDisplay player={creatorPlayer} matchId={currentMatch?.historyEntryId ?? 0} />
							: <span className="font-mono text-muted-foreground">{creatorId}</span>}
					</div>
				)}
				{teamId != null && ingameSquadId != null && (
					<div className="flex items-center gap-2 text-muted-foreground">
						<span>Team {teamId}</span>
						<span>·</span>
						<span>In-game ID: {ingameSquadId}</span>
					</div>
				)}
			</div>

			<Separator />

			<div className="flex min-h-0 flex-1">
				<div className="flex-1 px-3 py-0.5 min-w-0">
					<h3 className="text-xs font-medium py-0.5">Squad Events</h3>
					<ScrollArea ref={scrollAreaRef} className="h-75">
						<div ref={contentRef} className="flex flex-col gap-0.5 min-h-0 w-full max-w-175">
							{isPending && allEvents.length === 0 && (
								<div className="flex items-center justify-center py-6">
									<Spinner className="size-5" />
								</div>
							)}
							{allEvents.map(e => <ServerEvent key={e.id} event={e} />)}
						</div>
						<div ref={bottomRef} />
						{showScrollButton && (
							<Button
								onClick={() => scrollToBottom()}
								variant="secondary"
								className="absolute bottom-0 left-0 right-0 w-full h-6 shadow-lg flex items-center justify-center z-10 bg-opacity-20! rounded-none backdrop-blur-sm"
								title="Scroll to bottom"
							>
								<Icons.ChevronDown className="h-3 w-3" />
								<span className="text-xs">Scroll to bottom</span>
							</Button>
						)}
					</ScrollArea>
				</div>

				<Separator orientation="vertical" />

				<div className="w-36 shrink-0 px-2 py-0.5">
					<h3 className="text-xs font-medium py-0.5">Players ({currentPlayers.length})</h3>
					<div className="flex flex-col gap-1">
						{[...currentPlayers].sort((a, b) => Number(b.isLeader) - Number(a.isLeader)).map(player => (
							<PlayerDisplay
								key={SM.PlayerIds.getPlayerId(player.ids)}
								className="text-xs"
								player={player}
								matchId={currentMatch?.historyEntryId ?? 0}
							/>
						))}
						{currentPlayers.length === 0 && <span className="text-muted-foreground text-xs italic">No players</span>}
					</div>
				</div>
			</div>
		</div>
	)
}
