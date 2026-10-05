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
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Browser from '@/lib/browser'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

import AppliedFiltersPanel from './applied-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerPickerPhone from './layer-picker-phone.tsx'
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
	// the submission controls, at the foot of the rail, or pinned under the results on a phone
	footer: React.ReactNode
	// on a phone, a Summary tab in place of the footer: how the selection is added, and the submit button
	phoneSummary?: { content: React.ReactNode; submit: React.ReactNode }
	onClose: () => void
}

/**
 * The layer picker's dialog body. Constraints sit in a rail to the right of the table with the footer at its foot;
 * the applied filters get a row under the title bar. A phone gets LayerPickerPhone instead.
 */
export default function LayerPickerLayout(props: LayerPickerLayoutProps) {
	const phone = Browser.useIsSmallViewport()
	if (phone) {
		return (
			<LayerPickerPhone
				frameKey={props.frameKey}
				squadServer={props.squadServer}
				title={props.title}
				description={props.description}
				tourPrefix={props.tourPrefix}
				summary={props.phoneSummary}
				footer={props.footer}
				onClose={props.onClose}
			/>
		)
	}
	return <LayerPickerDesktop {...props} />
}

function LayerPickerDesktop(props: LayerPickerLayoutProps) {
	const { frameKey } = props
	const showPoolCheckboxes = Zus.useStore(frameKey, SelectLayersFrame.Sel.repeatRulesApplicable)
	const fullTableWidth = Zus.useStore(frameKey, LayerTablePrt.Sel.fullTableWidth)
	// built apart from the rail, so a new footer re-renders only the footer and not every filter menu item
	const filterMenu = <LayerFilterMenu stores={{ filterMenu: frameKey }} />

	return (
		<HeadlessDialogContent
			data-tour={`${props.tourPrefix}-dialog`}
			className="gap-0 p-0 overflow-hidden max-h-[95vh] max-w-[95vw]"
			// wide enough for every visible column, so the table only compacts when the viewport can't fit the dialog. The
			// 7.5 spacing units are the body's p-2.5 on both sides and its gap-2.5, the 2px the dialog's border
			style={{ width: `max(${MIN_DIALOG_WIDTH_PX}px, calc(${fullTableWidth + RAIL_WIDTH_PX + 2}px + var(--spacing) * 7.5))` }}
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
			<div className="flex min-h-0 flex-1 gap-2.5 p-2.5 overflow-auto">
				<div data-tour={`${props.tourPrefix}-pick`} className="flex min-w-0 flex-1 flex-col">
					<LayerTable
						extraPanelItems={showPoolCheckboxes ? <PoolCheckboxes stores={{ poolCheckboxes: frameKey }} /> : undefined}
						stores={{ layerTable: frameKey }}
						canChangeRowsPerPage={false}
						canToggleColumns={props.canToggleColumns}
						enableForceSelect
						autoCompact
					/>
				</div>
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
					<div className="flex flex-col gap-1.5 border-t border-line pt-2 shadow-[inset_0_1px_0_var(--line-soft)]">{props.footer}</div>
				</div>
			</div>
		</HeadlessDialogContent>
	)
}
