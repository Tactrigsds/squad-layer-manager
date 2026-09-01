import { z } from 'zod'

import { APP_EVENT_TYPE, SERVER_EVENT_TYPE } from '$root/drizzle/enums'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'

// The history page's query model. A query is one flat object -- exactly the page's url search params -- and
// everything (saving, sharing, recents) stores or replays that object. Basic mode's fields and advanced
// mode's node tree both normalize to the same tree (`queryFilterNode`), so the server compiles one shape.
//
// The advanced tree reuses the filter AST's comparison and block nodes over a history vocabulary, plus two
// node kinds of its own: `match-layer` embeds a layer filter (evaluated against the layers actually played),
// and `subquery` embeds another result type's query, projected to an id set.

export const RESULT_TYPES = ['events', 'players', 'matches'] as const
export type ResultType = (typeof RESULT_TYPES)[number]

export const MATCH_OUTCOMES = ['team1', 'team2', 'draw'] as const
export const SET_BY_TYPES = ['manual', 'gameserver', 'generated', 'unknown', 'ingame-vote', 'plugin'] as const
export const EVENT_VARIANTS = ['normal', 'suicide', 'teamkill'] as const

// -------- vocabulary --------

export type ColumnDomain =
	| { kind: 'timestamp' }
	| { kind: 'number' }
	| { kind: 'enum'; options: readonly string[] }
	// options come from a table or the layer components, resolved where those are at hand
	| { kind: 'dynamic-enum'; source: DynamicEnumSource }
	// a player reference: an eos id, or a steam64 the engine resolves to one
	| { kind: 'player' }
	// an SLM user reference: a discord id, or a name the engine resolves against nickname and username
	| { kind: 'user' }
	// free text; `eq` reads as "contains" (fts MATCH for chat)
	| { kind: 'text' }

export const DYNAMIC_ENUM_SOURCES = ['damageSources', 'servers', 'layers', 'maps', 'gamemodes', 'factions', 'units'] as const
export type DynamicEnumSource = (typeof DYNAMIC_ENUM_SOURCES)[number]

export type ColumnDef = { key: ColumnKey; displayName: string; domain: ColumnDomain }

// Both event families, since a search runs over both. The two enums overlap on the handful of names that
// describe the same action from either side (PLAYER_WARNED, MAP_SET, ...), and a shared name deliberately
// matches both: "show me the warns" wants the admin's action and the warn the server recorded for it.
export const EVENT_TYPES = [...new Set([...SERVER_EVENT_TYPE.options, ...APP_EVENT_TYPE.options])].sort()

export const COLUMN_DEFS = {
	time: { key: 'time', displayName: 'Time', domain: { kind: 'timestamp' } },
	eventId: { key: 'eventId', displayName: 'Event id', domain: { kind: 'number' } },
	server: { key: 'server', displayName: 'Server', domain: { kind: 'dynamic-enum', source: 'servers' } },
	player: { key: 'player', displayName: 'Player', domain: { kind: 'player' } },
	// The SLM user an event is attributable to: whoever performed it, plus anyone it was performed against
	// (see iterAssocUserIds). Only app events have one, so this reads as false against a server event, which
	// is what makes "events involving user X" mean the audit trail rather than nothing.
	user: { key: 'user', displayName: 'SLM user', domain: { kind: 'user' } },
	'event.type': { key: 'event.type', displayName: 'Event type', domain: { kind: 'enum', options: EVENT_TYPES } },
	'event.variant': { key: 'event.variant', displayName: 'Kill variant', domain: { kind: 'enum', options: EVENT_VARIANTS } },
	'event.damageSource': {
		key: 'event.damageSource',
		displayName: 'Damage source',
		domain: { kind: 'dynamic-enum', source: 'damageSources' },
	},
	'chat.message': { key: 'chat.message', displayName: 'Chat text', domain: { kind: 'text' } },
	'match.outcome': { key: 'match.outcome', displayName: 'Match outcome', domain: { kind: 'enum', options: MATCH_OUTCOMES } },
	'match.setBy': { key: 'match.setBy', displayName: 'Layer set by', domain: { kind: 'enum', options: SET_BY_TYPES } },
	// how lopsided the match was, as the winner's remaining tickets over the loser's. Unsigned, because which
	// side won is `match.outcome`'s question; this one is only ever asked as "a blowout" or "a close game".
	'match.ticketDiff': { key: 'match.ticketDiff', displayName: 'Ticket difference', domain: { kind: 'number' } },
	// The layer played, by part. Every one of these is read off the layer id (L.toLayer), never off a join:
	// the id spells out map, gamemode and both sides, so the engine resolves them by parsing the few hundred
	// distinct ids in range rather than by asking the layer engine, which it has no artifact for.
	'layer.layer': { key: 'layer.layer', displayName: 'Layer', domain: { kind: 'dynamic-enum', source: 'layers' } },
	'layer.map': { key: 'layer.map', displayName: 'Map', domain: { kind: 'dynamic-enum', source: 'maps' } },
	'layer.gamemode': { key: 'layer.gamemode', displayName: 'Gamemode', domain: { kind: 'dynamic-enum', source: 'gamemodes' } },
	'layer.faction': { key: 'layer.faction', displayName: 'Faction', domain: { kind: 'dynamic-enum', source: 'factions' } },
	'layer.unit': { key: 'layer.unit', displayName: 'Unit', domain: { kind: 'dynamic-enum', source: 'units' } },
} as const satisfies Record<string, { key: string; displayName: string; domain: ColumnDomain }>

