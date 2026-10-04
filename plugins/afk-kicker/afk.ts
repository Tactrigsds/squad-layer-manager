// Who is AFK, and how many of them the queue needs gone.
//
// On the idle gamemodes (seeding and training), a player is AFK when SLM counts them idle for `idleWindow`: see
// slm/systems/player-activity for the rule. Everywhere else, a player is AFK when they have been out of a squad for
// `squadlessWindow`.
//
// The squadless clock starts again at a new game, as it does after a restart: nothing is persisted, and everyone is
// treated as first seen.

import type * as SE from 'slm/models/server-events'
import type * as SM from 'slm/models/squad'
import type * as PlayerActivity from 'slm/systems/player-activity'

export type Tracker = {
	squadlessSince: Map<SM.PlayerId, number>
	lastWarned: Map<SM.PlayerId, number>
	/** when each recent kick was sent, until its slot has had time to show up in the server info */
	recentKicks: number[]
	/** players the server refused to kick, left alone until they leave */
	unkickable: Set<SM.PlayerId>
}

export function init(): Tracker {
	return { squadlessSince: new Map(), lastWarned: new Map(), recentKicks: [], unkickable: new Set() }
}

export function note(tracker: Tracker, event: SE.Event): void {
	// recentKicks survives because it tracks slots, and unkickable because a player's protection outlasts the game
	if (event.type === 'NEW_GAME') {
		tracker.squadlessSince.clear()
		tracker.lastWarned.clear()
	}
}

/** Brings the squadless clock up to date with the roster, and drops everyone who has left. */
export function observe(tracker: Tracker, roster: ReadonlyMap<SM.PlayerId, SM.Player>, now: number): void {
	for (const [id, player] of roster) {
		if (player.squadId !== null) tracker.squadlessSince.delete(id)
		else if (!tracker.squadlessSince.has(id)) tracker.squadlessSince.set(id, now)
	}
	for (const map of [tracker.squadlessSince, tracker.lastWarned]) {
		for (const id of map.keys()) if (!roster.has(id)) map.delete(id)
	}
	for (const id of tracker.unkickable) if (!roster.has(id)) tracker.unkickable.delete(id)
}

export type Rule = { kind: 'squadless' | 'idle'; window: number }

export type Afk = { id: SM.PlayerId; player: SM.Player; since: number; reason: Rule['kind'] }

/**
 * Every AFK player on the roster who can be kicked, longest AFK first. `idle` is who SLM counts as idle under the
 * rule's window, from slm/systems/player-activity, which the idle rule reads instead of a clock of its own.
 */
export function afkPlayers(
	tracker: Tracker,
	roster: ReadonlyMap<SM.PlayerId, SM.Player>,
	rule: Rule,
	now: number,
	idle: readonly PlayerActivity.IdlePlayer[],
): Afk[] {
	const out: Afk[] = []
	if (rule.kind === 'idle') {
		for (const p of idle) {
			if (!tracker.unkickable.has(p.id)) out.push({ id: p.id, player: p.player, since: p.lastActive, reason: 'idle' })
		}
	} else {
		for (const [id, player] of roster) {
			if (tracker.unkickable.has(id)) continue
			const since = tracker.squadlessSince.get(id)
			if (since !== undefined && now - since >= rule.window) out.push({ id, player, since, reason: 'squadless' })
		}
	}
	return out.sort((a, b) => a.since - b.since)
}

export type Slots = {
	maxPlayerCount: number
	playerCount: number
	queueLength?: number
	reserveSlots?: number
	reserveQueueLength?: number
}

/**
 * How many players have to go to bring the queue down to `targetQueue`. Zero or less means none; exactly zero
 * means the server is full by that measure, so the next arrival will cost somebody their slot.
 *
 * Kicks sent in the last few seconds count as slots already freed, because the server info can lag behind a
 * kick. Counting them twice only delays the next kick, where not counting them would kick again for the same
 * queued player.
 *
 * Null when the numbers cannot be right. A missing MaxPlayers parses as 0, which would otherwise read as every
 * AFK player needing to go.
 */
export function kicksNeeded(slots: Slots, targetQueue: number, recentKicks: number): number | null {
	if (slots.maxPlayerCount <= 0 || slots.playerCount > slots.maxPlayerCount) return null
	const publicSlots = slots.maxPlayerCount - (slots.reserveSlots ?? 0)
	const free = Math.max(0, publicSlots - slots.playerCount)
	const queued = (slots.queueLength ?? 0) + (slots.reserveQueueLength ?? 0)
	return queued - free - targetQueue - recentKicks
}

export function pruneKicks(tracker: Tracker, now: number, settleMs: number): void {
	tracker.recentKicks = tracker.recentKicks.filter((at) => now - at < settleMs)
}
