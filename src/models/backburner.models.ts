import { createId } from '@/lib/id'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { normalizeForMatch } from '@/lib/string'
import { assertNever } from '@/lib/type-guards'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import type * as LC from '@/models/layer-columns'
import * as USR from '@/models/users.models'
import StringComparison from 'string-comparison'
import { z } from 'zod'

export const ItemIdSchema = z.string().min(1)
export type ItemId = z.infer<typeof ItemIdSchema>

export const BackburnerItemSchema = z.object({
	itemId: ItemIdSchema,
	// the template's constraint set; conventionally an 'and' block of the shapes parseTemplateParts recognizes
	filter: F.FilterNodeSchema,
	source: USR.GuiOrChatUserIdSchema,
	createdAt: z.number().int(),
})
export type BackburnerItem = z.infer<typeof BackburnerItemSchema>

// oldest first: generation folds templates in this order
export const BackburnerListSchema = z.array(BackburnerItemSchema)
export type BackburnerList = z.infer<typeof BackburnerListSchema>

export function createItemId() {
	return createId(16)
}

export function sameOwner(a: USR.GuiOrChatUserId, b: USR.GuiOrChatUserId): boolean {
	if (a.discordId !== undefined && b.discordId !== undefined && a.discordId === b.discordId) return true
	if (a.steamId !== undefined && b.steamId !== undefined && a.steamId === b.steamId) return true
	return false
}

export function ownedItems(items: BackburnerItem[], owner: USR.GuiOrChatUserId): BackburnerItem[] {
	return items.filter(item => sameOwner(item.source, owner))
}

export type MergeTemplatesResult =
	| { code: 'ok'; filter: F.FilterNode }
	// a filter applied regularly on one side and inverted on the other: almost certainly not what was intended
	| { code: 'err:conflicting-filters'; filterIds: string[] }

// Merging widens element-wise: each recognized element of the two templates is OR'd (value lists union,
// matchup sides union). Applied filters are the exception: the lists union deduped and all still apply.
export function mergeTemplateFilters(target: F.FilterNode, source: F.FilterNode): MergeTemplatesResult {
	const a = parseTemplateParts(target)
	const b = parseTemplateParts(source)
	const parts = emptyTemplateParts()
	for (const key of ['layers', 'maps', 'gamemodes', 'versions', 'collections', 'sizes'] as const) {
		parts[key] = unionValues(a[key], b[key])
	}
	mergeTeamParts(parts, a, b)
	parts.filterIds = unionValues(a.filterIds, b.filterIds)
	parts.excludedFilterIds = unionValues(a.excludedFilterIds, b.excludedFilterIds)
	const conflicts = parts.filterIds.filter(id => parts.excludedFilterIds.includes(id))
	if (conflicts.length > 0) return { code: 'err:conflicting-filters', filterIds: conflicts }
	parts.other = [...a.other, ...b.other]
	return { code: 'ok', filter: buildTemplateFilter(parts) }
}

function unionValues<T>(a: T[], b: T[]): T[] {
	const out = [...a]
	for (const value of b) {
		if (!out.includes(value)) out.push(value)
	}
	return out
}

function hasTeamParts(parts: TemplateParts): boolean {
	return parts.factions.length > 0 || parts.alliances.length > 0 || parts.units.length > 0
		|| (!!parts.matchup && matchupHasValues(parts.matchup))
}

// a template's team constraints as one matchup: the explicit matchup node if present, with loose
// either-team singles folded into side 0 (equivalent for unlocked matchups, which is what singles produce)
function asMatchup(parts: TemplateParts): F.MatchupNode {
	const node = parts.matchup && matchupHasValues(parts.matchup)
		? (structuredClone(parts.matchup) as F.MatchupNode)
		: (FB.allowMatchups([{}, {}]) as F.MatchupNode)
	const singles: [F.TeamColumn, string[]][] = [['Faction', parts.factions], ['Alliance', parts.alliances], ['Unit', parts.units]]
	for (const [column, values] of singles) {
		if (values.length > 0) node.teams[0][column] = unionValues(node.teams[0][column] ?? [], values)
	}
	return node
}

