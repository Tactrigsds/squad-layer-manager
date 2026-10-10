import * as Icons from 'lucide-react'
import React from 'react'

import PlayerBulkContextMenuOptions, { detectFullSquadSelection } from '@/components/player-bulk-context-menu-options'
import { PlayerMenuItems } from '@/components/player-context-menu-options'
import type { SwitchRequestsWindowProps } from '@/components/switch-requests-window.helpers'
import { useOpenTeamSwapsWindow } from '@/components/team-swaps-window.helpers'
import { MatchTeamDisplay } from '@/components/teams-display'
import { ColumnFilterSelect } from '@/components/teams-panel/cells'
import { FILTER_NONE, PHONE_SORTS, type PhoneSort, useGroupingModes } from '@/components/teams-panel/teams-panel.helpers'
import type { TimeoutsWindowProps } from '@/components/timeouts-window.helpers'
import { Button } from '@/components/ui/button'
import { OpenWindowInteraction } from '@/components/ui/draggable-window'
import { Input } from '@/components/ui/input'
import { MenuSheet, sheetMenuSlots } from '@/components/ui/menu-sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as SRQ_Msgs from '@/messages/switch-requests.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as MH from '@/models/match-history.models'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import * as RBAC from '@/rbac.models.ts'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as WarnChat from '@/systems/warn-chat.client'

// The phone toolbar: search, one button that cycles both teams, one side, the other side, and the sheet behind
// the sliders button with everything the desktop row spreads across the header.
export function PhoneTeamsToolbar({
	searchRef,
	...props
}: {
	stores: SquadServerFrame.KeyProp
	searchRef: React.RefObject<HTMLInputElement | null>
	initialSearchQuery: string
	onSearchChange: (query: string) => void
	leftTeam: MH.NormedTeamId
	rightTeam: MH.NormedTeamId
	onOpenSheet: () => void
}) {
	const squadServer = props.stores.squadServer!
	const panelStores: TeamsPanelPrt.KeyProp = { teamsPanel: squadServer }
	const phoneTeam = Zus.useStore(squadServer, TeamsPanelPrt.Sel.phoneTeam)
	const match = MatchHistoryClient.useCurrentMatch(squadServer.serverId)
	const { showSelected, adminsOnly, roleFilter } = Zus.useStore(squadServer, TeamsPanelPrt.Sel.headerState)
	const filters = Zus.useStore(squadServer, TeamsPanelPrt.Sel.columnFilters('combined'))
	const active = [showSelected, adminsOnly, roleFilter !== null, filters.group !== null, filters.squad !== null].filter(Boolean).length
	const order: [MH.NormedTeamId, MH.NormedTeamId] = [props.leftTeam, props.rightTeam]
	const step = phoneTeam === 'both' ? 0 : phoneTeam === order[0] ? 1 : 2
	// the input only exists while the search is open; closing it drops the query with it
	const [searchOpen, setSearchOpen] = React.useState(props.initialSearchQuery !== '')
	const toggleSearch = () => {
		if (searchOpen) TeamsPanelPrt.Actions.setSearchQuery(panelStores, '')
		setSearchOpen(!searchOpen)
	}
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<Button
					size="icon"
					variant={searchOpen ? 'primary' : 'default'}
					aria-pressed={searchOpen}
					className="shrink-0"
					onClick={toggleSearch}
					title={tr.text(SM_Msgs.searchLabel())}
				>
					<Icons.Search />
				</Button>
				<Button
					className="min-w-0 flex-1 justify-start gap-1.5 px-2.5 font-bold"
					onClick={() => TeamsPanelPrt.Actions.cyclePhoneTeam(panelStores, order)}
					title={tr.text(SM_Msgs.bothTeams())}
				>
					{phoneTeam === 'both' ? (
						<>
							<Icons.Users />
							{tr.text(SM_Msgs.bothTeams())}
						</>
					) : match ? (
						<MatchTeamDisplay matchId={match.historyEntryId} teamId={phoneTeam} showAltTeamIndicator stores={props.stores} />
					) : (
						phoneTeam
					)}
					<span className="ms-auto flex gap-[3px]">
						{[0, 1, 2].map((i) => (
							<span key={i} className={cn('block size-[5px] rounded-full', i === step ? 'bg-pri-hi' : 'bg-line-soft')} />
						))}
					</span>
				</Button>
				<CollapseSquadsButton sortingTarget="combined" stores={props.stores} />
				<Button size="icon" className="relative shrink-0" onClick={props.onOpenSheet} title={tr.text(SM_Msgs.sortAndShow())}>
					<Icons.SlidersHorizontal />
					{active > 0 && (
						<span className="absolute inset-e-1 top-1 grid h-3.5 min-w-3.5 place-items-center rounded-sm bg-pri px-[3px] font-mono text-[10px] text-pri-text">
							{active}
						</span>
					)}
				</Button>
			</div>
			{searchOpen && (
				<Input
					ref={searchRef}
					autoFocus
					containerClassName="w-full"
					placeholder={tr.text(SM_Msgs.searchPlayers())}
					defaultValue={props.initialSearchQuery}
					onChange={(e) => props.onSearchChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') SquadServerFrame.Actions.selectSearchMatches(props.stores, e.currentTarget.value)
					}}
				/>
			)}
		</div>
	)
}

