import { z } from 'zod'

import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
import * as ZodUtils from '@/lib/zod-utils'
import * as SM from '@/models/squad.models'

export const BaseSchema = z.object({
	id: z.number(),
	time: z.number(),
	matchId: z.number(),
})
export type Base = z.infer<typeof BaseSchema>

// What an event is about, declared beside the event's own type. The write path indexes off these (see
// buildAssociationRows), so adding an association is one entry here rather than an edit in every consumer.
//
// Extractors rather than json paths: a path is only ever evaluated in-process, so being data buys nothing,
// while a function is checked against the payload type. A renamed field then fails to compile instead of
// quietly yielding nothing, which would show up only as events that stopped matching a filter.

/** One, several, or none. Extractors return whichever is natural for the field they read. */
export type AssocValues<T> = T | null | undefined | readonly (T | null | undefined)[]

export type EventMeta<E> = {
	players: { assocType: ServerEventPlayerAssocType; get: (event: E) => AssocValues<SM.Player | SM.PlayerId> }[]
	// squads carry either the whole object (which registers the squad) or just its uniqueId (which references one)
	squads: { get: (event: E) => AssocValues<SM.UniqueSquad | number> }[]
}

export function* iterAssocValues<T>(values: AssocValues<T>): Generator<T> {
	if (values === null || values === undefined) return
	if (Array.isArray(values)) {
		for (const value of values as readonly (T | null | undefined)[]) {
			if (value !== null && value !== undefined) yield value
		}
		return
	}
	yield values as T
}

export const ActionSourceSchema = z.discriminatedUnion('type', [
	// native, log-parsed provenance -- external to SLM (an outside RCON tool or an in-game admin action)
	...SM.LogEvents.ActionSourceSchema.options,
	// link to an SLM app event (audit log). the normal SLM-originated case; upgrades over rcon/player
	// in place when SLM recognizes its own action. AppEventId is a bare string, so it needs no import here.
	z.object({ type: ZodUtils.internedLiteral('event'), id: z.string() }),
	// SLM-caused but with no dedicated app event yet (fallback)
	z.object({ type: ZodUtils.internedLiteral('system'), reason: z.string().optional() }),
])
export type ActionSource = z.infer<typeof ActionSourceSchema>

export function meta<E>(opts?: Partial<EventMeta<E>>): EventMeta<E> {
	return {
		players: opts?.players ?? [],
		squads: opts?.squads ?? [],
	}
}
