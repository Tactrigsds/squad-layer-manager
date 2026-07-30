import { DurationFormat } from '@formatjs/intl-durationformat'
import * as dateFns from 'date-fns'

import * as DH from '@/lib/display-helpers'
import * as I18n from '@/messages/i18n'
import type * as L from '@/models/layer'

// Formatters for values that appear inside message bodies. Separate from the vocabulary in
// models/messages.models.ts because these reach into display-helpers, and that module has to stay an import leaf:
// it is imported by models that the display layer
// itself imports, so an edge from there into @/lib or @/models closes a module-init cycle.

// date-fns only measures the duration here; naming its parts is Intl's, which is what makes "1 minute, 30 seconds"
// come out in the reader's language and with the reader's separator. Uses formatjs's DurationFormat rather than the
// platform's so the output does not depend on how new the browser is.
export function formatInterval(interval: number, options?: { round?: 'second'; locale?: string }) {
	const { round, locale } = options ?? {}
	const normalizedInterval = round === 'second' ? Math.round(interval / 1000) * 1000 : interval
	const duration = dateFns.intervalToDuration({ start: 0, end: normalizedInterval })
	// an interval short enough to round away has no parts, and DurationFormat rejects that
	if (!Object.keys(duration).length) return ''
	return new DurationFormat(locale ?? I18n.getAmbientLocale(), { style: 'long' }).format(duration)
}

// minute-granular "1h 47m" for tight roster rows. Sub-minute intervals round up to a minute so a player who was
// present never displays as nothing.
export function formatIntervalCompact(interval: number, locale?: string) {
	const minutes = Math.max(1, Math.round(interval / 60_000))
	const duration = minutes >= 60 ? { hours: Math.floor(minutes / 60), minutes: minutes % 60 } : { minutes }
	return new DurationFormat(locale ?? I18n.getAmbientLocale(), { style: 'narrow' }).format(duration)
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
