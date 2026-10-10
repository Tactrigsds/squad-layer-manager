import { CheckIcon } from '@radix-ui/react-icons'
import * as Icons from 'lucide-react'
import React from 'react'

import ComboBox from '@/components/combo-box/combo-box.tsx'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import * as LayerSearchPrt from '@/frame-partials/layer-search.partial.ts'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as MsgFmt from '@/messages/format'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as CS from '@/models/context-shared.models'
import * as LC from '@/models/layer-columns.models'
import type * as LQY from '@/models/layer-queries.models'
import * as L from '@/models/layer.models'
import type * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'

import { ConstraintEvalSheetButton } from './constraint-matches-indicator.tsx'
import LayerContextMenuOptions from './layer-context-menu-options.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import { RichSearchField, SearchErrors, SearchSuggestions } from './layer-search-parts.tsx'
import { partColumnName, useSearchInput } from './layer-search.helpers.ts'
import PoolCheckboxes from './pool-checkboxes.tsx'
import { TablePagination } from './table-pagination'
import { Input } from './ui/input.tsx'

export type ResultsView = 'list' | 'search' | 'advanced'

// The picker's Results tab on a phone. The list view reads the search back as rich text above the layers; tapping it
// opens the search view, where the same search is plain text in an input and only the layers show beneath it.
// Leaving the input returns to the list. Advanced search is the full filter menu, editing the same constraints.
export default function PhoneResultsTab(props: {
	frameKey: SelectLayersFrame.Key
	squadServer?: SquadServerFrame.Key
	view: ResultsView
	setView: (view: ResultsView) => void
	// pinned under the list view, e.g. the way on to the Summary tab or a dialog's own submit button
	footer?: React.ReactNode
}) {
	switch (props.view) {
		case 'list':
			return <ListView {...props} />
		case 'search':
			return <SearchView {...props} />
		case 'advanced':
			return <AdvancedView {...props} />
		default:
			return null
	}
}

type ViewProps = React.ComponentProps<typeof PhoneResultsTab>

function ListView(props: ViewProps) {
	const { frameKey } = props
	const showPoolCheckboxes = Zus.useStore(frameKey, SelectLayersFrame.Sel.repeatRulesApplicable)
	const selectedCount = Zus.useStore(frameKey, (s) => s.layerTable.selected.length)
	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="sticky top-0 z-1 flex flex-col gap-2 border-b border-line bg-panel-hi px-3 py-2 shadow-[0_4px_10px_rgba(0,0,0,0.35)]">
					<div role="search" className="flex gap-1.5">
						<RichSearchField frameKey={frameKey} onOpen={() => props.setView('search')} />
						<AdvancedButton onClick={() => props.setView('advanced')} />
					</div>
					<ResultCount frameKey={frameKey} />
				</div>
				<div className="flex flex-col gap-2.5 p-3">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<SortControls frameKey={frameKey} />
						{showPoolCheckboxes && <PoolCheckboxes stores={{ poolCheckboxes: frameKey }} />}
					</div>
					{selectedCount > 0 && (
						<div className="flex min-h-9 items-center gap-2 rounded-sm border border-pri-lo bg-pri-lo/25 ps-3 pe-1">
							<span className="flex-1 text-sm text-pri-hi">{tr.text(L_Msgs.selectedCount(selectedCount))}</span>
							<Button variant="ghost" size="sm" onClick={() => LayerTablePrt.Actions.setSelected({ layerTable: frameKey }, [])}>
								{tr.text(L_Msgs.clearSelection())}
							</Button>
						</div>
					)}
					<LayerRows frameKey={frameKey} squadServer={props.squadServer} />
					<Pagination frameKey={frameKey} />
				</div>
			</div>
			{props.footer && (
				<div className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-panel p-3 shadow-[inset_0_1px_0_var(--line-soft)]">
					{props.footer}
				</div>
			)}
		</>
	)
}

function AdvancedButton(props: { onClick: () => void; keepFocus?: boolean }) {
	return (
		<Button
			size="icon"
			className="shrink-0"
			aria-label={tr.text(L_Msgs.advancedSearch())}
			title={tr.text(L_Msgs.advancedSearch())}
			onMouseDown={props.keepFocus ? (e) => e.preventDefault() : undefined}
			onClick={props.onClick}
		>
			<Icons.SlidersHorizontal />
		</Button>
	)
}

