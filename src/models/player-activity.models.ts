// What makes a player idle. The population chart samples it, the server tracks it live for each server, and plugins
// read it through slm/systems/player-activity, so every part of SLM that talks about idle players means one thing.
//
// A player in a squad or in a vehicle is never idle. Anyone else is idle once a threshold has passed since their
// last activity. A player counts as active when first seen, so a restart or a new game never makes everyone idle
// at once. Every clock starts again at a new game.
import { z } from '@/lib/zod'
import type * as CHAT from '@/models/chat.models'
import { t } from '@/models/messages.models'
import * as SDoc from '@/models/schema-docs.models'
import type * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'

// The idle thresholds the setting offers, in minutes. Stored population samples count players against every one of
// them, so changing the setting needs no recompute.
export const IDLE_STEPS_MIN = [5, 10, 15, 20, 30] as const
export type IdleStep = (typeof IDLE_STEPS_MIN)[number]

export const SettingsSchema = z.object({
	idleThresholdMinutes: z
		.literal(IDLE_STEPS_MIN)
		.prefault(10)
		.meta(
			SDoc.of({
				label: t('Idle Threshold (minutes)'),
				description: t(
					'How long a player outside a squad and on foot can go without doing anything before SLM counts them as idle. One of 5, 10, 15, 20 or 30.',
				),
			}),
		),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

export function thresholdMs(settings: Settings): number {
	return settings.idleThresholdMinutes * 60_000
}

type AnyEvent = SE.Event | CHAT.EventEnriched
type PlayerRef = SM.Player | SM.PlayerId | undefined

function idOf(player: PlayerRef): SM.PlayerId | undefined {
	if (player === undefined) return undefined
	return typeof player === 'string' ? player : SM.PlayerIds.getPlayerId(player.ids)
}

/**
 * The players an event shows at the keyboard. Excluded: SLM's own polling (PLAYER_RECONCILED, TEAMS_POLLED_UPDATE),
 * anything an admin or SLM did to the player, and squads SLM synthesized from a poll.
 */
export function actors(event: AnyEvent): SM.PlayerId[] {
	const ids: PlayerRef[] = []
	switch (event.type) {
		case 'CHAT_MESSAGE':
		case 'PLAYER_JOINED_SQUAD':
		case 'PLAYER_LEFT_SQUAD':
		case 'PLAYER_PROMOTED_TO_LEADER':
		case 'PLAYER_CHANGED_TEAM':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA':
			if (!('source' in event && event.source)) ids.push(event.player)
			break
		case 'PLAYER_DETAILS_CHANGED':
			ids.push(event.player)
			break
		// Squad does not respawn anyone, so a dead player has to press something to get back in
		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED':
			ids.push(event.victim, event.attacker)
			break
		case 'SQUAD_CREATED':
			if (!event.synthesized) ids.push(event.squad.creator)
			break
		case 'VEHICLE_DESTROYED':
		case 'DEPLOYABLE_DESTROYED':
		case 'FOB_RADIO_DAMAGED':
			ids.push(event.attacker)
			break
		default:
			break
	}
	const out: SM.PlayerId[] = []
	for (const ref of ids) {
		const id = idOf(ref)
		if (id !== undefined) out.push(id)
	}
	return out
}

/** When each player on the server last did something, in ms since the epoch. */
export type Tracker = { lastActive: Map<SM.PlayerId, number> }

export function init(): Tracker {
	return { lastActive: new Map() }
}

function seeAll(tracker: Tracker, players: readonly SM.Player[], time: number) {
	const present = new Set<SM.PlayerId>()
	for (const player of players) {
		const id = SM.PlayerIds.getPlayerId(player.ids)
		present.add(id)
		if (!tracker.lastActive.has(id)) tracker.lastActive.set(id, time)
	}
	for (const id of tracker.lastActive.keys()) if (!present.has(id)) tracker.lastActive.delete(id)
}

/** Moves the clocks for one event, which happened at `time`. */
export function note(tracker: Tracker, event: AnyEvent, time: number = event.time) {
	switch (event.type) {
		case 'NEW_GAME':
			tracker.lastActive.clear()
			// legacy matches carried the initial roster here; see server-events.models.ts
			if (event.state) seeAll(tracker, event.state.players, time)
			return
		case 'RESET':
			seeAll(tracker, event.state.players, time)
			return
		case 'PLAYER_CONNECTED':
		case 'PLAYER_RECONCILED': {
			const id = idOf(event.player)!
			if (!tracker.lastActive.has(id)) tracker.lastActive.set(id, time)
			return
		}
		case 'PLAYER_DISCONNECTED':
			tracker.lastActive.delete(idOf(event.player)!)
			return
		default:
			for (const id of actors(event)) if (tracker.lastActive.has(id)) tracker.lastActive.set(id, time)
	}
}

// the facts about a player that can keep them from counting as idle
export type IdleFacts = Pick<SM.Player, 'squadId' | 'vehicle'>

/** Whether a player in this state can count as idle at all. */
export function canIdle(player: IdleFacts): boolean {
	return player.squadId === null && !player.vehicle
}

/** Whether a player counts as idle at `now` under `thresholdMs`, given when they last acted. */
export function isIdle(player: IdleFacts, lastActive: number | undefined, now: number, thresholdMs: number): boolean {
	return canIdle(player) && lastActive !== undefined && now - lastActive >= thresholdMs
}
