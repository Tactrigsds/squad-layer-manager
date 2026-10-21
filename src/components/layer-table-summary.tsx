import * as Icons from 'lucide-react'
import React from 'react'

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as MsgFmt from '@/messages/format'
import * as LC_Msgs from '@/messages/layer-columns.messages'
import * as L_Msgs from '@/messages/layer.messages'
import * as DH from '@/models/display-helpers.models'
import type * as LC from '@/models/layer-columns.models'
import type * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

const TIP_VALUES_SHOWN = 12
const CARD_VALUES_SHOWN = 5

function valueLabel(value: LQY.ValueCount['value']) {
	if (value === null) return tr.text(L_Msgs.noValue())
	if (typeof value === 'boolean') return value ? 'True' : 'False'
	return String(value)
}

// how many distinct values a column holds among the results, beside its name in the header
export function ColumnDistinctCount(props: { stores: LayerTablePrt.KeyProp; column: string }) {
	const count = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.columnDistinctCount(props.column))
	const stale = Zus.useStore(props.stores.layerTable, (s) => s.layerTable.summaryStale)
	if (count === null) {
		return (
			<span
				role="img"
				aria-label={tr.text(L_Msgs.countingValues())}
				className="ms-1 inline-block h-2 w-5 rounded-sm bg-muted align-middle"
			/>
		)
	}
	return <span className={cn('ms-1 font-normal text-text-2', stale && 'italic text-text-3')}>({MsgFmt.formatNumber(count)})</span>
}

export function ColumnSummaryTip(props: { stores: LayerTablePrt.KeyProp; colDef: LC.ColumnDef; isNumeric: boolean }) {
	return (
		<div className="flex w-72 max-w-full flex-col gap-2 py-1">
			<div className="flex items-baseline justify-between gap-3">
				<span className="font-semibold">{tr.text(LC_Msgs.columnName(props.colDef))}</span>
				{!props.isNumeric && <DistinctCountLabel stores={props.stores} column={props.colDef.name} />}
				{props.isNumeric && <span className="text-text-2">{tr.text(L_Msgs.rangeInResults())}</span>}
			</div>
			{props.isNumeric ? (
				<ColumnRangeDisplay stores={props.stores} column={props.colDef.name} large />
			) : (
				<ValueCountList stores={props.stores} column={props.colDef.name} limit={TIP_VALUES_SHOWN} />
			)}
		</div>
	)
}

function DistinctCountLabel(props: { stores: LayerTablePrt.KeyProp; column: string }) {
	const count = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.columnDistinctCount(props.column))
	if (count === null) return null
	return <span className="whitespace-nowrap text-text-2">{tr.text(L_Msgs.distinctValues(count))}</span>
}

// `limit` null lists every value. A list cut short names how many it left out unless `hideRemainder` is set
function ValueCountList(props: { stores: LayerTablePrt.KeyProp; column: string; limit: number | null; hideRemainder?: boolean }) {
	const counts = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.columnValueCounts(props.column))
	if (!counts) return <span className="text-text-2">{tr.text(L_Msgs.countingValues())}</span>
	const shown = props.limit === null ? counts : counts.slice(0, props.limit)
	const max = counts[0]?.count ?? 1
	return (
		<>
			<ul className="flex flex-col gap-1">
				{shown.map((entry) => (
					<li key={String(entry.value)} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-2">
						<span className={cn('truncate', entry.value === null && 'text-text-2')}>{valueLabel(entry.value)}</span>
						<span className="fd-prog">
							<span className="fd-prog-bar" style={{ width: `${(entry.count / max) * 100}%` }} />
						</span>
						<span className="fd-num text-end font-mono text-xs text-text-2">{MsgFmt.formatNumber(entry.count)}</span>
					</li>
				))}
			</ul>
			{!props.hideRemainder && counts.length > shown.length && (
				<span className="text-text-2">{tr.text(L_Msgs.moreValues(MsgFmt.formatNumber(counts.length - shown.length)))}</span>
			)}
		</>
	)
}

