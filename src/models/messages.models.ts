import type React from 'react'

import type * as CS from '@/models/context-shared'
import type * as SM from '@/models/squad.models'

// Import leaf: models absorb their text through this vocabulary and the display layer imports those models back, so
// a value import from @/lib or @/models closes a module-init cycle. Type imports only.

type Serializable = string | number | boolean | bigint | Date | undefined | null

// An arg may itself be translatable, for a message that interpolates a translated noun. Rich text may position any
// target, string or rich, inside its sentence.
//
// Rich text may also position an already-rendered node, which is the line between the two: a TString is data, and
// travels to whoever reads it, while rich text is resolved where it is displayed and never crosses a wire. The
// activity feed is the case that needs it -- its slots are players, squads and layers the feed renders as links,
// one per event, which is content rather than the static formatting a custom tag stands for.
export type TArgs = Record<string, Serializable | TString>
export type TRichArgs<T extends string = string> = Record<string, Serializable | TString | TRichText<T> | Rendered>

// An already-rendered slot, whose node type belongs to the surface doing the rendering rather than to the message.
// Every react surface passes a ReactNode; the activity feed passes a dom node, because it builds its rows without
// react. A message only positions the thing, so it never looks inside either.
export type Rendered = React.ReactNode | Node

// The inline elements a rich pattern may put around parts of its own sentence: `press <strong>{key}</strong>`,
// `edited by <user>{name}</user>`. A renderer resolves one tag's chunks to a node. The standard formatting set is
// ambient on every Translator; a custom tag must be handed to the translator (Translator.withTags, or
// useTranslator's second argument) before it will accept the message, which the phantom parameter on TRichText
// enforces at compile time.
export type TagRenderer = (chunks: React.ReactNode[]) => React.ReactNode
export type TagRenderers<T extends string = string> = Record<T, TagRenderer>

// rendered by every translator unasked; the renderers live in @/messages/i18n (STANDARD_TAGS), typed against this
export type StandardTag = 'strong' | 'em' | 'code'

// The tag names a pattern uses, read from its literal type. A closing tag, an empty "<>", or a "<" followed by
// whitespace (prose like "a < b") is not a name. `a<b` with no spaces still reads as a tag; quote the "<" per ICU
// ('<') where that bites.
type TagName<T extends string> = T extends '' ? never : T extends `/${string}` ? never : T extends `${string} ${string}` ? never : T
export type TagsOf<S extends string> = S extends `${string}<${infer Tag}>${infer Rest}` ? TagName<Tag> | TagsOf<Rest> : never
export type CustomTagsOf<S extends string> = Exclude<TagsOf<S>, StandardTag>

type NoSelfClosing<S extends string> = S extends `${string}/>${string}`
	? 'ICU does not support self-closing tags; write <tag></tag>'
	: unknown
type NoTags<S extends string> = [TagsOf<S>] extends [never] ? unknown : 'this pattern contains tags, which only rich text renders; use rt'

// A translatable string: its English source, which is also the catalogue key, with its ICU values unresolved.
// `context` distinguishes two messages whose English is identical but whose translations are not: "Cancel" the
// dialog dismissal against "Cancel" the lifting of a timeout. Part of the catalogue key, never rendered.
export type TString = {
	$msg: 'string'
	original: string
	args?: TArgs
	context?: string
	// set by raw(): `original` is a value, not a pattern
	verbatim?: true
	// set by join(): these are resolved and concatenated, with `original` as the separator
	parts?: TString[]
}

// T is the custom tags the pattern (and its nested targets) use, so a Translator that cannot render them rejects
// the message at compile time. Phantom: nothing ever sets `tags`, renderers live on the Translator, and the value
// stays serializable.
export type TRichText<T extends string = string> = {
	$msg: 'rich-text'
	original: string
	args?: TRichArgs
	context?: string
	tags?: readonly T[]
}

export type TTarget<T extends string = string> = TString | TRichText<T>

// Rejects an argument typed as plain `string`: a message is only translatable when its source is written at the
// call site, where the extractor can read it. This is the type-level half of that guarantee; the lexical half is
// `pnpm i18n:lint` (src/scripts/extract-messages.ts), which shares its visitor with the extractor.
type Literal<S extends string> = string extends S ? 'must be a compile-time string literal' : unknown

export type TOpts<C extends string = string> = { context?: C & Literal<C> }

export function t<S extends string, C extends string = string>(
	original: S & Literal<S> & NoTags<S>,
	args?: TArgs,
	opts?: TOpts<C>,
): TString {
	return { $msg: 'string', original, args, context: opts?.context }
}