function mergeTeamParts(out: TemplateParts, a: TemplateParts, b: TemplateParts) {
	if (!hasTeamParts(a) || !hasTeamParts(b)) {
		const src = hasTeamParts(a) ? a : b
		out.factions = [...src.factions]
		out.alliances = [...src.alliances]
		out.units = [...src.units]
		out.matchup = src.matchup
		return
	}
	const ma = asMatchup(a)
	const mb = asMatchup(b)
	out.matchup = FB.allowMatchups(
		[unionSpec(ma.teams[0], mb.teams[0]), unionSpec(ma.teams[1], mb.teams[1])],
		// staying locked is a narrowing, so the merge only keeps it when both sides had it
		{ locked: ma.locked && mb.locked },
	) as F.MatchupNode
}

function unionSpec(x: F.MatchupTeamSpec, y: F.MatchupTeamSpec): F.MatchupTeamSpec {
	const out: F.MatchupTeamSpec = {}
	for (const column of F.TEAM_COLUMNS) {
		const values = unionValues(x[column] ?? [], y[column] ?? [])
		if (values.length > 0) out[column] = values
	}
	return out
}

// Bakes the configured pool filter into a template (include mode -> included-in, exclude -> excluded-from),
// so requests carry pool membership themselves instead of having it enforced separately at generation time.
export function withPoolFilter(filter: F.FilterNode, poolFilter: { filterId: string; mode: 'include' | 'exclude' } | null): F.FilterNode {
	if (!poolFilter) return filter
	const parts = parseTemplateParts(filter)
	const key = poolFilter.mode === 'include' ? 'filterIds' : 'excludedFilterIds'
	if (parts[key].includes(poolFilter.filterId)) return filter
	parts[key].push(poolFilter.filterId)
	return buildTemplateFilter(parts)
}

export function removeByIds(items: BackburnerItem[], itemIds: ItemId[]): BackburnerItem[] {
	const ids = new Set(itemIds)
	return items.filter(item => !ids.has(item.itemId))
}

// draft-vs-saved diff, so panel rows can be colour-coded like the shared layer list's mutations. Items present
// in both lists are "moved" only when their order genuinely changed: the longest order-preserving run of shared
// items counts as stable, so a single reorder marks just the item that jumped rather than everything it shifted.
export function diffMutations(draft: BackburnerItem[], saved: BackburnerItem[]): ItemMut.Mutations {
	const mutations = ItemMut.initMutations()
	const savedById = new Map(saved.map(item => [item.itemId, item]))
	const draftIds = new Set(draft.map(item => item.itemId))
	for (const item of draft) {
		const prev = savedById.get(item.itemId)
		if (!prev) mutations.added.add(item.itemId)
		else if (!Obj.deepEqual(prev.filter, item.filter)) mutations.edited.add(item.itemId)
	}
	for (const item of saved) {
		if (!draftIds.has(item.itemId)) mutations.removed.add(item.itemId)
	}

	// shared items in draft order, keyed by their position in the saved order; the longest increasing run of
	// those positions is the set that kept its relative order, everything else moved
	const savedIndex = new Map(saved.map((item, index) => [item.itemId, index]))
	const shared = draft.filter(item => savedIndex.has(item.itemId))
	const stable = longestIncreasingRun(shared.map(item => savedIndex.get(item.itemId)!))
	shared.forEach((item, position) => {
		if (!stable.has(position)) mutations.moved.add(item.itemId)
	})
	return mutations
}

// positions (into `seq`) that belong to one longest strictly-increasing subsequence
function longestIncreasingRun(seq: number[]): Set<number> {
	const predecessor = new Array<number>(seq.length).fill(-1)
	// tailPositions[len-1] = index into seq of the smallest tail value of an increasing subsequence of length len
	const tailPositions: number[] = []
	for (let i = 0; i < seq.length; i++) {
		let lo = 0
		let hi = tailPositions.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (seq[tailPositions[mid]] < seq[i]) lo = mid + 1
			else hi = mid
		}
		if (lo > 0) predecessor[i] = tailPositions[lo - 1]
		if (lo === tailPositions.length) tailPositions.push(i)
		else tailPositions[lo] = i
	}
	const result = new Set<number>()
	let cursor = tailPositions.length > 0 ? tailPositions[tailPositions.length - 1] : -1
	while (cursor !== -1) {
		result.add(cursor)
		cursor = predecessor[cursor]
	}
	return result
}

// -------- the structured view of a template --------
// A template is stored as a FilterNode so the fold and future free-form editing stay general, but every
// surface (the simple editor, row display, chat listings) works through this decomposition of it. Conjuncts
// outside the recognized shapes land in `other` and are preserved verbatim on rebuild.

