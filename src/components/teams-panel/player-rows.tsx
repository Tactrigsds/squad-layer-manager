import * as Icons from 'lucide-react'
import React from 'react'

import * as RC from '@/components/feed/render-context'
import PlayerBulkContextMenuOptions from '@/components/player-bulk-context-menu-options'
import PlayerContextMenuOptions from '@/components/player-context-menu-options'
import SquadContextMenuOptions from '@/components/squad-context-menu-options'
import { SquadDisplay } from '@/components/squad-display'
import {
	type BaseRowMeta,
	MENU_ANCHOR_STYLE,
	type RowCellProps,
	type RowCellRenderer,
	type RowMenuTarget,
	samePlayerIds,
	sameSquadGroup,
	shiftClickCellProps,
	type SquadGroupInfo,
} from '@/components/teams-panel/teams-panel.helpers'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { TableCell, TableRow } from '@/components/ui/table'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import * as SM from '@/models/squad.models'
import type * as TeamsPanelModels from '@/models/teams-panel.models'
import { tr } from '@/systems/messages.client'

// Separator row rendered above each squad's players when the table is sorted by squad. Shows the squad
// id/name, member count and creator, opens the squad context menu, and its checkbox selects/deselects
// every (visible) member of the squad. The "Unassigned" group (null squad) has no context menu.
function SquadGroupHeaderRowView(props: {
	info: SquadGroupInfo
	playerIds: string[]
	colSpan: number
	collapsed: boolean
	phone: boolean
	stores: SquadServerFrame.KeyProp
}) {
	const selectedCount = Zus.useStore(
		props.stores.squadServer!,
		(s: SquadServerFrame.State) => props.playerIds.filter((id) => SquadServerFrame.Sel.playerSelection(s)[id]).length,
	)
	const allSelected = props.playerIds.length > 0 && selectedCount === props.playerIds.length
	const someSelected = selectedCount > 0 && !allSelected
	const toggle = (checked: boolean) => {
		SquadServerFrame.Actions.setSelection(props.stores, (current) => {
			const next = { ...current }
			for (const id of props.playerIds) {
				if (checked) next[id] = true
				else delete next[id]
			}
			return next
		})
	}
	// clicking anywhere on the header row folds the squad's players, except on the squad name, which opens its
	// window, and the checkbox, which stops propagation to keep its own behavior
	const toggleCollapsed = (e: React.MouseEvent) => {
		if (RC.opensWindow(e.target)) return
		TeamsPanelPrt.Actions.toggleSquadCollapsed({ teamsPanel: props.stores.squadServer! }, props.info.key)
	}
	const chevron = (
		<Icons.ChevronDown
			className={cn('ms-auto size-3.5 shrink-0 text-text-3 transition-transform', props.collapsed && '-rotate-90 rtl:rotate-90')}
		/>
	)
	const { squad, creatorName, faction, totalSize } = props.info
	const shownCount = props.playerIds.length
	const checkbox = (
		<div onClick={(e) => e.stopPropagation()}>
			<Checkbox
				checked={allSelected ? true : someSelected ? 'indeterminate' : false}
				onCheckedChange={toggle}
				aria-label={tr.text(squad ? SM_Msgs.selectSquadCheckbox(squad.squadId) : SM_Msgs.selectUnassignedCheckbox())}
			/>
		</div>
	)
	const labelContent = (
		<>
			{squad ? (
				<SquadDisplay stores={props.stores} squad={squad} matchId={0} showMenu={false} className="min-w-0" />
			) : (
				<span className="font-semibold">{tr.text(SM_Msgs.unassignedSquad())}</span>
			)}
			<span className="shrink-0 text-muted-foreground">{tr.text(SM_Msgs.squadRowCount(shownCount, totalSize))}</span>
			{creatorName && (
				<span className="min-w-0 truncate text-muted-foreground" title={tr.text(SM_Msgs.createdBy(creatorName))}>
					{tr.text(SM_Msgs.createdBy(creatorName))}
				</span>
			)}
		</>
	)
	const factionLabel = faction && (
		<span className="shrink-0 text-xs font-semibold" style={{ color: faction.color }}>
			{faction.label}
		</span>
	)
	// the label takes its width from the cell, so a long squad name truncates rather than widening the table.
	// combined desktop table: keep the faction in its own cell so it lines up under the faction column. A phone row
	// is one cell, so the faction goes inline.
	return factionLabel && !props.phone ? (
		<TableRow
			className="cursor-pointer [&>td]:h-[calc(var(--row)-6px)] [&>td]:bg-white/5 hover:[&>td]:bg-white/8"
			data-collapsed={props.collapsed || undefined}
			data-tour="squad-header"
			data-tour-squad={squad?.squadName}
			data-squad-menu={squad?.uniqueId}
			onClick={toggleCollapsed}
		>
			<TableCell>{checkbox}</TableCell>
			<TableCell>{factionLabel}</TableCell>
			<TableCell colSpan={props.colSpan - 2}>
				<div className="flex items-center gap-2 text-xs [contain:inline-size]">
					{labelContent}
					{chevron}
				</div>
			</TableCell>
		</TableRow>
	) : (
		<TableRow
			className="cursor-pointer [&>td]:h-[calc(var(--row)-6px)] [&>td]:bg-white/5 hover:[&>td]:bg-white/8"
			data-collapsed={props.collapsed || undefined}
			data-tour="squad-header"
			data-tour-squad={squad?.squadName}
			data-squad-menu={squad?.uniqueId}
			onClick={toggleCollapsed}
		>
			<TableCell colSpan={props.colSpan}>
				<div className="flex items-center gap-2 overflow-hidden text-xs [contain:inline-size]">
					{checkbox}
					{factionLabel}
					{labelContent}
					{chevron}
				</div>
			</TableCell>
		</TableRow>
	)
}

