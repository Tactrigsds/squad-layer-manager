import ShortLayerName from '@/components/short-layer-name'
import type * as L from '@/models/layer'

/**
 * The plugin-facing layer name: `slm/components/layer`. A thin front for ShortLayerName, whose own props
 * (team parity, backfill, match descriptors, a forwarded ref for drop targets) belong to the queue and the
 * match history rather than to naming a layer.
 */
export function LayerName({ layerId, className, allowShowInfo }: { layerId: L.LayerId; className?: string; allowShowInfo?: boolean }) {
	return <ShortLayerName layerId={layerId} className={className} allowShowInfo={allowShowInfo} />
}
