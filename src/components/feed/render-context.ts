// What a dom-built row needs that a react component would have taken from a hook, and where an interaction on one
// finds it again.
//
// A row is plain dom, so it carries no closures: everything an event handler needs is either an attribute on the
// element or a payload hung off it, and the ambient state (which server, which windows outlet, how teams are
// labelled) is looked up from the enclosing scope. One scope per host element, one host element per react component
// that mounts dom.

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as MH from '@/models/match-history.models'
import type * as PG from '@/models/player-groupings.models'
import type * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'

export const SCOPE_ATTR = 'data-dom-scope'

export type RenderCtx = {
	scopeId: string
	stores: SquadServerFrame.KeyProp
	// the draggable-window outlet a window opened from here belongs to (react context, resolved once per scope)
	outletKey: unknown
	// what a popover opened from here has to clear; see @/models/zindex
	zIndexBase: number
	displayTeamsNormalized: boolean
	// per-match stores for scopes whose rows span servers (the history page); a dashboard scope leaves it
	// unset and everything uses `stores`
	storesForMatch?: (matchId: number | null | undefined) => SquadServerFrame.KeyProp | undefined
	// a results context renders every event its query matched, including teamless chat the live feed drops
	showTeamlessChat?: boolean
	// and including the types the feed draws nothing for, which appear as a type-and-payload placeholder
	// rather than as a silent gap between the result count and the rows
	placeholderUndrawn?: boolean
	matchById: (matchId: number | null | undefined) => MH.MatchDetails | undefined
	// the most recent match on record, and the one in progress -- not always the same match
	latestMatch: MH.MatchDetails | undefined
	currentMatch: MH.MatchDetails | undefined
	groupColor: (playerId: string, player: PG.PlayerFactsSource | undefined) => string | null
	// The display names an app event's actor resolves to. Looked up through the ctx rather than by a hook, so the
	// app-event templates stay inert and serialize on the server like every other row. A name the caller cannot
	// resolve comes back undefined and the template falls back to naming the actor generically.
	userLabel: (userId: USR.UserId) => string | undefined
	pluginName: (pluginId: string) => string | undefined
	// One page of the rendered event rows behind a results row's count, by ROW_EVENTS_ATTR key. Supplied by
	// the page rather than closed over by the row, which has no closures to give. The cursor is opaque here:
	// it is parked on the row as json and handed back to resume.
	loadRowEvents?: (key: string, cursor?: unknown) => Promise<{ rows: string[]; nextCursor?: unknown }>
}

// Whether a row's timestamp carries its date as well as its time. Ambient rather than a prop or a ctx field,
// like the render locale: every row draws its time through one atom, and the alternative is threading a flag
// through every template that renders an EventLine. Only ever set around a synchronous render pass.
//
// The history page's results want it (they span days and servers); the live feed and the player window,
// which are one match or one recent slice, do not.
let fullTimestamps = false

export function setFullTimestamps(value: boolean): boolean {
	const previous = fullTimestamps
	fullTimestamps = value
	return previous
}

export function usingFullTimestamps(): boolean {
	return fullTimestamps
}

// The match a row belongs to, drawn beside its time where a feed's rows span several of them. Ambient for
// the same reason the timestamp format is: every row draws its time through one atom, and reaching that atom
// with a per-row field means threading it through all 86 EventLine call sites. Only ever set around a
// synchronous render of one row (see renderEventRows).
let rowMatchId: number | undefined

export function setRowMatchId(matchId: number | undefined): number | undefined {
	const previous = rowMatchId
	rowMatchId = matchId
	return previous
}

export function currentRowMatchId(): number | undefined {
	return rowMatchId
}

const scopes = new Map<string, RenderCtx>()

export function register(ctx: RenderCtx) {
	scopes.set(ctx.scopeId, ctx)
}

export function unregister(scopeId: string) {
	scopes.delete(scopeId)
}

