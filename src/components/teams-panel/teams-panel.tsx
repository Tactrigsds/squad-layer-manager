import * as Icons from 'lucide-react'
import React from 'react'

import { StickyGroup } from '@/components/sticky-group.tsx'
import type { SwitchRequestsWindowProps } from '@/components/switch-requests-window.helpers'
import { MatchTeamDisplay } from '@/components/teams-display'
import {
	CollapseSquadsButton,
	PhoneSelectionBar,
	PhoneSortSheet,
	PhoneSwapsSummary,
	PhoneTeamsToolbar,
} from '@/components/teams-panel/phone-toolbar'
import { CombinedPlayerTable, TeamPlayerTable } from '@/components/teams-panel/roster-tables'
import { SwapsPanel } from '@/components/teams-panel/swaps-panel'
import { useGroupingModes } from '@/components/teams-panel/teams-panel.helpers'
import type { TimeoutsWindowProps } from '@/components/timeouts-window.helpers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { OpenWindowInteraction } from '@/components/ui/draggable-window'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Browser from '@/lib/browser'
import { useDeadlineClock } from '@/lib/react.ts'
import { assertNever } from '@/lib/type-guards'
import { useDebounced } from '@/lib/use-debounce'
import { usePriorityPlus } from '@/lib/use-priority-plus'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as SRQ_Msgs from '@/messages/switch-requests.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as MH from '@/models/match-history.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SRQClient from '@/systems/switch-requests.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as UPClient from '@/systems/user-presence.client'

void import('@/components/squad-details-window')

void import('@/components/switch-requests-window')

void import('@/components/teamswaps-help-window')

void import('@/components/team-swaps-window')

void import('@/components/timeouts-window')

// filtering both rosters is the expensive part of a keystroke and does not need to keep up with typing
const SEARCH_DEBOUNCE_MS = 150

// in fold order: when the header row runs out of room the last one moves into the More menu first
const FOLDABLE_TOGGLES = ['admins-only', 'show-spoilers'] as const
type FoldableToggle = (typeof FOLDABLE_TOGGLES)[number]

