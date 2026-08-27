// Who on the roster is actually playing.
//
// A seeding roll wants the count of people who would notice a map change, not the count of connected
// clients. So every event that only a present human produces stamps that player's clock, and anyone whose
// stamp has gone stale is counted as AFK.
//
// One Map of eos id to timestamp, rebuilt from nothing on activation. Nothing here is persisted: a restart
// re-learns the roster within a poll or two, and a wrong answer for one minute after a restart is not worth a
// table.

import type * as SE from 'slm/models/server-events'
import type * as SM from 'slm/models/squad'

export type Activity = { lastActive: Map<string, number> }

export function init(): Activity {
	return { lastActive: new Map() }
}

/**
 * Events that mean the player is at the keyboard.
 *
 * Excluded on purpose: PLAYER_RECONCILED and TEAMS_POLLED_UPDATE, which are SLM's own polling rather than
 * anything the player did, and PLAYER_DISCONNECTED, which is the opposite of presence. A player who is
 * killed is not active either, so only the attacker is stamped.
 */
function actors(event: SE.Event): string[] {
	switch (event.type) {
		case 'CHAT_MESSAGE':
		case 'PLAYER_JOINED_SQUAD':
		case 'PLAYER_LEFT_SQUAD':
		case 'PLAYER_PROMOTED_TO_LEADER':
		case 'PLAYER_CHANGED_TEAM':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA':
			// an admin action carries a source; that is something done to the player, not by them
			return 'source' in event && event.source ? [] : [event.player]
		// a kit change is a deliberate act at a spawn point. isAdmin flipping is not, but it does not flip.
		case 'PLAYER_DETAILS_CHANGED':
			return [event.player]
		case 'PLAYER_CONNECTED':
			// starts their clock, so someone who just joined is never counted as AFK
			return eosOf(event.player)
		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED':
			return event.variant === 'suicide' ? [] : [event.attacker]
		case 'SQUAD_CREATED':
			return event.synthesized ? [] : [event.squad.creator]
		default:
			return []
	}
}

function eosOf(player: SM.Player): string[] {
	return player.ids.eos ? [player.ids.eos] : []
}

export function note(activity: Activity, event: SE.Event, now: number): void {
	for (const id of actors(event)) activity.lastActive.set(id, now)
}

export type Census = { population: number; activePopulation: number; afkPopulation: number }

/**
 * Counts the roster against the activity clock. The roster is authoritative for who is present, so someone
 * who has left stops counting even though their stamp is still in the map.
 */
export function census(activity: Activity, roster: readonly SM.Player[], now: number, windowMs: number): Census {
	let active = 0
	for (const player of roster) {
		const last = player.ids.eos === undefined ? undefined : activity.lastActive.get(player.ids.eos)
		if (last !== undefined && now - last <= windowMs) active++
	}
	return { population: roster.length, activePopulation: active, afkPopulation: roster.length - active }
}

/** Drops stamps for players no longer on the roster, so a long-running server does not accumulate them. */
export function prune(activity: Activity, roster: readonly SM.Player[]): void {
	const present = new Set(roster.map((p) => p.ids.eos).filter((id): id is string => id !== undefined))
	for (const id of activity.lastActive.keys()) {
		if (!present.has(id)) activity.lastActive.delete(id)
	}
}
