import { cn } from '@/lib/utils.ts'
import * as L from '@/models/layer'

export default function MapLayerDisplay(
	{ layer, extraLayerStyles: extraLayerStyles, className }: {
		layer: string
		extraLayerStyles?: Record<string, string | undefined>
		className?: string
	},
) {
	extraLayerStyles ??= {}
	const segments = L.parseLayerStringSegment(layer)
	if (!segments || segments.Gamemode === 'Training') return segments?.Map ?? layer
	return (
		<span className={cn(extraLayerStyles.Layer, extraLayerStyles.Size, className)}>
			<span className={extraLayerStyles.Map}>{segments.Map}</span>
			{segments.Gamemode && '_'}
			<span className={extraLayerStyles.Gamemode}>{segments.Gamemode}</span>
			{segments.LayerVersion && segments.Gamemode && '_'}
			<span className={extraLayerStyles.Layer}>{segments.LayerVersion?.toLowerCase()}</span>
		</span>
	)
}
