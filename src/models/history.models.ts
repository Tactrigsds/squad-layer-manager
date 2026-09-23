import { APP_EVENT_TYPE, SERVER_EVENT_TYPE } from '$root/drizzle/enums'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as CHAT from '@/models/chat.models'
import * as F from '@/models/filter.models'
import * as SM from '@/models/squad.models'

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
export const CHAT_CHANNELS = SM.CHAT_CHANNEL_TYPE.options

// the two ends of a kill, as the index records them (playerEventIndex.assocType)
export const PLAYER_ROLES = ['attacker', 'victim'] as const
export type PlayerRole = (typeof PLAYER_ROLES)[number]

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

export const EVENT_FAMILIES = ['server', 'app'] as const
export type EventFamily = (typeof EVENT_FAMILIES)[number]

const SERVER_EVENT_NAMES: ReadonlySet<string> = new Set(SERVER_EVENT_TYPE.options)
const APP_EVENT_NAMES: ReadonlySet<string> = new Set(APP_EVENT_TYPE.options)

// which families raise a type. Two for the shared names, and a picker has to show those under either family
// rather than pick one, since selecting the name really does match both.
export function eventTypeFamilies(type: string): EventFamily[] {
	const families: EventFamily[] = []
	if (SERVER_EVENT_NAMES.has(type)) families.push('server')
	if (APP_EVENT_NAMES.has(type)) families.push('app')
	return families
}

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
	// Who a kill was between. `player` matches an event the player is named in at all, which for a kill is
	// both ends of it; these two say which end. Only PLAYER_DIED and PLAYER_WOUNDED record the distinction.
	'event.attacker': { key: 'event.attacker', displayName: 'Attacker', domain: { kind: 'player' } },
	'event.victim': { key: 'event.victim', displayName: 'Victim', domain: { kind: 'player' } },
	'chat.message': { key: 'chat.message', displayName: 'Chat text', domain: { kind: 'text' } },
	// which chat a message went to. Only CHAT_MESSAGE has one, so this reads as false against everything else
	'chat.channel': { key: 'chat.channel', displayName: 'Chat channel', domain: { kind: 'enum', options: CHAT_CHANNELS } },
	// the match's own id, which every results row shows, so a row can be taken back to the match it came from
	'match.id': { key: 'match.id', displayName: 'Match id', domain: { kind: 'number' } },
	'match.outcome': { key: 'match.outcome', displayName: 'Match outcome', domain: { kind: 'enum', options: MATCH_OUTCOMES } },
	'match.setBy': { key: 'match.setBy', displayName: 'Layer set by', domain: { kind: 'enum', options: SET_BY_TYPES } },
	// how lopsided the match was, as the winner's remaining tickets over the loser's. Unsigned, because which
	// side won is `match.outcome`'s question; this one is only ever asked as "a blowout" or "a close game".
	'match.ticketDiff': { key: 'match.ticketDiff', displayName: 'Ticket difference', domain: { kind: 'number' } },
	// whole minutes from start to end, so a match still running or one the app never saw end has none
	'match.duration': { key: 'match.duration', displayName: 'Match length', domain: { kind: 'number' } },
	// The match's scoreline, over both sides: which side is team 1 flips between consecutive matches, so
	// "how much fighting was there" is the question worth asking, not "how much did team 1 do". Deaths run
	// ahead of kills by the teamkills and suicides nobody was credited with. Tallied when a match ends, so a
	// match still in progress has none.
	'match.kills': { key: 'match.kills', displayName: 'Kills', domain: { kind: 'number' } },
	'match.wounds': { key: 'match.wounds', displayName: 'Wounds', domain: { kind: 'number' } },
	'match.deaths': { key: 'match.deaths', displayName: 'Deaths', domain: { kind: 'number' } },
	// how one-sided the fighting was, as one side's kills over the other's. Unsigned for the same reason
	// ticketDiff is, and a distinct question from it: a ticket blowout can still be an even firefight.
	'match.killDiff': { key: 'match.killDiff', displayName: 'Kill difference', domain: { kind: 'number' } },
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