// Faction and unit are matched against both sides at once: historically "was RGF in this match" is the
// question worth asking, where "was RGF specifically team 1" is close to meaningless, since the slot a side
// occupies flips between consecutive matches. A matchup is two predicates in an `and`.
export const LAYER_COLUMN_KEYS = ['layer.layer', 'layer.map', 'layer.gamemode', 'layer.faction', 'layer.unit'] as const
export type LayerColumnKey = (typeof LAYER_COLUMN_KEYS)[number]

export function isLayerColumn(key: string): key is LayerColumnKey {
	return (LAYER_COLUMN_KEYS as readonly string[]).includes(key)
}

export type ColumnKey = keyof typeof COLUMN_DEFS
export const COLUMN_KEYS = Object.keys(COLUMN_DEFS) as ColumnKey[]

export function getColumnDef(key: string): ColumnDef | undefined {
	return (COLUMN_DEFS as Record<string, ColumnDef>)[key]
}

/** The comparison's subject as a known column key, or undefined if it names nothing this vocabulary has. */
export function compColumnKey(node: F.CompNode | F.EditableCompNode): ColumnKey | undefined {
	const column = F.compAnchorColumn(node as F.CompNode)
	return column !== undefined && getColumnDef(column) !== undefined ? (column as ColumnKey) : undefined
}

// the F.ValueDomain a history column presents to the shared operator machinery. The enum mapping string is
// only ever compared for equality, so the column key namespaced under 'history:' serves.
export function columnValueDomain(key: string): F.ValueDomain | undefined {
	const def = getColumnDef(key)
	if (!def) return undefined
	switch (def.domain.kind) {
		case 'timestamp':
		case 'number':
			return { kind: 'number', integral: true }
		case 'enum':
		case 'dynamic-enum':
			return { kind: 'enum', mapping: `history:${key}` }
		case 'player':
		case 'user':
		case 'text':
			return { kind: 'string' }
		default:
			assertNever(def.domain)
	}
}

// which of the shared operator options a column offers. Text columns read `eq` as "contains", so ordering
// and set operators make no sense on them; player columns are identity-only.
export function columnCompOptions(key: string): F.CompOpSelectOption[] {
	const def = getColumnDef(key)
	const all = F.compOpSelectOptions(columnValueDomain(key))
	if (!def) return all
	switch (def.domain.kind) {
		case 'text':
			return all.filter((o) => o.type === 'eq').map((o) => ({ ...o, label: o.neg ? 'not containing' : 'contains' }))
		case 'player':
		case 'user':
			return all.filter((o) => o.type === 'eq' || o.type === 'in')
		default:
			return all
	}
}

// -------- nodes --------

