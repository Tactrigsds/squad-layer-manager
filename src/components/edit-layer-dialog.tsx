import { Button } from '@/components/ui/button'
import { HeadlessDialog, HeadlessDialogContent, HeadlessDialogFooter, HeadlessDialogHeader, HeadlessDialogTitle } from '@/components/ui/headless-dialog'
import { useFrameLifecycle } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Obj from '@/lib/object'
import { useRefConstructor } from '@/lib/react.ts'
import * as ZusUtils from '@/lib/zustand'
import type * as L from '@/models/layer'
import type * as LL from '@/models/layer-list.models'
import { DragContextProvider } from '@/systems/dndkit.client.tsx'
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
	cursor?: LL.Cursor
	stores?: Partial<SelectLayersFrame.KeyProp & SquadServerFrame.KeyProp>
}

type EditLayerDialogContentProps = {
	layerId?: L.LayerId
	onSelectLayer: (layerId: L.LayerId) => void
	cursor?: LL.Cursor
	stores?: Partial<SelectLayersFrame.KeyProp & SquadServerFrame.KeyProp>
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
				squadServer: props.stores?.squadServer,
			}),
	)
	const frameKey = useFrameLifecycle(
		SelectLayersFrame.frame,
		{
			frameKey: props.stores?.selectLayers,
			input: frameInputRef.current,
			equalityFn: Obj.deepEqual,
		},
	)

	const [initialLayerId, editedLayerId] = ZusUtils.useStore(
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
					{
						/* FIXME stage4: AppliedFiltersPanel's stores type also requires a squadServer key (see applied-filters-panel.tsx),
					   which isn't available in this select-layers-only context. Left as-is (pre-existing before this migration pass). */
					}
					<AppliedFiltersPanel stores={{ appliedFilters: frameKey, squadServer: props.stores?.squadServer }} />
				</div>
			</HeadlessDialogHeader>

			<div className="flex min-h-0 items-start space-x-2">
				<LayerFilterMenu stores={{ filterMenu: frameKey }} />
				<div className="flex flex-col space-y-2 justify-between h-full min-h-0">
					<div className="flex h-full min-h-0">
						<LayerTable
							stores={{ layerTable: frameKey, squadServer: props.stores?.squadServer }}
							extraPanelItems={<PoolCheckboxes stores={{ poolCheckboxes: frameKey }} />}
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
						stores={props.stores}
						onClose={onClose}
					/>
				)}
			</DragContextProvider>
		</HeadlessDialog>
	)
}