// AT surfaces the custom tags of nested rich args, so they join the pattern's own in the result's requirement.
// NoInfer keeps AT inferring from the args alone: without it, an rt written inline in a def body picks the
// surface's contextual TRichText<string> up through its return type, which erases the requirement.
export function rt<S extends string, AT extends string = never, C extends string = string>(
	original: S & Literal<S> & NoSelfClosing<S>,
	args?: TRichArgs<AT>,
	opts?: TOpts<C>,
): TRichText<CustomTagsOf<S> | NoInfer<AT>> {
	return { $msg: 'rich-text', original, args, context: opts?.context }
}

// Text that came from outside the app: an error string the game server sent back, a BattleMetrics note, something a
// user typed. It reaches a reader unchanged, with no catalogue entry and no ICU parse, which is what separates it
// from prose the app owns -- `t` refuses a non-literal precisely so that this case has to say what it is.
export function raw(value: string): TString {
	return { $msg: 'string', original: value, verbatim: true }
}

// Several sentences read as one, for a body the app assembles at runtime: the lines of a teamswap receipt, one
// entry per command in a help listing. Each part is translated on its own, so the count of them does not have to be
// something an ICU pattern could have known.
export function join(parts: readonly TString[], separator = '\n'): TString {
	return { $msg: 'string', original: separator, parts: [...parts] }
}

export function isTString(value: unknown): value is TString {
	return (value as TString | undefined)?.$msg === 'string'
}
export function isTRichText(value: unknown): value is TRichText {
	return (value as TRichText | undefined)?.$msg === 'rich-text'
}
export function isTTarget(value: unknown): value is TTarget {
	return isTString(value) || isTRichText(value)
}

// What a renderer knows about who it renders for. Locale is enough today: direction and friends derive from it via
// Intl.Locale, and get added here when a message needs them.
export type LocalizationProps = { locale: string }

// A surface whose content depends on the reader in ways ICU cannot express
export type Dyn<V> = V | ((props: LocalizationProps) => V)

export type WarnOptionsBase<T = TString> = { msg: T | T[] } | T | T[]
// returning undefined skips the warning
export type WarnOptions<T = TString> = WarnOptionsBase<T> | ((ctx: SM.Ctx.Player & LocalizationProps) => WarnOptionsBase<T> | undefined)

// The arguments a sonner toast call takes, so a message can carry a description without its caller unpacking one:
// `toast.error(...m.toast())`. Which of toast/toast.error/toast.warning delivers it stays with the caller, since
// that is a severity decision the surface already owns.
export type ToastArgs<T> = readonly [message: T, options?: { description?: T }]

// The text of a confirmation dialog. Deliberately not the alert dialog's whole options object: `content` is JSX the
// component owns, `variant` is styling, and the button `id` the caller matches the result against is protocol.
export type ConfirmOptions<T> = { title: T; description?: T; confirmLabel: T }

// The surfaces a message can deliver on. warn and broadcast go through RCON, which renders plain strings only.
type Surfaces = {
	text: Dyn<TString>
	broadcast: Dyn<TString>
	warn: WarnOptions<TString>
	toast: Dyn<ToastArgs<TTarget>>
	confirm: Dyn<ConfirmOptions<TTarget>>
	richText: Dyn<TRichText>
}

// What a factory body returns: any subset of the surfaces with at least one present. def stamps the brand.
export type MsgInput = { [K in keyof Surfaces]: Pick<Surfaces, K> & Partial<Surfaces> }[keyof Surfaces]

// The brand that tells a message from a bare target, and from any other object that happens to have a `text`.
// A plain discriminant rather than a symbol, so a message survives structural clone, superjson and immer.
type MsgBase = { $msg: 'msg' } & Partial<Surfaces>

export type Msg =
	| Variants.Textable
	| Variants.Broadcastable
	| Variants.Warnable
	| Variants.Toastable
	| Variants.Confirmable
	| Variants.TRichTextable

// `text` stands in for the other single-string surfaces. It does not stand in for confirm: synthesizing a
// title/confirmLabel split from one string is a policy call no Translator should own.
//
// The rich-capable variants take the custom tags their content may use; a Translator instantiates them with the
// tags it can render, which is what rejects an undersupplied message at its render call site.
export namespace Variants {
	export type Textable = MsgBase & Pick<Surfaces, 'text'>
	export type Broadcastable = MsgBase & (Pick<Surfaces, 'broadcast'> | Pick<Surfaces, 'text'>)
	export type Warnable = MsgBase & (Pick<Surfaces, 'warn'> | Pick<Surfaces, 'text'>)
	export type Toastable<T extends string = string> = MsgBase & ({ toast: Dyn<ToastArgs<TTarget<T>>> } | Pick<Surfaces, 'text'>)
	export type Confirmable<T extends string = string> = MsgBase & { confirm: Dyn<ConfirmOptions<TTarget<T>>> }
	export type TRichTextable<T extends string = string> = MsgBase & ({ richText: Dyn<TRichText<T>> } | Pick<Surfaces, 'text'>)
}