function ColumnRangeDisplay(props: { stores: LayerTablePrt.KeyProp; column: string; large?: boolean }) {
	const range = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.columnRange(props.column))
	if (!range) return <span className="text-text-2">{tr.text(L_Msgs.readingRange())}</span>
	if (!range.results || !range.all) return <span className="text-text-2">{tr.text(L_Msgs.noRangeInResults())}</span>
	const { results, all } = range
	const span = all.max - all.min || 1
	const left = ((results.min - all.min) / span) * 100
	const width = Math.max(((results.max - results.min) / span) * 100, 1)
	const track = (
		<span className="fd-prog relative block">
			<span className="fd-prog-bar absolute inset-y-0" style={{ insetInlineStart: `${left}%`, width: `${width}%` }} />
		</span>
	)
	if (!props.large) {
		return (
			<>
				<span className="fd-num text-end font-mono text-xs">{DH.formatScore(results.min)}</span>
				{track}
				<span className="fd-num font-mono text-xs">{DH.formatScore(results.max)}</span>
			</>
		)
	}
	return (
		<div className="flex flex-col gap-1.5">
			<span className="fd-num text-center font-mono text-base font-semibold">
				{tr.text(L_Msgs.valueRange(DH.formatScore(results.min), DH.formatScore(results.max)))}
			</span>
			{track}
			<span className="fd-num flex justify-between font-mono text-2xs text-text-2">
				<span>{DH.formatScore(all.min)}</span>
				<span>{DH.formatScore(all.max)}</span>
			</span>
			<span className="text-2xs text-text-2">{tr.text(L_Msgs.rangeTrackCaption())}</span>
		</div>
	)
}

export function LayerTableViewToggle(props: { stores: LayerTablePrt.KeyProp }) {
	const view = Zus.useStore(props.stores.layerTable, (s) => s.layerTable.view)
	return (
		<ToggleGroup
			type="single"
			size="sm"
			aria-label={tr.text(L_Msgs.tableView())}
			value={view}
			onValueChange={(value) => {
				if (value === 'results' || value === 'summary') LayerTablePrt.Actions.setView(props.stores, value)
			}}
		>
			<ToggleGroupItem value="results" className="gap-1.5 px-2">
				<Icons.Rows3 className="size-3.5" aria-hidden="true" />
				{tr.text(L_Msgs.resultsView())}
			</ToggleGroupItem>
			<ToggleGroupItem value="summary" className="gap-1.5 px-2">
				<Icons.ChartNoAxesColumn className="size-3.5" aria-hidden="true" />
				{tr.text(L_Msgs.summaryView())}
			</ToggleGroupItem>
		</ToggleGroup>
	)
}

