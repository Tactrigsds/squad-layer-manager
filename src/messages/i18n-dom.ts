// Resolving a message to dom nodes instead of react elements.
//
// The two paths share everything that matters: the same catalogue, the same ICU evaluation, the same message
// builders. ICU already treats an argument as opaque and hands it back positioned inside the sentence, so the only
// react in @/messages/i18n is the tag renderers and the node it assembles at the end. This is that ending, in dom.

import * as Dom from '@/lib/dom'
import * as I18n from '@/messages/i18n'
import * as Msgs from '@/models/messages.models'

export type DomTagRenderers<T extends string = string> = Record<T, I18n.DomTagRenderer>

const STANDARD_TAGS: DomTagRenderers<Msgs.StandardTag> = {
	strong: (chunks) => Dom.el('strong', null, chunks),
	em: (chunks) => Dom.el('em', null, chunks),
	code: (chunks) => Dom.el('code', null, chunks),
}

function coerce(part: unknown): Dom.Child {
	if (part === null || part === undefined || part === false) return null
	if (Dom.isNode(part)) return part
	if (Array.isArray(part)) return part.map(coerce)
	// whatever ICU produced that isn't one of ours: a formatted number, plural or date part
	return String(part as string | number)
}

function assemble(parts: string | unknown[]): Node | string {
	if (typeof parts === 'string') return parts
	if (parts.length === 1) {
		const only = coerce(parts[0])
		if (typeof only === 'string' || Dom.isNode(only)) return only
	}
	return Dom.frag(parts.map(coerce))
}

export interface DomTranslator<T extends string = never> {
	readonly locale: string
	withTags<U extends string>(tags: DomTagRenderers<U>): DomTranslator<T | U>
	text(msg: Msgs.Variants.Textable | Msgs.TString): string
	richText(msg: Msgs.Variants.TRichTextable<T> | Msgs.TTarget<T>): Node | string
}

function make(locale: () => string, custom: DomTagRenderers | undefined): DomTranslator<string> {
	// the string surface is the same on both: it resolves to text, which has no node type to disagree about
	const strTr = () => I18n.translatorFor(locale())
	const dyn = <V>(value: Msgs.Dyn<V>): V =>
		typeof value === 'function' ? (value as (props: Msgs.LocalizationProps) => V)({ locale: locale() }) : value

	// tag renderers and args share the ICU values namespace, so an arg may shadow a renderer of the same name
	const nodeArgs = (args?: Msgs.TRichArgs): I18n.MessageValues => {
		const out: I18n.MessageValues = { ...STANDARD_TAGS, ...custom }
		if (args) for (const [name, value] of Object.entries(args)) out[name] = Msgs.isTTarget(value) ? render(value) : value
		return out
	}
	const rich = (target: Msgs.TRichText): Node | string =>
		assemble(I18n.resolve(target.original, nodeArgs(target.args), locale(), target.context))
	const render = (target: Msgs.TTarget): Node | string => (Msgs.isTString(target) ? strTr().text(target) : rich(target))

	return {
		get locale() {
			return locale()
		},
		withTags: (extra) => make(locale, { ...custom, ...extra }),
		text: (msg) => strTr().text(msg),
		richText: (msg) => {
			if (Msgs.isTTarget(msg)) return render(msg)
			return msg.richText ? rich(dyn(msg.richText)) : strTr().text(dyn(msg.text!))
		},
	}
}

/** The viewer's translator, following the ambient locale, in dom. The counterpart to `tr` in @/systems/messages.client. */
export const ambient: DomTranslator<string> = make(I18n.getAmbientLocale, undefined)