const PLAYER_COLUMN_KEYS = ['player', 'event.attacker', 'event.victim'] as const

/** Columns whose values are player references, and so need resolving before the tree can compile. */
export function isPlayerColumn(key: string): key is (typeof PLAYER_COLUMN_KEYS)[number] {
	return (PLAYER_COLUMN_KEYS as readonly string[]).includes(key)
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

// The measures a match can be ordered by. Only the ones the engine can order in sql: the events count is
// gathered per page, after the ordering has already decided which page that is.
export const MATCH_SORT_COLUMNS = ['time', 'duration', 'ticketDiff', 'kills', 'killDiff'] as const
export type MatchSortColumn = (typeof MATCH_SORT_COLUMNS)[number]

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
	// which end of a kill the players above have to be on. Absent means either, which is every other event too
	playerRole: z.enum(PLAYER_ROLES).optional(),
	users: z.array(z.string()).optional(),

	// Superseded by the lists above, and only ever read on the way in: every saved query and every shared
	// link written before they were lists still carries these, and folds into them (see foldSingles).
	server: z.string().optional(),
	player: z.string().optional(),
	user: z.string().optional(),
	outcome: z.enum(MATCH_OUTCOMES).optional(),

	// events only: which end of the range the page starts from. A bound rather than a filter, so it sits
	// outside the tree like the others and means the same thing in both modes. Absent means newest, which
	// keeps it out of the url of every query that does not care.
	order: z.enum(['newest', 'oldest']).optional(),

	types: z.array(z.enum(EVENT_TYPES)).optional(),
	// the activity feed's secondary filter, as a shortcut over event type. Absent means ALL (see feedFilterNode)
	feed: CHAT.SECONDARY_FILTER_STATE.optional(),
	variant: z.enum(EVENT_VARIANTS).optional(),
	damageSource: z.string().optional(),
	chat: z.string().optional(),
	channel: z.enum(CHAT_CHANNELS).optional(),
	layer: F.FilterNodeSchema.optional(),
	map: z.string().optional(),
	gamemode: z.string().optional(),
	faction: z.string().optional(),
	outcomes: z.array(z.enum(MATCH_OUTCOMES)).optional(),
	setBy: z.enum(SET_BY_TYPES).optional(),
	// bounds on match.ticketDiff. Either alone reads as "a blowout" / "a close game"; both make a band
	ticketDiffMin: z.number().int().nonnegative().optional(),
	ticketDiffMax: z.number().int().nonnegative().optional(),
	// bounds on match.duration, in whole minutes
	durationMin: z.number().int().nonnegative().optional(),
	durationMax: z.number().int().nonnegative().optional(),
	// bounds on the scoreline measures, read the same way as ticketDiff's
	killsMin: z.number().int().nonnegative().optional(),
	killsMax: z.number().int().nonnegative().optional(),
	woundsMin: z.number().int().nonnegative().optional(),
	woundsMax: z.number().int().nonnegative().optional(),
	deathsMin: z.number().int().nonnegative().optional(),
	deathsMax: z.number().int().nonnegative().optional(),
	killDiffMin: z.number().int().nonnegative().optional(),
	killDiffMax: z.number().int().nonnegative().optional(),
	name: z.string().optional(),
	matchId: z.number().int().positive().optional(),
	minMatches: z.number().int().positive().optional(),

	// one field for all three tabs, read through playerSort/matchSort: the tabs are views over one query, so
	// a sort set on one carries into the next and falls back where its column means nothing there
	sort: z.object({ column: z.enum([...PLAYER_SORT_COLUMNS, ...MATCH_SORT_COLUMNS]), dir: z.enum(['asc', 'desc']) }).optional(),

	// advanced mode's tree
	q: NodeSchema.optional(),
})

