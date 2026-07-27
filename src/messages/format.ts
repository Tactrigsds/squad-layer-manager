import * as dateFns from 'date-fns'

import * as DH from '@/lib/display-helpers'
import type * as L from '@/models/layer'

// Formatters for values that appear inside message bodies. Separate from shared.ts because these reach into
// display-helpers, and shared.ts has to stay an import leaf: it is imported by models that the display layer
// itself imports, so an edge from there into @/lib or @/models closes a module-init cycle.

export function formatInterval(interval: number, options?: { terse?: boolean; round?: 'second' }) {
	const { terse = true, round } = options ?? {}
	const normalizedInterval = round === 'second' ? Math.round(interval / 1000) * 1000 : interval
	const duration = dateFns.intervalToDuration({ start: 0, end: normalizedInterval })
	let txt = dateFns.formatDuration(duration)
	if (terse) txt = txt.replace(' seconds', 's').replace(' minutes', 'm')
	return txt
}

export function voteChoicesLines(choices: L.LayerId[], you?: 1 | 2, displayProps?: DH.LayerDisplayProp[]) {
	const lines = choices.map((c, index) => {
		return `${index + 1}. ${DH.toShortLayerNameFromId(c, you, displayProps)}`
	})

	if (lines.join(' ').length < 50) {
		return [lines.join(' ')]
	}
	return lines
}
