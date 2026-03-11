import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'

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

export function meta(opts?: Partial<EventMeta>) {
	return {
		players: opts?.players ?? [],
		squads: opts?.squads ?? [],
	} satisfies EventMeta
}
