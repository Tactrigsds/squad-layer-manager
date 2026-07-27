import { createIntl, type IntlShape } from '@formatjs/intl'
import type React from 'react'

// Where a message's text is resolved against a locale. Kept beside shared.ts rather than inside it so the
// vocabulary and the lookup stay separable, and kept an import leaf for the same reason shared.ts is: models
// absorb their text from there, and the display layer that renders them imports those models back.
//
// Messages are keyed by their own English source. A translator receives that string and returns another one, which
// is the gettext model rather than the invented-identifier one: no message has to declare an id, so the 897
// zero-argument messages in this tree need no source change at all to become translatable. The cost is that
// editing English copy orphans its translations, which the extractor reports rather than silently dropping.
//
// Two English strings that need different translations are told apart by a `context`, which is part of the key and
// never rendered. Only a handful need one: "Cancel" the dialog dismissal against "Cancel" the lifting of a timeout.

export const DEFAULT_LOCALE = 'en'

export type MessageValues = Record<string, React.ReactNode | Date>

// The catalogues a build carries. English is absent on purpose: a message IS its English, so resolving en means
// handing the key straight back, with no ICU parse and no allocation.
const catalogues: Record<string, Record<string, string>> = {}

export function registerCatalogue(locale: string, messages: Record<string, string>) {
	catalogues[locale] = { ...catalogues[locale], ...messages }
}

export function availableLocales() {
	return [DEFAULT_LOCALE, ...Object.keys(catalogues)]
}

// The locale of whoever this process is rendering for. Ambient because in a browser there is exactly one viewer, so
// there is nothing to confuse it with. The server never relies on it: every message rendered for a game server or a
// player is passed a locale explicitly, since one process serves many of both.
let ambientLocale = DEFAULT_LOCALE

export function setAmbientLocale(locale: string) {
	ambientLocale = locale
}

export function getAmbientLocale() {
	return ambientLocale
}

// Picks the best of the reader's preferences that this build can actually serve, in their order of preference.
//
// Adopting a locale with no catalogue would be worse than ignoring it: the text would still be English, but the
// plural rules would be that locale's, and a language whose rules have no `one` category renders "1 players".
export function negotiateLocale(preferred: readonly string[]) {
	const available = availableLocales()
	for (const want of preferred) {
		const exact = available.find((l) => l.toLowerCase() === want.toLowerCase())
		if (exact) return exact
		const primary = want.split('-')[0].toLowerCase()
		const related = available.find((l) => l.split('-')[0].toLowerCase() === primary)
		if (related) return related
	}
	return DEFAULT_LOCALE
}

const intls = new Map<string, IntlShape<React.ReactNode>>()

function intlFor(locale: string) {
	let intl = intls.get(locale)
	if (!intl) {
		intl = createIntl<React.ReactNode>({
			// A locale reaching here from a stored setting or an Accept-Language header may be anything at all, and
			// createIntl throws on a tag it cannot parse. English is a better answer than a blank page.
			locale: Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : DEFAULT_LOCALE,
			defaultLocale: DEFAULT_LOCALE,
			messages: catalogues[locale] ?? {},
			// A key with no entry renders its English, which is the useful outcome for a partly translated locale.
			onError: () => {},
		})
		intls.set(locale, intl)
	}
	return intl
}

export function key(source: string, context?: string) {
	return context ? `${source} [${context}]` : source
}

// Resolves a message to a string. `source` is both the key and the English, and doubles as the ICU pattern once a
// message carries arguments.
export function translate(source: string, values?: MessageValues, locale?: string, context?: string): string {
	const resolved = locale ?? ambientLocale
	if (!values && (resolved === DEFAULT_LOCALE || !catalogues[resolved])) return source
	return intlFor(resolved).formatMessage(
		{ id: key(source, context), defaultMessage: source },
		values as Record<string, string | number>,
	) as string
}

// The same, for a message whose arguments are rendered nodes. Returns the node list ICU assembled around them.
export function translateNode(source: string, values?: MessageValues, locale?: string, context?: string): React.ReactNode {
	const resolved = locale ?? ambientLocale
	return intlFor(resolved).formatMessage(
		{ id: key(source, context), defaultMessage: source },
		values as Record<string, React.ReactNode>,
	) as React.ReactNode
}
