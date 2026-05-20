import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
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

export type ActionSource = SM.LogEvents.ActionSource
// | { type: 'slm-user'; userId: USR.UserId }

export function meta(opts?: Partial<EventMeta>) {
	return {
		players: opts?.players ?? [],
		squads: opts?.squads ?? [],
	} satisfies EventMeta
}