function ResultCount(props: { frameKey: SelectLayersFrame.Key }) {
	const [total, fetching] = Zus.useStore(
		props.frameKey,
		Zus.useShallow((s) => [s.layerTable.pageData?.totalCount ?? null, s.layerTable.isFetching] as const),
	)
	return (
		<div
			role="status"
			className="flex min-h-6 items-center gap-2 text-text-2 [&_strong]:font-mono [&_strong]:text-xl [&_strong]:font-bold [&_strong]:text-pri-hi"
		>
			{total === null ? null : total > 0 ? (
				<span>{tr.richText(L_Msgs.matchedLayers(MsgFmt.formatNumber(total)))}</span>
			) : (
				<span className="font-semibold text-text">{tr.text(L_Msgs.noLayersMatched())}</span>
			)}
			{(fetching || total === null) && <span className="fd-spin" />}
		</div>
	)
}

const DEFAULT_SORT_KEY = '__default'
const RANDOM_SORT_KEY = '__random'
const ABS_DIRECTIONS: LQY.LayersQuerySortDirection[] = ['ASC', 'DESC', 'ASC:ABS', 'DESC:ABS']
const PLAIN_DIRECTIONS: LQY.LayersQuerySortDirection[] = ['ASC', 'DESC']

// Sorting from a picker and a direction button, since a phone has no column headers to tap. The dice shows only
// while the order is random, and rerolls it.
function SortControls(props: { frameKey: SelectLayersFrame.Key }) {
	const stores = { layerTable: props.frameKey }
	const [sort, colConfig, columnVisibility] = Zus.useStore(
		props.frameKey,
		Zus.useShallow((s) => [s.layerTable.sort, s.layerTable.colConfig, s.layerTable.columnVisibility] as const),
	)
	const ctx: LC.Ctx = { ...CS.init(), effectiveColsConfig: colConfig }
	const columns = Object.keys(colConfig.defs).filter((name) => columnVisibility[name] && !LC.isVirtualColumn(name, colConfig))
	const options = [
		{ value: DEFAULT_SORT_KEY, label: tr.text(L_Msgs.defaultOrder()) },
		{ value: RANDOM_SORT_KEY, label: tr.text(L_Msgs.randomOrder()), description: tr.text(L_Msgs.randomizeHint()) },
		...columns.map((name) => ({ value: name, label: partColumnName(name) })),
	]
	const value = sort?.type === 'random' ? RANDOM_SORT_KEY : sort?.type === 'column' ? sort.sortBy : DEFAULT_SORT_KEY
	const columnSort = sort?.type === 'column' ? sort : null
	const directions = columnSort && LC.isNumericColumn(columnSort.sortBy, ctx) ? ABS_DIRECTIONS : PLAIN_DIRECTIONS
	const directionLabel = columnSort ? DIRECTION_LABELS[columnSort.direction]() : tr.text(L_Msgs.sortAscending())

	return (
		<div className="flex min-w-0 flex-[999_1_14rem] gap-1.5">
			<ComboBox
				title={tr.text(L_Msgs.sortBy())}
				className="min-w-0 flex-1"
				allowEmpty={false}
				sort={false}
				options={options}
				value={value}
				onSelect={(key) => {
					if (key === RANDOM_SORT_KEY) LayerTablePrt.Actions.randomize(stores)
					else if (key === DEFAULT_SORT_KEY || !key) LayerTablePrt.Actions.setSort(stores, null)
					else LayerTablePrt.Actions.setSort(stores, { type: 'column', sortBy: key, direction: 'ASC' })
				}}
			/>
			<Button
				size="icon"
				className="shrink-0 gap-0.5"
				disabled={!columnSort}
				aria-label={directionLabel}
				title={directionLabel}
				onClick={() => {
					if (!columnSort) return
					const next = directions[(directions.indexOf(columnSort.direction) + 1) % directions.length]
					LayerTablePrt.Actions.setSort(stores, { ...columnSort, direction: next })
				}}
			>
				{columnSort?.direction.startsWith('DESC') ? <Icons.ArrowDown /> : <Icons.ArrowUp />}
				{columnSort?.direction.endsWith(':ABS') && <span className="text-2xs">{tr.text(L_Msgs.sortByMagnitude())}</span>}
			</Button>
			{sort?.type === 'random' && (
				<Button
					size="icon"
					className="shrink-0"
					aria-label={tr.text(L_Msgs.reroll())}
					title={tr.text(L_Msgs.reroll())}
					onClick={() => LayerTablePrt.Actions.randomize(stores)}
				>
					<Icons.Dices />
				</Button>
			)}
		</div>
	)
}

const DIRECTION_LABELS: Record<LQY.LayersQuerySortDirection, () => string> = {
	ASC: () => tr.text(L_Msgs.sortAscending()),
	DESC: () => tr.text(L_Msgs.sortDescending()),
	'ASC:ABS': () => tr.text(L_Msgs.sortAscendingByMagnitude()),
	'DESC:ABS': () => tr.text(L_Msgs.sortDescendingByMagnitude()),
}