export function LayerTableSummaryView(props: { stores: LayerTablePrt.KeyProp }) {
	const stale = Zus.useStore(props.stores.layerTable, (s) => s.layerTable.summaryStale)
	const filterRows = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.filterSummaryRows)
	const { valueColumns, rangeColumns } = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.summaryColumns)
	const colConfig = Zus.useStore(props.stores.layerTable, (s) => s.layerTable.colConfig)

	const complete = Zus.useStore(props.stores.layerTable, (s) => !!s.layerTable.summary?.complete)
	return (
		<div
			className={cn('fd-well flex flex-col gap-4 p-3 transition-opacity', stale && 'opacity-60')}
			aria-busy={stale || !complete}
			// every part of the summary describes the current query; e2e waits on it
			data-summary-complete={complete && !stale}
		>
			{filterRows.length > 0 && (
				<section aria-labelledby="summary-filters" className="flex flex-col gap-2">
					<h3 id="summary-filters" className="fd-lbl-k">
						{tr.text(L_Msgs.summaryFilters())}
					</h3>
					<FilterSummaryTable stores={props.stores} rows={filterRows} />
				</section>
			)}
			<section aria-labelledby="summary-columns" className="flex flex-col gap-2">
				<h3 id="summary-columns" className="fd-lbl-k">
					{tr.text(L_Msgs.summaryColumns())}
				</h3>
				<div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
					{valueColumns.map((column) => (
						<ValueCountCard key={column} stores={props.stores} colDef={colConfig.defs[column]} />
					))}
				</div>
			</section>
			{rangeColumns.length > 0 && (
				<section aria-labelledby="summary-ranges" className="flex flex-col gap-2">
					<h3 id="summary-ranges" className="fd-lbl-k">
						{tr.text(L_Msgs.summaryScoreRanges())}
					</h3>
					<div className="grid grid-cols-[minmax(0,14rem)_auto_minmax(4rem,1fr)_auto] items-center gap-x-3 gap-y-2">
						{rangeColumns.map((column) => (
							<React.Fragment key={column}>
								<span className="truncate">{tr.text(LC_Msgs.columnName(colConfig.defs[column]))}</span>
								<ColumnRangeCells stores={props.stores} column={column} />
							</React.Fragment>
						))}
					</div>
					<p className="text-2xs text-text-2">{tr.text(L_Msgs.rangeTrackCaption())}</p>
				</section>
			)}
		</div>
	)
}

// fills the three grid cells after a range row's name, whatever state the range is in
function ColumnRangeCells(props: { stores: LayerTablePrt.KeyProp; column: string }) {
	const range = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.columnRange(props.column))
	if (range?.results && range.all) return <ColumnRangeDisplay stores={props.stores} column={props.column} />
	return <span className="col-span-3 text-text-2">{tr.text(range ? L_Msgs.noRangeInResults() : L_Msgs.readingRange())}</span>
}

function ValueCountCard(props: { stores: LayerTablePrt.KeyProp; colDef: LC.ColumnDef }) {
	const column = props.colDef.name
	const expanded = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.summaryColumnExpanded(column))
	const count = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.columnValueCounts(column))?.length ?? 0
	return (
		<article className="flex min-w-0 flex-col gap-2 rounded-sm border border-border bg-card p-2">
			<header className="flex items-baseline justify-between gap-2">
				<h4 className="truncate font-semibold">{tr.text(LC_Msgs.columnName(props.colDef))}</h4>
				<DistinctCountLabel stores={props.stores} column={column} />
			</header>
			<div className={cn('flex flex-col gap-1', expanded && 'max-h-64 overflow-y-auto pe-1')}>
				<ValueCountList stores={props.stores} column={column} limit={expanded ? null : CARD_VALUES_SHOWN} hideRemainder />
			</div>
			{count > CARD_VALUES_SHOWN && (
				<button
					type="button"
					className="fd-btn-link self-start"
					onClick={() => LayerTablePrt.Actions.toggleSummaryColumnExpanded(props.stores, column)}
				>
					{expanded ? tr.text(L_Msgs.showFewerValues()) : tr.text(L_Msgs.showAllValues(MsgFmt.formatNumber(count)))}
				</button>
			)}
		</article>
	)
}