export type TemplateParts = {
	// full layer strings (the Layer column, e.g. Gorodok_RAAS_v1); an alternative to maps/gamemodes/versions
	layers: string[]
	maps: string[]
	gamemodes: string[]
	versions: string[]
	collections: string[]
	sizes: string[]
	// team dimensions: one value = either team fields it; two = a matchup (either orientation).
	// used by the chat token grammar; the GUI edits `matchup` directly
	factions: string[]
	alliances: string[]
	units: string[]
	// a full matchup node (allow-matchups, any dimensions/values/lock state)
	matchup?: F.MatchupNode
	filterIds: string[]
	excludedFilterIds: string[]
	other: F.FilterNode[]
}

export function emptyTemplateParts(): TemplateParts {
	return {
		layers: [],
		maps: [],
		gamemodes: [],
		versions: [],
		collections: [],
		sizes: [],
		factions: [],
		alliances: [],
		units: [],
		filterIds: [],
		excludedFilterIds: [],
		other: [],
	}
}

const COLUMN_PART_KEYS = {
	Layer: 'layers',
	Map: 'maps',
	Gamemode: 'gamemodes',
	LayerVersion: 'versions',
	Collection: 'collections',
	Size: 'sizes',
} as const satisfies Record<string, keyof TemplateParts>

const TEAM_PART_KEYS = {
	Faction: 'factions',
	Alliance: 'alliances',
	Unit: 'units',
} as const satisfies Record<F.TeamColumn, keyof TemplateParts>

export function buildTemplateFilter(parts: Partial<TemplateParts>): F.FilterNode {
	const nodes: F.FilterNode[] = []
	for (const [column, key] of Object.entries(COLUMN_PART_KEYS)) {
		const values = (parts[key] ?? []) as string[]
		if (values.length === 1) nodes.push(FB.eq(column, values[0]))
		else if (values.length > 1) nodes.push(FB.inValues(column, values))
	}
	for (const column of Object.keys(TEAM_PART_KEYS) as F.TeamColumn[]) {
		const values = parts[TEAM_PART_KEYS[column]] ?? []
		if (values.length === 1) nodes.push(FB.eq(FB.teamCol(column), values[0]))
		// two team values means a matchup, either orientation
		else if (values.length >= 2) nodes.push(FB.allowMatchups([{ [column]: [values[0]] }, { [column]: [values[1]] }]))
	}
	if (parts.matchup && matchupHasValues(parts.matchup)) nodes.push(parts.matchup)
	for (const filterId of parts.filterIds ?? []) nodes.push(FB.includedIn(filterId))
	for (const filterId of parts.excludedFilterIds ?? []) nodes.push(FB.excludedFrom(filterId))
	nodes.push(...(parts.other ?? []))
	return FB.and(nodes)
}

function stringValues(node: { args: readonly unknown[] }): string[] | undefined {
	const arg = node.args[1] as { type?: string; value?: unknown; values?: unknown[] } | undefined
	if (!arg || typeof arg !== 'object') return undefined
	if (arg.type === 'value') return typeof arg.value === 'string' ? [arg.value] : undefined
	if (arg.type === 'values' && Array.isArray(arg.values)) {
		return arg.values.every(value => typeof value === 'string') ? (arg.values as string[]) : undefined
	}
	return undefined
}

export function parseTemplateParts(filter: F.FilterNode): TemplateParts {
	const parts = emptyTemplateParts()
	const conjuncts = filter.type === 'and' ? filter.children : [filter]
	for (const node of conjuncts) {
		if ((node.type === 'eq' || node.type === 'in') && !node.neg) {
			const subject = node.args[0]
			const values = stringValues(node)
			if (values && subject?.type === 'column' && subject.column in COLUMN_PART_KEYS) {
				const key = COLUMN_PART_KEYS[subject.column as keyof typeof COLUMN_PART_KEYS]
				if (parts[key].length === 0) {
					parts[key].push(...values)
					continue
				}
			}
			if (
				values?.length === 1
				&& node.type === 'eq'
				&& subject?.type === 'team-column'
				&& subject.quantifier === 'either'
				&& parts[TEAM_PART_KEYS[subject.column]].length === 0
			) {
				parts[TEAM_PART_KEYS[subject.column]].push(values[0])
				continue
			}
		}
		if (node.type === 'allow-matchups' && !parts.matchup) {
			parts.matchup = node
			continue
		}
		if (node.type === 'included-in') {
			parts.filterIds.push(node.filterId)
			continue
		}
		if (node.type === 'excluded-from') {
			parts.excludedFilterIds.push(node.filterId)
			continue
		}
		parts.other.push(node)
	}
	return parts
}

