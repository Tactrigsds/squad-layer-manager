import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
	HeadlessDialog,
	HeadlessDialogContent,
	HeadlessDialogDescription,
	HeadlessDialogHeader,
	HeadlessDialogTitle,
} from '@/components/ui/headless-dialog'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Browser from '@/lib/browser'
import * as Obj from '@/lib/object-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'
import { tr } from '@/systems/messages.client'
import { useLoggedInUser } from '@/systems/users.client'

import AppliedFiltersPanel from './applied-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerTable from './layer-table.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import TabsList from './ui/tabs-list.tsx'

type SelectMode = 'vote' | 'layers'

// horizontal space the dialog consumes around the table: the constraint rail, its gap and border, and the
// dialog's own padding
const RAIL_WIDTH_PX = 318
const DIALOG_HORIZONTAL_CHROME_PX = RAIL_WIDTH_PX + 60

type SelectLayersDialogProps = {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	selectQueueItems?: (queueItems: LL.NewItem[]) => void
	defaultSelected?: L.LayerId[]
	stores?: Partial<SelectLayersFrame.KeyProp & SquadServerFrame.KeyProp>
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	// rendered in the title bar, e.g. the play next / play after switch
	footerAdditions?: React.ReactNode
	// rendered in the submit block above the mode switch and Submit, e.g. the tags to apply
	footerBeforeSubmit?: React.ReactNode
	cursor?: LL.Cursor
}

type SelectLayersDialogContentProps = {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	selectQueueItems?: (queueItems: LL.NewItem[]) => void
	defaultSelected: L.LayerId[]
	stores?: Partial<SelectLayersFrame.KeyProp & SquadServerFrame.KeyProp>
	footerAdditions?: React.ReactNode
	footerBeforeSubmit?: React.ReactNode
	cursor?: LL.Cursor
	onClose: () => void
}

/**
 * The layer picker. Constraints sit in a rail to the right of the table with the submission controls at its foot;
 * the applied filters get a row under the title bar. On a phone the rail becomes a Filters button that opens the
 * constraints as a full-screen sheet, and the submit block pins to the bottom.
 */
