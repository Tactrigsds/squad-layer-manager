import type * as L from '@/models/layer.models'

// A queue item's history, or a played match's when the match has no queue item behind it
export type LayerHistoryWindowProps = {
	serverId: string
	layerId: L.LayerId
	itemId?: string
	matchId?: number
}

export function layerHistoryWindowId(props: LayerHistoryWindowProps) {
	return `${props.serverId}:${props.itemId ?? `match-${props.matchId}`}`
}
