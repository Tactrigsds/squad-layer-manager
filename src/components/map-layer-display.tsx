import React from 'react'

import * as Atoms from './feed/atoms'
import { useDomContent } from './feed/dom-content'

export default function MapLayerDisplay({
	layer,
	extraLayerStyles,
	className,
}: {
	layer: string
	extraLayerStyles?: Record<string, string | undefined>
	className?: string
}) {
	const node = React.useMemo(() => Atoms.mapLayerDisplay(layer, extraLayerStyles, className), [layer, extraLayerStyles, className])
	const ref = useDomContent<HTMLSpanElement>(node)
	return <span ref={ref} className="contents" />
}
