import { copyAdminSetNextLayerCommand } from '@/client.helpers/layer-table-helpers'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { toast } from '@/lib/toast'
import * as L_Msgs from '@/messages/layer.messages'
import * as L from '@/models/layer'

import LayerInfoDialog from './layer-info'

void import('./layer-info')

function copyHistoryEntryId(selectedHistoryEntryIds: number[]) {
	let text = ''
	for (const id of selectedHistoryEntryIds) {
		if (text !== '') text += '\n'
		text += id
	}
	void navigator.clipboard.writeText(text)
	toast(...L_Msgs.copiedHistoryEntryIds(selectedHistoryEntryIds.length).toast())
}

function copyLayerId(selectedLayerIds: L.LayerId[]) {
	let text = ''
	for (const id of selectedLayerIds) {
		if (text !== '') text += '\n'
		text += id
	}
	void navigator.clipboard.writeText(text)
	toast(...L_Msgs.copiedLayerIds().toast())
}

export function LayerContextMenuItems(props: { selectedLayerIds: L.LayerId[]; selectedHistoryEntryIds?: number[] }) {
	return (
		<>
			{props.selectedLayerIds.length === 1 && L.isKnownLayer(props.selectedLayerIds[0]) && (
				<LayerInfoDialog layerId={props.selectedLayerIds[0]}>
					<ContextMenuItem>Show layer info</ContextMenuItem>
				</LayerInfoDialog>
			)}
			<ContextMenuItem onClick={() => copyAdminSetNextLayerCommand(props.selectedLayerIds)}>
				Copy AdminSetNextLayer command
			</ContextMenuItem>
			<ContextMenuItem onClick={() => copyLayerId(props.selectedLayerIds)}>Copy layer id</ContextMenuItem>
			{props.selectedHistoryEntryIds && (
				<ContextMenuItem onClick={() => copyHistoryEntryId(props.selectedHistoryEntryIds!)}>Copy history entry id</ContextMenuItem>
			)}
		</>
	)
}
