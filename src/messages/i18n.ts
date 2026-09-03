import * as React from 'react'

import * as ICU from '@/messages/icu'
// messages.models is itself a type-only leaf, so this value import keeps i18n one too
import * as Msgs from '@/models/messages.models'

import compiledEnglish from '../../data/generated/messages/en.compiled.json'

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

// What ICU is handed for one message's arguments. ICU never looks inside a value, so the node type is whichever
// surface is rendering: react's for a component tree, the dom's for the activity feed (see @/messages/i18n-dom).
export type MessageValues = Record<string, Msgs.Rendered | Date | Msgs.TagRenderer | DomTagRenderer>

export type DomTagRenderer = (chunks: (Node | string)[]) => Node | string

// The catalogues a build carries, holding each message's compiled form (@/messages/icu).
//
// English is built in rather than registered, so there is no boot step to miss: it is the source language, and a
// process that renders anything at all needs it. It holds only the messages that have structure. The ~1,300 that
// are only text are absent from it, and resolving one hands the key straight back, with no allocation.
//
// The compiled form is the only one the runtime can read, so a message interpolates its arguments only if the
// extractor saw it. `pnpm i18n:lint` is what makes that true of every message in src.
const catalogues: Record<string, Record<string, ICU.Entry>> = {
	// through unknown because JSON widens the compiled form's tuples to arrays; the extractor is what types it
	[DEFAULT_LOCALE]: compiledEnglish as unknown as Record<string, ICU.Entry>,
}

export function registerCatalogue(locale: string, messages: Record<string, ICU.Entry>) {
	catalogues[locale] = catalogues[locale] ? { ...catalogues[locale], ...messages } : messages
}

export function availableLocales() {
	return [...new Set([DEFAULT_LOCALE, ...Object.keys(catalogues)])]
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

const intlLocales = new Map<string, string>()

// A locale reaching here from a stored setting or an Accept-Language header may be anything at all, and the Intl
// constructors a plural needs throw on a tag they cannot parse. English is a better answer than a blank page.
function intlLocale(locale: string) {
	let resolved = intlLocales.get(locale)
	if (resolved === undefined) {
		resolved = Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : DEFAULT_LOCALE
		intlLocales.set(locale, resolved)
	}
	return resolved
}

export function key(source: string, context?: string) {
	return context ? `${source} [${context}]` : source
}

// A message's text, or the parts of it once its arguments are interpolated. A locale that is missing a key falls
// back to the English compiled form rather than to the source, so an untranslated message still interpolates.
export function resolve(
	source: string,
	values: MessageValues | undefined,
	locale: string,
	context: string | undefined,
): string | unknown[] {
	const k = key(source, context)
	const entry = catalogues[locale]?.[k] ?? catalogues[DEFAULT_LOCALE]?.[k] ?? source
	if (typeof entry === 'string') return entry
	try {
		return ICU.evaluate(entry, (values ?? {}) as ICU.Values, intlLocale(locale))
	} catch {
		// a value or a tag renderer the caller did not supply; its own English reads better than a half-built sentence
		return source
	}
}

// Resolves a message to a string. `source` is both the key and the English.
export function translate(source: string, values?: MessageValues, locale?: string, context?: string): string {
	const parts = resolve(source, values, locale ?? ambientLocale, context)
	return typeof parts === 'string' ? parts : parts.join('')
}

// The same, for a message whose arguments are rendered nodes. Returns the node list assembled around them.
export function translateNode(source: string, values?: MessageValues, locale?: string, context?: string): React.ReactNode {
	const parts = resolve(source, values, locale ?? ambientLocale, context)
	if (typeof parts === 'string') return parts
	return normalizeNode(parts.length === 1 ? (parts[0] as React.ReactNode) : (parts as React.ReactNode[]))
}

// A run of literal tokens -- command triggers, ids, filenames -- dropped into a sentence. Two things this gets
// right that `join(', ')` does not: the separators and the final conjunction come from the locale, and each token
// is wrapped in a `bdi`, which isolates its direction. Without that isolation an LTR token like `!shownext` in an
// RTL sentence reorders around the neighbouring punctuation, and the reader is shown a command they cannot type.
export function tokenList(
	tokens: string[],
	locale: string,
	opts?: { type?: 'conjunction' | 'disjunction'; tag?: string },
): React.ReactNode {
	const parts = new Intl.ListFormat(locale, { type: opts?.type ?? 'conjunction', style: 'short' }).formatToParts(tokens)
	return parts.map((part, index) =>
		part.type === 'element'
			? React.createElement('bdi', { key: index }, opts?.tag ? React.createElement(opts.tag, null, part.value) : part.value)
			: React.createElement(React.Fragment, { key: index }, part.value),
	)
}

// -------- resolving Msg values (see @/models/messages.models) --------

// the formatting vocabulary every translator renders unasked; custom tags come in through Translator.withTags
export const STANDARD_TAGS: Msgs.TagRenderers<Msgs.StandardTag> = {
	strong: (chunks) => React.createElement('strong', null, ...chunks),
	em: (chunks) => React.createElement('em', null, ...chunks),
	code: (chunks) => React.createElement('code', null, ...chunks),
}

function keyChunks(chunks: React.ReactNode[]): React.ReactNode[] {
	return chunks.map((chunk, index) => React.createElement(React.Fragment, { key: index }, normalizeNode(chunk)))
}

function keyedRenderers<T extends string>(renderers: Msgs.TagRenderers<T> | undefined): Msgs.TagRenderers<T> | undefined {
	if (!renderers) return undefined
	const out = {} as Msgs.TagRenderers<T>
	for (const name in renderers) {
		const render = renderers[name]
		out[name] = (chunks) => render(keyChunks(chunks))
	}
	return out
}

function normalizeNode(node: React.ReactNode): React.ReactNode {
	if (!Array.isArray(node)) return node
	return node.map((part, index) => React.createElement(React.Fragment, { key: index }, normalizeNode(part)))
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
		const out: MessageValues = { ...keyedRenderers(STANDARD_TAGS), ...keyedRenderers(custom) }
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