function FilterSummaryTable(props: { stores: LayerTablePrt.KeyProp; rows: LayerTablePrt.Sel.FilterSummaryRow[] }) {
	const filters = FilterEntityClient.useFilterEntities()
	const total = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.summaryTotal)
	return (
		<Table className="table-fixed">
			<TableHeader>
				<TableRow>
					<TableHead className="w-[30%]">{tr.text(L_Msgs.summaryFilterColumn())}</TableHead>
					<TableHead className="w-32">
						<span className="flex items-center gap-1.5">
							{tr.text(L_Msgs.summaryAppliedAsColumn())}
							<AppliedAsHint />
						</span>
					</TableHead>
					<TableHead>{tr.text(L_Msgs.summaryMatchesColumn())}</TableHead>
					<TableHead className="w-44">
						<span className="flex items-center justify-end gap-1.5">
							{tr.text(L_Msgs.summaryRemovesColumn())}
							<RemovesHint />
						</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((row) => {
					const share = total ? row.count.matches / total : 0
					return (
						<TableRow key={row.filterId}>
							<TableCell className="truncate font-medium">{filters.get(row.filterId)?.name ?? row.filterId}</TableCell>
							<TableCell>
								<AppliedAsBadge appliedAs={row.appliedAs} />
							</TableCell>
							<TableCell>
								<span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
									<span className="fd-prog">
										<span className="fd-prog-bar" style={{ width: `${share * 100}%` }} />
									</span>
									<span className="fd-num font-mono text-xs text-text-2">
										{tr.text(L_Msgs.summaryMatchCount(MsgFmt.formatNumber(row.count.matches), String(Math.round(share * 100))))}
									</span>
								</span>
							</TableCell>
							<TableCell className="fd-num text-end font-mono text-xs">
								{row.count.removed === null ? <span className="text-text-3">-</span> : MsgFmt.formatNumber(row.count.removed)}
							</TableCell>
						</TableRow>
					)
				})}
			</TableBody>
		</Table>
	)
}

function AppliedAsBadge(props: { appliedAs: LayerTablePrt.Sel.FilterSummaryRow['appliedAs'] }) {
	switch (props.appliedAs) {
		case 'regular':
			return <span className="fd-badge fd-badge-pri">{tr.text(L_Msgs.filterAppliedRegular())}</span>
		case 'inverted':
			return <span className="fd-badge">{tr.text(L_Msgs.filterAppliedInverted())}</span>
		case 'indicator':
			return <span className="fd-badge fd-badge-info">{tr.text(L_Msgs.filterAppliedIndicator())}</span>
		case 'off':
			return <span className="fd-badge fd-badge-line">{tr.text(L_Msgs.filterAppliedOff())}</span>
		default:
			assertNever(props.appliedAs)
	}
}

function HeaderHint(props: { label: string; title: string; children: React.ReactNode }) {
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<button type="button" aria-label={props.label} className="text-text-2 hover:text-text">
					<Icons.CircleHelp className="size-3.5" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex max-w-80 flex-col gap-1.5 py-1 font-normal normal-case tracking-normal">
					<span className="font-semibold">{props.title}</span>
					{props.children}
				</div>
			</TooltipContent>
		</Tooltip>
	)
}

function AppliedAsHint() {
	const states = [
		[L_Msgs.filterAppliedRegular(), L_Msgs.appliedAsHintRegular()],
		[L_Msgs.filterAppliedInverted(), L_Msgs.appliedAsHintInverted()],
		[L_Msgs.filterAppliedIndicator(), L_Msgs.appliedAsHintIndicator()],
		[L_Msgs.filterAppliedOff(), L_Msgs.appliedAsHintOff()],
	] as const
	return (
		<HeaderHint label={tr.text(L_Msgs.appliedAsHintLabel())} title={tr.text(L_Msgs.summaryAppliedAsColumn())}>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
				{states.map(([name, meaning]) => (
					<React.Fragment key={tr.text(name)}>
						<dt className="font-semibold">{tr.text(name)}</dt>
						<dd className="text-text-2">{tr.text(meaning)}</dd>
					</React.Fragment>
				))}
			</dl>
		</HeaderHint>
	)
}

function RemovesHint() {
	return (
		<HeaderHint label={tr.text(L_Msgs.removesHintLabel())} title={tr.text(L_Msgs.summaryRemovesColumn())}>
			<p>{tr.text(L_Msgs.removesHintDefinition())}</p>
			<p className="text-text-2">{tr.text(L_Msgs.removesHintOverlap())}</p>
			<p className="text-text-2">{tr.text(L_Msgs.removesHintOrder())}</p>
		</HeaderHint>
	)
}
