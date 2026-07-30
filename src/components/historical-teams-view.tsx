import * as Icons from 'lucide-react'

import { PlayerDisplay } from '@/components/player-display'
import { SquadDisplay } from '@/components/squad-display'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as Format from '@/messages/format'
import type * as CHAT from '@/models/chat.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

import { type HistoricalMember, type HistoricalTeam, Sel } from './historical-teams-view.helpers'

export default function HistoricalTeamsView(props: { stores: SquadServerFrame.KeyProp; events: CHAT.EventEnriched[] | null }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const teams = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		Sel.teams(props.events),
	)
	const displayMatch = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ChatPrt.Sel.displayMatch,
	)
	if (!teams) return null

	return (
		<ScrollArea className="h-full">
			<div className="pr-4 @container">
				<p className="text-xs text-muted-foreground px-1 pb-2">{tr.text(CHAT_Msgs.historicalTeamsDescription())}</p>
				<div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-x-6 gap-y-4 items-start">
					{teams.map((team) => (
						<TeamColumn key={team.display.label} team={team} matchId={displayMatch?.historyEntryId ?? 0} stores={props.stores} />
					))}
				</div>
			</div>
		</ScrollArea>
	)
}

function TeamColumn(props: { team: HistoricalTeam; matchId: number; stores: SquadServerFrame.KeyProp }) {
	const team = props.team
	return (
		<section aria-label={team.display.label} className="min-w-0">
			<h3 className="flex items-center gap-2 text-sm font-semibold border-b pb-1 mb-1.5">
				<span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: team.display.color }} />
				<span className="truncate">{team.display.label}</span>
				<span className="ml-auto text-xs font-normal text-muted-foreground whitespace-nowrap">
					{tr.text(CHAT_Msgs.teamPlayerCount(team.playerCount))}
				</span>
			</h3>
			<ul className="flex flex-col gap-1.5">
				{team.squads.map((group) => (
					<li key={group.squad?.uniqueId ?? 'unassigned'}>
						<div className="text-xs text-muted-foreground">
							{group.squad ? (
								<SquadDisplay squad={group.squad} matchId={props.matchId} showMenu={false} stores={props.stores} />
							) : (
								<span className="font-bold">{tr.text(CHAT_Msgs.unassignedSquad())}</span>
							)}
						</div>
						<ul className="flex flex-col">
							{group.members.map((member) => (
								<MemberRow key={member.player.ids.eos} member={member} matchId={props.matchId} stores={props.stores} />
							))}
						</ul>
					</li>
				))}
			</ul>
		</section>
	)
}

function MemberRow(props: { member: HistoricalMember; matchId: number; stores: SquadServerFrame.KeyProp }) {
	const member = props.member
	return (
		<li className={cn('flex items-center gap-1.5 text-sm pl-2 min-w-0', !member.eligible && 'opacity-60')}>
			{/* the context menu's actions target the live server, where this roster's players may no longer be */}
			<PlayerDisplay
				player={member.player}
				matchId={props.matchId}
				stores={props.stores}
				className="min-w-0 truncate"
				disableContextMenu
			/>
			<span
				className="ml-auto text-xs text-muted-foreground tabular-nums whitespace-nowrap"
				title={tr.text(CHAT_Msgs.timeOnTeam(Format.formatIntervalCompact(member.timeMs)))}
			>
				{Format.formatIntervalCompact(member.timeMs)}
			</span>
			{/* only stints worth naming: the compact format rounds anything shorter up to "1m", which overstates a
			 few seconds spent on the wrong side while the roster settled */}
			{member.otherTeamMs >= 60_000 && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Icons.ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					</TooltipTrigger>
					<TooltipContent>{tr.text(CHAT_Msgs.alsoOnOtherTeam(Format.formatIntervalCompact(member.otherTeamMs)))}</TooltipContent>
				</Tooltip>
			)}
			{!member.eligible && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Icons.TriangleAlert className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
					</TooltipTrigger>
					<TooltipContent>
						<p>{tr.text(CHAT_Msgs.notInBreakdown())}</p>
						<ul className="list-disc pl-4 text-muted-foreground">
							{member.exclusionReasons.map((reason) => (
								<li key={reason}>{tr.text(CHAT_Msgs.exclusionReasonLabels[reason])}</li>
							))}
						</ul>
					</TooltipContent>
				</Tooltip>
			)}
		</li>
	)
}