const SelectLayersDialogContent = React.memo<SelectLayersDialogContentProps>(function SelectLayersDialogContent(props) {
	const [frameInput] = React.useState(() => {
		if (props.stores?.selectLayers) return undefined
		return SelectLayersFrame.createInput({ cursor: props.cursor })
	})
	const frameKey = useFrameLifecycle(SelectLayersFrame.frame, {
		frameKey: props.stores?.selectLayers,
		input: frameInput,
		equalityFn: Obj.deepEqual,
	})
	// a frame this dialog provisioned itself dies with it; one handed in via stores belongs to its provider
	useFrameTeardownOnUnmount(frameKey, !props.stores?.selectLayers)

	const [selectMode, _setSelectMode] = React.useState<SelectMode>(props.pinMode ?? 'layers')
	const setSelectedLayers = React.useCallback(
		(update: React.SetStateAction<L.LayerId[]>) => LayerTablePrt.Actions.setSelected({ layerTable: frameKey }, update),
		[frameKey],
	)

	function setAdditionType(newAdditionType: SelectMode) {
		if (newAdditionType === 'vote') {
			setSelectedLayers((prev) => {
				const seenIds = new Set<string>()
				return prev.filter((layerId) => {
					if (seenIds.has(layerId)) {
						return false
					}
					seenIds.add(layerId)
					return true
				})
			})
		}
		_setSelectMode(newAdditionType)
	}

	const user = useLoggedInUser()
	const [submitted, setSubmitted] = React.useState(false)
	const phone = Browser.useIsSmallViewport()

	// collapse the table to its essential columns when the full set can't fit in the viewport.
	// the breakpoint is derived from the table's own column sizes rather than hardcoded
	const fullTableWidth = Zus.useStore(frameKey, (s) =>
		LayerTablePrt.getFullTableWidth(s.layerTable.colConfig, s.layerTable.columnVisibility),
	)
	const [compactTable, setCompactTable] = React.useState(false)
	React.useLayoutEffect(() => {
		const check = () => setCompactTable(window.innerWidth < fullTableWidth + DIALOG_HORIZONTAL_CHROME_PX)
		check()
		window.addEventListener('resize', check)
		return () => window.removeEventListener('resize', check)
	}, [fullTableWidth])

	const canSubmit = Zus.useStore(frameKey, (s) => s.layerTable.selected.length > 0 && !submitted)
	const selectedCount = Zus.useStore(frameKey, (s) => s.layerTable.selected.length)
	const showPoolCheckboxes = Zus.useStore(frameKey, SelectLayersFrame.Sel.repeatRulesApplicable)
	const constraintCount = Zus.useStore(
		frameKey,
		(s) => Object.values(s.filterMenu.menuItems).filter((c) => F.editableCompHasValue(c)).length,
	)

	const submit = props.selectQueueItems
		? () => {
				if (!canSubmit) return
				setSubmitted(true)
				const selectedLayers = Zus.getState(frameKey).layerTable.selected
				try {
					const source: LL.Source = { type: 'manual', userId: user!.discordId }
					if (selectMode === 'layers' || selectedLayers.length === 1) {
						const items: LL.NewSingleItem[] = selectedLayers.map((layerId) => ({ type: 'single-list-item', layerId }))
						props.selectQueueItems!(items)
					} else if (selectMode === 'vote') {
						const item: LL.NewVoteItem = {
							type: 'vote-list-item',
							layerId: selectedLayers[0],
							choices: selectedLayers.map((layerId) => LL.createItem({ type: 'single-list-item', layerId }, source)),
						}
						props.selectQueueItems!([item])
					}
					props.onClose()
				} finally {
					setSubmitted(false)
				}
			}
		: undefined

	// Reset selected layers when component mounts or default selection changes
	React.useEffect(() => {
		setSelectedLayers(props.defaultSelected)
	}, [props.defaultSelected, setSelectedLayers])

	const modeSwitch = !props.pinMode && (
		<TabsList
			variant="seg"
			options={[
				{ label: tr.text(L_Msgs.voteMode()), value: 'vote' },
				{ label: tr.text(L_Msgs.setLayerMode()), value: 'layers' },
			]}
			active={selectMode}
			setActive={setAdditionType}
		/>
	)
	const submitButton = submit && (
		<Button data-tour="add-submit" variant="primary" size="sm" disabled={!canSubmit} onClick={submit} className={cn(phone && 'w-full')}>
			{phone && selectedCount > 0 ? tr.text(L_Msgs.submitCount(selectedCount)) : tr.text(L_Msgs.submit())}
		</Button>
	)

	const [filtersOpen, setFiltersOpen] = React.useState(false)

	return (
		<HeadlessDialogContent
			data-tour="add-dialog"
			className={cn('gap-0 p-0 overflow-hidden', !phone && 'max-h-[95vh] w-[1090px] max-w-[95vw]')}
			showCloseButton={false}
		>
			<HeadlessDialogHeader className="m-0 flex-nowrap items-center pr-2 gap-2">
				<HeadlessDialogTitle className="whitespace-nowrap">{props.title}</HeadlessDialogTitle>
				{props.description && (
					<HeadlessDialogDescription className="basis-auto truncate">· {props.description}</HeadlessDialogDescription>
				)}
				{props.footerAdditions}
				<span className="flex-1" />
				{!phone && <kbd className="fd-kbd">Esc</kbd>}
				<Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label={tr.text(UI_Msgs.close())}>
					<Icons.X />
				</Button>
			</HeadlessDialogHeader>
			<div className="flex items-center gap-2 min-h-[calc(var(--ctl)+6px)] px-2.5 border-b border-line shadow-[inset_0_1px_0_var(--line-soft)] overflow-x-auto">
				<AppliedFiltersPanel stores={{ appliedFilters: frameKey, squadServer: props.stores?.squadServer }} />
			</div>
			<div className={cn('flex min-h-0 flex-1 gap-2.5 p-2.5', phone ? 'flex-col overflow-hidden' : 'overflow-auto')}>
				<div data-tour="add-pick" className={cn('flex min-w-0 flex-col', phone ? 'flex-1 min-h-0 overflow-auto' : 'flex-1')}>
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
									<div className="flex-1 min-h-0 overflow-auto">
										<LayerFilterMenu stores={{ filterMenu: frameKey }} />
									</div>
									<DialogFooter>
										<Button variant="primary" size="sm" onClick={() => setFiltersOpen(false)}>
											{tr.text(UI_Msgs.done())}
										</Button>
									</DialogFooter>
								</DialogContent>
							</Dialog>
						</div>
					)}
					<LayerTable
						extraPanelItems={showPoolCheckboxes ? <PoolCheckboxes stores={{ poolCheckboxes: frameKey }} /> : undefined}
						stores={{ layerTable: frameKey }}
						canChangeRowsPerPage={false}
						canToggleColumns
						enableForceSelect
						compact={compactTable || phone}
					/>
				</div>
				{!phone && (
					<div
						data-tour="add-filters"
						className="flex shrink-0 flex-col gap-2.5 border-l border-line pl-2.5 shadow-[-1px_0_0_var(--line-soft)]"
						style={{ width: RAIL_WIDTH_PX }}
					>
						<div className="flex flex-col gap-1">
							<span className="fd-lbl-k">{tr.text(F_Msgs.constraints())}</span>
							<LayerFilterMenu stores={{ filterMenu: frameKey }} />
						</div>
						<div className="flex-1" />
						<div className="flex flex-col gap-1.5 border-t border-line pt-2 shadow-[inset_0_1px_0_var(--line-soft)]">
							{props.footerBeforeSubmit && (
								<div className="flex items-center gap-1 whitespace-nowrap">{props.footerBeforeSubmit}</div>
							)}
							<div className="flex items-center justify-between gap-2">
								{modeSwitch}
								{submitButton}
							</div>
						</div>
					</div>
				)}
				{phone && (
					<div className="flex shrink-0 flex-col gap-1.5 border-t border-line pt-2 shadow-[inset_0_1px_0_var(--line-soft)]">
						<div className="flex items-center gap-2">
							{props.footerBeforeSubmit}
							<span className="flex-1" />
							{modeSwitch}
						</div>
						{submitButton}
					</div>
				)}
			</div>
		</HeadlessDialogContent>
	)
})

export default function SelectLayersDialog(props: SelectLayersDialogProps) {
	const defaultSelected: L.LayerId[] = props.defaultSelected ?? []

	const onOpenChange = props.onOpenChange
	const onClose = () => {
		if (!onOpenChange) return
		onOpenChange(false)
	}

	return (
		<HeadlessDialog open={props.open} onOpenChange={onOpenChange} unmount={false}>
			<SelectLayersDialogContent
				title={props.title}
				description={props.description}
				pinMode={props.pinMode}
				selectQueueItems={props.selectQueueItems}
				defaultSelected={defaultSelected}
				stores={props.stores}
				footerAdditions={props.footerAdditions}
				footerBeforeSubmit={props.footerBeforeSubmit}
				cursor={props.cursor}
				onClose={onClose}
			/>
		</HeadlessDialog>
	)
}
