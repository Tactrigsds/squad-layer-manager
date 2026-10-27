import * as Icons from 'lucide-react'
import React from 'react'

import { PlayerDisplay } from '@/components/player-display'
import { SquadDisplay } from '@/components/squad-display'
import { StatsSortOptions } from '@/components/stats-sort-options'
import { statMetricLabel } from '@/components/stats-sort-options.helpers'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Str from '@/lib/string-utils'
import { useDebounced } from '@/lib/use-debounce'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as MsgFmt from '@/messages/format'
import * as SM_Msgs from '@/messages/squad.messages'
import * as CHAT from '@/models/chat.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

import { type HistoricalMember, type HistoricalSquadGroup, Sel, type SortedHistoricalTeam } from './historical-teams-view.helpers'

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
		Sel.sortedTeams(props.events),
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
			<div className="pe-4 @container">
				<p className="text-xs text-muted-foreground px-1 pb-2">{tr.text(CHAT_Msgs.historicalTeamsDescription())}</p>
				<HistoricalTeamsControls stores={props.stores} />
				<div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-x-6 gap-y-4 items-start">
					{teams.map((team) => (
						<TeamColumn key={team.display.label} team={team} matchId={displayMatch?.historyEntryId ?? 0} stores={props.stores} />
					))}
				</div>
			</div>
		</ScrollArea>
	)
}

const SEARCH_DEBOUNCE_MS = 150

function HistoricalTeamsControls(props: { stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const chat: ChatPrt.KeyProp = { chat: squadServer }
	const sort = Zus.useStore(chat.chat, ChatPrt.Sel.historicalTeamsSort)
	const countedOnly = Zus.useStore(chat.chat, ChatPrt.Sel.historicalTeamsCountedOnly)
	const countedOnlyId = React.useId()
	const [open, setOpen] = React.useState(false)
	// read once: the input is uncontrolled, so the store only seeds it
	const [initialSearch] = React.useState(() => Zus.getState(chat.chat, ChatPrt.Sel.historicalTeamsSearch))
	const onSearchChange = React.useCallback(
		(query: string) => ChatPrt.Actions.setHistoricalTeamsSearch({ chat: squadServer }, query),
		[squadServer],
	)
	const setSearch = useDebounced({ delay: SEARCH_DEBOUNCE_MS, onChange: onSearchChange })
	const extraKeys = [
		{ key: 'name' as const, label: tr.text(CHAT_Msgs.historicalSortName()) },
		{ key: 'time' as const, label: tr.text(CHAT_Msgs.historicalSortTime()) },
	]
	const sorted = sort.key !== 'default'
	const keyLabel = (key: Exclude<CHAT.HistoricalTeamsSort['key'], 'default'>) =>
		extraKeys.find((k) => k.key === key)?.label ?? tr.text(statMetricLabel(key as CHAT.StatMetric))
	return (
		<div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
			<Input
				containerClassName="min-w-0 flex-[0_1_180px]"
				placeholder={tr.text(SM_Msgs.searchPlayers())}
				defaultValue={initialSearch}
				onChange={(e) => setSearch(e.target.value)}
			/>
			<div className="flex items-center gap-1.5" title={tr.text(CHAT_Msgs.countedOnlyHint())}>
				<Checkbox
					id={countedOnlyId}
					checked={countedOnly}
					onCheckedChange={(checked) => ChatPrt.Actions.setHistoricalTeamsCountedOnly(chat, checked)}
				/>
				<Label htmlFor={countedOnlyId} className="fd-lbl-plain">
					{tr.text(CHAT_Msgs.countedOnly())}
				</Label>
			</div>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button size="sm" variant="outline" className={cn('min-w-0', sorted && 'text-primary')}>
						<Icons.ArrowUpDown />
						<span className="truncate">
							{sort.key !== 'default'
								? tr.text(SM_Msgs.statsSortLabel(sort.scope, keyLabel(sort.key)))
								: tr.text(CHAT_Msgs.historicalSortButton())}
						</span>
						{sorted && <span className="font-mono">{sort.desc ? '↓' : '↑'}</span>}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-auto max-w-80 p-1">
					<StatsSortOptions
						scope={sorted ? sort.scope : null}
						sortKey={sorted ? sort.key : 'kills'}
						desc={sort.desc}
						extraKeys={extraKeys}
						onPick={(pick) => ChatPrt.Actions.setHistoricalTeamsSort(chat, pick)}
						onClear={() => {
							ChatPrt.Actions.setHistoricalTeamsSort(chat, CHAT.DEFAULT_HISTORICAL_TEAMS_SORT)
							setOpen(false)
						}}
					/>
				</PopoverContent>
			</Popover>
		</div>
	)
}

function TeamColumn(props: { team: SortedHistoricalTeam; matchId: number; stores: SquadServerFrame.KeyProp }) {
	const team = props.team
	return (
		<section aria-label={team.display.label} className="min-w-0">
			<h3 className="flex items-center gap-2 text-sm font-semibold border-b pb-1 mb-1.5">
				<span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: team.display.color }} />
				<span className="truncate">{team.display.label}</span>
				<span className="ms-auto text-xs font-normal text-muted-foreground whitespace-nowrap">
					{tr.text(SM_Msgs.squadRowCount(team.shownCount, team.playerCount))}
				</span>
			</h3>
			{team.shownCount === 0 ? (
				<p className="px-2 text-xs text-muted-foreground">{tr.text(CHAT_Msgs.noHistoricalPlayersMatch())}</p>
			) : team.layout.kind === 'squads' ? (
				<ul className="flex flex-col gap-1.5">
					{team.layout.squads.map((group) => (
						<li key={group.squad?.uniqueId ?? 'unassigned'}>
							<SquadHeading group={group} matchId={props.matchId} stores={props.stores} />
							<ul className="flex flex-col">
								{group.members.map((member) => (
									<MemberRow key={member.player.ids.eos} member={member} matchId={props.matchId} stores={props.stores} />
								))}
							</ul>
						</li>
					))}
				</ul>
			) : (
				<ul className="flex flex-col">
					{team.layout.members.map((member) => (
						<MemberRow key={member.player.ids.eos} member={member} matchId={props.matchId} stores={props.stores} showSquad />
					))}
				</ul>
			)}
		</section>
	)
}