function LayerRows(props: { frameKey: SelectLayersFrame.Key; squadServer?: SquadServerFrame.Key; keepFocus?: boolean }) {
	const layers = Zus.useStore(props.frameKey, (s) => s.layerTable.pageData?.layers)
	const teamParity = Zus.useStore(props.frameKey, props.squadServer ?? null, LayerTablePrt.Sel.teamParity)
	const sortColumn = Zus.useStore(props.frameKey, (s) => (s.layerTable.sort?.type === 'column' ? s.layerTable.sort.sortBy : null))
	if (!layers) return null
	return (
		<ul className="flex flex-col gap-1.5">
			{layers.map((row) => (
				<LayerRow
					key={row.id}
					frameKey={props.frameKey}
					row={row}
					teamParity={teamParity}
					sortColumn={sortColumn}
					keepFocus={props.keepFocus}
				/>
			))}
		</ul>
	)
}

// the layer's own columns already show these, so a sort by one of them needs no value beside it
const SHOWN_COLUMNS = new Set(['Layer', 'Map', 'Gamemode', 'LayerVersion', 'Faction_1', 'Faction_2', 'Unit_1', 'Unit_2'])

const LayerRow = React.memo(function LayerRow(props: {
	frameKey: SelectLayersFrame.Key
	row: LayerQueriesClient.RowData
	teamParity: number
	sortColumn: string | null
	keepFocus?: boolean
}) {
	const { row } = props
	const stores = { layerTable: props.frameKey }
	const { isUnselectable, isSelected, blockedByPool, blockedByMods } = Zus.useStore(
		props.frameKey,
		UsersClient.loggedInUserQueryOptions,
		RbacClient.RbacStore,
		LayerTablePrt.Sel.rowSelectionStatus(row.id),
	)
	const layer = L.toLayer(row.id)
	const name = [layer.Map, layer.Gamemode, layer.LayerVersion].filter(Boolean).join(' ')
	const sortValue =
		props.sortColumn && !SHOWN_COLUMNS.has(props.sortColumn) ? formatSortValue((row as Record<string, unknown>)[props.sortColumn]) : null
	const keepFocus = props.keepFocus ? (e: React.MouseEvent) => e.preventDefault() : undefined

	function toggle() {
		if (isUnselectable) return
		LayerTablePrt.Actions.setSelected(stores, (selected) =>
			selected.includes(row.id) ? selected.filter((id) => id !== row.id) : [...selected, row.id],
		)
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<li
					className={cn(
						'flex items-center gap-1 rounded-sm border pe-1 select-none [-webkit-touch-callout:none]',
						isSelected ? 'border-pri-lo bg-pri-lo/25' : 'border-line bg-panel shadow-[inset_0_1px_0_var(--line-soft)]',
						isUnselectable && !isSelected && 'text-text-3',
					)}
				>
					<button
						type="button"
						role="checkbox"
						aria-checked={isSelected}
						aria-disabled={isUnselectable || undefined}
						onMouseDown={keepFocus}
						onClick={toggle}
						className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 ps-3 text-start"
					>
						{blockedByMods ? (
							<span className="fd-cbx opacity-45" title={tr.text(F_Msgs.unsupportedModDescription())}>
								<Icons.PackageX />
							</span>
						) : blockedByPool ? (
							<span className="fd-cbx opacity-45">
								<Icons.Ban />
							</span>
						) : (
							<span className={cn('fd-cbx shrink-0', isSelected && 'fd-cbx-on')}>{isSelected && <CheckIcon />}</span>
						)}
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="flex flex-wrap items-baseline gap-x-2">
								<span className="font-semibold">{name}</span>
								{sortValue !== null && <span className="font-mono text-xs text-pri-hi">{sortValue}</span>}
							</span>
							<span className="flex flex-wrap gap-x-1.5 text-sm">
								<span className="text-team1">{[layer.Faction_1, layer.Unit_1].filter(Boolean).join(' ')}</span>
								<span className="text-text-3">{tr.text(L_Msgs.versus())}</span>
								<span className="text-team2">{[layer.Faction_2, layer.Unit_2].filter(Boolean).join(' ')}</span>
							</span>
						</span>
					</button>
					<span onMouseDown={keepFocus}>
						<ConstraintEvalSheetButton
							layerId={row.id}
							itemParity={props.teamParity}
							matchDescriptors={row.constraints.matchDescriptors}
							queriedConstraints={row.constraints.queriedConstraints}
							height={24}
							className="min-h-11 min-w-11 justify-end px-1.5"
							sheetTitle={name}
						/>
					</span>
				</li>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<LayerContextMenuOptions layerIds={[row.id]} />
			</ContextMenuContent>
		</ContextMenu>
	)
})

