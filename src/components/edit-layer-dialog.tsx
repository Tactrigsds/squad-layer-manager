import { Button } from '@/components/ui/button'
import { HeadlessDialog, HeadlessDialogContent, HeadlessDialogFooter, HeadlessDialogHeader, HeadlessDialogTitle } from '@/components/ui/headless-dialog'
import { useFrameLifecycle, useFrameStore } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as Obj from '@/lib/object'
import { useRefConstructor } from '@/lib/react.ts'
import * as ZusUtils from '@/lib/zustand'
import type * as L from '@/models/layer'
import type * as LQY from '@/models/layer-queries.models.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import React from 'react'
import AppliedFiltersPanel from './applied-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import LayerTable from './layer-table.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'

export type EditLayerDialogProps = {
	open: boolean
	onOpenChange: (open: boolean) => void
	layerId?: L.LayerId
	onSelectLayer: (layerId: L.LayerId) => void
	cursor?: LQY.Cursor
	frames?: Partial<SelectLayersFrame.KeyProp>
}

type EditLayerDialogContentProps = {
	layerId?: L.LayerId
	onSelectLayer: (layerId: L.LayerId) => void
	cursor?: LQY.Cursor
	frames?: Partial<SelectLayersFrame.KeyProp>
	onClose: () => void
}

const EditLayerDialogContent = React.memo<EditLayerDialogContentProps>(function EditLayerDialogContent(props) {
	const defaultLayerIdRef = React.useRef(props.layerId)
	const frameInputRef = useRefConstructor(
		() =>
			SelectLayersFrame.createInput({
				cursor: props.cursor,
				initialEditedLayerId: defaultLayerIdRef.current,
				selected: defaultLayerIdRef.current ? [defaultLayerIdRef.current] : [],
				maxSelected: 1,
				minSelected: defaultLayerIdRef.current ? 1 : 0,
			}),
	)
	const frameKey = useFrameLifecycle(
		SelectLayersFrame.frame,
		{
			frameKey: props.frames?.selectLayers,
			input: frameInputRef.current,
			deps: undefined,
			equalityFn: Obj.deepEqual,
		},
	)

	const [initialLayerId, editedLayerId] = useFrameStore(
		frameKey,
		ZusUtils.useShallow(s => [s.initialEditedLayerId, s.layerTable.selected[0]]),
	)

	const canSubmit = !!editedLayerId && initialLayerId !== editedLayerId
	function submit() {
		const canSubmit = !!editedLayerId && initialLayerId !== editedLayerId
		if (!canSubmit) return
		props.onClose()
		props.onSelectLayer(editedLayerId!)
	}

	return (
		<HeadlessDialogContent className="max-h-[95vh] w-max max-w-[95vw] flex flex-col overflow-auto">
			<HeadlessDialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<HeadlessDialogTitle>Edit Layer</HeadlessDialogTitle>
				</div>
				<div className="flex justify-end items-center space-x-2">
					<AppliedFiltersPanel frameKey={frameKey} />
				</div>
			</HeadlessDialogHeader>

			<div className="flex min-h-0 items-start space-x-2">
				<LayerFilterMenu frameKey={frameKey} />
				<div className="flex flex-col space-y-2 justify-between h-full min-h-0">
					<div className="flex h-full min-h-0">
						<LayerTable
							frameKey={frameKey}
							extraPanelItems={<PoolCheckboxes frameKey={frameKey} />}
							canChangeRowsPerPage={false}
							canToggleColumns={false}
							enableForceSelect
						/>
					</div>
				</div>
			</div>

			<HeadlessDialogFooter>
				<div className="flex items-center justify-end w-full">
					<Button disabled={!canSubmit} onClick={submit}>
						Submit
					</Button>
				</div>
			</HeadlessDialogFooter>
		</HeadlessDialogContent>
	)
})

export default function EditLayerDialog(props: EditLayerDialogProps) {
	const { onOpenChange } = props
	const onClose = React.useCallback(() => {
		onOpenChange(false)
	}, [onOpenChange])

	return (
		<HeadlessDialog open={props.open} onOpenChange={props.onOpenChange} unmount={false}>
			<DragContextProvider>
				{props.open && (
					<EditLayerDialogContent
						layerId={props.layerId}
						onSelectLayer={props.onSelectLayer}
						cursor={props.cursor}
						frames={props.frames}
						onClose={onClose}
					/>
				)}
			</DragContextProvider>
		</HeadlessDialog>
	)
}