export type MatchLayerNode = { type: 'match-layer'; neg: boolean; filter: F.FilterNode; comment?: string }
export type SubqueryTarget = 'matches' | 'players'
export type SubqueryNode = { type: 'subquery'; neg: boolean; target: SubqueryTarget; filter: Node; comment?: string }
// a match-layer node after server-side resolution: the layer filter evaluated (on the thread that owns the
// layer engine) into the matches it selects, so the engine -- wherever it runs -- never needs the engine's
// artifact. Never produced by the editor.
export type MatchIdsNode = { type: 'match-ids'; neg: boolean; matchIds: number[]; comment?: string }

export type Node = { type: F.BlockType; children: Node[]; comment?: string } | F.CompNode | MatchLayerNode | SubqueryNode | MatchIdsNode

const NegSchema = z.boolean().prefault(false)
const CommentSchema = F.NodeCommentSchema.optional()

export const MatchLayerNodeSchema = z.object({
	type: z.literal('match-layer'),
	neg: NegSchema,
	filter: F.FilterNodeSchema,
	comment: CommentSchema,
})

export const SubqueryNodeSchema = z.object({
	type: z.literal('subquery'),
	neg: NegSchema,
	target: z.enum(['matches', 'players']),
	filter: z.lazy(() => NodeSchema),
	comment: CommentSchema,
})

export const MatchIdsNodeSchema = z.object({
	type: z.literal('match-ids'),
	neg: NegSchema,
	matchIds: z.array(z.number().int()),
	comment: CommentSchema,
})

const blockSchema = <T extends F.BlockType>(type: T) =>
	z.object({ type: z.literal(type), children: z.lazy(() => z.array(NodeSchema)), comment: CommentSchema })

export const NodeSchema: z.ZodType<Node> = z.lazy(() =>
	z.discriminatedUnion('type', [
		F.EqNodeSchema,
		F.InNodeSchema,
		F.LtNodeSchema,
		F.GtNodeSchema,
		F.InRangeNodeSchema,
		MatchLayerNodeSchema,
		SubqueryNodeSchema,
		MatchIdsNodeSchema,
		blockSchema('and'),
		blockSchema('or'),
		blockSchema('nor'),
		blockSchema('nand'),
	]),
) as z.ZodType<Node>

// -------- editable nodes --------
// the same partial-node treatment the filter editor gets: an editing session is mostly half-filled nodes

export type EditableMatchLayerNode = { type: 'match-layer'; neg: boolean; filter: F.EditableFilterNode; comment?: string }
export type EditableSubqueryNode = { type: 'subquery'; neg: boolean; target: SubqueryTarget; filter: EditableNode; comment?: string }

export type EditableNode =
	| { type: F.BlockType; children: EditableNode[]; comment?: string }
	| F.EditableCompNode
	| EditableMatchLayerNode
	| EditableSubqueryNode

export function isBlockNode<T extends { type: string }>(node: T): node is Extract<T, { type: F.BlockType }> {
	return F.isBlockType(node.type)
}
export function isCompNode<T extends { type: string }>(node: T): node is Extract<T, { type: F.CompType }> {
	return F.isCompType(node.type)
}

export function isValidNode(node: EditableNode | Node): node is Node {
	if (isBlockNode(node)) return node.children.every(isValidNode)
	if (isCompNode(node)) return F.isValidCompNode(node as F.EditableCompNode)
	if (node.type === 'match-layer') return F.FilterNodeSchema.safeParse(node.filter).success
	if (node.type === 'subquery') return isValidNode(node.filter)
	if (node.type === 'match-ids') return true
	assertNever(node)
}

export function isMatchIdsNode(node: Node): node is MatchIdsNode {
	return node.type === 'match-ids'
}

// excludes children, mirroring F.isLocallyValidFilterNode
export function isLocallyValidNode(node: EditableNode): boolean {
	if (isBlockNode(node)) return true
	if (isCompNode(node)) return F.isValidCompNode(node as F.EditableCompNode)
	if (node.type === 'match-layer') return F.FilterNodeSchema.safeParse(node.filter).success
	if (node.type === 'subquery') return true
	assertNever(node)
}

