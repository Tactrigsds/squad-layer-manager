import { createColumnHelper } from '@tanstack/react-table'
import type { ColumnHelper } from '@tanstack/react-table'
import * as Icons from 'lucide-react'
import React from 'react'

import { useRenderCtx } from '@/components/feed/use-render-ctx'
import { PlayerDisplayInCtx } from '@/components/player-display'
import { ColumnFilterSelect, SelectOrSpinner, SquadCell, SwitchRequestIcon } from '@/components/teams-panel/cells'
import { PlayerTable } from '@/components/teams-panel/player-table'
import {
	type BasePlayerTableMeta,
	type BaseRowMeta,
	type CombinedPlayer,
	type CombinedRowMeta,
	type CombinedTableMeta,
	compareRolesForSort,
	FILTER_NONE,
	panelStoresOf,
	type PlayerColumn,
	type PlayerColumns,
	type RowCellProps,
	type RowCellRenderer,
	SHRINKABLE_PLAYER_COLUMNS,
	type SquadGroupInfo,
	type TeamPlayerTableMeta,
	type TeamRowMeta,
	useGroupColorByName,
	useGroupingModes,
} from '@/components/teams-panel/teams-panel.helpers'
import { Checkbox } from '@/components/ui/checkbox'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Browser from '@/lib/browser'
import * as DH from '@/lib/display-helpers'
import * as FitCols from '@/lib/fitted-columns'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as L from '@/models/layer.models'
import * as MH from '@/models/match-history.models'
import * as PG from '@/models/player-groupings.models'
import type * as SM from '@/models/squad.models'
import type * as TeamsPanelModels from '@/models/teams-panel.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

function statsCell({ player }: RowCellProps<TeamsPanelModels.EnrichedPlayer, BaseRowMeta>) {
	const s = player.stats
	return (
		<span className="font-mono text-xs whitespace-nowrap">
			{s?.kills ?? 0}/{s?.wounds ?? 0}/{s?.deaths ?? 0}
		</span>
	)
}

const playerColumnHelper = createColumnHelper<TeamsPanelModels.EnrichedPlayer>()

const combinedColumnHelper = createColumnHelper<CombinedPlayer>()

// Shared cell/column builders used by both the per-team and combined tables. Each reads only the
// fields on BaseRowMeta and BasePlayerTableMeta so it works regardless of which variant's meta is attached;
// the squad column, which differs between variants, is parameterized via squadColumn().

function selectCell({ playerId, selected, meta }: RowCellProps<TeamsPanelModels.EnrichedPlayer, BaseRowMeta>) {
	return (
		<div onClick={(e) => e.stopPropagation()}>
			<SelectOrSpinner
				playerId={playerId}
				checked={selected}
				onCheckedChange={(checked) => TeamsPanelPrt.Actions.setPlayersSelected(panelStoresOf(meta), [playerId], checked)}
				stores={meta.stores}
			/>
		</div>
	)
}

function nameCell({ player, playerId, meta }: RowCellProps<TeamsPanelModels.EnrichedPlayer, BaseRowMeta>) {
	// let the enclosing row context menu (bulk-aware) handle right-clicks on the name
	return (
		<span className="flex min-w-0 items-center gap-1">
			<PlayerDisplayInCtx
				ctx={meta.renderCtx}
				player={player}
				matchId={meta.matchId}
				disableContextMenu
				className="min-w-0 items-center [&>button]:truncate"
			/>
			<SwitchRequestIcon playerId={playerId} teamId={player.teamId} stores={meta.stores} />
			{player.inAdminCam && (
				<span
					title={tr.text(SM_Msgs.adminCamHint())}
					onClickCapture={(e) => {
						if (!e.shiftKey) return
						e.preventDefault()
						e.stopPropagation()
						SquadServerFrame.Actions.selectAllInAdminCam(meta.stores, e.ctrlKey ? undefined : (player.teamId ?? undefined))
					}}
				>
					<Icons.Camera className="h-3 w-3 text-[#b58cff] shrink-0" />
				</span>
			)}
		</span>
	)
}

function nameColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>): PlayerColumn<T, BaseRowMeta> {
	return {
		def: helper.accessor((row) => row.ids.usernameNoTag ?? row.ids.username ?? '', { id: 'name', header: 'Name' }),
		cell: nameCell,
	}
}

function groupCell({ player, meta }: RowCellProps<TeamsPanelModels.EnrichedPlayer, BaseRowMeta>) {
	const group = player.group
	if (!group) return null
	const color = meta.groupColorByName.get(group)
	return (
		<span className="flex items-center gap-1 max-w-24">
			{color && <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />}
			<span className="truncate">{group}</span>
		</span>
	)
}

function groupColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>): PlayerColumn<T, BaseRowMeta> {
	const def = helper.accessor((row) => row.group ?? '', {
		id: 'group',
		// party ids sort by number; any other group name falls through to plain text order
		sortingFn: (a, b) => PG.comparePartyIds(a.original.group ?? '', b.original.group ?? ''),
		header: ({ table }) => {
			const meta = table.options.meta as BasePlayerTableMeta
			const { filters, availableGroups } = meta
			return (
				<span className="flex flex-col items-start max-w-24">
					<span className="max-w-full truncate" title={tr.text(SM_Msgs.groupColumn())}>
						{tr.text(SM_Msgs.groupColumn())}
					</span>
					<ColumnFilterSelect
						value={filters.group}
						column="group"
						teamsPanel={meta.stores.squadServer!}
						squadFilterTarget={meta.squadFilterTarget}
						options={[
							...availableGroups.map((g) => ({ value: g, label: g })),
							{ value: FILTER_NONE, label: tr.text(PG_Msgs.ungroupedIn(meta.groupingId)) },
						]}
						triggerClassName="max-w-24"
					/>
				</span>
			)
		},
	})
	return { def, cell: groupCell }
}

function roleCell({ player }: RowCellProps<TeamsPanelModels.EnrichedPlayer, BaseRowMeta>) {
	return player.role ?? ''
}

function roleColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>): PlayerColumn<T, BaseRowMeta> {
	const def = helper.accessor((row) => row.role ?? '', {
		id: 'role',
		header: ({ table }) => {
			const meta = table.options.meta as BasePlayerTableMeta
			const { filters, availableRoles } = meta
			return (
				<span className="flex flex-col items-start">
					{tr.text(SM_Msgs.roleColumn())}
					<ColumnFilterSelect
						value={filters.role}
						column="role"
						teamsPanel={meta.stores.squadServer!}
						squadFilterTarget={meta.squadFilterTarget}
						options={availableRoles.map((r) => ({ value: r, label: r }))}
					/>
				</span>
			)
		},
		enableSorting: false,
	})
	return { def, cell: roleCell }
}

function vehicleCell({ player }: RowCellProps<TeamsPanelModels.EnrichedPlayer, BaseRowMeta>) {
	return player.vehicle && <span className="block truncate">{player.vehicle}</span>
}

// a spoiler, and verbatim until more samples pin down what the game puts in it (see SM.PlayerSchema)
function vehicleColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>): PlayerColumn<T, BaseRowMeta> {
	const def = helper.accessor((row) => row.vehicle ?? '', {
		id: 'vehicle',
		header: () => tr.text(SM_Msgs.vehicleColumn()),
		enableSorting: false,
	})
	return { def, cell: vehicleCell }
}

function tksCell({ player }: RowCellProps<TeamsPanelModels.EnrichedPlayer, BaseRowMeta>) {
	const tks = player.stats?.teamkills ?? 0
	return <span className={cn('font-mono text-xs tabular-nums', tks > 0 && 'text-destructive font-semibold')}>{tks}</span>
}

// team kills. Not gated behind showSpoilers -- teamkills are always shown so admins can act on them.
function tksColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>): PlayerColumn<T, BaseRowMeta> {
	const def = helper.accessor((row) => row.stats?.teamkills ?? 0, {
		id: 'tks',
		header: () => <span title={tr.text(SM_Msgs.teamKillsHint())}>{tr.text(SM_Msgs.teamKillsColumn())}</span>,
		sortDescFirst: true,
	})
	return { def, cell: tksCell }
}

