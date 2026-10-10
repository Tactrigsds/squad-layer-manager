import type { ColumnDef, SortingState } from '@tanstack/react-table'
import React from 'react'

import type * as RC from '@/components/feed/render-context'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as FitCols from '@/lib/fitted-columns'
import * as RSel from '@/lib/reselect'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import * as MH from '@/models/match-history.models'
import * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import type * as TeamsPanelModels from '@/models/teams-panel.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as TSWClient from '@/systems/teamswaps.client'

export type PhoneSort = { id: string; desc: boolean }

export const PHONE_SORTS: { key: string; sort: PhoneSort; label: () => string; spoiler?: boolean }[] = [
	{ key: 'squad', sort: { id: 'squad', desc: false }, label: () => tr.text(SM_Msgs.sortSquad()) },
	{ key: 'name', sort: { id: 'name', desc: false }, label: () => tr.text(SM_Msgs.sortName()) },
	{ key: 'tks', sort: { id: 'tks', desc: true }, label: () => tr.text(SM_Msgs.sortTeamKills()) },
	{ key: 'stats', sort: { id: 'stats', desc: true }, label: () => tr.text(SM_Msgs.sortKills()), spoiler: true },
]

// shift+click anywhere in the squad/role/group cell selects the players sharing it
export function shiftClickCellProps(
	columnId: string,
	player: TeamsPanelModels.EnrichedPlayer,
	stores: SquadServerFrame.KeyProp,
): Pick<React.HTMLAttributes<HTMLElement>, 'onClickCapture' | 'title'> {
	if (columnId === 'squad' && player.squadId !== null) {
		return {
			title: tr.text(SM_Msgs.squadCellHint()),
			onClickCapture: (e) => {
				if (!e.shiftKey) return
				// the (SL) indicator has its own shift+click handler (select squad leaders); let it win
				if ((e.target as HTMLElement).closest('[data-select-squad-leaders]')) return
				e.preventDefault()
				e.stopPropagation()
				SquadServerFrame.Actions.selectSquad(stores, SM.PlayerIds.getPlayerId(player.ids))
			},
		}
	}
	if (columnId === 'role' && player.role != null) {
		const role = player.role
		return {
			title: tr.text(SM_Msgs.roleCellHint()),
			onClickCapture: (e) => {
				if (!e.shiftKey) return
				e.preventDefault()
				e.stopPropagation()
				SquadServerFrame.Actions.selectAllWithRole(stores, role, e.ctrlKey ? undefined : (player.teamId ?? undefined))
			},
		}
	}
	if (columnId === 'group' && player.group) {
		const group = player.group
		return {
			title: tr.text(SM_Msgs.groupCellHint()),
			onClickCapture: (e) => {
				if (!e.shiftKey) return
				e.preventDefault()
				e.stopPropagation()
				SquadServerFrame.Actions.selectGroup(stores, group, e.ctrlKey ? undefined : (player.teamId ?? undefined))
			},
		}
	}
	return {}
}

// What the body cells read besides the player. Each variant extends it with its squad-lookup shape. Kept apart from
// the header meta, whose filter options change with the roster, so the memoized rows only see what they render.
export type BaseRowMeta = {
	matchId: number
	groupColorByName: Map<string, string>
	stores: SquadServerFrame.KeyProp
	// one per table rather than one per name: a ctx subscribes to the match history, settings and users
	renderCtx: RC.RenderCtx
}

// shared across both table variants' headers
export type BasePlayerTableMeta = BaseRowMeta & {
	// the grouping mode the group column shows, which names its no-group option
	groupingId: string | null
	filters: { role: string | null; group: string | null; squad: string | null }
	// which of the panel's per-table squad filters this table's header writes
	squadFilterTarget: TeamsPanelPrt.SquadFilterTarget
	availableRoles: string[]
	availableGroups: string[]
	statsSort: StatsSortState
	// SLM was restarted mid-match, so combat stats are incomplete -- surfaced as a disclaimer on the stats header
	statsMayBeInaccurate: boolean
}

// the column headers and cells dispatch straight to the panel partial rather than being handed setters through meta
export function panelStoresOf(meta: BaseRowMeta): TeamsPanelPrt.KeyProp {
	return { teamsPanel: meta.stores.squadServer! }
}

export type TeamRowMeta = BaseRowMeta & { squads: SM.UniqueSquad[] }

export type TeamPlayerTableMeta = BasePlayerTableMeta & TeamRowMeta & { teamId: SM.TeamId }

export type CombinedPlayer = TeamsPanelPrt.CombinedPlayer

export type CombinedRowMeta = BaseRowMeta & {
	squadsWithTeam: TeamsPanelPrt.SquadWithTeam[]
	getFaction: (normedTeam: MH.NormedTeamId) => string
	getTeamColor: (normedTeam: MH.NormedTeamId) => string
}

export type CombinedTableMeta = BasePlayerTableMeta & CombinedRowMeta

