import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as FRM from '@/lib/frame.ts'
import * as Obj from '@/lib/object'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import React from 'react'
import ExtraFiltersPanel from './extra-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'

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
	frameKey: SelectLayersFrame.Key
}

export default function EditLayerDialogWrapper(props: EditLayerDialogProps) {
	const setupComplete = FRM.useFrameExists(SelectLayersFrame.frame, props.frameKey)
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			{props.children && <DialogTrigger asChild>{props.children}</DialogTrigger>}
			<DialogContent className="w-auto max-w-full min-w-0 pb-2 overflow-x-auto">
				<DragContextProvider>
					{setupComplete && <EditLayerListItemDialog {...props} />}
				</DragContextProvider>
			</DialogContent>
		</Dialog>
	)
}

function EditLayerListItemDialog(props: InnerEditLayerDialogProps) {
	const queryInput = SelectLayersFrame.useQueryInput(props.frameKey)
	const initialLayerId = SelectLayersFrame.useSelectedSelectLayersState(props.frameKey, s => s.initialEditedLayerId)
	const [editedLayerId, setEditedLayerId] = React.useState(initialLayerId)
	const canSubmit = !!editedLayerId && initialLayerId !== editedLayerId

	function submit() {
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
					<ExtraFiltersPanel frameKey={props.frameKey} />
				</div>
			</DialogHeader>

			{
				<div className="flex items-start space-x-2 min-h-0">
					<LayerFilterMenu frameKey={props.frameKey} />
					<div className="flex flex-col h-full justify-between">
						<TableStyleLayerPicker
							defaultPageSize={16}
							queryInput={queryInput}
							editingSingleValue={true}
							extraPanelItems={<PoolCheckboxes frameKey={props.frameKey} />}
							selected={editedLayerId ? [editedLayerId] : []}
							onSelect={(update) => {
								const id = (typeof update === 'function' ? update([]) : update)[0]
								if (!id) return
								setEditedLayerId(id)
							}}
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