function squadColumn<T extends TeamsPanelModels.EnrichedPlayer, M extends BaseRowMeta>(
	helper: ColumnHelper<T>,
	opts: {
		getSquad: (player: T, meta: M) => SM.UniqueSquad | undefined
		squadLabel: (squad: SM.UniqueSquad, player: T, meta: M) => string
		fallbackLabel: (player: T, meta: M) => string
		filterOptions: (meta: M & BasePlayerTableMeta) => { value: string; label: string }[]
	},
): PlayerColumn<T, M> {
	// unsquadded players get MAX_SAFE_INTEGER so they sort after real squads when ascending
	const def = helper.accessor((row) => row.squadId ?? Number.MAX_SAFE_INTEGER, {
		id: 'squad',
		// sort by squad, then role within the squad; reads row.original so the role tiebreaker isn't
		// limited to the squadId accessor value cached by tanstack
		sortingFn: (a, b) => {
			const squadA = a.original.squadId ?? Number.MAX_SAFE_INTEGER
			const squadB = b.original.squadId ?? Number.MAX_SAFE_INTEGER
			if (squadA !== squadB) return squadA - squadB
			return compareRolesForSort(a.original, b.original)
		},
		header: ({ table }) => {
			const meta = table.options.meta as M & BasePlayerTableMeta
			return (
				<span className="flex flex-col items-start">
					{tr.text(SM_Msgs.squadColumn())}
					<ColumnFilterSelect
						value={meta.filters.squad}
						column="squad"
						teamsPanel={meta.stores.squadServer!}
						squadFilterTarget={meta.squadFilterTarget}
						options={opts.filterOptions(meta)}
					/>
				</span>
			)
		},
	})
	const cell = ({ player, meta }: RowCellProps<T, M>) => {
		if (player.squadId === null) return ''
		const squad = opts.getSquad(player, meta)
		if (!squad) return opts.fallbackLabel(player, meta)
		return (
			<SquadCell
				squad={squad}
				label={opts.squadLabel(squad, player, meta)}
				isLeader={player.isLeader}
				teamId={player.teamId ?? undefined}
				stores={meta.stores}
			/>
		)
	}
	return { def, cell }
}

// the stats column's def is appended per table, since its sort follows the metric picked in its header
function playerColumns<T extends TeamsPanelModels.EnrichedPlayer, M extends BaseRowMeta>(
	columns: PlayerColumn<T, M>[],
): PlayerColumns<T, M> {
	const cells: Record<string, RowCellRenderer<T, M>> = { stats: statsCell }
	for (const column of columns) cells[column.def.id!] = column.cell
	return { defs: columns.map((column) => column.def), cells }
}

const teamPlayerColumns = playerColumns<TeamsPanelModels.EnrichedPlayer, TeamRowMeta>([
	{
		def: playerColumnHelper.display({
			id: 'select',
			header: ({ table }) => {
				const { stores, teamId } = table.options.meta as TeamPlayerTableMeta
				return (
					<Checkbox
						checked={table.getIsAllRowsSelected()}
						onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
						onClick={(e) => {
							if (e.altKey) {
								e.preventDefault()
								SquadServerFrame.Actions.invertSelection(stores, e.ctrlKey ? undefined : teamId)
								return
							}
							if (!e.shiftKey) return
							e.preventDefault()
							SquadServerFrame.Actions.selectAllTeamPlayers(stores, e.ctrlKey ? undefined : teamId)
						}}
						title={tr.text(SM_Msgs.selectAllTeamHint())}
						aria-label={tr.text(SM_Msgs.selectAllRows())}
					/>
				)
			},
		}),
		cell: selectCell,
	},
	nameColumn(playerColumnHelper),
	groupColumn(playerColumnHelper),
	squadColumn<TeamsPanelModels.EnrichedPlayer, TeamRowMeta>(playerColumnHelper, {
		getSquad: (player, meta) => meta.squads.find((s) => s.squadId === player.squadId),
		squadLabel: (squad) => (squad.squadName === 'Command Squad' ? `CMD(${squad.squadId})` : String(squad.squadId)),
		fallbackLabel: (player) => String(player.squadId),
		filterOptions: (meta) => [
			...meta.squads.map((s) => ({
				value: String(s.squadId),
				label: s.squadName === 'Command Squad' ? `CMD(${s.squadId})` : `${s.squadId} ${s.squadName}`,
			})),
			{ value: FILTER_NONE, label: tr.text(SM_Msgs.unassignedSquad()) },
		],
	}),
	roleColumn(playerColumnHelper),
	vehicleColumn(playerColumnHelper),
	tksColumn(playerColumnHelper),
])

