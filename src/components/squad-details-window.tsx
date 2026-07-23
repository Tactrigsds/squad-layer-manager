import { PlayerDisplay } from '@/components/player-display'
import { SquadMenuItems } from '@/components/squad-context-menu-options'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as ChatPrt from '@/frame-partials/chat.partial'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'

import { useTailingScroll } from '@/hooks/use-tailing-scroll'
import * as ZusUtils from '@/lib/zustand'
import * as CHAT from '@/models/chat.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import { ServerEvent } from './server-event'
import type { SquadDetailsWindowProps } from './squad-details-window.helpers'
import { MatchTeamDisplay } from './teams-display'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowPinToggle, DraggableWindowTitle } from './ui/draggable-window'
import { Separator } from './ui/separator'
import { Spinner } from './ui/spinner'
import WarnChatBox from './warn-chat-box'

const dropdownMenuSlots = {
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent,
}

DraggableWindowStore.getState().registerDefinition<SquadDetailsWindowProps, unknown>({
	type: WINDOW_ID.enum['squad-details'],
	component: SquadDetailsWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 420,
	minHeight: 320,
	defaultWidth: 650,
	defaultHeight: 560,
	getId: (props) => String(props.uniqueSquadId),
	loadAsync: async ({ props }) => {
		const squadServerFrameKey = props.stores.squadServer
		const isLive = ChatPrt.Sel.chatState(ZusUtils.getState(squadServerFrameKey)).squads.some(sq => sq.uniqueId === props.uniqueSquadId)
		if (!isLive) {
			const serverId = squadServerFrameKey.serverId
			await RPC.queryClient.fetchQuery(
				RPC.orpc.matchHistory.getSquadDetails.queryOptions({ input: { serverId, uniqueSquadId: props.uniqueSquadId } }),
			)
		}
	},
})

