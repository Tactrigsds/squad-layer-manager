import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
import type { AppEventId } from '@/models/app-events.models'
import type * as SM from '@/models/squad.models'

export type Base = {
	id: number
	time: number
	matchId: number
}

export type EventMeta = {
	players: {
		assocType: ServerEventPlayerAssocType
		// if no path then we use the assocType as the property name
		path?: string
	}[]
	// json path to objects with squad details (at least squadId, teamId)
	squads: string[]
}

export type ActionSource =
	// native, log-parsed provenance -- external to SLM (an outside RCON tool or an in-game admin action)
	| SM.LogEvents.ActionSource
	// link to an SLM app event (audit log). the normal SLM-originated case; upgrades over rcon/player
	// in place when SLM recognizes its own action
	| { type: 'event'; id: AppEventId }
	// SLM-caused but with no dedicated app event yet (fallback)
	| { type: 'system'; reason?: string }

export function meta(opts?: Partial<EventMeta>) {
	return {
		players: opts?.players ?? [],
		squads: opts?.squads ?? [],
	} satisfies EventMeta
}