function SquadHeading(props: { group: HistoricalSquadGroup; matchId: number; stores: SquadServerFrame.KeyProp }) {
	const { squad, score } = props.group
	const kd = Str.formatRatio(score.kills, score.deaths)
	return (
		<div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
			{squad ? (
				<SquadDisplay squad={squad} matchId={props.matchId} showMenu={false} stores={props.stores} className="min-w-0" />
			) : (
				<span className="font-bold">{tr.text(CHAT_Msgs.unassignedSquad())}</span>
			)}
			{squad && (
				<span className="ms-auto font-mono whitespace-nowrap" title={tr.text(CHAT_Msgs.squadScoreHint(kd))}>
					{score.kills}/{score.wounds}/{score.deaths}
					<span className="ms-1.5">{kd}</span>
				</span>
			)}
		</div>
	)
}

function MemberRow(props: { member: HistoricalMember; matchId: number; stores: SquadServerFrame.KeyProp; showSquad?: boolean }) {
	const member = props.member
	return (
		<li className={cn('flex flex-wrap items-center gap-x-1.5 text-sm ps-2 min-w-0', !member.eligible && 'opacity-60')}>
			{props.showSquad && (
				<span
					className="min-w-[2ch] shrink-0 text-end font-mono text-xs text-muted-foreground"
					title={member.squad?.squadName ?? tr.text(CHAT_Msgs.unassignedSquad())}
				>
					{member.squad?.squadId ?? '-'}
				</span>
			)}
			{/* the context menu's actions target the live server, where this roster's players may no longer be */}
			<PlayerDisplay
				player={member.player}
				matchId={props.matchId}
				stores={props.stores}
				className="min-w-0 flex-[1_1_5rem] truncate"
				disableContextMenu
			/>
			<span className="ms-auto font-mono text-xs whitespace-nowrap" title={tr.text(CHAT_Msgs.scorelineHint())}>
				{member.stats.kills}/{member.stats.wounds}/{member.stats.deaths}
			</span>
			{member.stats.teamkills > 0 && (
				<span
					className="font-mono text-xs tabular-nums text-destructive font-semibold whitespace-nowrap"
					title={tr.text(SM_Msgs.teamKillsHint())}
				>
					{tr.text(SM_Msgs.teamKillsCount(member.stats.teamkills))}
				</span>
			)}
			<span
				className="text-xs text-muted-foreground tabular-nums whitespace-nowrap"
				title={tr.text(CHAT_Msgs.timeOnTeam(MsgFmt.formatIntervalCompact(member.timeMs)))}
			>
				{MsgFmt.formatIntervalCompact(member.timeMs)}
			</span>
			{/* only stints worth naming: the compact format rounds anything shorter up to "1m", which overstates a
			 few seconds spent on the wrong side while the roster settled */}
			{member.otherTeamMs >= 60_000 && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Icons.ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					</TooltipTrigger>
					<TooltipContent>{tr.text(CHAT_Msgs.alsoOnOtherTeam(MsgFmt.formatIntervalCompact(member.otherTeamMs)))}</TooltipContent>
				</Tooltip>
			)}
			{!member.eligible && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Icons.TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warn" />
					</TooltipTrigger>
					<TooltipContent>
						<p>{tr.text(CHAT_Msgs.notInBreakdown())}</p>
						<ul className="list-disc ps-4 text-muted-foreground">
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
