import * as dateFns from 'date-fns'
import type React from 'react'

import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import type * as L from '@/models/layer'
import type { WarnOptions } from '@/models/squad-rcon.models'

// Helpers shared between messages. Logic belonging to a single message stays in that message's module.

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
	broadcast?: () => string
	warn?: () => WarnOptions
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

// Declares a message. The implementation is the identity function: everything it buys is in the closure the factory
// body opens, which is where logic shared between a message's targets lives -- reachable by every target of THIS
// message and by nothing else, and computed once per message rather than once per target.
//
// `const T` keeps the target map inferred narrowly, so a message with no toast errors on `.toast()` rather than
// silently handing back undefined. Args are declared once, on the factory, so targets cannot drift on what they take.
export function def<A extends readonly unknown[], const T extends Targets>(build: (...args: A) => T): (...args: A) => T {
	return build
}