function SquadDetailsWindow({ uniqueSquadId, stores }: SquadDetailsWindowProps) {
	const squadServerFrameKey = stores.squadServer
	const serverId = squadServerFrameKey.serverId
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)

	const liveSquad = ZusUtils.useStore(
		squadServerFrameKey,
		s => ChatPrt.Sel.chatState(s).squads.find(sq => sq.uniqueId === uniqueSquadId) ?? null,
	)
	// a squad that disbands while this window is open drops off `squads`, but a RecentSquad still names the instance,
	// so the window keeps its title/team/creator instead of blanking out. Its live state (locked, the member list)
	// legitimately goes away with it.
	const recentSquad = ZusUtils.useStore(squadServerFrameKey, s => ChatPrt.Sel.recentSquad(uniqueSquadId)(s) ?? null)
	const knownSquad = liveSquad ?? recentSquad

	const currentMatchEvents = ZusUtils.useStore(
		squadServerFrameKey,
		ZusUtils.useShallow(s =>
			!currentMatch
				? []
				: ChatPrt.Sel.chatEvents(s).filter(e => e.matchId === currentMatch.historyEntryId && CHAT.isSquadFeedEvent(e, uniqueSquadId, false))
		),
	)

	const isCurrentMatchSquad = currentMatchEvents.length > 0

	const [squadMessagesOnly, setSquadMessagesOnly] = React.useState(false)

	const { data, isPending } = useQuery(RPC.orpc.matchHistory.getSquadDetails.queryOptions({
		input: { serverId, uniqueSquadId },
		enabled: !isCurrentMatchSquad,
		select: res => RPC.selectLoaded(res),
	}))

	const squad = data?.squad

	const currentPlayers = ZusUtils.useStore(
		squadServerFrameKey,
		ZusUtils.useShallow(s =>
			liveSquad
				? ChatPrt.Sel.chatState(s).players.filter(p => p.squadId === liveSquad.squadId && p.teamId === liveSquad.teamId)
				: []
		),
	)

	const allEvents = React.useMemo(() => {
		const events = isCurrentMatchSquad ? currentMatchEvents : (data?.events ?? [])
		// the events are already scoped to this squad instance; the toggle just hides member chat outside the squad
		// channel, i.e. any chat message not directly associated with the squad (team/all chat).
		if (!squadMessagesOnly) return events
		return events.filter(e => !(e.type === 'CHAT_MESSAGE' && !CHAT.hasAssocSquad(e, uniqueSquadId)))
	}, [isCurrentMatchSquad, currentMatchEvents, data?.events, squadMessagesOnly, uniqueSquadId])

	const { scrollAreaRef, contentRef, showScrollButton, scrollToBottom } = useTailingScroll()

	const creatorId = knownSquad?.creator ?? squad?.creatorId ?? null
	const creatorPlayer = creatorId
		? (currentPlayers.find(p => SM.PlayerIds.getPlayerId(p.ids) === creatorId)
			?? CHAT.findLastPlayerInstance(allEvents, creatorId))
		: null

	const teamId = (knownSquad?.teamId ?? squad?.teamId) as 1 | 2 | undefined
	const ingameSquadId = knownSquad?.squadId ?? squad?.ingameSquadId
	const isDefaultName = !knownSquad || knownSquad.squadName === `Squad ${ingameSquadId}`
	const displayName = knownSquad?.squadName ?? (ingameSquadId != null ? `Squad ${ingameSquadId}` : 'Squad Details')

	const aboveChatZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>
					{isDefaultName
						? displayName
						: <span className="font-semibold">{displayName}</span>}
					{teamId != null && (
						<span className="text-muted-foreground font-normal ml-1">
							(
							{currentMatch && <MatchTeamDisplay matchId={currentMatch.historyEntryId} teamId={teamId} stores={stores} />}
							{liveSquad?.locked && <Icons.Lock className="h-3 w-3 inline ml-1" aria-label="Squad is locked" />}
							)
						</span>
					)}
				</DraggableWindowTitle>
				{liveSquad && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
								title="Squad actions"
							>
								<Icons.Ellipsis className="h-3.5 w-3.5" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<SquadMenuItems squad={liveSquad} slots={dropdownMenuSlots} stores={stores} omitWarn />
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>

			<div className="px-3 py-2 space-y-1 text-xs border-b border-border/50">
				{creatorId && (
					<div className="flex items-center gap-1">
						<span className="text-muted-foreground shrink-0">Creator:</span>
						{creatorPlayer
							? <PlayerDisplay player={creatorPlayer} matchId={currentMatch?.historyEntryId ?? 0} stores={stores} />
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
				<div className="flex-1 px-3 py-0.5 min-w-0 flex flex-col">
					<div className="flex items-center justify-between gap-2 py-0.5">
						<h3 className="text-xs font-medium">Squad Events</h3>
						<label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
							<Checkbox
								className="h-3.5 w-3.5"
								checked={squadMessagesOnly}
								onCheckedChange={checked => setSquadMessagesOnly(checked === true)}
							/>
							Hide team/allchat
						</label>
					</div>
					<div className="relative flex-1 min-h-0">
						<ScrollArea ref={scrollAreaRef} className="h-full">
							<div ref={contentRef} className="flex flex-col gap-0.5 min-h-0 w-full max-w-175">
								{isPending && allEvents.length === 0 && (
									<div className="flex items-center justify-center py-6">
										<Spinner className="size-5" />
									</div>
								)}
								{allEvents.map(e => <ServerEvent key={e.id} event={e} stores={stores} />)}
							</div>
						</ScrollArea>
						{showScrollButton && (
							<Button
								onClick={() => scrollToBottom()}
								variant="secondary"
								style={{ zIndex: aboveChatZIndex }}
								className="absolute bottom-0 left-0 right-0 w-full h-6 shadow-lg flex items-center justify-center bg-opacity-20! rounded-none backdrop-blur-sm"
								title="Scroll to bottom"
							>
								<Icons.ChevronDown className="h-3 w-3" />
								<span className="text-xs">Scroll to bottom</span>
							</Button>
						)}
					</div>
				</div>

				<Separator orientation="vertical" />

				<div className="w-36 shrink-0 px-2 py-0.5 flex flex-col min-h-0">
					<h3 className="text-xs font-medium py-0.5">Players ({currentPlayers.length})</h3>
					<div className="flex flex-col gap-1 overflow-y-auto min-h-0">
						{[...currentPlayers].sort((a, b) => Number(b.isLeader) - Number(a.isLeader)).map(player => (
							<PlayerDisplay
								key={SM.PlayerIds.getPlayerId(player.ids)}
								className="text-xs"
								player={player}
								matchId={currentMatch?.historyEntryId ?? 0}
								stores={stores}
							/>
						))}
						{currentPlayers.length === 0 && <span className="text-muted-foreground text-xs italic">No players</span>}
					</div>
				</div>
			</div>
			{liveSquad && currentPlayers.length > 0 && (
				<div className="px-3 py-2 border-t border-border/50">
					<WarnChatBox
						serverId={serverId}
						playerIds={currentPlayers.map(p => SM.PlayerIds.getPlayerId(p.ids))}
						bodyPrefix={`@Squad${ingameSquadId}`}
						focusTarget={{ kind: 'squad', uniqueSquadId }}
						placeholder={`Warn ${displayName}…`}
					/>
				</div>
			)}
		</div>
	)
}
