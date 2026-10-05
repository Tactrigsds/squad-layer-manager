import * as Icons from 'lucide-react'
import React from 'react'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi.tsx'
import { Button } from '@/components/ui/button'
import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial.ts'
import * as LayerSearchPrt from '@/frame-partials/layer-search.partial.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as MsgFmt from '@/messages/format'
import * as L_Msgs from '@/messages/layer.messages'
import type * as F from '@/models/filter.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

import EmojiDisplay from './emoji-display.tsx'
import { FilterEntityLabel } from './filter-entity-select.tsx'

type ApplyAs = AppliedFiltersPrt.ApplyAs

// The picker's Filters tab on a phone: the server's default filters and the user's extra filters, each a card with
// an explicit Off / Match / Exclude control in place of the tri-state checkbox the desktop rail cycles through.
export default function PhoneFiltersTab(props: {
	frameKey: SelectLayersFrame.Key
	squadServer?: SquadServerFrame.Key
	onShowResults: () => void
}) {
	const { frameKey } = props
	const stores = { appliedFilters: frameKey, squadServer: props.squadServer }
	const squadServer = props.squadServer ?? null

	React.useEffect(() => SelectLayersFrame.Actions.watchFiltersOnlyCount({ selectLayers: frameKey }), [frameKey])

	const poolFilter = Zus.useStore(squadServer, AppliedFiltersPrt.Sel.poolFilter)
	const poolApplyAs = Zus.useStore(frameKey, (s) => s.appliedFilters.poolApplyAs)
	const selectableFilterIds = Zus.useStore(squadServer, AppliedFiltersPrt.Sel.selectableFilterIds)
	const extraFilterIds = Zus.useStore(frameKey, squadServer, AppliedFiltersPrt.ExtraFiltersStore, AppliedFiltersPrt.Sel.extraFilterIds)
	const addableFilters = Zus.useStore(squadServer, FilterEntityClient.filterEntities$, AppliedFiltersPrt.Sel.addableFilters)
	const filterStates = Zus.useStore(frameKey, (s) => s.appliedFilters.filterStates)

	const addOptions = addableFilters.map((filter) => ({ value: filter.id, label: <FilterEntityLabel filter={filter} /> }))

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<FiltersOnlyCountBanner frameKey={frameKey} onShowResults={props.onShowResults} />
			<div className="flex flex-col gap-2.5 p-3">
				<SectionHeading>{tr.text(L_Msgs.defaultFilters())}</SectionHeading>
				{poolFilter && (
					<FilterCard
						filterId={poolFilter.filterId}
						applyAs={poolApplyAs}
						pinned
						onChange={(applyAs) => AppliedFiltersPrt.Actions.setPoolApplyAs(stores, applyAs)}
					/>
				)}
				{selectableFilterIds.map((filterId) => (
					<FilterCard
						key={filterId}
						filterId={filterId}
						applyAs={filterStates.get(filterId) ?? 'disabled'}
						onChange={(applyAs) => AppliedFiltersPrt.Actions.setAppliedFilterState(stores, filterId, applyAs)}
					/>
				))}

				<SectionHeading>{tr.text(L_Msgs.extraFilters())}</SectionHeading>
				{extraFilterIds.length === 0 && <p className="text-sm text-text-2">{tr.text(L_Msgs.extraFiltersHint())}</p>}
				{extraFilterIds.map((filterId) => (
					<FilterCard
						key={filterId}
						filterId={filterId}
						applyAs={filterStates.get(filterId) ?? 'disabled'}
						onChange={(applyAs) => AppliedFiltersPrt.Actions.setAppliedFilterState(stores, filterId, applyAs)}
						onRemove={() => AppliedFiltersPrt.Actions.selectExtraFilters(stores, (ids) => ids.filter((id) => id !== filterId))}
					/>
				))}
				<ComboBoxMulti
					title={tr.text(L_Msgs.extraFilterNoun())}
					ariaLabel={tr.text(L_Msgs.extraFilters())}
					options={addOptions}
					values={extraFilterIds}
					onSelect={(update) => AppliedFiltersPrt.Actions.selectExtraFilters(stores, update)}
				>
					<Button className="self-start">
						<Icons.Plus />
						{tr.text(F_Msgs.addExtraFilters())}
					</Button>
				</ComboBoxMulti>
				<Button variant="ghost" className="self-start" onClick={() => AppliedFiltersPrt.Actions.disableAllAppliedFilters(stores)}>
					<Icons.Trash2 />
					{tr.text(F_Msgs.disableAllFilters())}
				</Button>
			</div>
		</div>
	)
}

