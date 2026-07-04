import { Button } from '@/components/ui/button'
import { HeadlessDialog, HeadlessDialogContent, HeadlessDialogDescription, HeadlessDialogFooter, HeadlessDialogHeader, HeadlessDialogTitle } from '@/components/ui/headless-dialog'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { useFrameLifecycle } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as Obj from '@/lib/object'
import { useRefConstructor } from '@/lib/react.ts'
import * as ZusUtils from '@/lib/zustand'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'

import { useLoggedInUser } from '@/systems/users.client'
import React from 'react'
import AppliedFiltersPanel from './applied-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerTable, { getFullTableWidth } from './layer-table.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import TabsList from './ui/tabs-list.tsx'

type SelectMode = 'vote' | 'layers'

// horizontal space the dialog consumes around the filter menu + table: outer wrapper p-4 (32) +
// panel p-6 (48) + space-x-2 gap (8)
const DIALOG_HORIZONTAL_CHROME_PX = 175

type SelectLayersDialogProps = {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	selectQueueItems?: (queueItems: LL.NewItem[]) => void
	defaultSelected?: L.LayerId[]
	stores?: Partial<SelectLayersFrame.KeyProp>
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	footerAdditions?: React.ReactNode
	children?: React.ReactNode
	cursor?: LL.Cursor
}

type SelectLayersDialogContentProps = {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	selectQueueItems?: (queueItems: LL.NewItem[]) => void
	defaultSelected: L.LayerId[]
	stores?: Partial<SelectLayersFrame.KeyProp>
	footerAdditions?: React.ReactNode
	cursor?: LL.Cursor
	onClose: () => void
}

const SelectLayersDialogContent = React.memo<SelectLayersDialogContentProps>(function SelectLayersDialogContent(props) {
	const frameInputRef = useRefConstructor(() => {
		if (props.stores?.selectLayers) return undefined
		SelectLayersFrame.createInput({ cursor: props.cursor })
	})
	const frameKey = useFrameLifecycle(SelectLayersFrame.frame, {
		frameKey: props.stores?.selectLayers,
		input: frameInputRef.current,
		equalityFn: Obj.deepEqual,
	})

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

	// collapse the table to its essential columns when the full set can't fit in the viewport.
	// the breakpoint is derived from the table's own column sizes rather than hardcoded
	const fullTableWidth = ZusUtils.useStore(frameKey, (s) => getFullTableWidth(s.layerTable.colConfig, s.layerTable.columnVisibility))
	const filterMenuRef = React.useRef<HTMLDivElement>(null)
	const [compactTable, setCompactTable] = React.useState(false)
	React.useLayoutEffect(() => {
		const check = () => {
			const filterMenuWidth = filterMenuRef.current?.offsetWidth ?? 0
			setCompactTable(window.innerWidth < fullTableWidth + filterMenuWidth + DIALOG_HORIZONTAL_CHROME_PX)
		}
		check()
		window.addEventListener('resize', check)
		const observer = new ResizeObserver(check)
		if (filterMenuRef.current) observer.observe(filterMenuRef.current)
		return () => {
			window.removeEventListener('resize', check)
			observer.disconnect()
		}
	}, [fullTableWidth])

	const canSubmit = ZusUtils.useStore(frameKey, (s) => s.layerTable.selected.length > 0 && !submitted)

	const submit = props.selectQueueItems
		? () => {
			if (!canSubmit) return
			setSubmitted(true)
			const selectedLayers = ZusUtils.getState(frameKey).layerTable.selected
			try {
				const source: LL.Source = { type: 'manual', userId: user!.discordId }
				if (selectMode === 'layers' || selectedLayers.length === 1) {
					const items: LL.NewSingleItem[] = selectedLayers.map(
						(layerId) => ({ type: 'single-list-item', layerId }),
					)
					;(props.selectQueueItems!)(items)
				} else if (selectMode === 'vote') {
					const item: LL.NewVoteItem = {
						type: 'vote-list-item',
						layerId: selectedLayers[0],
						choices: selectedLayers.map(layerId => LL.createItem({ type: 'single-list-item', layerId }, source)),
					}
					;(props.selectQueueItems!)([item])
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
	return (
		<HeadlessDialogContent className="max-h-[95vh] w-max max-w-[95vw] flex flex-col overflow-auto">
			<HeadlessDialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<HeadlessDialogTitle>{props.title}</HeadlessDialogTitle>
					{props.description && <HeadlessDialogDescription>{props.description}</HeadlessDialogDescription>}
				</div>
				<div className="flex justify-end items-center space-x-2">
					{
						/* FIXME stage4: AppliedFiltersPanel's stores type also requires a squadServer key (see applied-filters-panel.tsx),
					   which isn't available in this select-layers-only context. Left as-is (pre-existing before this migration pass). */
					}
					<AppliedFiltersPanel stores={{ appliedFilters: frameKey }} />
				</div>
			</HeadlessDialogHeader>

			<div className="flex shrink-0 items-start space-x-2 ">
				<div ref={filterMenuRef} className="shrink-0">
					<LayerFilterMenu stores={{ filterMenu: frameKey }} />
				</div>
				<div className="flex flex-col space-y-2 justify-between h-full">
					<div className="flex h-full">
						<LayerTable
							extraPanelItems={<PoolCheckboxes stores={{ poolCheckboxes: frameKey }} />}
							stores={{ layerTable: frameKey }}
							canChangeRowsPerPage={false}
							canToggleColumns
							enableForceSelect
							compact={compactTable}
						/>
					</div>
				</div>
			</div>

			<HeadlessDialogFooter className="shrink-0">
				<div className="flex items-center justify-end w-full space-x-2">
					{props.footerAdditions}
					{!props.pinMode && (
						<TabsList
							options={[
								{ label: 'Vote', value: 'vote' },
								{ label: 'Set Layer', value: 'layers' },
							]}
							active={selectMode}
							setActive={setAdditionType}
						/>
					)}
					{submit
						&& (
							<Button disabled={!canSubmit} onClick={submit}>
								Submit
							</Button>
						)}
				</div>
			</HeadlessDialogFooter>
		</HeadlessDialogContent>
	)
})

export default function SelectLayersDialog(props: SelectLayersDialogProps) {
	const defaultSelected: L.LayerId[] = React.useMemo(() => props.defaultSelected ?? [], [props.defaultSelected])

	const onOpenChange = props.onOpenChange
	const onClose = React.useCallback(() => {
		if (!onOpenChange) return
		onOpenChange(false)
	}, [onOpenChange])

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
				cursor={props.cursor}
				onClose={onClose}
			/>
		</HeadlessDialog>
	)
}
