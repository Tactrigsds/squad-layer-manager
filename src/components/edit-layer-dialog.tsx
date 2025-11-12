import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useFrameLifecycle, useFrameStore } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as FRM from '@/lib/frame.ts'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as AppRoutesClient from '@/systems.client/app-routes.client'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import React from 'react'
import AppliedFiltersPanel from './applied-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerTable from './layer-table.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'

export type EditLayerDialogProps = {
	children?: React.ReactNode
} & InnerEditLayerDialogProps

// index
// itemStore
type InnerEditLayerDialogProps = {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	layerId?: L.LayerId
	onSelectLayer: (layerId: L.LayerId) => void
	cursor?: LQY.Cursor
}

export default function EditLayerDialogWrapper(props: EditLayerDialogProps) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			{props.children && <DialogTrigger asChild>{props.children}</DialogTrigger>}
			<DialogContent className="w-auto max-w-full min-w-0 pb-2 overflow-x-auto">
				<DragContextProvider>
					{props.open && <EditLayerListItemDialog {...props} />}
				</DragContextProvider>
			</DialogContent>
		</Dialog>
	)
}

function EditLayerListItemDialog(props: InnerEditLayerDialogProps) {
	const defaultLayerId = React.useRef(props.layerId)
	const frameInputRef = React.useRef(SelectLayersFrame.createInput({ cursor: props.cursor, initialEditedLayerId: defaultLayerId.current }))
	const frameKey = useFrameLifecycle(
		SelectLayersFrame.frame,
		frameInputRef.current,
		undefined,
		Obj.deepEqual,
	)

	const [initialLayerId, editedLayerId] = useFrameStore(
		frameKey,
		ZusUtils.useShallow(s => [s.initialEditedLayerId, s.layerTable.selected[0]]),
	)

	const canSubmit = !!editedLayerId && initialLayerId !== editedLayerId
	function submit() {
		const canSubmit = !!editedLayerId && initialLayerId !== editedLayerId
		if (!canSubmit) return
		props.onOpenChange(false)
		props.onSelectLayer(editedLayerId!)
	}

	return (
		<>
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<DialogTitle>Edit</DialogTitle>
				</div>
				<div className="flex justify-end items-center space-x-2 flex-grow">
					<AppliedFiltersPanel frameKey={frameKey} />
				</div>
			</DialogHeader>

			{
				<div className="flex items-start space-x-2 min-h-0">
					<LayerFilterMenu frameKey={frameKey} />
					<div className="flex flex-col h-full justify-between">
						<LayerTable
							frameKey={frameKey}
							extraPanelItems={<PoolCheckboxes frameKey={frameKey} />}
							canChangeRowsPerPage={false}
							canToggleColumns={false}
							enableForceSelect={true}
						/>
						<div className="flex justify-end">
							<Button disabled={!canSubmit} onClick={submit}>
								Submit
							</Button>
						</div>
					</div>
				</div>
			}
		</>
	)
}
