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
	| 'feed'
	| 'types'
	| 'variant'
	| 'damageSource'
	| 'chat'
	| 'channel'
	| 'matchId'
	| 'outcomes'
	| 'setBy'
	| 'ticketDiff'
	| 'duration'
	| 'map'
	| 'gamemode'
	| 'faction'
	| 'layer'
	| 'minMatches'

export type FieldGroup = 'events' | 'match' | 'layer' | 'players'

export type RangeBoundKey = 'ticketDiffMin' | 'ticketDiffMax' | 'durationMin' | 'durationMax'

// how the chip edits: which control opens in its popover
export type FieldControl =
	// the activity feed's secondary filter, the same control and the same six options (see feedFilterNode)
	| { kind: 'feed' }
	// the event-type list, which brings its own options and family groupings (see event-type-options.ts)
	| { kind: 'event-types' }
	| { kind: 'enum'; options: readonly string[] }
	// the same list, picked several at a time. Names its query field because the key is the plural and the
	// control has to read the list off it
	| { kind: 'enum-multi'; field: 'outcomes'; options: readonly string[] }
	| { kind: 'text' }
	// the layer dimension this field picks a value from, named as the layer-columns vocabulary names it, so
	// the editor can reuse the pickers the rest of the app uses (options, groupings, icons)
	| { kind: 'layer-part'; column: 'Map' | 'Gamemode' | 'Faction_1' }
	| { kind: 'saved-filter' }
	// names its query field for the same reason the range does: the control is no longer one-of-a-kind
	| { kind: 'number'; field: 'minMatches' | 'matchId'; min?: number }
	// a pair of query fields edited as one row, named here because the field's own key is neither of them
	| { kind: 'number-range'; min: RangeBoundKey; max: RangeBoundKey; unit?: string }

export type FieldDef = {
	key: FieldKey
	group: FieldGroup
	control: FieldControl
	// absent means every result type offers it
	onlyFor?: readonly HQ.ResultType[]
}

export const FIELD_DEFS: Record<FieldKey, FieldDef> = {
	// events only: on a matches or players query an event-type condition reads as "containing such an event",
	// which turns DEFAULT's exclusions into "matches where nobody died", meaning nothing
	feed: { key: 'feed', group: 'events', control: { kind: 'feed' }, onlyFor: ['events'] },
	types: { key: 'types', group: 'events', control: { kind: 'event-types' } },
	variant: { key: 'variant', group: 'events', control: { kind: 'enum', options: HQ.EVENT_VARIANTS } },
	damageSource: { key: 'damageSource', group: 'events', control: { kind: 'text' } },
	chat: { key: 'chat', group: 'events', control: { kind: 'text' } },
	channel: { key: 'channel', group: 'events', control: { kind: 'enum', options: HQ.CHAT_CHANNELS } },
	matchId: { key: 'matchId', group: 'match', control: { kind: 'number', field: 'matchId', min: 1 } },
	outcomes: { key: 'outcomes', group: 'match', control: { kind: 'enum-multi', field: 'outcomes', options: HQ.MATCH_OUTCOMES } },
	setBy: { key: 'setBy', group: 'match', control: { kind: 'enum', options: HQ.SET_BY_TYPES } },
	ticketDiff: { key: 'ticketDiff', group: 'match', control: { kind: 'number-range', min: 'ticketDiffMin', max: 'ticketDiffMax' } },
	duration: {
		key: 'duration',
		group: 'match',
		control: { kind: 'number-range', min: 'durationMin', max: 'durationMax', unit: 'min' },
	},
	map: { key: 'map', group: 'layer', control: { kind: 'layer-part', column: 'Map' } },
	gamemode: { key: 'gamemode', group: 'layer', control: { kind: 'layer-part', column: 'Gamemode' } },
	faction: { key: 'faction', group: 'layer', control: { kind: 'layer-part', column: 'Faction_1' } },
	layer: { key: 'layer', group: 'layer', control: { kind: 'saved-filter' } },
	minMatches: { key: 'minMatches', group: 'players', control: { kind: 'number', field: 'minMatches', min: 1 }, onlyFor: ['players'] },
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
	events: ['feed', 'types', 'chat', 'matchId'],
	players: ['minMatches', 'types'],
	matches: ['outcomes', 'map', 'ticketDiff', 'duration'],
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
	const control = FIELD_DEFS[key].control
	if (control.kind === 'number-range') return query[control.min] !== undefined || query[control.max] !== undefined
	if (key === 'types' || key === 'outcomes') return (query[key]?.length ?? 0) > 0
	// every field but the ranges names its own query field, which is what Extract picks out here
	return query[key as Extract<FieldKey, keyof HQ.Query>] !== undefined
}

/** Clearing a chip. A range field owns two query fields, so it cannot just be keyed by its own name. */
export function clearPatch(key: FieldKey): Partial<HQ.Query> {
	const control = FIELD_DEFS[key].control
	if (control.kind === 'number-range') return { [control.min]: undefined, [control.max]: undefined }
	return { [key]: undefined }
}

/**
 * Every field the rail edits, cleared: the scope block as well as the optional ones.
 *
 * Leaves the result type, the mode, the sort and the advanced tree alone. Those say how the results are read
 * rather than what is being asked for, and an advanced query's tree is cleared by editing it.
 */
export function clearAllPatch(): Partial<HQ.Query> {
	const patch: Partial<HQ.Query> = {
		servers: undefined,
		from: undefined,
		to: undefined,
		players: undefined,
		playerRole: undefined,
		users: undefined,
	}
	for (const key of Object.keys(FIELD_DEFS) as FieldKey[]) Object.assign(patch, clearPatch(key))
	return patch
}

/** Whether anything the clear would take off is set. */
export function anyFieldSet(query: HQ.Query): boolean {
	if (query.servers?.length || query.players?.length || query.users?.length || query.playerRole) return true
	if (query.from !== undefined || query.to !== undefined) return true
	return (Object.keys(FIELD_DEFS) as FieldKey[]).some((key) => isSet(query, key))
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