function SectionHeading(props: { children: React.ReactNode }) {
	return <h3 className="fd-lbl-k mt-1.5">{props.children}</h3>
}

function FiltersOnlyCountBanner(props: { frameKey: SelectLayersFrame.Key; onShowResults: () => void }) {
	const filtersOnlyCount = Zus.useStore(props.frameKey, (s) => s.filtersOnlyCount.value)
	const searchCount = Zus.useStore(props.frameKey, (s) => s.layerTable.pageData?.totalCount ?? null)
	const searching = Zus.useStore(props.frameKey, (s) => LayerSearchPrt.Sel.parts(s).some((part) => part.type !== 'error'))
	return (
		<div
			role="status"
			className="sticky top-0 z-1 flex items-center gap-3 border-b border-line bg-panel-hi px-3 py-2.5 shadow-[0_4px_10px_rgba(0,0,0,0.35)]"
		>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-text-2 [&_strong]:font-mono [&_strong]:text-2xl [&_strong]:font-bold [&_strong]:text-pri-hi">
					{filtersOnlyCount === null ? (
						<span className="fd-spin" />
					) : (
						tr.richText(L_Msgs.filtersOnlyCount(MsgFmt.formatNumber(filtersOnlyCount)))
					)}
				</span>
				{searching && searchCount !== null && (
					<span className="text-xs text-text-2">{tr.text(L_Msgs.searchNotCounted(searchCount))}</span>
				)}
			</div>
			<Button className="shrink-0" onClick={props.onShowResults}>
				{tr.text(L_Msgs.phoneTabResults())}
				<Icons.ChevronRight className="rtl:-scale-x-100" />
			</Button>
		</div>
	)
}

const APPLY_OPTIONS: { value: ApplyAs; label: () => string; icon?: React.ComponentType<{ className?: string }>; on: string }[] = [
	{ value: 'disabled', label: () => tr.text(L_Msgs.filterOff()), on: 'data-[state=on]:text-text' },
	{
		value: 'regular',
		label: () => tr.text(L_Msgs.filterMatch()),
		icon: Icons.Check,
		on: 'data-[state=on]:bg-ok/20 data-[state=on]:text-ok',
	},
	{
		value: 'inverted',
		label: () => tr.text(L_Msgs.filterExclude()),
		icon: Icons.Ban,
		on: 'data-[state=on]:bg-danger/20 data-[state=on]:text-danger',
	},
]

function FilterCard(props: {
	filterId: F.FilterEntityId
	applyAs: ApplyAs
	pinned?: boolean
	onChange: (applyAs: ApplyAs) => void
	onRemove?: () => void
}) {
	const filter = FilterEntityClient.useFilterEntities().get(props.filterId)
	if (!filter) return null
	const emoji = props.applyAs === 'inverted' ? (filter.invertedEmoji ?? filter.emoji) : filter.emoji
	return (
		<div className="fd-panel flex flex-col gap-2 p-2.5">
			<div className="flex min-h-7 flex-wrap items-center gap-2">
				{emoji && <EmojiDisplay size="sm" emoji={emoji} showTooltip={false} />}
				<span className="min-w-0 flex-1 font-semibold">{filter.name}</span>
				{props.pinned && <span className="fd-chip">{tr.text(L_Msgs.pinnedFilter())}</span>}
				{props.onRemove && (
					<Button variant="ghost" size="icon-sm" onClick={props.onRemove} aria-label={tr.text(F_Msgs.clearFilter(filter.name))}>
						<Icons.X />
					</Button>
				)}
			</div>
			<div role="group" aria-label={filter.name} className="fd-grp w-full">
				{APPLY_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={props.applyAs === option.value}
						data-state={props.applyAs === option.value ? 'on' : 'off'}
						onClick={() => props.onChange(option.value)}
						className={cn('fd-btn flex-1 font-medium', option.on)}
					>
						{option.icon && <option.icon />}
						{option.label()}
					</button>
				))}
			</div>
		</div>
	)
}