function formatSortValue(value: unknown): string | null {
	if (typeof value === 'number') {
		const formatted = value.toFixed(2)
		return value > 0 ? `+${formatted}` : formatted
	}
	if (typeof value === 'string' || typeof value === 'boolean') return String(value)
	return null
}

function Pagination(props: { frameKey: SelectLayersFrame.Key }) {
	const [pageIndex, pageCount, fetching] = Zus.useStore(
		props.frameKey,
		Zus.useShallow((s) => [s.layerTable.pageIndex, s.layerTable.pageData?.pageCount ?? 0, s.layerTable.isFetching] as const),
	)
	if (pageCount <= 1) return null
	return (
		<div className="flex justify-center">
			<TablePagination
				pageIndex={pageIndex}
				pageCount={pageCount}
				disabled={fetching}
				onPageChange={(index) => LayerTablePrt.Actions.setPageIndex({ layerTable: props.frameKey }, index)}
			/>
		</div>
	)
}

function SearchView(props: ViewProps) {
	const { frameKey, setView } = props
	const { inputRef, initialText, setTextDebounced, finish, setInput, keepFocus } = useSearchInput(frameKey)

	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto" onMouseDown={keepFocus}>
				<div className="sticky top-0 z-1 flex items-center gap-1 border-b border-line bg-panel-hi py-2 ps-1 pe-3 shadow-[0_4px_10px_rgba(0,0,0,0.35)]">
					<Button
						variant="ghost"
						size="icon"
						className="shrink-0"
						aria-label={tr.text(L_Msgs.closeSearch())}
						onClick={() => {
							finish()
							setView('list')
						}}
					>
						<Icons.ArrowLeft className="rtl:-scale-x-100" />
					</Button>
					<div className="relative min-w-0 flex-1">
						<Icons.Search className="pointer-events-none absolute inset-s-2.5 top-1/2 z-1 size-4.5 -translate-y-1/2 text-text-3" />
						<Input
							ref={inputRef}
							type="search"
							// the view opens from a tap on the search box, so the keyboard is what the user asked for
							autoFocus
							enterKeyHint="search"
							autoComplete="off"
							aria-label={tr.text(L_Msgs.searchLayers())}
							placeholder={tr.text(L_Msgs.searchLayers())}
							defaultValue={initialText}
							className="ps-9"
							onChange={(e) => setTextDebounced(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
							}}
							onBlur={() => {
								finish()
								setView('list')
							}}
						/>
					</div>
					<AdvancedButton
						keepFocus
						onClick={() => {
							finish()
							setView('advanced')
						}}
					/>
				</div>
				<div className="flex flex-col gap-2.5 p-3">
					<SearchErrors frameKey={frameKey} inputRef={inputRef} setInput={setInput} />
					<SearchSuggestions frameKey={frameKey} setInput={setInput} />
					<ResultCount frameKey={frameKey} />
					<LayerRows frameKey={frameKey} squadServer={props.squadServer} keepFocus />
					<Pagination frameKey={frameKey} />
				</div>
			</div>
			{props.footer && (
				// the footer leaves this view without the input losing focus first, so the search is recorded here
				<div
					className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-panel p-3 shadow-[inset_0_1px_0_var(--line-soft)]"
					onMouseDown={keepFocus}
					onClickCapture={finish}
				>
					{props.footer}
				</div>
			)}
		</>
	)
}

function AdvancedView(props: ViewProps) {
	const { frameKey } = props
	const unwritten = Zus.useStore(frameKey, LayerSearchPrt.Sel.hasUnwrittenConstraints)
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="sticky top-0 z-1 flex items-center gap-3 border-b border-line bg-panel-hi px-3 py-2 shadow-[0_4px_10px_rgba(0,0,0,0.35)]">
				<div className="min-w-0 flex-1">
					<ResultCount frameKey={frameKey} />
				</div>
				<Button
					className="shrink-0"
					onClick={() => {
						LayerSearchPrt.Actions.commit({ layerSearch: frameKey })
						props.setView('list')
					}}
				>
					{tr.text(UI_Msgs.done())}
				</Button>
			</div>
			<div className="flex flex-col gap-2.5 p-3">
				<h3 className="text-base font-semibold">{tr.text(L_Msgs.advancedSearch())}</h3>
				{unwritten && <p className="text-sm text-warn">{tr.text(L_Msgs.unwrittenConstraints())}</p>}
				<LayerFilterMenu stores={{ filterMenu: frameKey }} />
			</div>
		</div>
	)
}
