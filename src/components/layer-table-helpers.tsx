import { ContextMenuItem } from '@/components/ui/context-menu'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as L from '@/models/layer'
import LayerInfoDialog from './layer-info'

/** eslint-disable react-refresh/only-export-components */
export function copyHistoryEntryId(selectedHistoryEntryIds: number[]) {
	let text = ''
	for (const id of selectedHistoryEntryIds) {
		if (text !== '') text += '\n'
		text += id
	}
	navigator.clipboard.writeText(text)
	globalToast$.next({
		title: `Copied History Entry ID${selectedHistoryEntryIds.length > 1 ? 's' : ''}`,
	})
}

/** eslint-disable react-refresh/only-export-components */
export function copyLayerId(selectedLayerIds: L.LayerId[]) {
	let text = ''
	for (const id of selectedLayerIds) {
		if (text !== '') text += '\n'
		text += id
	}
	navigator.clipboard.writeText(text)
	globalToast$.next({
		title: 'Copied Layer ID',
	})
}

/** eslint-disable react-refresh/only-export-components */
export function copyAdminSetNextLayerCommand(selectedLayerIds: L.LayerId[]) {
	let text = ''
	for (const layerId of selectedLayerIds) {
		if (text !== '') text += '\n'
		text += L.getAdminSetNextLayerCommand(layerId)
	}
	navigator.clipboard.writeText(text)
	globalToast$.next({
		title: 'Copied AdminSetNextLayer Command',
	})
}

export function LayerContextMenuItems(props: { selectedLayerIds: L.LayerId[]; selectedHistoryEntryIds?: number[] }) {
	return (
		<>
			{props.selectedLayerIds.length === 1 && (
				<LayerInfoDialog layerId={props.selectedLayerIds[0]}>
					<ContextMenuItem onSelect={(e) => e.preventDefault()}>
						Show layer info
					</ContextMenuItem>
				</LayerInfoDialog>
			)}
			<ContextMenuItem
				onClick={() => copyAdminSetNextLayerCommand(props.selectedLayerIds)}
			>
				Copy AdminSetNextLayer command
			</ContextMenuItem>
			<ContextMenuItem
				onClick={() => copyLayerId(props.selectedLayerIds)}
			>
				Copy layer id
			</ContextMenuItem>
			{props.selectedHistoryEntryIds
				&& (
					<ContextMenuItem
						onClick={() => copyHistoryEntryId(props.selectedHistoryEntryIds!)}
					>
						Copy history entry id
					</ContextMenuItem>
				)}
		</>
	)
}
