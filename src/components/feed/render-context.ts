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

export const SCOPE_ATTR = 'data-dom-scope'

export type RenderCtx = {
	scopeId: string
	stores: SquadServerFrame.KeyProp
	// the draggable-window outlet a window opened from here belongs to (react context, resolved once per scope)
	outletKey: unknown
	// what a popover opened from here has to clear; see @/models/zindex
	zIndexBase: number
	displayTeamsNormalized: boolean
	matchById: (matchId: number | null | undefined) => MH.MatchDetails | undefined
	// the most recent match on record, and the one in progress -- not always the same match
	latestMatch: MH.MatchDetails | undefined
	currentMatch: MH.MatchDetails | undefined
	groupColor: (playerId: string, player: PG.PlayerFactsSource | undefined) => string | null
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

// -------- interaction payloads --------
//
// Hung off the element rather than serialised into an attribute: an interaction reads it back in the same document
// that wrote it, and the payload dies with the node.

export type MenuTarget =
	| { kind: 'player'; playerId: SM.PlayerId }
	| { kind: 'squad'; squad: Pick<SM.Squad, 'squadId' | 'squadName' | 'teamId'> & { uniqueId?: number } }

export type WindowTarget = { windowId: string; windowProps: unknown; preload: boolean }

export type TipContent = { heading?: string; text: string }

const MENU = Symbol('menuTarget')
const WINDOW = Symbol('windowTarget')
const PLAYER = Symbol('player')
const ADMIN_BADGE = Symbol('adminBadge')

type Carrier<K extends symbol, T> = Element & { [key in K]?: T }

export const MENU_ATTR = 'data-dom-menu'
export const WINDOW_ATTR = 'data-dom-window'
export const TIP_ATTR = 'data-dom-tip'
export const TIP_HEADING_ATTR = 'data-dom-tip-heading'
/** an epoch the tooltip formats when it opens, so 600 rows don't each pay for a timezone-qualified timestamp */
export const TIP_TIME_ATTR = 'data-dom-tip-time'
/** shift-clicking one selects every admin, ctrl-shift every admin on either side */
export const ADMIN_BADGE_ATTR = 'data-dom-admin-badge'
/** a name whose colour follows the active player grouping, recoloured in place rather than rebuilt */
export const PLAYER_ATTR = 'data-dom-player'

export function setMenuTarget<E extends Element>(node: E, target: MenuTarget): E {
	;(node as Carrier<typeof MENU, MenuTarget>)[MENU] = target
	node.setAttribute(MENU_ATTR, '')
	return node
}

export function setWindowTarget<E extends Element>(node: E, target: WindowTarget): E {
	;(node as Carrier<typeof WINDOW, WindowTarget>)[WINDOW] = target
	node.setAttribute(WINDOW_ATTR, '')
	return node
}

export type AdminBadge = { stores: SquadServerFrame.KeyProp; teamId: SM.TeamId | null }

export function setAdminBadge<E extends Element>(node: E, badge: AdminBadge): E {
	;(node as Carrier<typeof ADMIN_BADGE, AdminBadge>)[ADMIN_BADGE] = badge
	node.setAttribute(ADMIN_BADGE_ATTR, '')
	return node
}

export function adminBadgeOf(node: Element): AdminBadge | undefined {
	return (node as Carrier<typeof ADMIN_BADGE, AdminBadge>)[ADMIN_BADGE]
}

export function menuTargetOf(node: Element): MenuTarget | undefined {
	return (node as Carrier<typeof MENU, MenuTarget>)[MENU]
}

export function windowTargetOf(node: Element): WindowTarget | undefined {
	return (node as Carrier<typeof WINDOW, WindowTarget>)[WINDOW]
}

type Coloured = { playerId: SM.PlayerId; player: PG.PlayerFactsSource }

export function setColourTarget<E extends Element>(node: E, playerId: SM.PlayerId, player: PG.PlayerFactsSource): E {
	;(node as Carrier<typeof PLAYER, Coloured>)[PLAYER] = { playerId, player }
	node.setAttribute(PLAYER_ATTR, '')
	return node
}

/**
 * Repaints every name under `root` against the current grouping.
 *
 * Battlemetrics data arrives as a stream, and a name's colour is the only thing in a row that follows it. Rebuilding
 * the rows for that would throw away every open disclosure and every measured row height, so the colours are written
 * over the top instead.
 */
export function applyGroupColors(root: Element, resolve: (playerId: SM.PlayerId, player: PG.PlayerFactsSource) => string | null) {
	for (const node of root.querySelectorAll<HTMLElement>(`[${PLAYER_ATTR}]`)) {
		const target = (node as Carrier<typeof PLAYER, Coloured>)[PLAYER]
		if (!target) continue
		node.style.color = resolve(target.playerId, target.player) ?? ''
	}
}