// A one-valued ref folds into its list and stops existing, so nothing downstream has two spellings of the
// same field to handle. Done in the schema rather than at the call sites because a query is parsed from
// three places (the url, a saved row, a recent) and any of them can be old.
type QueryFields = z.infer<typeof QueryFieldsSchema>
// spelled out rather than inferred: an inferred transform return turns `servers?: string[]` into
// `servers: string[] | undefined`, which makes every query literal have to name all three
type FoldedQuery = Omit<QueryFields, 'server' | 'player' | 'user' | 'outcome'>

function foldSingles({ server, player, user, outcome, ...rest }: QueryFields): FoldedQuery {
	const fold = <T extends string>(list: T[] | undefined, single: T | undefined) => {
		const merged = [...new Set([...(list ?? []), ...(single ? [single] : [])])]
		return merged.length > 0 ? merged : undefined
	}
	return {
		...rest,
		servers: fold(rest.servers, server),
		players: fold(rest.players, player),
		users: fold(rest.users, user),
		outcomes: fold(rest.outcomes, outcome),
	}
}

export const QuerySchema = QueryFieldsSchema.transform(foldSingles)
export type Query = z.infer<typeof QuerySchema>

export const DEFAULT_QUERY: Query = QuerySchema.parse({})

// The history url's params beside the query. None of them changes what the query answers, so a saved or recent
// query carries none of them.

// a run of result rows to highlight and scroll to, by the event ids at either end, anchor first
export const RowSelectionParamSchema = z.tuple([z.coerce.string(), z.coerce.string()])
export type RowSelectionParam = z.infer<typeof RowSelectionParamSchema>

// A position in the merged event order, where a page of events starts; exactly one id is set, per the family the
// cursor sits in. A url only carries one for a page asked for as text: the page itself loads more in place.
export const EventCursorSchema = z.object({
	time: z.number().int(),
	serverEventId: z.number().int().optional(),
	appEventId: z.string().optional(),
})
export type EventCursor = z.infer<typeof EventCursorSchema>

// What the url answers with. The page itself is html. Text is events as copying them gives, and players and
// matches as a table; csv is players and matches alone. Listed in order of preference, for a header that ranks
// several the same.
export const CONTENT_TYPES = ['text/html', 'text/plain', 'text/csv'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]
export const ContentTypeSchema = z.enum(CONTENT_TYPES)

/** The content types other than the page that a result type has a form in. */
export function rawContentTypes(type: ResultType): Exclude<ContentType, 'text/html'>[] {
	switch (type) {
		case 'events':
			return ['text/plain']
		case 'players':
		case 'matches':
			return ['text/plain', 'text/csv']
		default:
			assertNever(type)
	}
}

// which page of a players or matches result the url asks for as text, counted from 1 as the pager counts
export const PageParamSchema = z.number().int().positive()

export type Search = Query & { sel?: RowSelectionParam; cursor?: EventCursor; page?: number; contentType?: ContentType }
export type SearchExtras = Pick<Search, 'sel' | 'cursor' | 'page' | 'contentType'>

/** The history url's search, from the router's already-parsed params; a query that does not parse is the default. */
export function parseSearch(raw: Record<string, unknown>): Search {
	const res = QuerySchema.safeParse(raw)
	const search: Search = res.success ? res.data : DEFAULT_QUERY
	const sel = RowSelectionParamSchema.safeParse(raw.sel)
	const cursor = EventCursorSchema.safeParse(raw.cursor)
	const page = PageParamSchema.safeParse(raw.page)
	const contentType = ContentTypeSchema.safeParse(raw.contentType)
	return {
		...search,
		...(sel.success ? { sel: sel.data } : {}),
		...(cursor.success ? { cursor: cursor.data } : {}),
		...(page.success ? { page: page.data } : {}),
		...(contentType.success ? { contentType: contentType.data } : {}),
	}
}

/** A search split into the query it runs and the params beside it. */
export function splitSearch(search: Search): { query: Query } & SearchExtras {
	const { sel, cursor, page, contentType, ...query } = search
	return { query, sel, cursor, page, contentType }
}

/**
 * What a request for the history url answers with: the `contentType` param when it names one, else the type the
 * Accept header prefers, else the page. Types the header ranks equally go to the earliest in CONTENT_TYPES.
 */