function factionCell({ player, meta }: RowCellProps<CombinedPlayer, CombinedRowMeta>) {
	return (
		<span className="font-semibold" style={{ color: meta.getTeamColor(player.normedTeam) }}>
			{meta.getFaction(player.normedTeam)}
		</span>
	)
}

const combinedPlayerColumns = playerColumns<CombinedPlayer, CombinedRowMeta>([
	{
		def: combinedColumnHelper.display({
			id: 'select',
			header: ({ table }) => {
				const { stores } = table.options.meta as CombinedTableMeta
				return (
					<Checkbox
						checked={table.getIsAllRowsSelected()}
						onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
						onClick={(e) => {
							if (e.altKey) {
								e.preventDefault()
								SquadServerFrame.Actions.invertSelection(stores)
								return
							}
							if (!e.shiftKey) return
							e.preventDefault()
							SquadServerFrame.Actions.selectAllTeamPlayers(stores)
						}}
						title={tr.text(SM_Msgs.selectAllCombinedHint())}
						aria-label={tr.text(SM_Msgs.selectAllRows())}
					/>
				)
			},
		}),
		cell: selectCell,
	},
	{ def: combinedColumnHelper.accessor((row) => row.displayIndex, { id: 'faction', header: 'Faction' }), cell: factionCell },
	nameColumn(combinedColumnHelper),
	groupColumn(combinedColumnHelper),
	squadColumn<CombinedPlayer, CombinedRowMeta>(combinedColumnHelper, {
		getSquad: (player, meta) =>
			meta.squadsWithTeam.find(({ squad: s, normedTeam }) => s.squadId === player.squadId && normedTeam === player.normedTeam)?.squad,
		squadLabel: (squad, player, meta) => {
			const faction = meta.getFaction(player.normedTeam)
			return squad.squadName === 'Command Squad' ? `${faction}:CMD` : `${faction}:${squad.squadId}`
		},
		fallbackLabel: (player, meta) => `${meta.getFaction(player.normedTeam)}:${player.squadId}`,
		filterOptions: (meta) => [
			...meta.squadsWithTeam.map(({ squad: s, normedTeam }) => {
				const faction = meta.getFaction(normedTeam)
				const isCmd = s.squadName === 'Command Squad'
				return {
					value: `${normedTeam}:${s.squadId}`,
					label: isCmd ? `${faction}:CMD` : `${faction}:${s.squadId} ${s.squadName}`,
				}
			}),
			{ value: FILTER_NONE, label: tr.text(SM_Msgs.unassignedSquad()) },
		],
	}),
	roleColumn(combinedColumnHelper),
	vehicleColumn(combinedColumnHelper),
	tksColumn(combinedColumnHelper),
])

