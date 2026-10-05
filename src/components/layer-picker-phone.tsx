import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import {
	HeadlessDialogContent,
	HeadlessDialogDescription,
	HeadlessDialogHeader,
	HeadlessDialogTitle,
} from '@/components/ui/headless-dialog'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import type * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Zus from '@/lib/zustand'
import * as MsgFmt from '@/messages/format'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as L from '@/models/layer'
import { tr } from '@/systems/messages.client'

import PhoneFiltersTab from './layer-picker-phone-filters.tsx'
import PhoneResultsTab, { type ResultsView } from './layer-picker-phone-results.tsx'

type Tab = 'filters' | 'results' | 'summary'

// The layer picker on a phone, as tabs along the bottom: Filters, Results, and Summary where the dialog submits.
// It opens on Results. The tab bar steps aside while the search or Advanced search is open, since the on-screen
// keyboard covers it.
export default function LayerPickerPhone(props: {
	frameKey: SelectLayersFrame.Key
	squadServer?: SquadServerFrame.Key
	title: string
	description?: React.ReactNode
	tourPrefix: string
	// the Summary tab: how the selection is added, and the one submit button. Without it the footer is pinned under the results
	summary?: { content: React.ReactNode; submit: React.ReactNode }
	footer?: React.ReactNode
	onClose: () => void
}) {
	const { frameKey } = props
	const [tab, setTab] = React.useState<Tab>('results')
	const [view, setView] = React.useState<ResultsView>('list')
	const selectedCount = Zus.useStore(frameKey, (s) => s.layerTable.selected.length)
	const total = Zus.useStore(frameKey, (s) => s.layerTable.pageData?.totalCount ?? null)
	const activeFilterCount = Zus.useStore(
		frameKey,
		(s) =>
			(s.appliedFilters.poolApplyAs !== 'disabled' ? 1 : 0) +
			Array.from(s.appliedFilters.filterStates.values()).filter((state) => state !== 'disabled').length,
	)

	const goTo = (next: Tab) => {
		setTab(next)
		setView('list')
	}

	const resultsFooter = props.summary
		? selectedCount > 0 && (
				<Button className="w-full" onClick={() => goTo('summary')}>
					{tr.text(L_Msgs.continueWithLayers(selectedCount))}
					<Icons.ChevronRight className="rtl:-scale-x-100" />
				</Button>
			)
		: props.footer

	const tabs: { value: Tab; icon: React.ComponentType<{ className?: string }>; label: string; badge?: number | null; strong?: boolean }[] =
		[
			{ value: 'filters', icon: Icons.Filter, label: tr.text(L_Msgs.phoneTabFilters()), badge: activeFilterCount || null },
			{ value: 'results', icon: Icons.List, label: tr.text(L_Msgs.phoneTabResults()), badge: total, strong: true },
		]
	if (props.summary) {
		tabs.push({
			value: 'summary',
			icon: Icons.ListChecks,
			label: tr.text(L_Msgs.phoneTabSummary()),
			badge: selectedCount || null,
			strong: true,
		})
	}

	return (
		<HeadlessDialogContent data-tour={`${props.tourPrefix}-dialog`} className="gap-0 p-0 overflow-hidden" showCloseButton={false}>
			<HeadlessDialogHeader className="m-0 flex-nowrap items-center pe-1 gap-2">
				<HeadlessDialogTitle className="min-w-0 shrink-0 truncate max-w-full">
					<span title={props.title}>{props.title}</span>
				</HeadlessDialogTitle>
				{props.description && (
					<HeadlessDialogDescription className="basis-auto truncate">· {props.description}</HeadlessDialogDescription>
				)}
				<span className="flex-1" />
				<Button variant="ghost" size="icon" onClick={props.onClose} aria-label={tr.text(UI_Msgs.close())}>
					<Icons.X />
				</Button>
			</HeadlessDialogHeader>
			<div className="flex min-h-0 flex-1 flex-col">
				{tab === 'filters' && (
					<PhoneFiltersTab frameKey={frameKey} squadServer={props.squadServer} onShowResults={() => goTo('results')} />
				)}
				{tab === 'results' && (
					<PhoneResultsTab frameKey={frameKey} squadServer={props.squadServer} view={view} setView={setView} footer={resultsFooter} />
				)}
				{tab === 'summary' && props.summary && (
					<SummaryTab frameKey={frameKey} summary={props.summary} onShowResults={() => goTo('results')} />
				)}
			</div>
			{(tab !== 'results' || view === 'list') && (
				<nav
					aria-label={props.title}
					className="grid shrink-0 grid-flow-col auto-cols-fr min-h-(--tabbar-h) bg-panel-hi border-t border-line shadow-[inset_0_1px_0_var(--line-soft)] pb-[env(safe-area-inset-bottom)] box-content"
				>
					{tabs.map((t) => (
						<button
							key={t.value}
							type="button"
							aria-pressed={tab === t.value}
							data-state={tab === t.value ? 'active' : 'inactive'}
							onClick={() => goTo(t.value)}
							className="relative flex min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-2xs font-semibold text-text-3 data-[state=active]:text-pri-hi data-[state=active]:shadow-[inset_0_2px_0_var(--pri)]"
						>
							<t.icon className="size-6 shrink-0" />
							{t.badge !== undefined && t.badge !== null && (
								<span
									className={
										t.strong
											? 'absolute top-1.5 inset-s-[calc(50%+6px)] grid min-w-5 h-4.5 place-items-center rounded-full bg-pri px-1 font-mono text-2xs text-pri-text'
											: 'absolute top-1.5 inset-s-[calc(50%+6px)] grid min-w-5 h-4.5 place-items-center rounded-full bg-ctl-hi px-1 font-mono text-2xs text-text'
									}
								>
									{MsgFmt.formatNumberCompact(t.badge)}
								</span>
							)}
							<span className="line-clamp-2 max-w-full text-center leading-tight break-words">{t.label}</span>
						</button>
					))}
				</nav>
			)}
		</HeadlessDialogContent>
	)
}

