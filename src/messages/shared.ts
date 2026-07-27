import * as React from 'react'

import { assertNever } from '@/lib/type-guards'
import * as I18n from '@/messages/i18n'
import type { WarnOptions } from '@/models/squad-rcon.models'

// Resolves one string inside a target body, for a message whose shape is richer than a bare pattern: a toast with a
// description, a confirmation dialog's three parts, one of a warn's several popups. `node` is the same for a target
// that positions rendered nodes inside its sentence.
export const t = I18n.translate
export const node = I18n.translateNode

// The inline elements a message may put around part of its own sentence, so which words are emphasised travels with
// the text and a translator can move it. How they LOOK is still the container's, through `[&_strong]:` and friends.
export const tags = {
	strong: (chunks: React.ReactNode[]) => React.createElement('strong', null, ...chunks),
	code: (chunks: React.ReactNode[]) => React.createElement('code', null, ...chunks),
}

// Distinguishes two messages whose English is identical but whose translations are not: "Cancel" the dialog
// dismissal against "Cancel" the lifting of a timeout. Part of the key, never rendered.
export type MsgOpts = { context?: string }

// The vocabulary every message is written in. This module must stay an import leaf -- models absorb their own text
// from here, and the display layer they feed imports them back, so a value import from @/lib or @/models closes a
// module-init cycle. Formatters that need those live in ./format.ts.

// The arguments a sonner toast call takes, so a message can carry a description without its caller unpacking one:
// `toast.error(...m.toast())`. Which of toast/toast.error/toast.warning delivers it stays with the caller, since
// that is a severity decision the surface already owns.
export type ToastArgs = readonly [message: React.ReactNode, options?: { description?: React.ReactNode }]

// The text of a confirmation dialog. Deliberately not the alert dialog's whole options object: `content` is JSX the
// component owns, `variant` is styling, and the button `id` the caller matches the result against is protocol.
export type ConfirmOptions = { title: string; description?: string; confirmLabel: string }

// The surfaces a message can be delivered on. A message offers whatever subset it has something sensible to say on,
// and the compiler rejects `.toast()` on one that declares no toast.
//
// `react` and `toast` are SIBLINGS of `warn`, never wrappers around it: warn's return type is the WarnOptions union
// (a string, one string per popup, or a per-recipient function), which React cannot render, and a ReactNode handed to
// RCON would broadcast "[object Object]". Keeping the signatures divergent is what makes the compiler enforce that.
//
// `text` is the surface-agnostic one: a log line, an Error message, an HTTP response body. It exists because those
// callers need a plain string and neither `warn` (a union they cannot narrow) nor `react` (a node) can give them one.
export type Targets = {
	// broadcast and warn render for a game server and for one of its players, not for whoever is looking at the web
	// app, so they are handed the locale to render in. Every other target renders for the viewer, whose locale is
	// ambient.
	broadcast?: (locale?: string) => string
	warn?: (locale?: string) => WarnOptions
	react?: () => React.ReactNode
	toast?: () => ToastArgs
	confirm?: () => ConfirmOptions
	text?: () => string
}

// Who an admin action is being applied to. The same action is offered on one player, on a selection, and on a squad,
// and the only thing that differs between the three is how the subject is named -- so it is a parameter rather than
// three copies of every message.
export type Target =
	| { kind: 'player'; username?: string }
	// fullSquad titles the dialog "... Squad" while still describing the selection as N players, matching the menu
	// item, which reads "Warn Squad" when the selection happens to be exactly one squad's membership
	| { kind: 'players'; count: number; fullSquad?: boolean }
	| { kind: 'squad'; squadName: string; count: number }

// names the target in a dialog title: "Kill <this>"
export function targetNoun(target: Target) {
	switch (target.kind) {
		case 'player':
			return 'Player'
		case 'players':
			return target.fullSquad ? 'Squad' : 'Players'
		case 'squad':
			return 'Squad'
		default:
			assertNever(target)
	}
}

// names the target inside a question: "Kill <this>?"
export function targetSubject(target: Target) {
	switch (target.kind) {
		case 'player':
			return target.username ?? 'this player'
		case 'players':
			return `these ${target.count} players`
		case 'squad':
			return `the ${target.count} members of squad "${target.squadName}"`
		default:
			assertNever(target)
	}
}

// names the target inside a report of what happened: "Killed <this>"
export function targetAffected(target: Target) {
	switch (target.kind) {
		case 'player':
			return target.username ?? 'player'
		case 'players':
			return `${target.count} player${target.count === 1 ? '' : 's'}`
		case 'squad':
			return `squad "${target.squadName}"`
		default:
			assertNever(target)
	}
}

// A text target that resolves against a locale, which only the shorthands below can produce. A target map written
// out by hand carries whatever string its author wrote, so its `text` takes no locale and the compiler says so:
// passing one is an error until that message is rewritten as an ICU pattern.
type TextTarget = { readonly text: (locale?: string) => string }

// Declares a message. The factory body is where logic shared between a message's targets lives -- reachable by every
// target of THIS message and by nothing else, and computed once per message rather than once per target.
//
// `const T` keeps the target map inferred narrowly, so a message with no toast errors on `.toast()` rather than
// silently handing back undefined. Args are declared once, on the factory, so targets cannot drift on what they take.
//
// A message whose only target is `text` says so by producing the string directly: `def('Close')` where it takes no
// arguments, `def((count: number) => ...)` where it does. That is four fifths of the messages in this tree, and the
// bare form is the only one holding its text as data rather than as code, which is why it is the one this function
// can resolve against a locale on the author's behalf. Every other shape stays the target map.
//
// A message that takes arguments becomes translatable by declaring an ICU pattern and a mapping from its own
// parameters to that pattern's values. The mapping lives here so the call site keeps the signature it always had:
//
//   export const addLayers = Msgs.def(
//     '{count, plural, =0 {Add Layers} one {Add 1 Layer} other {Add # Layers}}',
//     (count: number) => ({ count }),
//   )
//
// The target-map overload has to come first: a candidate ahead of it types the factory body without `Targets` as its
// contextual type, and a `toast` returning an array literal then infers as an array rather than as a tuple.
export function def<A extends readonly unknown[], const T extends Targets>(build: (...args: A) => T): (...args: A) => T
export function def<A extends readonly unknown[]>(
	icu: string,
	values: (...args: A) => I18n.MessageValues,
	opts?: MsgOpts,
): (...args: A) => TextTarget
export function def<A extends readonly unknown[]>(build: (...args: A) => string): (...args: A) => TextTarget
export function def(text: string, opts?: MsgOpts): () => TextTarget
export function def(
	build: string | ((...args: never[]) => unknown),
	values?: ((...args: never[]) => I18n.MessageValues) | MsgOpts,
	opts?: MsgOpts,
) {
	if (typeof build === 'string') {
		if (typeof values === 'function') {
			return (...args: never[]) => ({ text: (locale?: string) => I18n.translate(build, values(...args), locale, opts?.context) })
		}
		return () => ({ text: (locale?: string) => I18n.translate(build, undefined, locale, values?.context) })
	}
	return (...args: never[]) => {
		const built = build(...args)
		return typeof built === 'string' ? { text: () => built } : built
	}
}