export function negotiateContentType(param: ContentType | undefined, accept: string | undefined): ContentType {
	if (param) return param
	if (!accept) return 'text/html'
	const ranges = accept.split(',').map((part) => {
		const [range, ...params] = part.trim().toLowerCase().split(';')
		const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
		return { range: range.trim(), q: q ? Number(q.slice(2)) : 1 }
	})
	// a type's quality is the one its most specific matching range gives it; unmatched is 0
	const quality = (type: ContentType) => {
		const [major] = type.split('/')
		const match =
			ranges.find((r) => r.range === type) ?? ranges.find((r) => r.range === `${major}/*`) ?? ranges.find((r) => r.range === '*/*')
		return match && Number.isFinite(match.q) ? match.q : 0
	}
	let best: ContentType = 'text/html'
	for (const type of CONTENT_TYPES) if (quality(type) > quality(best)) best = type
	return best
}

const URL_PATTERN = /https?:\/\/[^\s<>]+/g

/**
 * The history links in `text` that carry a selection, once each, in order. Only links to this app (`origin`) count.
 * Trailing sentence punctuation is not part of a link: a pasted url is often followed by one.
 */
export function selectionLinksIn(text: string, origin: string): { query: Query; sel: RowSelectionParam }[] {
	const own = new URL(origin).origin
	const seen = new Set<string>()
	const out: { query: Query; sel: RowSelectionParam }[] = []
	for (const [match] of text.matchAll(URL_PATTERN)) {
		let url: URL
		try {
			url = new URL(match.replace(/[.,!?)]+$/, ''))
		} catch {
			continue
		}
		if (url.origin !== own || url.pathname !== '/history' || seen.has(url.search)) continue
		seen.add(url.search)
		const { query, sel } = splitSearch(parseSearchParams(url.searchParams))
		if (sel) out.push({ query, sel })
	}
	return out
}

/**
 * The same from raw url params, for reading a history link outside the router. Each value is json where it parses
 * as json and a plain string otherwise, which is how the router serializes a search.
 */
export function parseSearchParams(params: URLSearchParams): Search {
	const raw: Record<string, unknown> = {}
	for (const [key, value] of params) {
		try {
			raw[key] = JSON.parse(value)
		} catch {
			raw[key] = value
		}
	}
	return parseSearch(raw)
}

/**
 * The query whose results are a server activity log's rows: its match on its server, through the same event
 * filter, oldest first as the log reads.
 *
 * Close rather than exact. The results also show the teamless chat and the undrawn event types the log leaves
 * out, and ADMIN differs as feedFilterNode says. The log shows its pinned rows (CHAT.isPinnedSystemEvent) under
 * every filter, where the results keep them only under ALL and DEFAULT, apart from each match's NEW_GAME.
 * "Selected Only" is not carried at all: `players` also matches a
 * player's game-participant rows and leaves out app events they were the actor of, which is a different set
 * from the log's.
 */
export function activityLogQuery(args: { serverId: string; matchId: number; feed: CHAT.SecondaryFilterState }): Query {
	return {
		...DEFAULT_QUERY,
		servers: [args.serverId],
		matchId: args.matchId,
		feed: args.feed === 'ALL' ? undefined : args.feed,
		order: 'oldest',
	}
}

// The one server every result can only have come from, where the query names exactly one. What lets a row
// with no match of its own still offer the interactions that act on a server.
export function soleServerId(query: Query): string | undefined {
	return query.servers?.length === 1 ? query.servers[0] : undefined
}

export type SortDir = 'asc' | 'desc'

// The shared `sort` field read as one tab's sort. A column belonging to another tab falls back to this tab's
// default rather than erroring: switching tabs carries the whole query across, sort included.
export function playerSort(query: Query): { column: PlayerSortColumn; dir: SortDir } {
	const sort = query.sort
	if (sort && (PLAYER_SORT_COLUMNS as readonly string[]).includes(sort.column)) {
		return { column: sort.column as PlayerSortColumn, dir: sort.dir }
	}
	return { column: 'matches', dir: 'desc' }
}

