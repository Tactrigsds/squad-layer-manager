import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { getFrameState, useFrameLifecycle, useFrameStore } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as Obj from '@/lib/object'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import { useLoggedInUser } from '@/systems.client/users.client'
import React from 'react'
import AppliedFiltersPanel from './applied-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerTable from './layer-table.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import TabsList from './ui/tabs-list.tsx'

type SelectMode = 'vote' | 'layers'

type SelectLayersDialogProps = {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	selectQueueItems: (queueItems: LL.NewLayerListItem[]) => void
	defaultSelected?: L.LayerId[]
	frames?: Partial<SelectLayersFrame.KeyProp>
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	headerAdditions?: React.ReactNode
	footerAdditions?: React.ReactNode
	children?: React.ReactNode
	cursor?: LQY.Cursor
}
export default function SelectLayersDialogWrapper(props: SelectLayersDialogProps & { children?: React.ReactNode }) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange} modal={true}>
			{props.children && <DialogTrigger asChild>{props.children}</DialogTrigger>}
			{props.open && <SelectLayersDialog {...props} />}
		</Dialog>
	)
}

export function SelectLayersDialog(props: SelectLayersDialogProps) {
	const defaultSelectedRef = React.useRef(props.defaultSelected ?? [])

	const frameInputRef = React.useRef(SelectLayersFrame.createInput({ cursor: props.cursor, selected: defaultSelectedRef.current }))
	const frameKey = useFrameLifecycle(SelectLayersFrame.frame, {
		frameKey: props.frames?.selectLayers,
		input: frameInputRef.current,
		deps: undefined,
		equalityFn: Obj.deepEqual,
	})

	const defaultSelected: L.LayerId[] = props.defaultSelected ?? []

	const [selectMode, _setSelectMode] = React.useState<SelectMode>(props.pinMode ?? 'layers')
	const setSelectedLayers = useFrameStore(frameKey, (s) => s.layerTable.setSelected)
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

	const canSubmit = useFrameStore(frameKey, (s) => s.layerTable.selected.length > 0) || !submitted
	function submit() {
		if (!canSubmit) return
		setSubmitted(true)
		const selectedLayers = getFrameState(frameKey).layerTable.selected
		try {
			const source: LL.Source = { type: 'manual', userId: user!.discordId }
			if (selectMode === 'layers' || selectedLayers.length === 1) {
				const items = selectedLayers.map(
					(layerId) =>
						({
							layerId: layerId,
						}) satisfies LL.NewLayerListItem,
				)
				props.selectQueueItems(items)
			} else if (selectMode === 'vote') {
				const item: LL.NewLayerListItem = {
					layerId: selectedLayers[0],
					choices: selectedLayers.map(layerId => LL.createLayerListItem({ layerId }, source)),
				}
				props.selectQueueItems([item])
			}
			onOpenChange(false)
		} finally {
			setSubmitted(false)
		}
	}

	function onOpenChange(open: boolean) {
		if (open) {
			setSelectedLayers(defaultSelected)
		}
		props.onOpenChange?.(open)
	}

	return (
		<DialogContent className="w-auto max-w-full overflow-x-auto min-w-0 pb-2">
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center space-x-2">
					<DialogTitle>{props.title}</DialogTitle>
					{props.description
						&& (
							<>
								<div className="mx-8 font-light">-</div>
								<DialogDescription>{props.description}</DialogDescription>
							</>
						)}
				</div>
				<div className="flex justify-end items-center space-x-2 flex-grow">
					<AppliedFiltersPanel frameKey={frameKey} />
					{props.headerAdditions}
				</div>
			</DialogHeader>

			<div className="flex min-h-0 items-start space-x-2">
				<LayerFilterMenu frameKey={frameKey} />
				<div className="flex flex-col space-y-2 justify-between h-full">
					<div className={'flex h-full flex-grow'}>
						<LayerTable
							extraPanelItems={<PoolCheckboxes frameKey={frameKey} />}
							frameKey={frameKey}
							canChangeRowsPerPage={false}
							canToggleColumns={true}
							enableForceSelect={true}
						/>
					</div>

					<div className="grow self-end space-x-2">
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
						<Button disabled={!canSubmit} onClick={submit}>
							Submit
						</Button>
					</div>
				</div>
			</div>

			<DialogFooter>
			</DialogFooter>
		</DialogContent>
	)
}