export function scopeOf(node: Element | null | undefined): RenderCtx | undefined {
	const host = node?.closest(`[${SCOPE_ATTR}]`)
	if (!host) return undefined
	return scopes.get(host.getAttribute(SCOPE_ATTR)!)
}

let nextScopeId = 0
export function newScopeId() {
	return `s${nextScopeId++}`
}

// -------- interaction targets --------
//
// Written as attributes, never as element-attached payloads: the markup may have been rendered on the server,
// and everything an interaction needs beyond these attributes (which frame, which outlet) is resolved from
// the enclosing scope at interaction time. The builders return attribute objects for a template to spread.

export type MenuTarget =
	| { kind: 'player'; playerId: SM.PlayerId }
	| { kind: 'squad'; squad: Pick<SM.Squad, 'squadId' | 'squadName' | 'teamId'> & { uniqueId?: number } }
	// the layer a row is about, and the match it was played in where the row has one. Acts on neither a
	// server nor a roster, so it is the one target that opens with no frame at all.
	| { kind: 'layer'; layerIds: string[]; historyEntryIds?: number[] }

export type WindowTarget = {
	windowId: string
	// the serializable props; the delegated handler adds `stores` from the scope per the frame mode
	arg: Record<string, unknown>
	// 'attach': add stores when the scope can supply one, open frameless otherwise.
	// 'require': the window is meaningless without one, so no stores means no open.
	frame?: 'attach' | 'require'
	// which match's server the stores should come from, for scopes whose rows span servers
	matchId?: number | null
	preload?: boolean
}

export type TipContent = { heading?: string; text: string }

export type Attrs = Record<string, string | number | undefined>

export const MENU_ATTR = 'data-dom-menu'
export const WINDOW_ATTR = 'data-dom-window'
export const WINDOW_ARG_ATTR = 'data-dom-window-arg'
export const WINDOW_FRAME_ATTR = 'data-dom-window-frame'
export const WINDOW_PRELOAD_ATTR = 'data-dom-window-preload'
export const MATCH_ATTR = 'data-dom-match'
export const TIP_ATTR = 'data-dom-tip'
export const TIP_HEADING_ATTR = 'data-dom-tip-heading'
/** an epoch the tooltip formats when it opens, so 600 rows don't each pay for a timezone-qualified timestamp */
export const TIP_TIME_ATTR = 'data-dom-tip-time'
/** shift-clicking one selects every admin, ctrl-shift every admin on either side */
export const ADMIN_BADGE_ATTR = 'data-dom-admin-badge'
/** a name whose colour follows the active player grouping, recoloured in place rather than rebuilt */
export const PLAYER_ATTR = 'data-dom-player'

// A results row that can show the events behind its own number, as `player:<eosId>` or `match:<id>`.
//
// Two rows: the data row carries the key, and a panel row underneath spans the table and holds the events.
// A panel row rather than a disclosure inside the count's cell, because the events want the width of the
// whole table and a cell would make its own column grow to fit them.
//
// The rows stay inert. They carry the key, an empty slot and a hidden panel; the ctx knows how to fill it.
export const ROW_EVENTS_ATTR = 'data-dom-row-events'
export const ROW_EVENTS_PANEL_ATTR = 'data-dom-row-events-panel'
export const ROW_EVENTS_SLOT_ATTR = 'data-dom-row-events-slot'
export const ROW_EVENTS_MORE_ATTR = 'data-dom-row-events-more'
// the one line a slot uses to say it is loading, or that it could not
export const ROW_EVENTS_STATUS_ATTR = 'data-dom-row-events-status'
// set once the slot has been filled, so hovering and opening do not fetch twice
export const ROW_EVENTS_DONE_ATTR = 'data-dom-row-events-done'
// the page cursor the next "load more" resumes from, parked on the row between fetches
export const ROW_EVENTS_CURSOR_ATTR = 'data-dom-row-events-cursor'
// on the data row while its panel is showing, which is what turns the chevron
export const ROW_OPEN_ATTR = 'data-open'