export function isMsg(value: unknown): value is Msg {
	return (value as MsgBase | undefined)?.$msg === 'msg'
}

// distributes, so a builder returning different shapes from different branches promotes each
type Promote<B> = B extends TString ? { $msg: 'msg'; text: B } : B extends TRichText ? { $msg: 'msg'; richText: B } : B & { $msg: 'msg' }

function mkText(original: string, args?: TArgs, context?: string): Variants.Textable {
	return { $msg: 'msg', text: { $msg: 'string', original, args, context } }
}

function promote(built: MsgInput | TTarget): Msg {
	if (isTString(built)) return { $msg: 'msg', text: built }
	if (isTRichText(built)) return { $msg: 'msg', richText: built }
	return { ...built, $msg: 'msg' }
}

// Declares a message. The factory body is where logic shared between a message's surfaces lives, computed once per
// message rather than once per surface. The built shape survives in the factory's return type, so a message with no
// toast is rejected by Translator.toast at the call site rather than resolving to undefined.
//
// A message whose only surface is text says so by producing the string directly: `def('Close')`. One that takes
// arguments declares an ICU pattern and a mapping from its own parameters to that pattern's values:
//
//   export const addLayers = Msgs.def(
//     '{count, plural, =0 {Add Layers} one {Add 1 Layer} other {Add # Layers}}',
//     (count: number) => ({ count }),
//   )
//
// A bare target stands for the surface it is: `def(rt('...'))` and `def((n: number) => t('{n} left', { n }))`
// declare a rich-text-only and a text-only message, with no surface object to write.
//
// The builder overloads come first, and infer their result as `const`: without that the declared surface types are
// the body's contextual type, so every message would carry every surface as optional and `toast` returning an
// array literal would infer as an array rather than as a tuple.
export function def<A extends readonly unknown[], const B extends MsgInput | TTarget>(build: (...args: A) => B): (...args: A) => Promote<B>
export function def<const B extends MsgInput | TTarget>(build: B): () => Promote<B>
export function def<A extends readonly unknown[], S extends string, C extends string = string>(
	icu: S & Literal<S> & NoTags<S>,
	values: (...args: A) => TArgs,
	opts?: TOpts<C>,
): (...args: A) => Variants.Textable
export function def<S extends string, C extends string = string>(text: S & Literal<S> & NoTags<S>, opts?: TOpts<C>): () => Variants.Textable
export function def(
	build: string | MsgInput | TTarget | ((...args: never[]) => MsgInput | TTarget),
	values?: ((...args: never[]) => TArgs) | TOpts,
	opts?: TOpts,
) {
	if (typeof build === 'string') {
		if (typeof values === 'function') {
			return (...args: never[]) => mkText(build, values(...args), opts?.context)
		}
		const msg = mkText(build, undefined, values?.context)
		return () => msg
	}
	if (typeof build === 'function') {
		return (...args: unknown[]) => promote((build as (...args: unknown[]) => MsgInput | TTarget)(...args))
	}
	const msg = promote(build)
	return () => msg
}

// One implementation per side is intended: a global instance for the client, whose viewer locale is ambient, and one
// on the server ctx, following the locale of whoever it resolves for. Constructed in @/messages/i18n.
//
// T is the custom tags this translator renders on top of the standard set; the base translators render none.
// withTags derives one that renders more, which is how a component supplies the renderers a message's pattern
// demands: `tr.withTags({ user: chunks => <UserLink>{chunks}</UserLink> })`, or useTranslator's second argument.
export interface Translator<T extends string = never> {
	// exposed so delivery code can hand a per-recipient warn function the LocalizationProps it expects
	readonly locale: string
	withTags<U extends string>(tags: TagRenderers<U>): Translator<T | U>
	// text and richText also take a bare target, for the lookup tables that hold one per key rather than a message
	text(msg: Variants.Textable | TString): string
	broadcast(msg: Variants.Broadcastable): string
	warn(msg: Variants.Warnable): WarnOptions<string>
	toast(msg: Variants.Toastable<T>): ToastArgs<React.ReactNode>
	confirm(msg: Variants.Confirmable<T>): ConfirmOptions<React.ReactNode>
	richText(msg: Variants.TRichTextable<T> | TTarget<T>): React.ReactNode
}

// The CtxDef lives in @/server/context.ts (TranslatorDef): this module holds no values.
export type Ctx = CS.Ctx & {
	tr: Translator
}