// A body cell renders from plain values rather than TanStack's row and table objects, which are mutable: the memoized
// PlayerRow would render them stale (see "Component rules" in docs/developers/architecture.md).
export type RowCellProps<T, M> = { player: T; playerId: SM.PlayerId; selected: boolean; meta: M }

export type RowCellRenderer<T, M> = (props: RowCellProps<T, M>) => React.ReactNode

export type PlayerColumn<T, M> = { def: ColumnDef<T, any>; cell: RowCellRenderer<T, M> }

export type PlayerColumns<T, M> = { defs: ColumnDef<T, any>[]; cells: Record<string, RowCellRenderer<T, M>> }

// Describes the squad-group a player belongs to, used to render the group-separator header rows when
// the table is sorted by squad. `key` identifies a contiguous group of same-squad rows. A null `squad`
// is the catch-all group for players not in any squad ("Unassigned"). `faction`, when set (combined
// table only), renders in its own cell aligned with the faction column. `totalSize` is the squad's size
// on the unfiltered roster, which is what the header reports.
export type SquadGroupInfo = {
	key: string
	squad: SM.UniqueSquad | null
	creatorName: string | null
	faction: { label: string; color: string } | null
	totalSize: number
}

const FILTERED_COLUMN_IDS = ['role', 'group', 'squad']

// middle-click on a header resets that column's sort and filter
export function headerResetProps(
	column: { id: string; getCanSort: () => boolean; clearSorting: () => void },
	meta: BasePlayerTableMeta,
): Pick<React.HTMLAttributes<HTMLElement>, 'title' | 'onMouseDown' | 'onAuxClick'> {
	const hasFilter = FILTERED_COLUMN_IDS.includes(column.id)
	if (!column.getCanSort() && !hasFilter) return {}
	return {
		title: hasFilter
			? column.getCanSort()
				? 'Middle-click: reset sort and filter'
				: 'Middle-click: reset filter'
			: 'Middle-click: reset sort',
		// prevent middle-click autoscroll
		onMouseDown: (e) => {
			if (e.button === 1) e.preventDefault()
		},
		onAuxClick: (e) => {
			if (e.button !== 1) return
			column.clearSorting()
			TeamsPanelPrt.Actions.clearColumnFilter(panelStoresOf(meta), meta.squadFilterTarget, column.id)
		},
	}
}

export const FILTER_ALL = TeamsPanelPrt.FILTER_ALL

export const FILTER_NONE = TeamsPanelPrt.FILTER_NONE

export type FilterOption = { value: string; label: string }

export function sameFilterOptions(a: FilterOption[], b: FilterOption[]) {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i].value !== b[i].value || a[i].label !== b[i].label) return false
	}
	return true
}

export type StatsSortMetric = 'kills' | 'wounds' | 'deaths'

export const STATS_SORT_METRICS: { metric: StatsSortMetric; short: typeof SM_Msgs.statsKillsShort; label: typeof SM_Msgs.sortKills }[] = [
	{ metric: 'kills', short: SM_Msgs.statsKillsShort, label: SM_Msgs.sortKills },
	{ metric: 'wounds', short: SM_Msgs.statsWoundsShort, label: SM_Msgs.sortWounds },
	{ metric: 'deaths', short: SM_Msgs.statsDeathsShort, label: SM_Msgs.sortDeaths },
]

export type StatsSortColumn = {
	toggleSorting: (desc?: boolean) => void
	clearSorting: () => void
}

// lives in the table component and flows in through table meta: picking a metric rebuilds the column
// def, so anything captured in the column def's closures would go stale or remount the header.
// `sorted` is derived from the sorting react state rather than read via column.getIsSorted() — the
// react compiler memoizes on the (stable) column identity, so getIsSorted() calls in render go stale
export type StatsSortState = {
	metric: StatsSortMetric
	setMetric: (m: StatsSortMetric) => void
	open: boolean
	setOpen: (open: boolean) => void
	sorted: false | 'asc' | 'desc'
}

// derive sort direction from the sorting react state rather than column.getIsSorted(): the react
// compiler memoizes on the stable column identity, so getIsSorted() calls in render go stale
export function sortDirFor(sorting: SortingState, columnId: string): false | 'asc' | 'desc' {
	const entry = sorting.find((s) => s.id === columnId)
	return entry ? (entry.desc ? 'desc' : 'asc') : false
}

// Secondary sort priority applied within a squad when sorting by squad: squad leadership roles first,
// then the heavy/light anti-tank and engineer roles, then everything else alphabetically. Keyed by the
// deduped role name (see SM.toDedupedRoleName), e.g. "USMC_SLln_01" -> "SLCrewman".
const ROLE_SORT_PRIORITY: Record<string, number> = {
	SL: 0,
	SLCrewman: 0,
	SLPilot: 0,
	HAT: 1,
	LAT: 2,
	Engineer: 3,
}