export default function TeamsPanel(props: { className?: string; stores: SquadServerFrame.KeyProp }) {
	const headerRef = React.useRef<HTMLDivElement>(null)
	const searchRef = React.useRef<HTMLInputElement>(null)
	const phone = Browser.useIsSmallViewport()
	const [sheetOpen, setSheetOpen] = React.useState(false)
	const squadServer = props.stores.squadServer!
	const panelStores: TeamsPanelPrt.KeyProp = { teamsPanel: squadServer }
	const splitTables = Zus.useStore(squadServer, TeamsPanelPrt.Sel.splitTables) && !phone
	const currentMatch = MatchHistoryClient.useCurrentMatch(squadServer.serverId)
	const displayTeamsNormalized = Zus.useStore(ClientOnlySettings.Store, (s) => s.displayTeamsNormalized)
	// the panel's state is keyed by normed team id, so a team keeps its filters and sorting when the displayed
	// order flips
	const [leftTeam, rightTeam] = MH.getDisplayedTeamOrder(currentMatch?.ordinal ?? 0, displayTeamsNormalized)
	const showSwapsPanel = Zus.useStore(
		squadServer,
		UPClient.Store,
		(tswStore, upStore) => TSWClient.Sel.hasSwaps(tswStore) || upStore.teamswapEditors.size > 0,
	)
	const selectedCount = Zus.useStore(squadServer, SquadServerFrame.Sel.selectedPlayerCount)
	const isReset = Zus.useStore(squadServer, SquadServerFrame.Sel.teamsPanelIsReset)
	const { showSelected, showSpoilers, roleFilter } = Zus.useStore(squadServer, TeamsPanelPrt.Sel.headerState)
	const showSelectedId = React.useId()
	const { fitCount, boxRef, measureRef } = usePriorityPlus(FOLDABLE_TOGGLES.length, !phone)
	const inlineToggles = FOLDABLE_TOGGLES.slice(0, fitCount)
	const foldedToggles = FOLDABLE_TOGGLES.slice(fitCount)
	// read once: the input is uncontrolled, so the store only seeds it
	const [initialSearchQuery] = React.useState(() => Zus.getState(squadServer, TeamsPanelPrt.Sel.searchQuery))
	const onSearchChange = React.useCallback(
		(searchQuery: string) => TeamsPanelPrt.Actions.setSearchQuery({ teamsPanel: squadServer }, searchQuery),
		[squadServer],
	)
	const setSearchQuery = useDebounced({ delay: SEARCH_DEBOUNCE_MS, onChange: onSearchChange })
	return (
		<div data-tour="teams-panel" className={cn('flex w-full flex-col', props.className)}>
			<div ref={headerRef} data-tour="teams-header" className="flex w-full flex-col gap-1.5 bg-panel px-2 pt-1.5 pb-1.5">
				<div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 text-base">
					<div className="min-w-0 truncate">
						<TeamTitle teamId={leftTeam} stores={props.stores} />
					</div>
					<TeamPlayerCounts leftTeam={leftTeam} rightTeam={rightTeam} stores={props.stores} />
					<div className="flex min-w-0 justify-end truncate">
						<TeamTitle teamId={rightTeam} stores={props.stores} />
					</div>
				</div>
				{showSwapsPanel && phone && <PhoneSwapsSummary leftTeam={leftTeam} rightTeam={rightTeam} stores={props.stores} />}
				{showSwapsPanel && !phone && (
					<SwapsPanel
						className="rounded-[3px] border border-line bg-white/3 px-2 py-1.5 text-xs"
						leftTeam={leftTeam}
						rightTeam={rightTeam}
						stores={props.stores}
					/>
				)}
				{phone ? (
					<PhoneTeamsToolbar
						stores={props.stores}
						searchRef={searchRef}
						initialSearchQuery={initialSearchQuery}
						onSearchChange={setSearchQuery}
						leftTeam={leftTeam}
						rightTeam={rightTeam}
						onOpenSheet={() => setSheetOpen(true)}
					/>
				) : (
					<div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 whitespace-nowrap">
						<div className="flex items-center gap-1.5">
							<Input
								ref={searchRef}
								data-tour="teams-search"
								containerClassName="w-[180px]"
								placeholder={tr.text(SM_Msgs.searchPlayers())}
								defaultValue={initialSearchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								// additive, like every other selection action -- merge matches into the current selection. Reads the
								// live input rather than the store, which the debounce may not have caught up to yet.
								onKeyDown={(e) => {
									if (e.key === 'Enter') SquadServerFrame.Actions.selectSearchMatches(props.stores, e.currentTarget.value)
								}}
							/>
							<CollapseSquadsButton sortingTarget={splitTables ? 'teams' : 'combined'} stores={props.stores} />
							<Button
								data-tour="teams-reset"
								size="icon"
								className="shrink-0"
								title={tr.text(SM_Msgs.resetPanel())}
								disabled={isReset}
								onClick={() => {
									SquadServerFrame.Actions.resetTeamsPanel(props.stores)
									if (searchRef.current) searchRef.current.value = ''
								}}
							>
								<Icons.Trash />
							</Button>
						</div>
						<div className="flex items-center gap-1.5">
							<Switch
								id={showSelectedId}
								checked={showSelected}
								disabled={selectedCount === 0}
								onCheckedChange={(checked) => TeamsPanelPrt.Actions.setShowSelected(panelStores, checked)}
							/>
							<Label htmlFor={showSelectedId} className="fd-lbl-plain">
								{tr.text(SM_Msgs.showSelected())}
							</Label>
							<span className="min-w-[3ch] font-mono text-xs text-text-3 data-[hide=true]:invisible" data-hide={selectedCount === 0}>
								({selectedCount})
							</span>
						</div>
						<div ref={boxRef} className="relative flex min-w-0 flex-1 items-center gap-x-3">
							{inlineToggles.map((toggle) => (
								<HeaderToggle key={toggle} toggle={toggle} stores={props.stores} />
							))}
							<div
								ref={measureRef}
								inert
								aria-hidden
								className="invisible pointer-events-none absolute top-0 start-0 flex w-max gap-x-3"
							>
								{FOLDABLE_TOGGLES.map((toggle) => (
									<HeaderToggle key={toggle} toggle={toggle} measure stores={props.stores} />
								))}
							</div>
						</div>
						{!showSpoilers && roleFilter !== null && (
							<Badge variant="secondary" className="gap-1" title={tr.text(SM_Msgs.hiddenRoleFilter())}>
								{tr.text(SM_Msgs.roleFilterLabel(roleFilter))}
								<button
									type="button"
									className="hover:text-destructive"
									title={tr.text(SM_Msgs.clearRoleFilter())}
									onClick={() => TeamsPanelPrt.Actions.setRoleFilter(panelStores, null)}
								>
									<Icons.X className="size-2.5" />
								</button>
							</Badge>
						)}
						<ControlPanel stores={props.stores} foldedToggles={foldedToggles} />
					</div>
				)}
			</div>
			<StickyGroup stickyRef={headerRef}>
				{splitTables ? (
					<div
						data-tour="teams-tables"
						className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-line [&>*+*]:shadow-[-1px_0_0_var(--line-soft)] rtl:[&>*+*]:shadow-[1px_0_0_var(--line-soft)]"
					>
						{([leftTeam, rightTeam] as const).map((teamId, i) => (
							// keyed by team so a table's own state (stats metric, popovers) follows its team across a flip
							<TeamPlayerTable key={teamId} teamId={teamId} className={i === 1 ? 'ps-1.5' : undefined} stores={props.stores} />
						))}
					</div>
				) : (
					<div data-tour="teams-tables" className="w-full">
						<CombinedPlayerTable stores={props.stores} />
					</div>
				)}
			</StickyGroup>
			{phone && (
				<>
					<PhoneSortSheet
						open={sheetOpen}
						onOpenChange={setSheetOpen}
						leftTeam={leftTeam}
						rightTeam={rightTeam}
						stores={props.stores}
					/>
					<PhoneSelectionBar stores={props.stores} />
				</>
			)}
		</div>
	)
}

function TeamTitle(props: { teamId: MH.NormedTeamId; stores: SquadServerFrame.KeyProp }) {
	const match = MatchHistoryClient.useCurrentMatch(props.stores.squadServer!.serverId)
	const phone = Browser.useIsSmallViewport()
	return (
		<div className="min-w-0 truncate">
			<MatchTeamDisplay
				teamId={props.teamId}
				matchId={match?.historyEntryId}
				showAltTeamIndicator={true}
				leadWithTeamName={true}
				hideCurrentWord={phone}
				stores={props.stores}
			/>
		</div>
	)
}

function TeamPlayerCounts(props: { leftTeam: MH.NormedTeamId; rightTeam: MH.NormedTeamId; stores: SquadServerFrame.KeyProp }) {
	const leftCount = Zus.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.teamPlayerCount(props.leftTeam),
	)
	const rightCount = Zus.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.teamPlayerCount(props.rightTeam),
	)
	return (
		<div className="flex items-center justify-center whitespace-nowrap font-mono">
			{tr.text(SM_Msgs.countVersus(leftCount, rightCount))}
		</div>
	)
}