function SummaryTab(props: {
	frameKey: SelectLayersFrame.Key
	summary: { content: React.ReactNode; submit: React.ReactNode }
	onShowResults: () => void
}) {
	const selected = Zus.useStore(props.frameKey, (s) => s.layerTable.selected)
	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
				<section className="flex flex-col gap-2">
					<div className="flex items-baseline gap-2">
						<h3 className="fd-lbl-k flex-1">{tr.text(L_Msgs.selectedLayers())}</h3>
						{selected.length > 0 && <span className="text-sm text-text-2">{tr.text(L_Msgs.selectedCount(selected.length))}</span>}
					</div>
					{selected.length === 0 ? (
						<div className="fd-panel flex flex-col items-start gap-2.5 p-3">
							<span className="text-sm text-text-2">{tr.text(L_Msgs.noLayersSelected())}</span>
							<Button onClick={props.onShowResults}>{tr.text(L_Msgs.goToResults())}</Button>
						</div>
					) : (
						<ol className="flex flex-col gap-1.5">
							{selected.map((layerId) => (
								<SelectedLayerRow key={layerId} frameKey={props.frameKey} layerId={layerId} />
							))}
						</ol>
					)}
				</section>
				{props.summary.content}
			</div>
			<div className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-panel p-3 shadow-[inset_0_1px_0_var(--line-soft)]">
				{props.summary.submit}
			</div>
		</>
	)
}

function SelectedLayerRow(props: { frameKey: SelectLayersFrame.Key; layerId: L.LayerId }) {
	const layer = L.toLayer(props.layerId)
	const name = [layer.Map, layer.Gamemode, layer.LayerVersion].filter(Boolean).join(' ')
	return (
		<li className="fd-panel flex min-h-14 items-center gap-2.5 py-1.5 ps-3 pe-1">
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-semibold">{name}</span>
				<span className="flex flex-wrap gap-x-1.5 text-sm">
					<span className="text-team1">{[layer.Faction_1, layer.Unit_1].filter(Boolean).join(' ')}</span>
					<span className="text-text-3">{tr.text(L_Msgs.versus())}</span>
					<span className="text-team2">{[layer.Faction_2, layer.Unit_2].filter(Boolean).join(' ')}</span>
				</span>
			</span>
			<Button
				variant="ghost"
				size="icon"
				aria-label={tr.text(L_Msgs.removeSelectedLayer(name))}
				onClick={() =>
					LayerTablePrt.Actions.setSelected({ layerTable: props.frameKey }, (ids) => ids.filter((id) => id !== props.layerId))
				}
			>
				<Icons.X />
			</Button>
		</li>
	)
}
