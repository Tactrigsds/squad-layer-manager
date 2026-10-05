import type * as FormatjsDuration from '@formatjs/intl-durationformat'
import * as dateFns from 'date-fns'

import * as DH from '@/lib/display-helpers'
import * as I18n from '@/messages/i18n'
import type * as L from '@/models/layer'
import { t } from '@/models/messages.models'

// Formatters for values that appear inside message bodies. Separate from the vocabulary in
// models/messages.models.ts because these reach into display-helpers, and that module has to stay an import leaf:
// it is imported by models that the display layer
// itself imports, so an edge from there into @/lib or @/models closes a module-init cycle.

// Firefox below 136 and Chrome below 129 lack Intl.DurationFormat. The polyfill is fetched only for them, by
// loadDurationFormat(), which the client awaits before its first render.
let DurationFormat = (Intl as { DurationFormat?: typeof FormatjsDuration.DurationFormat }).DurationFormat

export async function loadDurationFormat() {
	DurationFormat ??= (await import('@formatjs/intl-durationformat')).DurationFormat
}

const durationFormats = new Map<string, FormatjsDuration.DurationFormat>()

// one per locale and style: constructing a DurationFormat costs more than formatting with one
function durationFormat(locale: string, style: 'long' | 'narrow') {
	if (!DurationFormat) throw new Error('Intl.DurationFormat is unavailable and loadDurationFormat() has not run')
	const cacheKey = `${locale}|${style}`
	let format = durationFormats.get(cacheKey)
	if (!format) durationFormats.set(cacheKey, (format = new DurationFormat(locale, { style })))
	return format
}

// date-fns only measures the duration here; naming its parts is Intl's, which is what makes "1 minute, 30 seconds"
// come out in the reader's language and with the reader's separator.
export function formatInterval(interval: number, options?: { round?: 'second'; locale?: string }) {
	const { round, locale } = options ?? {}
	const normalizedInterval = round === 'second' ? Math.round(interval / 1000) * 1000 : interval
	const duration = dateFns.intervalToDuration({ start: 0, end: normalizedInterval })
	// an interval short enough to round away has no parts, and DurationFormat rejects that
	if (!Object.keys(duration).length) return ''
	return durationFormat(locale ?? I18n.getAmbientLocale(), 'long').format(duration)
}

// minute-granular "1h 47m" for tight roster rows. Sub-minute intervals round up to a minute so a player who was
// present never displays as nothing.
export function formatIntervalCompact(interval: number, locale?: string) {
	const minutes = Math.max(1, Math.round(interval / 60_000))
	const duration = minutes >= 60 ? { hours: Math.floor(minutes / 60), minutes: minutes % 60 } : { minutes }
	return durationFormat(locale ?? I18n.getAmbientLocale(), 'narrow').format(duration)
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * DAY],
	['month', 30 * DAY],
	['week', 7 * DAY],
	['day', DAY],
	['hour', HOUR],
	['minute', MINUTE],
	['second', SECOND],
]

// the largest unit the interval holds at least one of, and the rounded count of it
function approxUnit(interval: number): [Intl.RelativeTimeFormatUnit, number] {
	const abs = Math.abs(interval)
	for (const [unit, size] of RELATIVE_UNITS) {
		if (abs >= size) return [unit, Math.round(interval / size)]
	}
	return ['second', 0]
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>()

// "3 minutes ago", "in 2 hours", "yesterday": one unit, in the reader's language
export function formatRelativeTime(time: number | Date, options?: { locale?: string; now?: number }) {
	const locale = options?.locale ?? I18n.getAmbientLocale()
	let format = relativeFormats.get(locale)
	if (!format) {
		format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
		relativeFormats.set(locale, format)
	}
	const [unit, value] = approxUnit(+time - (options?.now ?? Date.now()))
	return format.format(value, unit)
}

// "3 minutes", "2 hours": an elapsed time to one unit, for where the exact figure is noise
export function formatIntervalApprox(interval: number, locale?: string) {
	const [unit, value] = approxUnit(interval)
	return durationFormat(locale ?? I18n.getAmbientLocale(), 'long').format({ [`${unit}s`]: Math.abs(value) })
}

const DATE_FORMATS = {
	dateTime: { dateStyle: 'medium', timeStyle: 'short' },
	dateTime24: { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' },
	date: { dateStyle: 'medium' },
	clock: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
	dateFull: { dateStyle: 'full' },
	weekdayMonthDay: { weekday: 'long', month: 'long', day: 'numeric' },
	weekdayDay: { weekday: 'short', day: 'numeric' },
	time: { timeStyle: 'short' },
	timeSeconds: { timeStyle: 'medium' },
} satisfies Record<string, Intl.DateTimeFormatOptions>

export type DateFormat = keyof typeof DATE_FORMATS

const dateFormats = new Map<string, Intl.DateTimeFormat>()

export function formatDate(time: number | Date, format: DateFormat, locale?: string) {
	const resolved = locale ?? I18n.getAmbientLocale()
	const cacheKey = `${resolved}|${format}`
	let formatter = dateFormats.get(cacheKey)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(resolved, DATE_FORMATS[format])
		dateFormats.set(cacheKey, formatter)
	}
	return formatter.format(time)
}

const numberFormats = new Map<string, Intl.NumberFormat>()

export function formatNumber(value: number, locale?: string) {
	const resolved = locale ?? I18n.getAmbientLocale()
	let formatter = numberFormats.get(resolved)
	if (!formatter) {
		formatter = new Intl.NumberFormat(resolved)
		numberFormats.set(resolved, formatter)
	}
	return formatter.format(value)
}

const compactNumberFormats = new Map<string, Intl.NumberFormat>()

// a count shortened for a badge: 62742 reads as "63K" in English
export function formatNumberCompact(value: number, locale?: string) {
	const resolved = locale ?? I18n.getAmbientLocale()
	let formatter = compactNumberFormats.get(resolved)
	if (!formatter) {
		formatter = new Intl.NumberFormat(resolved, { notation: 'compact' })
		compactNumberFormats.set(resolved, formatter)
	}
	return formatter.format(value)
}

// A human-readable list, "a, b and c", joined the way the reader's language joins one
export function formatList(items: readonly string[], options?: { locale?: string; type?: 'conjunction' | 'disjunction' | 'unit' }) {
	return I18n.listFormat(options?.locale ?? I18n.getAmbientLocale(), options?.type).format(items)
}

export function voteChoicesLines(choices: L.LayerId[], locale: string, you?: 1 | 2, displayProps?: DH.LayerDisplayProp[]) {
	const tr = I18n.translatorFor(locale)
	const lines = choices.map((c, index) =>
		tr.text(t('{position}. {layer}', { position: index + 1, layer: DH.toShortLayerNameFromId(c, you, displayProps) })),
	)

	if (lines.join(' ').length < 50) {
		return [lines.join(' ')]
	}
	return lines
}
