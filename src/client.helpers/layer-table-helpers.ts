import { globalToast$ } from '@/hooks/use-global-toast'
import * as L from '@/models/layer'

/** eslint-disable react-refresh/only-export-components */
export function copyAdminSetNextLayerCommand(selectedLayerIds: L.LayerId[]) {
	let text = ''
	for (const layerId of selectedLayerIds) {
		if (text !== '') text += '\n'
		text += L.getLayerCommand(layerId, 'set-next')
	}
	void navigator.clipboard.writeText(text)
	globalToast$.next({
		title: 'Copied AdminSetNextLayer Command',
	})
}
