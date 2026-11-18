import * as L_Msgs from '@/messages/layer.messages'
import * as L from '@/models/layer.models'
import * as Clipboard from '@/systems/clipboard.client'
import { tr } from '@/systems/messages.client'

/** eslint-disable react-refresh/only-export-components */
export function copyAdminSetNextLayerCommand(selectedLayerIds: L.LayerId[]) {
	let text = ''
	for (const layerId of selectedLayerIds) {
		if (text !== '') text += '\n'
		text += L.getLayerCommand(layerId, 'set-next')
	}
	void Clipboard.copy(text, tr.text(L_Msgs.setNextCommandsNoun(selectedLayerIds.length)))
}
