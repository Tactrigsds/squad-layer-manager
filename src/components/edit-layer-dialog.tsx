import React from 'react'

import { Button } from '@/components/ui/button'
import { HeadlessDialog } from '@/components/ui/headless-dialog'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Browser from '@/lib/browser'
import * as Obj from '@/lib/object-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import type * as L from '@/models/layer'
import type * as LL from '@/models/layer-list.models'
import { DragContextProvider } from '@/systems/dndkit.client.tsx'
import { tr } from '@/systems/messages.client'

import LayerPickerLayout from './layer-picker-layout.tsx'

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
	// the initializer runs once, so it captures the layer this dialog opened on without a ref holding it
	const [frameInput] = React.useState(() => {
		const defaultLayerId = props.layerId
		return SelectLayersFrame.createInput({
			cursor: props.cursor,
			initialEditedLayerId: defaultLayerId,
			selected: defaultLayerId ? [defaultLayerId] : [],
			maxSelected: 1,
			minSelected: defaultLayerId ? 1 : 0,
			squadServer: props.stores?.squadServer,
		})
	})
	const frameKey = useFrameLifecycle(SelectLayersFrame.frame, {
		frameKey: props.stores?.selectLayers,
		input: frameInput,
		equalityFn: Obj.deepEqual,
	})
	// a frame this dialog provisioned itself dies with it; one handed in via stores belongs to its provider
	useFrameTeardownOnUnmount(frameKey, !props.stores?.selectLayers)

	const [initialLayerId, editedLayerId] = Zus.useStore(
		frameKey,
		Zus.useShallow((s) => [s.initialEditedLayerId, s.layerTable.selected[0]]),
	)

	const phone = Browser.useIsSmallViewport()
	const canSubmit = !!editedLayerId && initialLayerId !== editedLayerId
	function submit() {
		if (!canSubmit) return
		props.onClose()
		props.onSelectLayer(editedLayerId!)
	}

	return (
		<LayerPickerLayout
			frameKey={frameKey}
			squadServer={props.stores?.squadServer}
			title={tr.text(L_Msgs.editLayerTitle())}
			tourPrefix="edit-layer"
			canToggleColumns={false}
			footer={
				<Button variant="primary" size="sm" disabled={!canSubmit} onClick={submit} className={cn(phone ? 'w-full' : 'self-end')}>
					{tr.text(L_Msgs.submit())}
				</Button>
			}
			onClose={props.onClose}
		/>
	)
})

export default function EditLayerDialog(props: EditLayerDialogProps) {
	const { onOpenChange } = props
	const onClose = () => {
		onOpenChange(false)
	}

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