function ControlPanel({ stores, foldedToggles }: { stores: SquadServerFrame.KeyProp; foldedToggles: FoldableToggle[] }) {
	const groupingModes = useGroupingModes()
	const switchRequestCount = Zus.useStore(stores.squadServer!, SRQClient.Sel.requestCount)
	// distinct players with an active timeout; the expiry check trims rows the server hasn't swept yet
	const timeouts = TimeoutsClient.useActiveTimeouts().filter((t) => !t.cancelled)
	const clock = useDeadlineClock(timeouts.map((t) => t.expiresAt.getTime()))
	const timedOutCount = new Set(timeouts.filter((t) => t.expiresAt.getTime() > clock).map((t) => t.playerId)).size

	return (
		<div className="ms-auto flex items-center gap-1 whitespace-nowrap">
			{groupingModes.ids.length > 0 && (
				<span data-tour="teams-grouping" className="flex items-center gap-1">
					<span className="text-text-3">{tr.text(SM_Msgs.groupingLabel())}</span>
					<Select
						value={groupingModes.active ?? ''}
						onValueChange={(value) => BattlemetricsClient.Actions.setSelectedGroupingId(value || null)}
					>
						<SelectTrigger className="fd-btn fd-btn-sm w-auto min-w-[88px] bg-ctl font-normal">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{groupingModes.ids.map((id) => (
								<SelectItem key={id} value={id}>
									{tr.text(PG_Msgs.groupingName(id))}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</span>
			)}
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button
						data-tour="teams-more"
						variant="ghost"
						size="sm"
						title={tr.text(SM_Msgs.moreActions())}
						aria-label={tr.text(SM_Msgs.moreActions())}
					>
						<Icons.Ellipsis />
						{switchRequestCount > 0 && <SwitchRequestCountChip count={switchRequestCount} />}
						{timedOutCount > 0 && <TimeoutCountChip count={timedOutCount} />}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<OpenWindowInteraction
						windowId={WINDOW_ID.enum['switch-requests']}
						windowProps={{ stores } satisfies SwitchRequestsWindowProps}
						preload="intent"
						render={(props: React.ComponentProps<typeof DropdownMenuItem>) => (
							<DropdownMenuItem data-tour="teams-switch-requests" title={tr.text(SRQ_Msgs.switchRequestsTabHint())} {...props}>
								<Icons.ArrowLeftRight />
								{tr.text(SRQ_Msgs.switchRequestsTab())}
								{switchRequestCount > 0 && <SwitchRequestCountChip count={switchRequestCount} className="ms-auto" />}
							</DropdownMenuItem>
						)}
					/>
					<OpenWindowInteraction
						windowId={WINDOW_ID.enum['timeouts']}
						windowProps={{} satisfies TimeoutsWindowProps}
						preload="intent"
						render={(props: React.ComponentProps<typeof DropdownMenuItem>) => (
							<DropdownMenuItem data-tour="teams-timeouts" title={tr.text(SM_Msgs.timeoutsTabHint())} {...props}>
								<Icons.UserX />
								{tr.text(SM_Msgs.timeoutsTab())}
								{timedOutCount > 0 && <TimeoutCountChip count={timedOutCount} className="ms-auto" />}
							</DropdownMenuItem>
						)}
					/>
					{foldedToggles.length > 0 && <DropdownMenuSeparator />}
					{foldedToggles.map((toggle) => (
						<HeaderToggleMenuItem key={toggle} toggle={toggle} stores={stores} />
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}

function SwitchRequestCountChip(props: { count: number; className?: string }) {
	return (
		<span
			className={cn(
				'grid h-3.5 min-w-3.5 place-items-center rounded-sm bg-[#e6b422] px-[3px] font-mono text-[10px] text-black',
				props.className,
			)}
		>
			{props.count}
		</span>
	)
}

function TimeoutCountChip(props: { count: number; className?: string }) {
	return (
		<span
			className={cn(
				'grid h-3.5 min-w-3.5 place-items-center rounded-sm bg-[#7a2624] px-[3px] font-mono text-[10px] text-[#ffd9d8]',
				props.className,
			)}
		>
			{props.count}
		</span>
	)
}

function useToggleState(toggle: FoldableToggle, stores: SquadServerFrame.KeyProp) {
	const { adminsOnly, showSpoilers } = Zus.useStore(stores.squadServer!, TeamsPanelPrt.Sel.headerState)
	switch (toggle) {
		case 'admins-only':
			return {
				checked: adminsOnly,
				label: tr.text(SM_Msgs.adminsOnly()),
				hint: undefined,
				tour: undefined,
				set: (checked: boolean) => TeamsPanelPrt.Actions.setAdminsOnly({ teamsPanel: stores.squadServer! }, checked),
			}
		case 'show-spoilers':
			return {
				checked: showSpoilers,
				label: tr.text(SM_Msgs.showSpoilers()),
				hint: tr.text(SM_Msgs.showSpoilersHint()),
				tour: 'teams-show-spoilers',
				set: (checked: boolean) => SquadServerFrame.Actions.setShowSpoilers(stores, checked),
			}
		default:
			return assertNever(toggle)
	}
}

// `measure` renders the copy the header row's fold measurement reads, without ids or tour anchors
function HeaderToggle(props: { toggle: FoldableToggle; measure?: boolean; stores: SquadServerFrame.KeyProp }) {
	const id = React.useId()
	const state = useToggleState(props.toggle, props.stores)
	return (
		<div data-tour={props.measure ? undefined : state.tour} className="flex items-center gap-1.5">
			<Switch id={props.measure ? undefined : id} checked={state.checked} onCheckedChange={state.set} />
			<Label htmlFor={props.measure ? undefined : id} className="fd-lbl-plain" title={state.hint}>
				{state.label}
			</Label>
		</div>
	)
}

function HeaderToggleMenuItem(props: { toggle: FoldableToggle; stores: SquadServerFrame.KeyProp }) {
	const state = useToggleState(props.toggle, props.stores)
	return (
		<DropdownMenuItem
			role="menuitemcheckbox"
			aria-checked={state.checked}
			data-tour={state.tour}
			className="justify-between gap-4"
			title={state.hint}
			onSelect={(e) => {
				e.preventDefault()
				state.set(!state.checked)
			}}
		>
			{state.label}
			<Switch checked={state.checked} tabIndex={-1} className="pointer-events-none" />
		</DropdownMenuItem>
	)
}