// Folds every squad's players away or brings them all back. Only meaningful while the sort keeps a squad's rows
// together, which is what the squad header rows are gated on too.
export function CollapseSquadsButton(props: { sortingTarget: TeamsPanelPrt.SortingTarget; stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const enabled = Zus.useStore(squadServer, TeamsPanelPrt.Sel.squadGroupsEnabled(props.sortingTarget))
	const collapsed = Zus.useStore(squadServer, TeamsPanelPrt.Sel.squadsCollapsed)
	const label = collapsed ? tr.text(SM_Msgs.expandSquads()) : tr.text(SM_Msgs.collapseSquads())
	return (
		<Button
			size="icon"
			className="shrink-0"
			disabled={!enabled}
			aria-pressed={collapsed}
			title={enabled ? label : tr.text(SM_Msgs.collapseNeedsSquadSort())}
			onClick={() => TeamsPanelPrt.Actions.setSquadsCollapsed({ teamsPanel: squadServer }, !collapsed)}
		>
			{collapsed ? <Icons.ChevronsUpDown /> : <Icons.ChevronsDownUp />}
		</Button>
	)
}

export function PhoneSortSheet(props: {
	open: boolean
	onOpenChange: (open: boolean) => void
	leftTeam: MH.NormedTeamId
	rightTeam: MH.NormedTeamId
	stores: SquadServerFrame.KeyProp
}) {
	const squadServer = props.stores.squadServer!
	const panelStores: TeamsPanelPrt.KeyProp = { teamsPanel: squadServer }
	const currentMatch$ = MatchHistoryClient.currentMatch$(squadServer.serverId)
	const sorting = Zus.useStore(squadServer, TeamsPanelPrt.Sel.sorting('combined'))
	const { showSelected, adminsOnly, showSpoilers } = Zus.useStore(squadServer, TeamsPanelPrt.Sel.headerState)
	const filters = Zus.useStore(squadServer, TeamsPanelPrt.Sel.columnFilters('combined'))
	const selectedCount = Zus.useStore(squadServer, SquadServerFrame.Sel.selectedPlayerCount)
	const { roles, groups } = Zus.useStore(
		squadServer,
		currentMatch$,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelPrt.Sel.filterOptions,
	)
	const groupingModes = useGroupingModes()
	const squadsWithTeam = Zus.useStore(
		squadServer,
		currentMatch$,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		ClientOnlySettings.Store,
		TeamsPanelPrt.Sel.squadsWithTeam,
	)
	// the combined default sorts by faction then squad; anything else in first place is a sort the user picked
	const activeKey = sorting.find((s) => s.id !== 'faction')?.id ?? 'squad'
	const pick = (sort: PhoneSort) =>
		TeamsPanelPrt.Actions.setSorting(panelStores, 'combined', sort.id === 'squad' ? TeamsPanelPrt.DEFAULT_COMBINED_SORTING : [sort])
	const row = 'flex min-h-(--mi-h) items-center gap-3 px-3 text-base'
	return (
		<MenuSheet
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={tr.text(SM_Msgs.sortAndShow())}
			trailing={
				<Button variant="ghost" size="sm" onClick={() => SquadServerFrame.Actions.resetTeamsPanel(props.stores)}>
					{tr.text(SM_Msgs.resetPanel())}
				</Button>
			}
		>
			<div className="fd-mlabel">{tr.text(SM_Msgs.sortBy())}</div>
			{PHONE_SORTS.filter((o) => !o.spoiler || showSpoilers).map((o) => (
				<button key={o.key} type="button" className={cn(row, 'w-full text-start')} onClick={() => pick(o.sort)}>
					<span className="fd-rad" data-state={activeKey === o.key ? 'checked' : undefined} />
					{o.label()}
					<span className="ms-auto font-mono text-xs text-text-3">{o.sort.desc ? '↓' : '↑'}</span>
				</button>
			))}
			<div className="fd-msep" />
			<div className="fd-mlabel">{tr.text(SM_Msgs.showLabel())}</div>
			<label className={row}>
				<Switch
					checked={showSelected}
					disabled={selectedCount === 0}
					onCheckedChange={(checked) => TeamsPanelPrt.Actions.setShowSelected(panelStores, checked)}
				/>
				{tr.text(SM_Msgs.selectedOnly())}
				<span className="ms-auto font-mono text-xs text-text-3">{selectedCount}</span>
			</label>
			<label className={row}>
				<Switch checked={adminsOnly} onCheckedChange={(checked) => TeamsPanelPrt.Actions.setAdminsOnly(panelStores, checked)} />
				{tr.text(SM_Msgs.adminsOnly())}
			</label>
			<label className={row} title={tr.text(SM_Msgs.showSpoilersHint())}>
				<Switch checked={showSpoilers} onCheckedChange={(checked) => TeamsPanelPrt.Actions.setShowSpoilers(panelStores, checked)} />
				{tr.text(SM_Msgs.showSpoilers())}
				<span className="ms-auto font-mono text-xs text-text-3">{tr.text(SM_Msgs.spoilersOnHint())}</span>
			</label>
			<div className="fd-msep" />
			<div className="fd-mlabel">{tr.text(SM_Msgs.filterLabel())}</div>
			<div className="grid grid-cols-2 gap-2 px-3 pb-2 [&_.fd-sel]:h-(--ctl) [&_.fd-sel]:w-full [&_.fd-sel]:bg-ctl [&_.fd-sel]:px-2.5 [&_.fd-sel]:text-sm">
				<ColumnFilterSelect
					value={filters.group}
					column="group"
					teamsPanel={panelStores.teamsPanel}
					squadFilterTarget="combined"
					options={[
						...groups.map((g) => ({ value: g, label: g })),
						{ value: FILTER_NONE, label: tr.text(PG_Msgs.ungroupedIn(groupingModes.active)) },
					]}
				/>
				<ColumnFilterSelect
					value={filters.role}
					column="role"
					teamsPanel={panelStores.teamsPanel}
					squadFilterTarget="combined"
					options={roles.map((r) => ({ value: r, label: r }))}
				/>
				<ColumnFilterSelect
					value={filters.squad}
					column="squad"
					teamsPanel={panelStores.teamsPanel}
					squadFilterTarget="combined"
					options={[
						...squadsWithTeam.map(({ squad, normedTeam }) => ({
							value: `${normedTeam}:${squad.squadId}`,
							label: `${normedTeam} · ${squad.squadId} ${squad.squadName}`,
						})),
						{ value: FILTER_NONE, label: tr.text(SM_Msgs.unassignedSquad()) },
					]}
				/>
				<GroupingSelect />
			</div>
			<div className="fd-msep" />
			<div className="grid grid-cols-2 gap-2 px-3 pb-2">
				<OpenWindowInteraction
					windowId={WINDOW_ID.enum['switch-requests']}
					windowProps={{ stores: props.stores } satisfies SwitchRequestsWindowProps}
					preload="intent"
					render={({ ref, ...rest }: { ref?: React.Ref<HTMLButtonElement> } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
						<Button ref={ref} variant="ghost" {...rest}>
							<Icons.ArrowLeftRight />
							{tr.text(SRQ_Msgs.switchRequestsTab())}
						</Button>
					)}
				/>
				<OpenWindowInteraction
					windowId={WINDOW_ID.enum['timeouts']}
					windowProps={{} satisfies TimeoutsWindowProps}
					preload="intent"
					render={({ ref, ...rest }: { ref?: React.Ref<HTMLButtonElement> } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
						<Button ref={ref} variant="ghost" {...rest}>
							<Icons.UserX />
							{tr.text(SM_Msgs.timeoutsTab())}
						</Button>
					)}
				/>
			</div>
		</MenuSheet>
	)
}

// the admin-list grouping picker, as the header's ControlPanel renders it
function GroupingSelect() {
	const modes = useGroupingModes()
	return (
		<Select value={modes.active ?? ''} onValueChange={(value) => BattlemetricsClient.Actions.setSelectedGroupingId(value || null)}>
			<SelectTrigger className="fd-btn w-auto bg-ctl font-normal">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{modes.ids.map((id) => (
					<SelectItem key={id} value={id}>
						{tr.text(PG_Msgs.groupingName(id))}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

// From the first selected player: the count, the two actions an admin reaches for most, the way into the rest,
// and clear. Sits above the tab bar so the list scrolls under it.
export function PhoneSelectionBar({ stores }: { stores: SquadServerFrame.KeyProp }) {
	const squadServer = stores.squadServer!
	const selectedIds = Zus.useStore(
		squadServer,
		Zus.useShallow((s: SquadServerFrame.State) => {
			const sel = SquadServerFrame.Sel.playerSelection(s)
			return Object.keys(sel).filter((id) => sel[id])
		}),
	)
	const fullSquad = Zus.useStore(squadServer, (s: ChatPrt.Store) =>
		detectFullSquadSelection(selectedIds, ChatPrt.Sel.players(s), ChatPrt.Sel.squads(s)),
	)
	const canQueue = Zus.useStore(squadServer, TSWClient.Sel.someCanQueue(selectedIds))
	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players', { serverId: squadServer.serverId }))
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)
	const openOrFocusWindow = useOpenOrFocusWindow()
	const [menuOpen, setMenuOpen] = React.useState(false)
	if (selectedIds.length === 0) return null
	const single = selectedIds.length === 1 ? selectedIds[0] : null
	const label = fullSquad ? `${fullSquad.squadName} · ${selectedIds.length}` : tr.text(SM_Msgs.selectedCount(selectedIds.length))
	const warn = () => {
		if (single) {
			openOrFocusWindow(WINDOW_ID.enum['player-details'], { playerId: single, stores })
			WarnChat.requestWarnFocus({ kind: 'player', playerId: single })
		} else if (fullSquad) {
			openOrFocusWindow(WINDOW_ID.enum['squad-details'], { uniqueSquadId: fullSquad.uniqueId, stores })
			WarnChat.requestWarnFocus({ kind: 'squad', uniqueSquadId: fullSquad.uniqueId })
		} else {
			WarnChat.requestWarnFocus({ kind: 'server-activity' })
		}
	}
	return (
		<>
			<div
				className="fixed inset-x-2 flex items-center gap-1.5 rounded-[3px] border border-line-soft bg-panel-hi py-1.5 ps-3 pe-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
				style={{ zIndex, bottom: 'calc(var(--tabbar-h) + 8px)' }}
			>
				<span className="min-w-0 flex-1 truncate font-bold" title={label}>
					{label}
				</span>
				<Button size="sm" disabled={!!manageDenied || !canQueue} onClick={() => TSWClient.Actions.swapNext(stores, selectedIds)}>
					<Icons.ArrowLeftRight />
					{tr.text(SM_Msgs.swapNextLabel())}
				</Button>
				<Button size="icon-sm" title={tr.text(SM_Msgs.warnLabel())} onClick={warn}>
					<Icons.TriangleAlert />
				</Button>
				<Button size="icon-sm" variant="ghost" title={tr.text(SM_Msgs.moreActions())} onClick={() => setMenuOpen(true)}>
					<Icons.EllipsisVertical />
				</Button>
				<Button
					size="icon-sm"
					variant="ghost"
					title={tr.text(SM_Msgs.clearSelection())}
					onClick={() => SquadServerFrame.Actions.setSelection(stores, {})}
				>
					<Icons.X />
				</Button>
			</div>
			<MenuSheet open={menuOpen} onOpenChange={setMenuOpen} title={label}>
				{single ? (
					<PlayerMenuItems playerId={single} slots={sheetMenuSlots} stores={stores} />
				) : (
					<PlayerBulkContextMenuOptions playerIds={selectedIds} stores={stores} slots={sheetMenuSlots} />
				)}
			</MenuSheet>
		</>
	)
}

// What the phone list says about pending swaps: the counts, and the way into the window that edits them.
export function PhoneSwapsSummary(props: { leftTeam: MH.NormedTeamId; rightTeam: MH.NormedTeamId; stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const info = Zus.useStore(
		squadServer,
		Zus.useShallow((s: TSWClient.Store & ChatPrt.Store) => {
			const count = (team: MH.NormedTeamId) => {
				const swaps = TSWClient.Sel.swapsToTeamEnrichedWithMutations(s, team)
				let pending = 0
				let unsaved = 0
				for (const swap_ of swaps.values()) {
					if (!swap_.mutation.removed) pending++
					if (swap_.mutation.added || swap_.mutation.removed) unsaved++
				}
				return { pending, unsaved }
			}
			const a = count('A')
			const b = count('B')
			return { A: a.pending, B: b.pending, unsaved: a.unsaved + b.unsaved }
		}),
	)
	const open = useOpenTeamSwapsWindow({ stores: props.stores })
	return (
		<button
			type="button"
			onClick={(e) => open(e.currentTarget)}
			className="flex min-h-(--ctl) w-full items-center gap-2.5 rounded-[3px] border border-[rgba(230,180,34,0.35)] bg-[rgba(230,180,34,0.10)] ps-3 pe-1.5 text-start"
		>
			<Icons.ArrowLeftRight className="size-4 shrink-0 text-warn" />
			<span className="flex min-w-0 flex-1 flex-col leading-tight">
				<span className="truncate font-bold" title={tr.text(SM_Msgs.swapsPending(info.A + info.B))}>
					{tr.text(SM_Msgs.swapsPending(info.A + info.B))}
				</span>
				<span className="truncate text-xs text-text-2">
					<span className="inline-block rtl:-scale-x-100">→</span> <MatchTeamDisplay teamId={props.leftTeam} stores={props.stores} />{' '}
					{info[props.leftTeam]} · <span className="inline-block rtl:-scale-x-100">→</span>{' '}
					<MatchTeamDisplay teamId={props.rightTeam} stores={props.stores} /> {info[props.rightTeam]}
					{info.unsaved > 0 && <> · {tr.text(SM_Msgs.swapsUnsaved(info.unsaved))}</>}
				</span>
			</span>
			<span className="fd-btn fd-btn-sm shrink-0">
				{tr.text(SM_Msgs.editSwaps())}
				<Icons.ChevronRight className="rtl:-scale-x-100" />
			</span>
		</button>
	)
}
