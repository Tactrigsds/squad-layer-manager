import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'
import type * as LayerInfoDialogClient from '@/systems/layer-info-dialog.client'
import type * as L from '@/models/layer'

export type LayerInfoWindowProps = {
	layerId: L.LayerId
	tab?: LayerInfoDialogClient.Tab
}

export const useOpenLayerInfoWindow = buildUseOpenWindow<LayerInfoWindowProps>(WINDOW_ID.enum['layer-info'])
