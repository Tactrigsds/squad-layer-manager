import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
	HeadlessDialogContent,
	HeadlessDialogDescription,
	HeadlessDialogHeader,
	HeadlessDialogTitle,
} from '@/components/ui/headless-dialog'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Browser from '@/lib/browser'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as F from '@/models/filter.models'
import { tr } from '@/systems/messages.client'

import AppliedFiltersPanel from './applied-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerTable from './layer-table.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'

const RAIL_WIDTH_PX = 318
const MIN_DIALOG_WIDTH_PX = 1090

type LayerPickerLayoutProps = {
	frameKey: SelectLayersFrame.Key
	squadServer?: SquadServerFrame.Key
	title: string
	description?: React.ReactNode
	// data-tour anchors are `${tourPrefix}-dialog`, `${tourPrefix}-pick` and `${tourPrefix}-filters`
	tourPrefix: string
	canToggleColumns: boolean
	// the submission controls, at the foot of the rail, or pinned to the bottom on a phone
	footer: React.ReactNode
	onClose: () => void
}

/**
 * The layer picker's dialog body. Constraints sit in a rail to the right of the table with the footer at its foot;
 * the applied filters get a row under the title bar. On a phone the rail becomes a Filters button that opens the
 * constraints as a full-screen sheet, and the footer pins to the bottom.
 */
export default function LayerPickerLayout(props: LayerPickerLayoutProps) {
	const { frameKey } = props
	const phone = Browser.useIsSmallViewport()
	const showPoolCheckboxes = Zus.useStore(frameKey, SelectLayersFrame.Sel.repeatRulesApplicable)
	const constraintCount = Zus.useStore(
		frameKey,
		(s) => Object.values(s.filterMenu.menuItems).filter((c) => F.editableCompHasValue(c)).length,
	)
	const fullTableWidth = Zus.useStore(frameKey, LayerTablePrt.Sel.fullTableWidth)
	const [filtersOpen, setFiltersOpen] = React.useState(false)
	// built apart from the rail, so a new footer re-renders only the footer and not every filter menu item
	const filterMenu = <LayerFilterMenu stores={{ filterMenu: frameKey }} />
	const layerTable = (
		<LayerTable
			extraPanelItems={showPoolCheckboxes ? <PoolCheckboxes stores={{ poolCheckboxes: frameKey }} /> : undefined}
			stores={{ layerTable: frameKey }}
			canChangeRowsPerPage={false}
			canToggleColumns={props.canToggleColumns}
			enableForceSelect
			compact={phone}
			autoCompact
		/>
	)

	return (
		<HeadlessDialogContent
			data-tour={`${props.tourPrefix}-dialog`}
			className={cn('gap-0 p-0 overflow-hidden', !phone && 'max-h-[95vh] max-w-[95vw]')}
			// wide enough for every visible column, so the table only compacts when the viewport can't fit the dialog. The
			// 7.5 spacing units are the body's p-2.5 on both sides and its gap-2.5, the 2px the dialog's border
			style={
				phone
					? undefined
					: { width: `max(${MIN_DIALOG_WIDTH_PX}px, calc(${fullTableWidth + RAIL_WIDTH_PX + 2}px + var(--spacing) * 7.5))` }
			}
			showCloseButton={false}
		>
			<HeadlessDialogHeader className="m-0 flex-nowrap items-center pe-2 gap-2">
				<HeadlessDialogTitle className="min-w-0 shrink-0 truncate max-w-full">
					<span title={props.title}>{props.title}</span>
				</HeadlessDialogTitle>
				{props.description && (
					<HeadlessDialogDescription className="basis-auto truncate">· {props.description}</HeadlessDialogDescription>
				)}
				<span className="flex-1" />
				<Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label={tr.text(UI_Msgs.close())}>
					<Icons.X />
				</Button>
			</HeadlessDialogHeader>
			<div className="flex items-center gap-2 min-h-[calc(var(--ctl)+6px)] px-2.5 border-b border-line shadow-[inset_0_1px_0_var(--line-soft)] overflow-x-auto">
				<AppliedFiltersPanel stores={{ appliedFilters: frameKey, squadServer: props.squadServer }} />
			</div>
			<div className={cn('flex min-h-0 flex-1 gap-2.5 p-2.5', phone ? 'flex-col overflow-hidden' : 'overflow-auto')}>
				<div
					data-tour={`${props.tourPrefix}-pick`}
					className={cn('flex min-w-0 flex-col', phone ? 'flex-1 min-h-0 overflow-auto' : 'flex-1')}
				>
					{phone && (
						<div className="mb-1.5 flex items-center gap-2 overflow-x-auto">
							<Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
								<Button className="h-[34px] shrink-0 px-3" onClick={() => setFiltersOpen(true)}>
									<Icons.Filter />
									{tr.text(F_Msgs.filtersButton())}
									{constraintCount > 0 && <span className="fd-chip">{constraintCount}</span>}
								</Button>
								<DialogContent>
									<DialogHeader>
										<DialogTitle>{tr.text(F_Msgs.filtersButton())}</DialogTitle>
									</DialogHeader>
									<div className="flex-1 min-h-0 overflow-auto">{filterMenu}</div>
									<DialogFooter>
										<Button variant="primary" size="sm" onClick={() => setFiltersOpen(false)}>
											{tr.text(UI_Msgs.done())}
										</Button>
									</DialogFooter>
								</DialogContent>
							</Dialog>
						</div>
					)}
					{layerTable}
				</div>
				{!phone && (
					<div
						data-tour={`${props.tourPrefix}-filters`}
						className="flex shrink-0 flex-col gap-2.5 border-s border-line ps-2.5 shadow-[-1px_0_0_var(--line-soft)] rtl:shadow-[1px_0_0_var(--line-soft)]"
						style={{ width: RAIL_WIDTH_PX }}
					>
						<div className="flex flex-col gap-1">
							<span className="fd-lbl-k">{tr.text(F_Msgs.constraints())}</span>
							{filterMenu}
						</div>
						<div className="flex-1" />
						<div className="flex flex-col gap-1.5 border-t border-line pt-2 shadow-[inset_0_1px_0_var(--line-soft)]">
							{props.footer}
						</div>
					</div>
				)}
				{phone && (
					<div className="flex shrink-0 flex-col gap-1.5 border-t border-line pt-2 shadow-[inset_0_1px_0_var(--line-soft)]">
						{props.footer}
					</div>
				)}
			</div>
		</HeadlessDialogContent>
	)
}