export function menuAttrs(target: MenuTarget, matchId?: number | null): Attrs {
	return {
		[MENU_ATTR]: JSON.stringify(target),
		[MATCH_ATTR]: matchId ?? undefined,
	}
}

export function windowAttrs(target: WindowTarget): Attrs {
	return {
		[WINDOW_ATTR]: target.windowId,
		[WINDOW_ARG_ATTR]: JSON.stringify(target.arg),
		[WINDOW_FRAME_ATTR]: target.frame,
		[MATCH_ATTR]: target.matchId ?? undefined,
		[WINDOW_PRELOAD_ATTR]: target.preload ? '' : undefined,
	}
}

export type AdminBadge = { teamId: SM.TeamId | null; matchId?: number | null }

export function adminBadgeAttrs(badge: AdminBadge): Attrs {
	return {
		[ADMIN_BADGE_ATTR]: badge.teamId === null ? '' : String(badge.teamId),
		[MATCH_ATTR]: badge.matchId ?? undefined,
	}
}

export function colourAttrs(playerId: SM.PlayerId): Attrs {
	return { [PLAYER_ATTR]: playerId }
}

export function adminBadgeOf(node: Element): AdminBadge | undefined {
	const raw = node.getAttribute(ADMIN_BADGE_ATTR)
	if (raw === null) return undefined
	return { teamId: raw === '' ? null : (Number(raw) as SM.TeamId), matchId: matchIdOf(node) }
}

export function menuTargetOf(node: Element): MenuTarget | undefined {
	const raw = node.getAttribute(MENU_ATTR)
	if (!raw) return undefined
	try {
		return JSON.parse(raw) as MenuTarget
	} catch {
		return undefined
	}
}

export function windowTargetOf(node: Element): WindowTarget | undefined {
	const windowId = node.getAttribute(WINDOW_ATTR)
	if (!windowId) return undefined
	let arg: Record<string, unknown>
	try {
		arg = JSON.parse(node.getAttribute(WINDOW_ARG_ATTR) ?? '{}') as Record<string, unknown>
	} catch {
		return undefined
	}
	const frame = node.getAttribute(WINDOW_FRAME_ATTR)
	return {
		windowId,
		arg,
		frame: frame === 'attach' || frame === 'require' ? frame : undefined,
		matchId: matchIdOf(node),
		preload: node.getAttribute(WINDOW_PRELOAD_ATTR) !== null,
	}
}

// A window-opening click is only handled once it reaches the document (see interactions.ts), so an enclosing
// row with a click handler of its own has to skip these rather than have the name stop propagation.
export function opensWindow(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest(`[${WINDOW_ATTR}]`) !== null
}

export function matchIdOf(node: Element): number | undefined {
	const raw = node.getAttribute(MATCH_ATTR)
	if (raw === null) return undefined
	const matchId = Number(raw)
	return Number.isFinite(matchId) ? matchId : undefined
}

/**
 * Repaints every name under `root` against the current grouping.
 *
 * Battlemetrics data arrives as a stream, and a name's colour is the only thing in a row that follows it. Rebuilding
 * the rows for that would throw away every open disclosure and every measured row height, so the colours are written
 * over the top instead. The element carries only the player id; the facts come from the caller, who has the events
 * the rows were rendered from.
 */
export function applyGroupColors(
	root: Element,
	resolve: (playerId: SM.PlayerId, player: PG.PlayerFactsSource) => string | null,
	factsOf: (playerId: SM.PlayerId) => PG.PlayerFactsSource | undefined,
) {
	for (const node of root.querySelectorAll<HTMLElement>(`[${PLAYER_ATTR}]`)) {
		const playerId = node.getAttribute(PLAYER_ATTR)
		if (!playerId) continue
		const facts = factsOf(playerId)
		node.style.color = (facts && resolve(playerId, facts)) ?? ''
	}
}
