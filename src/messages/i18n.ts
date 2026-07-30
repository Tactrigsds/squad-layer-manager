import { createIntl, type IntlShape } from '@formatjs/intl'
import * as React from 'react'

// messages.models is itself a type-only leaf, so this value import keeps i18n one too
import * as Msgs from '@/models/messages.models'

// Where a message's text is resolved against a locale. Kept beside the vocabulary (models/messages.models.ts)
// rather than inside it so the two stay separable, and kept an import leaf for the same reason that one is: models
// absorb their text from there, and the display layer that renders them imports those models back.
//
// Messages are keyed by their own English source. A translator receives that string and returns another one, which
// is the gettext model rather than the invented-identifier one: no message declares an id, so the ~1,300
// zero-argument messages in this tree read as their own text at the call site. The cost is that editing English
// copy orphans its translations, which the extractor reports rather than silently dropping.
//
// Two English strings that need different translations are told apart by a `context`, which is part of the key and
// never rendered. Only a handful need one: "Cancel" the dialog dismissal against "Cancel" the lifting of a timeout.

export const DEFAULT_LOCALE = 'en'

export type MessageValues = Record<string, React.ReactNode | Date | ((chunks: React.ReactNode[]) => React.ReactNode)>

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

// The header's language tags ordered by their q weights, ready for negotiateLocale. Wildcards and invalid
// pieces are dropped; ties keep the header's own order, which sort() preserves by being stable.
export function parseAcceptLanguage(header: string | undefined): string[] {
	if (!header) return []
	const entries: { tag: string; q: number }[] = []
	for (const part of header.split(',')) {
		const [tag, ...params] = part.trim().split(';')
		const cleaned = tag.trim()
		if (!cleaned || cleaned === '*') continue
		let q = 1
		for (const param of params) {
			const [key, value] = param.trim().split('=')
			if (key.trim() === 'q') q = Number(value)
		}
		if (Number.isNaN(q) || q <= 0) continue
		entries.push({ tag: cleaned, q })
	}
	return entries.sort((a, b) => b.q - a.q).map((e) => e.tag)
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

// -------- resolving Msg values (see @/models/messages.models) --------

// the formatting vocabulary every translator renders unasked; custom tags come in through Translator.withTags
export const STANDARD_TAGS: Msgs.TagRenderers<Msgs.StandardTag> = {
	strong: (chunks) => React.createElement('strong', null, ...chunks),
	code: (chunks) => React.createElement('code', null, ...chunks),
}

export function createTranslator(props: Msgs.LocalizationProps): Msgs.Translator {
	return makeTranslator(props, undefined)
}

function makeTranslator(props: Msgs.LocalizationProps, custom: Msgs.TagRenderers | undefined): Msgs.Translator<string> {
	const { locale } = props
	const dyn = <V>(value: Msgs.Dyn<V>): V => (typeof value === 'function' ? (value as (props: Msgs.LocalizationProps) => V)(props) : value)
	const strArgs = (args?: Msgs.TArgs): MessageValues | undefined => {
		if (!args) return undefined
		const out: MessageValues = {}
		for (const [name, value] of Object.entries(args)) out[name] = Msgs.isTString(value) ? str(value) : value
		return out
	}
	// tag renderers and args share the ICU values namespace, so an arg may shadow a renderer of the same name
	const nodeArgs = (args?: Msgs.TRichArgs): MessageValues => {
		const out: MessageValues = { ...STANDARD_TAGS, ...custom }
		if (args) for (const [name, value] of Object.entries(args)) out[name] = Msgs.isTTarget(value) ? render(value) : value
		return out
	}
	const str = (target: Msgs.TString): string => {
		if (target.parts) return target.parts.map(str).join(target.original)
		if (target.verbatim) return target.original
		return translate(target.original, strArgs(target.args), locale, target.context)
	}
	const rich = (target: Msgs.TRichText): React.ReactNode => translateNode(target.original, nodeArgs(target.args), locale, target.context)
	const render = (target: Msgs.TTarget): React.ReactNode => (Msgs.isTString(target) ? str(target) : rich(target))
	const warnBase = (base: Msgs.WarnOptionsBase): Msgs.WarnOptionsBase<string> => {
		if (Msgs.isTString(base)) return str(base)
		if (Array.isArray(base)) return base.map(str)
		return { msg: Array.isArray(base.msg) ? base.msg.map(str) : str(base.msg) }
	}
	return {
		locale,
		withTags: (extra) => makeTranslator(props, { ...custom, ...extra }),
		text: (msg) => str(Msgs.isTString(msg) ? msg : dyn(msg.text)),
		broadcast: (msg) => str(dyn((msg.broadcast ?? msg.text)!)),
		warn: (msg) => {
			const warn: Msgs.WarnOptions = (msg.warn ?? msg.text)!
			if (typeof warn === 'function') {
				return (ctx) => {
					const base = warn(ctx)
					return base === undefined ? undefined : warnBase(base)
				}
			}
			return warnBase(warn)
		},
		toast: (msg) => {
			if (!msg.toast) return [str(dyn(msg.text!))]
			const [message, options] = dyn(msg.toast)
			return options?.description !== undefined ? [render(message), { description: render(options.description) }] : [render(message)]
		},
		confirm: (msg) => {
			const confirm = dyn(msg.confirm)
			return {
				title: render(confirm.title),
				confirmLabel: render(confirm.confirmLabel),
				...(confirm.description !== undefined ? { description: render(confirm.description) } : {}),
			}
		},
		richText: (msg) => {
			if (Msgs.isTTarget(msg)) return render(msg)
			return msg.richText ? rich(dyn(msg.richText)) : str(dyn(msg.text!))
		},
	}
}

const translators = new Map<string, Msgs.Translator>()

// The translator for one HTTP request, chosen from the only preference an unauthenticated visitor carries.
export function translatorForRequest(acceptLanguage: string | undefined): Msgs.Translator {
	return translatorFor(negotiateLocale(parseAcceptLanguage(acceptLanguage)))
}

export function translatorFor(locale: string): Msgs.Translator {
	let tr = translators.get(locale)
	if (!tr) {
		tr = createTranslator({ locale })
		translators.set(locale, tr)
	}
	return tr
}

// The viewer's translator, following the ambient locale. Only a browser has one viewer, so this is the client's;
// on the server it stands for the source language, which is what a log line or a test assertion wants.
export const ambient: Msgs.Translator = liveTranslator(getAmbientLocale)

// A translator that re-reads its locale on every call, for a long-lived ctx whose locale is a live setting.
export function liveTranslator(locale: () => string, tags?: Msgs.TagRenderers): Msgs.Translator<string> {
	const derived = new Map<string, Msgs.Translator<string>>()
	const current = () => {
		const resolved = locale()
		let tr = derived.get(resolved)
		if (!tr) {
			tr = tags ? translatorFor(resolved).withTags(tags) : (translatorFor(resolved) as Msgs.Translator<string>)
			derived.set(resolved, tr)
		}
		return tr
	}
	return {
		get locale() {
			return locale()
		},
		withTags: (extra) => liveTranslator(locale, { ...tags, ...extra }),
		text: (msg) => current().text(msg),
		broadcast: (msg) => current().broadcast(msg),
		warn: (msg) => current().warn(msg),
		toast: (msg) => current().toast(msg),
		confirm: (msg) => current().confirm(msg),
		richText: (msg) => current().richText(msg),
	}
}
