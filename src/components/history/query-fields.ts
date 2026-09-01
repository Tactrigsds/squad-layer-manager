import * as HQ from '@/models/history.models'

// Basic mode's optional fields, as the rail lists them: which control edits one, where it sits in the
// "+ Filter" menu, and which result types offer it. Server, time, player and user are not here -- they are
// the scope block, always shown, because every query is scoped by them.
//
// Relevance is ordering, not capability. Every field compiles for every result type (queryFilterNode), so
// "event type" on a matches query means "matches containing such an event", which is worth having. The
// result type only decides which fields are shown before you ask for them (DEFAULT_FIELDS) and what the
// "+ Filter" menu leads with.

export type FieldKey =
	| 'types'
	| 'variant'
	| 'damageSource'
	| 'chat'
	| 'outcome'
	| 'setBy'
	| 'ticketDiff'
	| 'map'
	| 'gamemode'
	| 'faction'
	| 'layer'
	| 'minMatches'

export type FieldGroup = 'events' | 'match' | 'layer' | 'players'

// how the chip edits: which control opens in its popover
export type FieldControl =
	| { kind: 'multi-enum'; options: readonly string[] }
	| { kind: 'enum'; options: readonly string[] }
	| { kind: 'text' }
	| { kind: 'layer-part'; part: 'maps' | 'gamemodes' | 'factions' }
	| { kind: 'saved-filter' }
	| { kind: 'number' }
	| { kind: 'number-range' }

export type FieldDef = {
	key: FieldKey
	group: FieldGroup
	control: FieldControl
	// absent means every result type offers it
	onlyFor?: readonly HQ.ResultType[]
}

export const FIELD_DEFS: Record<FieldKey, FieldDef> = {
	types: { key: 'types', group: 'events', control: { kind: 'multi-enum', options: HQ.EVENT_TYPES } },
	variant: { key: 'variant', group: 'events', control: { kind: 'enum', options: HQ.EVENT_VARIANTS } },
	damageSource: { key: 'damageSource', group: 'events', control: { kind: 'text' } },
	chat: { key: 'chat', group: 'events', control: { kind: 'text' } },
	outcome: { key: 'outcome', group: 'match', control: { kind: 'enum', options: HQ.MATCH_OUTCOMES } },
	setBy: { key: 'setBy', group: 'match', control: { kind: 'enum', options: HQ.SET_BY_TYPES } },
	ticketDiff: { key: 'ticketDiff', group: 'match', control: { kind: 'number-range' } },
	map: { key: 'map', group: 'layer', control: { kind: 'layer-part', part: 'maps' } },
	gamemode: { key: 'gamemode', group: 'layer', control: { kind: 'layer-part', part: 'gamemodes' } },
	faction: { key: 'faction', group: 'layer', control: { kind: 'layer-part', part: 'factions' } },
	layer: { key: 'layer', group: 'layer', control: { kind: 'saved-filter' } },
	minMatches: { key: 'minMatches', group: 'players', control: { kind: 'number' }, onlyFor: ['players'] },
}

const GROUP_ORDER: Record<HQ.ResultType, readonly FieldGroup[]> = {
	events: ['events', 'layer', 'match', 'players'],
	players: ['players', 'events', 'layer', 'match'],
	matches: ['match', 'layer', 'events', 'players'],
}

// What the rail shows for a result type before anything is asked for: the fields that type's questions are
// usually about. Not a capability boundary -- every other field is one "+ Filter" away, and a field carried
// in from another result type stays visible while it holds a value (see visibleFields).
const DEFAULT_FIELDS: Record<HQ.ResultType, readonly FieldKey[]> = {
	events: ['types', 'chat'],
	players: ['minMatches', 'types'],
	matches: ['outcome', 'map', 'ticketDiff'],
}

/**
 * The fields the rail lists, in menu order.
 *
 * A set field is always shown, whichever result type set it: switching type is a change of view over one
 * query, so a filter that survives into the new results has to stay visible, or the results answer a
 * question the rail no longer admits to asking. `extra` carries the fields "+ Filter" has added but which
 * have no value yet.
 */
export function visibleFields(query: HQ.Query, extra: readonly FieldKey[] = []): { group: FieldGroup; fields: FieldDef[] }[] {
	const out: { group: FieldGroup; fields: FieldDef[] }[] = []
	for (const group of GROUP_ORDER[query.type]) {
		const fields = Object.values(FIELD_DEFS).filter(
			(def) =>
				def.group === group &&
				(def.onlyFor === undefined || def.onlyFor.includes(query.type)) &&
				(isSet(query, def.key) || extra.includes(def.key) || DEFAULT_FIELDS[query.type].includes(def.key)),
		)
		if (fields.length > 0) out.push({ group, fields })
	}
	return out
}

/** Whether the query carries a value for this field, which is what decides if it has a chip. */
export function isSet(query: HQ.Query, key: FieldKey): boolean {
	switch (key) {
		case 'types':
			return (query.types?.length ?? 0) > 0
		case 'ticketDiff':
			return query.ticketDiffMin !== undefined || query.ticketDiffMax !== undefined
		default:
			return query[key] !== undefined
	}
}

/** Clearing a chip. `ticketDiff` owns two query fields, so it cannot just be keyed by its own name. */
export function clearPatch(key: FieldKey): Partial<HQ.Query> {
	if (key === 'ticketDiff') return { ticketDiffMin: undefined, ticketDiffMax: undefined }
	return { [key]: undefined }
}

/** The fields the "+ Filter" menu offers: everything applicable that the rail is not already showing. */
export function addableGroups(query: HQ.Query, shown: readonly FieldKey[]): { group: FieldGroup; fields: FieldDef[] }[] {
	const out: { group: FieldGroup; fields: FieldDef[] }[] = []
	for (const group of GROUP_ORDER[query.type]) {
		const fields = Object.values(FIELD_DEFS).filter(
			(def) => def.group === group && !shown.includes(def.key) && (def.onlyFor === undefined || def.onlyFor.includes(query.type)),
		)
		if (fields.length > 0) out.push({ group, fields })
	}
	return out
}