export function matchSort(query: Query): { column: MatchSortColumn; dir: SortDir } {
	const sort = query.sort
	if (sort && (MATCH_SORT_COLUMNS as readonly string[]).includes(sort.column)) {
		return { column: sort.column as MatchSortColumn, dir: sort.dir }
	}
	return { column: 'time', dir: 'desc' }
}

// -------- normalization --------

function comp(column: ColumnKey, values: (string | number)[]): F.CompNode {
	const subject: F.ColumnArg = { type: 'column', column }
	if (values.length === 1) return { type: 'eq', neg: false, args: [subject, { type: 'value', value: values[0] }] }
	return { type: 'in', neg: false, args: [subject, { type: 'values', values }] }
}

// `gt`/`lt` are strict, so an inclusive bound is expressed as the neighbouring integer. A pair becomes one
// `inrange` rather than two comparisons, which is what the advanced editor shows when the mode is switched.
function rangeNodes(column: string, min: number | undefined, max: number | undefined): Node[] {
	const subject: F.ColumnArg = { type: 'column', column }
	if (min !== undefined && max !== undefined) {
		return [{ type: 'inrange', neg: false, args: [subject, { type: 'value', value: min }, { type: 'value', value: max }] }]
	}
	if (min !== undefined) return [{ type: 'gt', neg: false, args: [subject, { type: 'value', value: min - 1 }] }]
	if (max !== undefined) return [{ type: 'lt', neg: false, args: [subject, { type: 'value', value: max + 1 }] }]
	return []
}

const KILL_TYPES = ['PLAYER_DIED', 'PLAYER_WOUNDED']
const SQUAD_MEMBERSHIP_TYPES = ['PLAYER_JOINED_SQUAD', 'PLAYER_LEFT_SQUAD']
// the in-game counterparts of an admin's actions, which the audit trail records from the other side
const ADMIN_ACTION_TYPES = ['PLAYER_KICKED', 'PLAYER_BANNED', 'POSSESSED_ADMIN_CAMERA', 'UNPOSSESSED_ADMIN_CAMERA']
// roster bookkeeping rather than anything a player did; only ALL shows them
const BOOKKEEPING_TYPES = ['PLAYER_RECONCILED', 'PLAYER_DETAILS_CHANGED']

const NOT_TEAMKILL: F.CompNode = {
	type: 'eq',
	neg: true,
	args: [
		{ type: 'column', column: 'event.variant' },
		{ type: 'value', value: 'teamkill' },
	],
}

/**
 * The activity feed's secondary filter as a node, so the history page offers the same six views.
 *
 * Not quite the same predicate. The feed decides per event with the whole object in hand, where this has only
 * what the index carries: `ADMIN` picks up admin chat and the admin actions, but not the connects and
 * disconnects the feed shows for admins, since whether a player was one is not indexed. The rest are exact.
 */