export function matchupHasValues(node: F.MatchupNode): boolean {
	return node.teams.some(side => Object.values(side).some(values => (values?.length ?? 0) > 0))
}

// per-column values for seeding the select-layers menu when a request is dragged into the queue. The matchup's
// left spec fills the Team 1 columns (_1) and the right spec the Team 2 columns (_2); a single either-team pick
// (the chat grammar's `factions`/`alliances`/`units`) lands on Team 1. Filters/`other` conjuncts aren't menu
// fields and are left out (the pool filter is reapplied by the dialog itself).
export function templateToMenuFieldValues(filter: F.FilterNode): Record<string, F.Value[]> {
	const parts = parseTemplateParts(filter)
	const fields: Record<string, F.Value[]> = {}
	const set = (column: string, values: F.Value[]) => {
		if (values.length > 0) fields[column] = values
	}
	set('Layer', parts.layers)
	set('Map', parts.maps)
	set('Gamemode', parts.gamemodes)
	set('LayerVersion', parts.versions)
	set('Collection', parts.collections)
	set('Size', parts.sizes)
	if (parts.matchup) {
		const [left, right] = parts.matchup.teams
		for (const column of F.TEAM_COLUMNS) {
			set(F.resolveTeamColumn(column, 1), left[column] ?? [])
			set(F.resolveTeamColumn(column, 2), right[column] ?? [])
		}
	} else {
		set('Faction_1', parts.factions)
		set('Alliance_1', parts.alliances)
		set('Unit_1', parts.units)
	}
	return fields
}

// the inverse: a template capturing a concrete queued layer (dragged from the queue into the requests). Map,
// gamemode and version pin the layer; each team's faction/unit becomes one side of an either-orientation matchup
// (Team 1 -> left, Team 2 -> right), mirroring templateToMenuFieldValues.
export function templateFromLayer(layer: Partial<L.KnownLayer>): F.FilterNode {
	const parts = emptyTemplateParts()
	if (layer.Map) parts.maps = [layer.Map]
	if (layer.Gamemode) parts.gamemodes = [layer.Gamemode]
	if (layer.LayerVersion) parts.versions = [layer.LayerVersion]
	const left: F.MatchupTeamSpec = {}
	const right: F.MatchupTeamSpec = {}
	if (layer.Faction_1) left.Faction = [layer.Faction_1]
	if (layer.Unit_1) left.Unit = [layer.Unit_1]
	if (layer.Faction_2) right.Faction = [layer.Faction_2]
	if (layer.Unit_2) right.Unit = [layer.Unit_2]
	if (Object.keys(left).length > 0 || Object.keys(right).length > 0) {
		parts.matchup = { type: 'allow-matchups', locked: false, teams: [left, right] }
	}
	return buildTemplateFilter(parts)
}

function describeMatchupSide(spec: F.MatchupTeamSpec): string {
	const bits: string[] = []
	for (const column of Object.keys(spec) as F.TeamColumn[]) {
		const values = spec[column]
		if (values && values.length > 0) bits.push(values.map(String).join('/'))
	}
	return bits.length > 0 ? bits.join(' ') : 'any'
}

// one rendered condition of a template. filterId is set on the filter-entity conditions so a UI can show the
// filter's own indicator alongside its name; excluded marks the "not <name>" form, whose indicator is the
// filter's inverted one
export type TemplateDisplayPart = { text: string; filterId?: string; excluded?: boolean }

// the segments a template renders as (rows, chat listings): map/gamemode/version/... values verbatim, team
// pairs as "A vs B", filter names resolved by the caller, and a count for anything unrecognized
export function templateDisplayParts(
	filter: F.FilterNode,
	getFilterName?: (id: string) => string | undefined,
): TemplateDisplayPart[] {
	const parts = parseTemplateParts(filter)
	const values = [...parts.layers, ...parts.maps, ...parts.gamemodes, ...parts.versions, ...parts.collections, ...parts.sizes]
	const out: TemplateDisplayPart[] = values.map(text => ({ text }))
	for (const values of [parts.factions, parts.alliances, parts.units]) {
		if (values.length === 1) out.push({ text: values[0] })
		else if (values.length >= 2) out.push({ text: `${values[0]} vs ${values[1]}` })
	}
	if (parts.matchup && matchupHasValues(parts.matchup)) {
		const [a, b] = parts.matchup.teams
		out.push({ text: `${describeMatchupSide(a)} vs ${describeMatchupSide(b)}${parts.matchup.locked ? ' (locked)' : ''}` })
	}
	for (const id of parts.filterIds) out.push({ text: getFilterName?.(id) ?? id, filterId: id })
	for (const id of parts.excludedFilterIds) out.push({ text: `not ${getFilterName?.(id) ?? id}`, filterId: id, excluded: true })
	if (parts.other.length > 0) {
		out.push({ text: `+${parts.other.length} custom condition${parts.other.length === 1 ? '' : 's'}` })
	}
	return out.length > 0 ? out : [{ text: 'any layer' }]
}

