import { useQuery } from '@tanstack/react-query'

import { copyAdminSetNextLayerCommand } from '@/client.helpers/layer-table-helpers'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import * as ConfigClient from '@/systems/config.client'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'

import type { MenuSlots } from './player-context-menu-options'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu'

void import('./layer-info')

const contextMenuSlots: MenuSlots = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent,
}

function copyLayerIds(layerIds: L.LayerId[]) {
	void navigator.clipboard.writeText(layerIds.join('\n'))
	toast(...tr.toast(L_Msgs.copiedLayerIds()))
}

function copyHistoryEntryIds(historyEntryIds: number[]) {
	void navigator.clipboard.writeText(historyEntryIds.join('\n'))
	toast(...tr.toast(L_Msgs.copiedHistoryEntryIds(historyEntryIds.length)))
}

// details, scores and squadcalc all address one layer, so they only appear when the selection resolves to one.
// Split out so the layer-info query backing the scores entry isn't run for a multi-layer selection.
function SingleLayerItems({ layerId, slots }: { layerId: L.LayerId; slots: MenuSlots }) {
	const { Item } = slots
	const openOrFocusWindow = useOpenOrFocusWindow()
	const layerRes = useQuery(LayerQueriesClient.getLayerInfoQueryOptions(layerId))
	const cfg = ConfigClient.useEffectiveColConfig()
	const squadcalcUrl = Zus.useStore(ConfigClient.Store, (config) =>
		config ? L.getSquadcalcUrl(config.PUBLIC_SQUADCALC_URL, layerId) : undefined,
	)

	const scores = layerRes.data && cfg ? LC.partitionScores(layerRes.data as L.KnownLayer, cfg) : undefined
	const hasScores = scores && Object.values(scores).some((type) => Object.values(type).some((score) => typeof score === 'number'))

	function showLayerInfo(tab: 'details' | 'scores') {
		openOrFocusWindow(WINDOW_ID.enum['layer-info'], { layerId, tab })
	}

	return (
		<>
			<Item onClick={() => showLayerInfo('details')}>{tr.text(L_Msgs.showDetails())}</Item>
			{/* the window falls back to details when a layer has no scores, so this stays enabled until the query says otherwise */}
			<Item onClick={() => showLayerInfo('scores')} disabled={!!layerRes.data && !hasScores}>
				{tr.text(L_Msgs.showScores())}
			</Item>
			<Item disabled={!squadcalcUrl} onClick={() => squadcalcUrl && window.open(squadcalcUrl, '_blank', 'noopener,noreferrer')}>
				{tr.text(L_Msgs.openInSquadCalc())}
			</Item>
		</>
	)
}

export function LayerMenuItems({
	layerIds,
	historyEntryIds,
	slots,
}: {
	layerIds: L.LayerId[]
	historyEntryIds?: number[]
	slots: MenuSlots
}) {
	const { Item, Separator, Sub, SubTrigger, SubContent } = slots
	const singleKnownLayerId = layerIds.length === 1 && L.isKnownLayer(layerIds[0]) ? layerIds[0] : undefined

	return (
		<>
			{singleKnownLayerId && (
				<>
					<SingleLayerItems layerId={singleKnownLayerId} slots={slots} />
					<Separator />
				</>
			)}
			<Sub>
				<SubTrigger>{tr.text(L_Msgs.copySub())}</SubTrigger>
				<SubContent>
					<Item onClick={() => copyAdminSetNextLayerCommand(layerIds)}>{tr.text(L_Msgs.copySetNextCommand())}</Item>
					<Item onClick={() => copyLayerIds(layerIds)}>{tr.text(L_Msgs.copyLayerId())}</Item>
					{historyEntryIds && <Item onClick={() => copyHistoryEntryIds(historyEntryIds)}>{tr.text(L_Msgs.copyHistoryEntryId())}</Item>}
				</SubContent>
			</Sub>
		</>
	)
}

export default function LayerContextMenuOptions(props: { layerIds: L.LayerId[]; historyEntryIds?: number[] }) {
	return <LayerMenuItems layerIds={props.layerIds} historyEntryIds={props.historyEntryIds} slots={contextMenuSlots} />
}