export function feedFilterNode(feed: CHAT.SecondaryFilterState): Node | undefined {
	switch (feed) {
		case 'ALL':
			return undefined
		case 'DEFAULT':
			return {
				type: 'nor',
				children: [
					{ type: 'and', children: [comp('event.type', KILL_TYPES), NOT_TEAMKILL] },
					comp('event.type', SQUAD_MEMBERSHIP_TYPES),
					comp('event.type', BOOKKEEPING_TYPES),
				],
			}
		case 'CHAT':
			return comp('event.type', ['CHAT_MESSAGE', 'ADMIN_BROADCAST', 'BROADCAST_SENT', 'PLAYER_WARNED'])
		// the audit trail. MAP_SET needs no mention: it is one of the names both families raise, so naming it
		// as an app event already matches the server event too (see EVENT_TYPES)
		case 'SLM_EVENTS':
			return comp('event.type', APP_EVENT_TYPE.options)
		case 'ADMIN':
			return {
				type: 'or',
				children: [
					comp('event.type', [...new Set([...APP_EVENT_TYPE.options, 'ADMIN_BROADCAST', ...ADMIN_ACTION_TYPES])]),
					{ type: 'and', children: [comp('event.type', ['CHAT_MESSAGE']), comp('chat.channel', ['ChatAdmin'])] },
				],
			}
		case 'KILLFEED':
			return comp('event.type', KILL_TYPES)
		default:
			assertNever(feed)
	}
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
	if (query.players?.length && query.type !== 'players') {
		children.push(comp(query.playerRole ? `event.${query.playerRole}` : 'player', query.players))
	}
	if (query.users?.length) children.push(comp('user', query.users))
	if (query.types && query.types.length > 0) children.push(comp('event.type', query.types))
	if (query.feed) {
		const node = feedFilterNode(query.feed)
		if (node) children.push(node)
	}
	if (query.variant) children.push(comp('event.variant', [query.variant]))
	if (query.damageSource) children.push(comp('event.damageSource', [query.damageSource]))
	if (query.chat) children.push(comp('chat.message', [query.chat]))
	if (query.channel) children.push(comp('chat.channel', [query.channel]))
	if (query.layer) children.push({ type: 'match-layer', neg: false, filter: query.layer })
	if (query.map) children.push(comp('layer.map', [query.map]))
	if (query.gamemode) children.push(comp('layer.gamemode', [query.gamemode]))
	if (query.faction) children.push(comp('layer.faction', [query.faction]))
	if (query.matchId !== undefined) children.push(comp('match.id', [query.matchId]))
	if (query.outcomes?.length) children.push(comp('match.outcome', query.outcomes))
	if (query.setBy) children.push(comp('match.setBy', [query.setBy]))
	children.push(...rangeNodes('match.ticketDiff', query.ticketDiffMin, query.ticketDiffMax))
	children.push(...rangeNodes('match.kills', query.killsMin, query.killsMax))
	children.push(...rangeNodes('match.wounds', query.woundsMin, query.woundsMax))
	children.push(...rangeNodes('match.deaths', query.deathsMin, query.deathsMax))
	children.push(...rangeNodes('match.killDiff', query.killDiffMin, query.killDiffMax))
	children.push(...rangeNodes('match.duration', query.durationMin, query.durationMax))
	return { type: 'and', children }
}

// The same query, narrowed to the events of one row of a players or matches result. A basic query stays basic,
// with the row as one more field, so a link to those events reads the way the query did. An advanced query has
// the row anded onto its tree, the only narrowing that composes with anything a tree can hold.

function narrowedTree(query: Query, extra: Node): Query {
	return { ...query, type: 'events', q: { type: 'and', children: [queryFilterNode(query), extra] } }
}

export function eventsForPlayer(query: Query, playerId: string): Query {
	if (query.mode === 'advanced') return narrowedTree(query, comp('player', [playerId]))
	// On a players result, `players` and the `playerRole` qualifying it pick which rows show, as do `name` and
	// `minMatches`; none of them filters the events a row counts (see queryFilterNode, groupPlayerRefs). So the row's
	// player replaces them rather than being anded with them.
	return { ...query, type: 'events', players: [playerId], playerRole: undefined, name: undefined, minMatches: undefined }
}

export function eventsForMatch(query: Query, matchId: number): Query {
	if (query.mode === 'advanced') return narrowedTree(query, { type: 'match-ids', neg: false, matchIds: [matchId] })
	// every row of a matches result already passed the query's own `matchId`, if it has one, so this narrows it
	return { ...query, type: 'events', matchId }
}

/** The same, for a results row by its key (`player:<eos id>` or `match:<id>`); undefined for a key of neither kind. */
export function eventsForRow(query: Query, rowKey: string): Query | undefined {
	const separator = rowKey.indexOf(':')
	const kind = rowKey.slice(0, separator)
	const id = rowKey.slice(separator + 1)
	if (kind === 'player') return eventsForPlayer(query, id)
	if (kind === 'match') return eventsForMatch(query, Number(id))
	return undefined
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
	// how many events the query matched for this player, which is what the row expands to show
	events: number
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