export function TeamPlayerTable(props: { teamId: MH.NormedTeamId; className?: string; stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const currentMatch$ = MatchHistoryClient.currentMatch$(squadServer.serverId)
	const match = MatchHistoryClient.useCurrentMatch(squadServer.serverId)
	const matchId = match?.historyEntryId ?? 0

	const displayedPlayers = Zus.useStore(
		squadServer,
		currentMatch$,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelPrt.Sel.displayedTeamPlayers(props.teamId),
	)
	const creatorNames = Zus.useStore(squadServer, TeamsPanelPrt.Sel.playerNamesById)
	const { roles, groups } = Zus.useStore(
		squadServer,
		currentMatch$,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelPrt.Sel.filterOptions,
	)
	const groupingModes = useGroupingModes()
	const groupColorByName = useGroupColorByName(groups, groupingModes)
	const squads = Zus.useStore(squadServer, currentMatch$, ChatPrt.Sel.squadsForTeam(props.teamId))
	const squadSizes = Zus.useStore(squadServer, currentMatch$, TeamsPanelPrt.Sel.squadSizes)
	const statsMayBeInaccurate = Zus.useStore(squadServer, currentMatch$, ChatPrt.Sel.statsMayBeInaccurate)
	const filters = Zus.useStore(squadServer, TeamsPanelPrt.Sel.columnFilters(props.teamId))
	const columnFit = React.useMemo(
		(): FitCols.Spec => ({
			shrinkable: SHRINKABLE_PLAYER_COLUMNS,
			onFit: (m, available) => {
				const minWidth = FitCols.minimumWidth(SHRINKABLE_PLAYER_COLUMNS, m)
				TeamsPanelPrt.Actions.reportTeamTableFit({ teamsPanel: squadServer }, props.teamId, minWidth, available)
			},
		}),
		[squadServer, props.teamId],
	)

	const getSquadGroup = (player: TeamsPanelModels.EnrichedPlayer): SquadGroupInfo | null => {
		const key = TeamsPanelPrt.squadGroupKey(props.teamId, player.squadId)
		const totalSize = squadSizes.get(key) ?? 0
		if (player.squadId === null) return { key, squad: null, creatorName: null, faction: null, totalSize }
		const squad = squads.find((s) => s.squadId === player.squadId)
		if (!squad) return null
		return { key, squad, creatorName: creatorNames.get(squad.creator) || null, faction: null, totalSize }
	}

	const renderCtx = useRenderCtx(props.stores)
	const rowMeta = { matchId, groupColorByName, stores: props.stores, squads, renderCtx } satisfies TeamRowMeta
	const meta = {
		...rowMeta,
		teamId: MH.getDenormedTeamId(props.teamId, match?.ordinal ?? 0),
		groupingId: groupingModes.active,
		filters,
		squadFilterTarget: props.teamId,
		availableRoles: roles,
		availableGroups: groups,
		statsMayBeInaccurate,
	} satisfies Omit<TeamPlayerTableMeta, 'statsSort'>

	return (
		<PlayerTable
			data={displayedPlayers}
			columns={teamPlayerColumns}
			meta={meta}
			rowMeta={rowMeta}
			sortingTarget="teams"
			label={tr.text(
				SM_Msgs.teamTableLabel(tr.text(L_Msgs.teamName(props.teamId, match && MH.getNormedTeamFaction(match, props.teamId), true))),
			)}
			stores={props.stores}
			getSquadGroup={getSquadGroup}
			columnFit={columnFit}
			className={props.className}
		/>
	)
}

export function CombinedPlayerTable(props: { className?: string; stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const currentMatch$ = MatchHistoryClient.currentMatch$(squadServer.serverId)
	const match = MatchHistoryClient.useCurrentMatch(squadServer.serverId)
	const matchId = match?.historyEntryId ?? 0

	const displayedPlayers = Zus.useStore(
		squadServer,
		currentMatch$,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		ClientOnlySettings.Store,
		TeamsPanelPrt.Sel.displayedCombinedPlayers,
	)
	const squadsWithTeam = Zus.useStore(
		squadServer,
		currentMatch$,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		ClientOnlySettings.Store,
		TeamsPanelPrt.Sel.squadsWithTeam,
	)
	const creatorNames = Zus.useStore(squadServer, TeamsPanelPrt.Sel.playerNamesById)
	const { roles, groups } = Zus.useStore(
		squadServer,
		currentMatch$,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelPrt.Sel.filterOptions,
	)
	const groupingModes = useGroupingModes()
	const groupColorByName = useGroupColorByName(groups, groupingModes)
	const displayTeamsNormalized = Zus.useStore(ClientOnlySettings.Store, (s) => s.displayTeamsNormalized)
	const ordinal = match?.ordinal ?? 0
	const squadSizes = Zus.useStore(squadServer, currentMatch$, TeamsPanelPrt.Sel.squadSizes)
	const statsMayBeInaccurate = Zus.useStore(squadServer, currentMatch$, ChatPrt.Sel.statsMayBeInaccurate)
	const filters = Zus.useStore(squadServer, TeamsPanelPrt.Sel.columnFilters('combined'))
	const phone = Browser.useIsSmallViewport()
	// the phone layout renders no header row to measure
	const columnFit = React.useMemo(
		(): FitCols.Spec | undefined =>
			phone
				? undefined
				: {
						shrinkable: SHRINKABLE_PLAYER_COLUMNS,
						onFit: (m, available) => {
							const minWidth = FitCols.minimumWidth(SHRINKABLE_PLAYER_COLUMNS, m, 'faction')
							TeamsPanelPrt.Actions.reportCombinedTableFit({ teamsPanel: squadServer }, minWidth, available, m.emPx)
						},
					},
		[phone, squadServer],
	)

	const layerId = match?.layerId
	const layer = React.useMemo(() => {
		if (!layerId) return null
		const l = L.toLayer(layerId)
		return L.isKnownLayer(l) ? l : null
	}, [layerId])
	const teamAIsTeam1 = ordinal % 2 === 0

	const getFaction = React.useCallback(
		(normedTeam: MH.NormedTeamId): string => {
			if (!layer) return normedTeam
			const isTeam1 = normedTeam === 'A' ? teamAIsTeam1 : !teamAIsTeam1
			return isTeam1 ? layer.Faction_1 : layer.Faction_2
		},
		[layer, teamAIsTeam1],
	)

	// matches the team indicator colors used by the layer/team displays: normed (A/B) colors when normalized,
	// in-game (1/2) colors otherwise
	const getTeamColor = React.useCallback(
		(normedTeam: MH.NormedTeamId) => DH.getTeamColor(MH.getDenormedTeamId(normedTeam, ordinal), ordinal, displayTeamsNormalized),
		[ordinal, displayTeamsNormalized],
	)

	const getSquadGroup = React.useCallback(
		(player: CombinedPlayer): SquadGroupInfo | null => {
			const faction = { label: getFaction(player.normedTeam), color: getTeamColor(player.normedTeam) }
			const key = TeamsPanelPrt.squadGroupKey(player.normedTeam, player.squadId)
			const totalSize = squadSizes.get(key) ?? 0
			if (player.squadId === null) return { key, squad: null, creatorName: null, faction, totalSize }
			const squad = squadsWithTeam.find(
				({ squad: s, normedTeam }) => s.squadId === player.squadId && normedTeam === player.normedTeam,
			)?.squad
			if (!squad) return null
			return { key, squad, creatorName: creatorNames.get(squad.creator) || null, faction, totalSize }
		},
		[squadsWithTeam, getFaction, getTeamColor, creatorNames, squadSizes],
	)

	const renderCtx = useRenderCtx(props.stores)
	const rowMeta = {
		matchId,
		groupColorByName,
		stores: props.stores,
		squadsWithTeam,
		getFaction,
		getTeamColor,
		renderCtx,
	} satisfies CombinedRowMeta
	const meta = {
		...rowMeta,
		groupingId: groupingModes.active,
		filters,
		squadFilterTarget: 'combined',
		availableRoles: roles,
		availableGroups: groups,
		statsMayBeInaccurate,
	} satisfies Omit<CombinedTableMeta, 'statsSort'>

	return (
		<PlayerTable
			data={displayedPlayers}
			columns={combinedPlayerColumns}
			meta={meta}
			rowMeta={rowMeta}
			sortingTarget="combined"
			label={tr.text(SM_Msgs.combinedTableLabel())}
			stores={props.stores}
			getSquadGroup={getSquadGroup}
			columnFit={columnFit}
			className={props.className}
		/>
	)
}
