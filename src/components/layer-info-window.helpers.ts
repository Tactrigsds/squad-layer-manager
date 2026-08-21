import scoreRanges from '$root/assets/score-ranges.json'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as L from '@/models/layer'
import type * as LC from '@/models/layer-columns'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'
import type * as LayerInfoDialogClient from '@/systems/layer-info-dialog.client'

export type LayerInfoWindowProps = {
	layerId: L.LayerId
	tab?: LayerInfoDialogClient.Tab
}

export const useOpenLayerInfoWindow = buildUseOpenWindow<LayerInfoWindowProps>(WINDOW_ID.enum['layer-info'])

// The dimensions the scores tab charts per team. score-ranges.json's paired section is what makes a dimension
// chartable: a diff column outside it has no axis to draw against, and Balance_Differential is a summary of the
// rest rather than one of them. Shared with the tutorial, which leaves its chart step out when there are none.
const PAIRED_SCORE_FIELDS = new Set(scoreRanges.paired.map((range) => range.field))

export function pairedScoreDimensions(scores: LC.PartitionedScores) {
	return Object.keys(scores.diffs)
		.filter((name) => name !== 'Balance_Differential' && PAIRED_SCORE_FIELDS.has(name))
		.sort()
}