export function* walkNodes(node: Node): IterableIterator<Node> {
	yield node
	if (isBlockNode(node)) for (const child of node.children) yield* walkNodes(child)
	// a subquery's filter is its own scope, deliberately not walked: callers that need it recurse explicitly
}

// -------- the query --------

const EpochMs = z.number().int().nonnegative()

export const PLAYER_SORT_COLUMNS = ['matches', 'kills', 'deaths', 'teamkills', 'chatMessages', 'lastSeen'] as const
export type PlayerSortColumn = (typeof PLAYER_SORT_COLUMNS)[number]

const QueryFieldsSchema = z.object({
	type: z.enum(RESULT_TYPES).prefault('events'),
	mode: z.enum(['basic', 'advanced']).prefault('basic'),

	// bounds, meaningful in both modes; every engine applies them outside the tree
	servers: z.array(z.string()).optional(),
	from: EpochMs.optional(),
	to: EpochMs.optional(),
	idMin: z.number().int().optional(),
	idMax: z.number().int().optional(),

	// basic mode's fields, one url param each so a basic query reads as a url
	players: z.array(z.string()).optional(),
	users: z.array(z.string()).optional(),

	// Superseded by the three lists above, and only ever read on the way in: every saved query and every
	// shared link written before they were lists still carries these, and folds into them (see foldSingles).
	server: z.string().optional(),
	player: z.string().optional(),
	user: z.string().optional(),

	// events only: which end of the range the page starts from. A bound rather than a filter, so it sits
	// outside the tree like the others and means the same thing in both modes. Absent means newest, which
	// keeps it out of the url of every query that does not care.
	order: z.enum(['newest', 'oldest']).optional(),

	types: z.array(z.enum(EVENT_TYPES)).optional(),
	variant: z.enum(EVENT_VARIANTS).optional(),
	damageSource: z.string().optional(),
	chat: z.string().optional(),
	layer: F.FilterNodeSchema.optional(),
	map: z.string().optional(),
	gamemode: z.string().optional(),
	faction: z.string().optional(),
	outcome: z.enum(MATCH_OUTCOMES).optional(),
	setBy: z.enum(SET_BY_TYPES).optional(),
	// bounds on match.ticketDiff. Either alone reads as "a blowout" / "a close game"; both make a band
	ticketDiffMin: z.number().int().nonnegative().optional(),
	ticketDiffMax: z.number().int().nonnegative().optional(),
	name: z.string().optional(),
	minMatches: z.number().int().positive().optional(),

	sort: z.object({ column: z.enum(PLAYER_SORT_COLUMNS), dir: z.enum(['asc', 'desc']) }).optional(),

	// advanced mode's tree
	q: NodeSchema.optional(),
})

// A one-valued ref folds into its list and stops existing, so nothing downstream has two spellings of the
// same field to handle. Done in the schema rather than at the call sites because a query is parsed from
// three places (the url, a saved row, a recent) and any of them can be old.
type QueryFields = z.infer<typeof QueryFieldsSchema>
// spelled out rather than inferred: an inferred transform return turns `servers?: string[]` into
// `servers: string[] | undefined`, which makes every query literal have to name all three
type FoldedQuery = Omit<QueryFields, 'server' | 'player' | 'user'>

function foldSingles({ server, player, user, ...rest }: QueryFields): FoldedQuery {
	const fold = (list: string[] | undefined, single: string | undefined) => {
		const merged = [...new Set([...(list ?? []), ...(single ? [single] : [])])]
		return merged.length > 0 ? merged : undefined
	}
	return { ...rest, servers: fold(rest.servers, server), players: fold(rest.players, player), users: fold(rest.users, user) }
}

export const QuerySchema = QueryFieldsSchema.transform(foldSingles)
export type Query = z.infer<typeof QuerySchema>

export const DEFAULT_QUERY: Query = QuerySchema.parse({})

// -------- normalization --------

function comp(column: ColumnKey, values: (string | number)[]): F.CompNode {
	const subject: F.ColumnArg = { type: 'column', column }
	if (values.length === 1) return { type: 'eq', neg: false, args: [subject, { type: 'value', value: values[0] }] }
	return { type: 'in', neg: false, args: [subject, { type: 'values', values }] }
}