// squad leaders sort ahead of everyone regardless of role: the SL might not have picked up the SL kit
// yet, so isLeader is the source of truth for who leads the squad
export function compareRolesForSort(a: TeamsPanelModels.EnrichedPlayer, b: TeamsPanelModels.EnrichedPlayer): number {
	if (a.isLeader !== b.isLeader) return a.isLeader ? -1 : 1
	const dedupedA = SM.toDedupedRoleName(a.role)
	const dedupedB = SM.toDedupedRoleName(b.role)
	const priorityA = ROLE_SORT_PRIORITY[dedupedA] ?? Number.MAX_SAFE_INTEGER
	const priorityB = ROLE_SORT_PRIORITY[dedupedB] ?? Number.MAX_SAFE_INTEGER
	if (priorityA !== priorityB) return priorityA - priorityB
	return dedupedA.localeCompare(dedupedB)
}

// the grouping modes on offer and the one in effect
export function useGroupingModes(): { groupings: PG.PlayerGroupings; ids: string[]; active: string | null } {
	const configured = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerGroupings)
	const groupings = configured ?? PG.EMPTY_PLAYER_GROUPINGS
	const ids = React.useMemo(() => PG.groupingIdsWithParty(groupings), [groupings])
	const active = Zus.useStore(BattlemetricsClient.Store, BattlemetricsClient.Sel.activeGroupingId(ids))
	return { groupings, ids, active }
}

// colors for the groups the roster falls into under the active grouping mode
export function useGroupColorByName(groups: string[], modes: ReturnType<typeof useGroupingModes>): Map<string, string> {
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const { groupings, active } = modes
	return React.useMemo(() => {
		const result = new Map<string, string>()
		if (active === null) return result
		for (const group of groups) result.set(group, PG.groupColorOf(groupings, active, group, orgFlags))
		return result
	}, [groups, groupings, active, orgFlags])
}

export function sameSquadGroup(a: SquadGroupInfo, b: SquadGroupInfo) {
	return (
		a.key === b.key &&
		a.squad === b.squad &&
		a.creatorName === b.creatorName &&
		a.totalSize === b.totalSize &&
		a.faction?.label === b.faction?.label &&
		a.faction?.color === b.faction?.color
	)
}

export function samePlayerIds(a: string[], b: string[]) {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

// the player row a pointer event landed in, if any. Events from a row's portalled menu have no row among their DOM
// ancestors, so they resolve to null.
export function rowPlayerId(target: EventTarget): SM.PlayerId | null {
	if (!(target instanceof Element)) return null
	return target.closest<HTMLElement>('tr[data-player-id]')?.dataset.playerId ?? null
}

// What a table's one context menu is showing. Rows and squad labels mount no menu of their own: right-click and
// long-press are delegated to the table body, which reads the target off the element hit, the same way the
// activity feed's rows work (docs/developers/architecture.md, "The activity feed is built as dom").
export type RowMenuTarget = { kind: 'player'; playerId: SM.PlayerId } | { kind: 'squad'; squad: SM.UniqueSquad }

// a squad label or squad header row wins over the player row around it
export function rowMenuTargetOf(target: EventTarget, stores: SquadServerFrame.KeyProp): RowMenuTarget | null {
	if (!(target instanceof Element)) return null
	const squadEl = target.closest<HTMLElement>('[data-squad-menu]')
	if (squadEl) {
		const uniqueId = Number(squadEl.dataset.squadMenu)
		const squad = ChatPrt.Sel.squads(Zus.getState(stores.squadServer!)).find((sq) => sq.uniqueId === uniqueId)
		if (squad) return { kind: 'squad', squad }
	}
	const playerId = rowPlayerId(target)
	return playerId === null ? null : { kind: 'player', playerId }
}

export const LONG_PRESS_MS = 700

// off the page and out of the way of the pointer; radix places the menu from the point on the re-fired event
export const MENU_ANCHOR_STYLE: React.CSSProperties = { position: 'fixed', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' }

export const SHRINKABLE_PLAYER_COLUMNS: FitCols.Spec['shrinkable'] = [
	{ id: 'name', minEm: 7 },
	{ id: 'group', minEm: 5.5 },
	{ id: 'role', minEm: 5 },
	{ id: 'vehicle', minEm: 5 },
]

type TeamCountsInputs = [frameState: SquadServerFrame.State, currentMatch: MH.MatchDetails | undefined]

export const teamCountsAfterSwap = RSel.createDeepSelector(
	[
		(...[frameState]: TeamCountsInputs) => TSWClient.Sel.localState(frameState).editedSwaps,
		(...[frameState]: TeamCountsInputs) => ChatPrt.Sel.players(frameState),
		(...[, currentMatch]: TeamCountsInputs) => currentMatch?.ordinal,
	],
	(editedSwaps, players, ordinal) => {
		const counts: Record<MH.NormedTeamId, number> = { A: 0, B: 0 }
		if (ordinal === undefined) return counts
		for (const player of players) {
			if (player.teamId === null) continue
			const playerId = SM.PlayerIds.getPlayerId(player.ids)
			const sw = editedSwaps.get(playerId)
			const destTeam = sw?.toTeam ?? MH.getNormedTeamId(player.teamId, ordinal)
			counts[destTeam]++
		}
		return counts
	},
)