// the squad header rows are rebuilt on every table render, so they compare by content rather than identity
export const SquadGroupHeaderRow = React.memo(
	SquadGroupHeaderRowView,
	(prev, next) =>
		prev.colSpan === next.colSpan &&
		prev.collapsed === next.collapsed &&
		prev.phone === next.phone &&
		prev.stores === next.stores &&
		sameSquadGroup(prev.info, next.info) &&
		samePlayerIds(prev.playerIds, next.playerIds),
)

// Memoized, so a kill or a chat message re-renders the rows of the players it touched rather than every row. Every
// prop is a plain value: TanStack's row objects are rebuilt with the data and mutated in place, and would defeat it.
function PlayerRowView<T extends TeamsPanelModels.EnrichedPlayer, M extends BaseRowMeta>(props: {
	player: T
	selected: boolean
	savedSwap: boolean
	columnIds: string[]
	cells: Record<string, RowCellRenderer<T, M>>
	meta: M
	phone: boolean
	// the phone layout names the faction on each row unless squad header rows already do
	flat: boolean
	onOpenMenu: (playerId: SM.PlayerId) => void
}) {
	const { player, selected, meta, columnIds, cells, phone, onOpenMenu } = props
	const playerId = SM.PlayerIds.getPlayerId(player.ids)
	const cellProps: RowCellProps<T, M> = { player, playerId, selected, meta }
	const phoneCell = (id: string) =>
		columnIds.includes(id) ? (
			<span key={id} className="contents" {...shiftClickCellProps(id, player, meta.stores)}>
				{cells[id](cellProps)}
			</span>
		) : null
	return (
		<TableRow
			data-tour="player-row"
			data-tour-player={player.ids.username}
			data-player-id={playerId}
			className={cn(
				'cursor-pointer select-none',
				props.savedSwap ? '[&>td]:bg-[rgba(230,180,34,0.16)]! data-[state=selected]:[&>td]:bg-[rgba(230,180,34,0.32)]!' : undefined,
			)}
			data-state={selected ? 'selected' : undefined}
		>
			{phone ? (
				<TableCell colSpan={columnIds.length} className="h-auto! px-2.5! pe-1! py-1.5 whitespace-normal">
					<div className="flex items-center gap-1">
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<div className="flex items-center gap-2 min-w-0">
								{phoneCell('select')}
								{props.flat && phoneCell('faction')}
								<span className="min-w-0 truncate">{phoneCell('name')}</span>
								{phoneCell('group')}
								<span className="flex-1" />
								{phoneCell('squad')}
								{phoneCell('tks')}
							</div>
							{columnIds.some((id) => id === 'role' || id === 'vehicle' || id === 'stats') && (
								<div className="flex items-center gap-2 min-w-0 ps-7 text-xs text-text-2">
									<span className="min-w-0 truncate">{phoneCell('role')}</span>
									<span className="min-w-0 truncate">{phoneCell('vehicle')}</span>
									<span className="flex-1" />
									{phoneCell('stats')}
								</div>
							)}
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							className="shrink-0"
							title={tr.text(SM_Msgs.moreActions())}
							onMouseDown={(e) => e.stopPropagation()}
							onClick={(e) => {
								e.stopPropagation()
								onOpenMenu(playerId)
							}}
						>
							<Icons.EllipsisVertical />
						</Button>
					</div>
				</TableCell>
			) : (
				columnIds.map((id) => (
					<TableCell key={id} {...shiftClickCellProps(id, player, meta.stores)}>
						{cells[id](cellProps)}
					</TableCell>
				))
			)}
		</TableRow>
	)
}

export const PlayerRow = React.memo(PlayerRowView) as typeof PlayerRowView

// memoized, so the table re-rendering with the roster leaves the closed menu alone
export const RowMenu = React.memo(function RowMenu(props: {
	target: RowMenuTarget | null
	anchorRef: React.RefObject<HTMLSpanElement | null>
	stores: SquadServerFrame.KeyProp
}) {
	const { target, stores } = props
	return (
		<ContextMenu>
			<ContextMenuTrigger ref={props.anchorRef} aria-hidden style={MENU_ANCHOR_STYLE} />
			<ContextMenuContent>
				{target?.kind === 'player' && <PlayerRowMenuOptions playerId={target.playerId} stores={stores} />}
				{target?.kind === 'squad' && <SquadRowMenuOptions squad={target.squad} stores={stores} />}
			</ContextMenuContent>
		</ContextMenu>
	)
})

// mounted only while the menu is open, so the selection it reads does not re-render every row
function PlayerRowMenuOptions(props: { playerId: SM.PlayerId; stores: SquadServerFrame.KeyProp }) {
	const selectedIds = Zus.useStore(props.stores.squadServer!, SquadServerFrame.Sel.selectedPlayerIds)
	if (selectedIds.size >= 2 && selectedIds.has(props.playerId)) {
		return <PlayerBulkContextMenuOptions playerIds={[...selectedIds]} stores={props.stores} />
	}
	return <PlayerContextMenuOptions playerId={props.playerId} stores={props.stores} />
}

// the live squad, or the one the menu opened on once it has disbanded, so a fading menu keeps its content
function SquadRowMenuOptions(props: { squad: SM.UniqueSquad; stores: SquadServerFrame.KeyProp }) {
	const live = Zus.useStore(props.stores.squadServer!, (s) => ChatPrt.Sel.squads(s).find((sq) => sq.uniqueId === props.squad.uniqueId))
	return <SquadContextMenuOptions squad={live ?? props.squad} stores={props.stores} />
}