// `gt`/`lt` are strict, so an inclusive bound is expressed as the neighbouring integer. A pair becomes one
// `inrange` rather than two comparisons, which is what the advanced editor shows when the mode is switched.
function ticketDiffNodes(query: Query): Node[] {
	const subject: F.ColumnArg = { type: 'column', column: 'match.ticketDiff' }
	const { ticketDiffMin: min, ticketDiffMax: max } = query
	if (min !== undefined && max !== undefined) {
		return [{ type: 'inrange', neg: false, args: [subject, { type: 'value', value: min }, { type: 'value', value: max }] }]
	}
	if (min !== undefined) return [{ type: 'gt', neg: false, args: [subject, { type: 'value', value: min - 1 }] }]
	if (max !== undefined) return [{ type: 'lt', neg: false, args: [subject, { type: 'value', value: max + 1 }] }]
	return []
}

/**
 * The one tree the server compiles: basic mode's fields assembled into an `and` block, or advanced mode's
 * tree as-is. Also what "switch to advanced" seeds the editor with. The bounds (server/from/to/idMin/idMax)
 * stay outside the tree in both modes.
 */
export function queryFilterNode(query: Query): Node {
	if (query.mode === 'advanced') return query.q ?? { type: 'and', children: [] }
	const children: Node[] = []
	// `player` on the players result type filters which rows are shown, not which events are aggregated;
	// the engine reads it from the query directly (see groupPlayerRefs)
	if (query.players?.length && query.type !== 'players') children.push(comp('player', query.players))
	if (query.users?.length) children.push(comp('user', query.users))
	if (query.types && query.types.length > 0) children.push(comp('event.type', query.types))
	if (query.variant) children.push(comp('event.variant', [query.variant]))
	if (query.damageSource) children.push(comp('event.damageSource', [query.damageSource]))
	if (query.chat) children.push(comp('chat.message', [query.chat]))
	if (query.layer) children.push({ type: 'match-layer', neg: false, filter: query.layer })
	if (query.map) children.push(comp('layer.map', [query.map]))
	if (query.gamemode) children.push(comp('layer.gamemode', [query.gamemode]))
	if (query.faction) children.push(comp('layer.faction', [query.faction]))
	if (query.outcome) children.push(comp('match.outcome', [query.outcome]))
	if (query.setBy) children.push(comp('match.setBy', [query.setBy]))
	children.push(...ticketDiffNodes(query))
	return { type: 'and', children }
}

// the players result type's output filter: which player rows to show, as opposed to which events count
export function groupPlayerRefs(query: Query): { players?: string[]; name?: string } {
	if (query.type !== 'players') return {}
	return { players: query.players?.length ? query.players : undefined, name: query.name || undefined }
}

// -------- validation --------

export type QueryProblem = { code: 'unknown-column'; column: string } | { code: 'invalid-node' }

export function validateQueryNode(node: Node, problems: QueryProblem[] = []): QueryProblem[] {
	for (const n of walkNodes(node)) {
		if (isCompNode(n)) {
			const column = F.compAnchorColumn(n as F.CompNode)
			if (!column || !getColumnDef(column)) problems.push({ code: 'unknown-column', column: column ?? '' })
		}
		if (n.type === 'subquery') validateQueryNode(n.filter, problems)
	}
	return problems
}

// -------- results --------

export type PlayerRow = {
	playerId: string
	username: string | null
	steamId: string | null
	matches: number
	kills: number
	deaths: number
	teamkills: number
	chatMessages: number
	lastSeen: number
}

export const PAGE_SIZES = { events: 100, players: 50, matches: 50 } as const

// -------- saved queries --------

export const SAVED_QUERY_ID = z.string().trim().min(1).max(24)
export const SavedQueryUpdateSchema = z.object({
	name: z.string().trim().min(1).max(128),
	visibility: z.enum(['private', 'shared']),
	query: QuerySchema,
})
export type SavedQueryUpdate = z.infer<typeof SavedQueryUpdateSchema>

export type SavedQuery = SavedQueryUpdate & {
	id: string
	ownerId: bigint
	updatedAt: number
}