export function describeTemplate(filter: F.FilterNode, getFilterName?: (id: string) => string | undefined): string {
	return templateDisplayParts(filter, getFilterName).map(part => part.text).join(', ')
}

// -------- request token resolution (/reqlayer) --------

export type ResolvedRequest = {
	filter: F.FilterNode
	// canonical names of what each token resolved to, for the confirmation reply
	parts: string[]
}

export type ResolveTokensResult =
	| { code: 'ok'; value: ResolvedRequest }
	| { code: 'err:empty'; msg: string }
	| { code: 'err:unknown-token'; token: string; msg: string }
	| { code: 'err:ambiguous-token'; token: string; msg: string }
	| { code: 'err:too-many'; column: string; msg: string }

type TokenTarget =
	| { kind: 'layer' | 'map' | 'gamemode' | 'version' | 'collection' | 'size' | 'faction' | 'alliance' | 'unit'; value: string }
	| { kind: 'filter'; filterId: string; name: string }

const TOKEN_PART_KEYS = {
	layer: 'layers',
	map: 'maps',
	gamemode: 'gamemodes',
	version: 'versions',
	collection: 'collections',
	size: 'sizes',
	faction: 'factions',
	alliance: 'alliances',
	unit: 'units',
} as const satisfies Record<Exclude<TokenTarget['kind'], 'filter'>, keyof TemplateParts>

