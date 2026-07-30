import { copyAdminSetNextLayerCommand } from '@/client.helpers/layer-table-helpers'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { toast } from '@/lib/toast'
import * as L_Msgs from '@/messages/layer.messages'
import * as L from '@/models/layer'
import { tr } from '@/systems/messages.client'

import LayerInfoDialog from './layer-info'

void import('./layer-info')

function copyHistoryEntryId(selectedHistoryEntryIds: number[]) {
	let text = ''
	for (const id of selectedHistoryEntryIds) {
		if (text !== '') text += '\n'
		text += id
	}
	void navigator.clipboard.writeText(text)
	toast(...tr.toast(L_Msgs.copiedHistoryEntryIds(selectedHistoryEntryIds.length)))
}

function copyLayerId(selectedLayerIds: L.LayerId[]) {
	let text = ''
	for (const id of selectedLayerIds) {
		if (text !== '') text += '\n'
		text += id
	}
	void navigator.clipboard.writeText(text)
	toast(...tr.toast(L_Msgs.copiedLayerIds()))
}

export function LayerContextMenuItems(props: { selectedLayerIds: L.LayerId[]; selectedHistoryEntryIds?: number[] }) {
	return (
		<>
			{props.selectedLayerIds.length === 1 && L.isKnownLayer(props.selectedLayerIds[0]) && (
				<LayerInfoDialog layerId={props.selectedLayerIds[0]}>
					<ContextMenuItem>{tr.text(L_Msgs.showLayerInfo())}</ContextMenuItem>
				</LayerInfoDialog>
			)}
			<ContextMenuItem onClick={() => copyAdminSetNextLayerCommand(props.selectedLayerIds)}>
				{tr.text(L_Msgs.copySetNextCommand())}
			</ContextMenuItem>
			<ContextMenuItem onClick={() => copyLayerId(props.selectedLayerIds)}>{tr.text(L_Msgs.copyLayerId())}</ContextMenuItem>
			{props.selectedHistoryEntryIds && (
				<ContextMenuItem onClick={() => copyHistoryEntryId(props.selectedHistoryEntryIds!)}>
					{tr.text(L_Msgs.copyHistoryEntryId())}
				</ContextMenuItem>
			)}
		</>
	)
}
