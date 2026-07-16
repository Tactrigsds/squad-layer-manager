import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
import * as SM from '@/models/squad.models'
import { z } from 'zod'

export const BaseSchema = z.object({
	id: z.number(),
	time: z.number(),
	matchId: z.number(),
})
export type Base = z.infer<typeof BaseSchema>

export type EventMeta = {
	players: {
		assocType: ServerEventPlayerAssocType
		// if no path then we use the assocType as the property name
		path?: string
	}[]
	// json path to objects with squad details (at least squadId, teamId)
	squads: string[]
}

export const ActionSourceSchema = z.discriminatedUnion('type', [
	// native, log-parsed provenance -- external to SLM (an outside RCON tool or an in-game admin action)
	...SM.LogEvents.ActionSourceSchema.options,
	// link to an SLM app event (audit log). the normal SLM-originated case; upgrades over rcon/player
	// in place when SLM recognizes its own action. AppEventId is a bare string, so it needs no import here.
	z.object({ type: z.literal('event'), id: z.string() }),
	// SLM-caused but with no dedicated app event yet (fallback)
	z.object({ type: z.literal('system'), reason: z.string().optional() }),
])
export type ActionSource = z.infer<typeof ActionSourceSchema>

export function meta(opts?: Partial<EventMeta>) {
	return {
		players: opts?.players ?? [],
		squads: opts?.squads ?? [],
	} satisfies EventMeta
}