// Maps and filter names match fuzzily (unique substring); everything else must match exactly
// (case/whitespace-insensitive). Exact matches are tried across every category first so a token that is
// exactly a faction code can never be stolen by a fuzzy map match.
export function resolveRequestTokens(input: {
	tokens: string[]
	components: LC.LayerComponents
	filterEntities: { id: string; name: string }[]
}): ResolveTokensResult {
	const { components, filterEntities } = input
	const tokens = input.tokens.map(t => t.trim()).filter(t => t.length > 0)
	if (tokens.length === 0) return { code: 'err:empty', msg: 'Nothing requested' }

	// exact lookup: normalized token -> canonical target. earlier entries win, so category priority is
	// insertion order: gamemodes, factions, alliances, units, sizes, versions, maps (incl. abbreviations)
	const exact = new Map<string, TokenTarget>()
	const addExact = (raw: string | null | undefined, target: TokenTarget) => {
		if (!raw) return
		const key = normalizeForMatch(raw)
		if (!exact.has(key)) exact.set(key, target)
	}
	for (const gamemode of components.gamemodes) {
		addExact(gamemode, { kind: 'gamemode', value: gamemode })
		addExact(components.gamemodeAbbreviations[gamemode], { kind: 'gamemode', value: gamemode })
	}
	for (const faction of components.factions) addExact(faction, { kind: 'faction', value: faction })
	for (const alliance of components.alliances) addExact(alliance, { kind: 'alliance', value: alliance })
	for (const unit of components.units) {
		addExact(unit, { kind: 'unit', value: unit })
		addExact(components.unitAbbreviations[unit], { kind: 'unit', value: unit })
		addExact(components.unitShortNames[unit], { kind: 'unit', value: unit })
	}
	for (const size of components.size) addExact(size, { kind: 'size', value: size })
	for (const collection of components.collections) {
		addExact(collection, { kind: 'collection', value: collection })
		addExact(components.collectionAbbreviations[collection], { kind: 'collection', value: collection })
	}
	for (const version of components.versions) {
		if (version !== null) addExact(version, { kind: 'version', value: version })
	}
	for (const layer of components.layers) addExact(layer, { kind: 'layer', value: layer })
	for (const map of components.maps) {
		addExact(map, { kind: 'map', value: map })
		addExact(components.mapAbbreviations[map], { kind: 'map', value: map })
	}

	const targets: TokenTarget[] = []
	for (const token of tokens) {
		const exactTarget = exact.get(normalizeForMatch(token))
		if (exactTarget) {
			targets.push(exactTarget)
			continue
		}

		const mapMatches = uniqueSubstringMatch(components.maps, token)
		if (mapMatches.code === 'ok') {
			targets.push({ kind: 'map', value: mapMatches.value })
			continue
		}
		if (mapMatches.code === 'err:multiple-matches') {
			return {
				code: 'err:ambiguous-token',
				token,
				msg: `"${token}" matches ${mapMatches.count} maps. Be more specific`,
			}
		}

		const filterMatches = uniqueSubstringMatch(filterEntities.map(f => f.name), token)
		if (filterMatches.code === 'ok') {
			const entity = filterEntities.find(f => f.name === filterMatches.value)!
			targets.push({ kind: 'filter', filterId: entity.id, name: entity.name })
			continue
		}
		if (filterMatches.code === 'err:multiple-matches') {
			return {
				code: 'err:ambiguous-token',
				token,
				msg: `"${token}" matches ${filterMatches.count} filters. Be more specific`,
			}
		}

		return { code: 'err:unknown-token', token, msg: unknownTokenMessage(token, exact, components, filterEntities) }
	}

	const parts = emptyTemplateParts()
	const displayParts: string[] = []
	for (const target of targets) {
		switch (target.kind) {
			case 'layer':
			case 'map':
			case 'gamemode':
			case 'version':
			case 'collection':
			case 'size':
			case 'faction':
			case 'alliance':
			case 'unit': {
				const key = TOKEN_PART_KEYS[target.kind]
				if (!parts[key].includes(target.value)) parts[key].push(target.value)
				displayParts.push(target.value)
				break
			}
			case 'filter':
				if (!parts.filterIds.includes(target.filterId)) parts.filterIds.push(target.filterId)
				displayParts.push(target.name)
				break
			default:
				assertNever(target)
		}
	}

	for (const [column, key] of Object.entries(TEAM_PART_KEYS)) {
		if (parts[key].length > 2) {
			return {
				code: 'err:too-many',
				column,
				msg: `At most two ${column.toLowerCase()}s can be requested (a matchup)`,
			}
		}
	}
	const singleValued: [string, 'layers' | 'maps' | 'gamemodes' | 'versions' | 'collections' | 'sizes'][] = [
		['layer', 'layers'],
		['map', 'maps'],
		['gamemode', 'gamemodes'],
		['version', 'versions'],
		['collection', 'collections'],
		['size', 'sizes'],
	]
	for (const [label, key] of singleValued) {
		if (parts[key].length > 1) {
			return { code: 'err:too-many', column: label, msg: `Only one ${label} can be requested` }
		}
	}

	return { code: 'ok', value: { filter: buildTemplateFilter(parts), parts: displayParts } }
}

function uniqueSubstringMatch(candidates: string[], token: string) {
	const normalized = normalizeForMatch(token)
	const matched = candidates.filter(candidate => normalizeForMatch(candidate).includes(normalized))
	if (matched.length === 0) return { code: 'err:not-found' as const }
	if (matched.length > 1) return { code: 'err:multiple-matches' as const, count: matched.length }
	return { code: 'ok' as const, value: matched[0] }
}

function unknownTokenMessage(
	token: string,
	exact: Map<string, TokenTarget>,
	components: LC.LayerComponents,
	filterEntities: { id: string; name: string }[],
): string {
	const candidates = [...exact.keys(), ...components.maps.map(normalizeForMatch), ...filterEntities.map(f => normalizeForMatch(f.name))]
	const sorted = StringComparison.diceCoefficient.sortMatch(normalizeForMatch(token), candidates)
	const base = `Unknown request "${token}"`
	if (sorted.length === 0) return base
	const best = sorted[sorted.length - 1]
	const target = exact.get(best.member)
	const suggestion = target
		? ('value' in target ? target.value : target.name)
		: (components.maps.find(m => normalizeForMatch(m) === best.member)
			?? filterEntities.find(f => normalizeForMatch(f.name) === best.member)?.name)
	return suggestion ? `${base}. Did you mean ${suggestion}?` : base
}

export function getLayerRequestSummary(
	items: BackburnerItem[],
	getFilterName?: (id: string) => string | undefined,
	owner?: USR.GuiOrChatUserId,
): string[] {
	return items.map((item, index) => {
		const own = owner && sameOwner(item.source, owner) ? ' (yours)' : ''
		return `${index + 1}. ${describeTemplate(item.filter, getFilterName)}${own}`
	})
}
