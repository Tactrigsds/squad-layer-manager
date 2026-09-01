import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
import type * as L from '@/models/layer'
import type * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'

// What an event is about, declared beside the event's own type. Both families use this: server events
// (server-events.models.ts) and app events (app-events.models.ts). The write path indexes off these, so adding
// an association is one entry there rather than an edit in every consumer.
//
// Extractors rather than json paths: a path is only ever evaluated in-process, so being data buys nothing,
// while a function is checked against the payload type. A renamed field then fails to compile instead of
// quietly yielding nothing, which would show up only as events that stopped matching a filter.

/** One, several, or none. Extractors return whichever is natural for the field they read. */
export type AssocValues<T> = T | null | undefined | readonly (T | null | undefined)[]

// How the event relates to the layer, which is the difference between "when did we play Gorodok" and "when did
// Gorodok merely come up in a vote".
export type LayerAssocKind =
	| 'played' // the layer a match ran on
	| 'set' // set as the server's next layer
	| 'queued' // present in the queue after a save
	| 'offered' // a choice in a vote, won or not

export type EventMeta<E> = {
	players: { assocType: ServerEventPlayerAssocType; get: (event: E) => AssocValues<SM.Player | SM.PlayerId> }[]
	// squads carry either the whole object (which registers the squad) or just its uniqueId (which references one)
	squads: { get: (event: E) => AssocValues<SM.UniqueSquad | number> }[]
	layers: { kind: LayerAssocKind; get: (event: E) => AssocValues<L.LayerId> }[]
	// SLM users the event attributes work to, beyond whoever performed it. Only app events have these.
	users: { get: (event: E) => AssocValues<USR.UserId> }[]
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

export function meta<E>(opts?: Partial<EventMeta<E>>): EventMeta<E> {
	return {
		players: opts?.players ?? [],
		squads: opts?.squads ?? [],
		layers: opts?.layers ?? [],
		users: opts?.users ?? [],
	}
}

/** The (layer, kind) pairs an event associates. Deduplicated: a queue save names the same layer many times. */
export function* iterAssocLayers<E>(eventMeta: EventMeta<E>, event: E): Generator<readonly [L.LayerId, LayerAssocKind]> {
	const seen = new Set<string>()
	for (const layerMeta of eventMeta.layers) {
		for (const layerId of iterAssocValues(layerMeta.get(event))) {
			const key = `${layerMeta.kind} ${layerId}`
			if (seen.has(key)) continue
			seen.add(key)
			yield [layerId, layerMeta.kind] as const
		}
	}
}
