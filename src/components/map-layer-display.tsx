import { cn } from '@/lib/utils.ts'
import * as L from '@/models/layer'

export default function MapLayerDisplay(
	{ layer, extraLayerStyles, className }: {
		layer: string
		extraLayerStyles?: Record<string, string | undefined>
		className?: string
	},
) {
	const _extraLayerStyles = extraLayerStyles ?? {}
	let segments = L.parseLayerStringSegment(layer)
	if (segments) segments = L.applyBackwardsCompatMappings(segments)
	if (!segments || segments.Gamemode === 'Training') return segments?.Map ?? layer
	return (
		<span className={cn(_extraLayerStyles.Layer, _extraLayerStyles.Size, className)}>
			<span className={_extraLayerStyles.Map}>{segments.Map}</span>
			{segments.Gamemode && '_'}
			<span className={_extraLayerStyles.Gamemode}>{segments.Gamemode}</span>
			{segments.LayerVersion && segments.Gamemode && '_'}
			<span className={_extraLayerStyles.Layer}>{segments.LayerVersion?.toLowerCase()}</span>
		</span>
	)
}
