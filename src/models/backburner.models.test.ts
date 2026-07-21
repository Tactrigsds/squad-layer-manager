import * as BB from '@/models/backburner.models'
import * as FB from '@/models/filter-builders'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import { describe, expect, it } from 'vitest'

const components = L.StaticLayerComponents

function resolve(tokens: string[], filterEntities: { id: string; name: string }[] = []) {
	return BB.resolveRequestTokens({ tokens, components, filterEntities })
}

function conjuncts(res: BB.ResolveTokensResult): F.FilterNode[] {
	if (res.code !== 'ok') throw new Error(`expected ok, got ${res.code}`)
	const filter = res.value.filter
	if (filter.type !== 'and') throw new Error('expected and root')
	return filter.children
}

function compArg(node: F.FilterNode): { column?: string; value?: unknown } {
	if (node.type !== 'eq' && node.type !== 'in') throw new Error(`expected comparison, got ${node.type}`)
	const subject = node.args[0] as { column?: string }
	const value = node.args[1] as { value?: unknown; values?: unknown[] }
	return { column: subject.column, value: value.value ?? value.values }
}

describe('resolveRequestTokens', () => {
	it('fuzzy-matches map names', () => {
		const res = resolve(['goro'])
		const nodes = conjuncts(res)
		expect(nodes).toHaveLength(1)
		expect(compArg(nodes[0])).toEqual({ column: 'Map', value: 'Gorodok' })
	})

	it('resolves the fallujah example with a faction matchup', () => {
		const res = resolve(['fallu', 'adf', 'pla'])
		const nodes = conjuncts(res)
		expect(compArg(nodes[0])).toEqual({ column: 'Map', value: 'Fallujah' })
		const matchup = nodes.find(n => n.type === 'allow-matchups')
		expect(matchup).toBeDefined()
		if (matchup?.type !== 'allow-matchups') throw new Error('unreachable')
		expect(matchup.locked).toBe(false)
		expect(matchup.teams).toEqual([{ Faction: ['ADF'] }, { Faction: ['PLA'] }])
		if (res.code !== 'ok') throw new Error('unreachable')
		expect(res.value.parts).toEqual(['Fallujah', 'ADF', 'PLA'])
	})

	it('matches gamemodes and sizes exactly', () => {
		const res = resolve(['raas', 'small'])
		const nodes = conjuncts(res)
		expect(compArg(nodes[0])).toEqual({ column: 'Gamemode', value: 'RAAS' })
		expect(compArg(nodes[1])).toEqual({ column: 'Size', value: 'Small' })
	})

	it('turns a single faction into an either-team comparison', () => {
		const res = resolve(['pla'])
		const nodes = conjuncts(res)
		expect(nodes).toHaveLength(1)
		expect(nodes[0].type).toBe('eq')
		if (nodes[0].type !== 'eq') throw new Error('unreachable')
		expect(nodes[0].args[0]).toMatchObject({ type: 'team-column', column: 'Faction', quantifier: 'either' })
	})

	it('rejects three or more factions', () => {
		const res = resolve(['adf', 'pla', 'rgf'])
		expect(res.code).toBe('err:too-many')
	})

	it('rejects ambiguous map fragments with a count', () => {
		// 'al' is a substring of several maps (AlBasrah, Fallujah, ...)
		const res = resolve(['al'])
		expect(res.code).toBe('err:ambiguous-token')
	})

	it('rejects unknown tokens with a suggestion', () => {
		const res = resolve(['gorodokk'])
		expect(res.code).toBe('err:unknown-token')
		if (res.code !== 'err:unknown-token') throw new Error('unreachable')
		expect(res.msg).toContain('Did you mean')
	})

	it('fuzzy-matches filter entity names', () => {
		const res = resolve(['heli'], [{ id: 'f1', name: 'Helicopter Layers' }])
		const nodes = conjuncts(res)
		expect(nodes).toEqual([FB.includedIn('f1')])
		if (res.code !== 'ok') throw new Error('unreachable')
		expect(res.value.parts).toEqual(['Helicopter Layers'])
	})

	it('rejects more than one value per single-valued category', () => {
		const res = resolve(['gorodok', 'fallu'])
		expect(res.code).toBe('err:too-many')
		if (res.code !== 'err:too-many') throw new Error('unreachable')
		expect(res.msg).toContain('Only one map')
	})

	it('rejects an empty request', () => {
		expect(resolve([]).code).toBe('err:empty')
		expect(resolve(['  ']).code).toBe('err:empty')
	})
})

function mergeOk(a: Parameters<typeof BB.mergeTemplateFilters>[0], b: Parameters<typeof BB.mergeTemplateFilters>[1]) {
	const res = BB.mergeTemplateFilters(a, b)
	if (res.code !== 'ok') throw new Error(`expected merge to succeed, got ${res.code}`)
	return res.filter
}

describe('template merge helpers', () => {
	it('unions values of the same element', () => {
		const merged = mergeOk(FB.eq('Map', 'Chora'), FB.eq('Map', 'Fallujah'))
		expect(BB.parseTemplateParts(merged).maps).toEqual(['Chora', 'Fallujah'])
	})

	it('keeps distinct elements from both templates', () => {
		const a = FB.and([FB.eq('Map', 'Gorodok'), FB.eq('Gamemode', 'RAAS')])
		const b = FB.and([FB.eq('Size', 'Large')])
		const parts = BB.parseTemplateParts(mergeOk(a, b))
		expect(parts.maps).toEqual(['Gorodok'])
		expect(parts.gamemodes).toEqual(['RAAS'])
		expect(parts.sizes).toEqual(['Large'])
	})

	it('dedupes identical values', () => {
		const merged = mergeOk(FB.eq('Map', 'Chora'), FB.eq('Map', 'Chora'))
		expect(BB.parseTemplateParts(merged).maps).toEqual(['Chora'])
	})

	it('merges either-team singles into a one-sided matchup', () => {
		const merged = mergeOk(FB.eq(FB.teamCol('Faction'), 'CAF'), FB.eq(FB.teamCol('Faction'), 'GFI'))
		const parts = BB.parseTemplateParts(merged)
		expect(parts.matchup?.teams[0].Faction).toEqual(['CAF', 'GFI'])
		expect(parts.matchup?.teams[1].Faction ?? []).toEqual([])
		expect(parts.matchup?.locked).toBe(false)
	})

	it('unions matchups side-wise and only stays locked when both were', () => {
		const a = FB.allowMatchups([{ Faction: ['PLA'] }, { Faction: ['VDV'] }], { locked: true })
		const b = FB.allowMatchups([{ Faction: ['USA'] }, { Faction: ['RGF'] }])
		const parts = BB.parseTemplateParts(mergeOk(a, b))
		expect(parts.matchup?.teams[0].Faction).toEqual(['PLA', 'USA'])
		expect(parts.matchup?.teams[1].Faction).toEqual(['VDV', 'RGF'])
		expect(parts.matchup?.locked).toBe(false)
	})

	it('keeps a lone side of team constraints verbatim', () => {
		const merged = mergeOk(FB.eq(FB.teamCol('Faction'), 'CAF'), FB.eq('Map', 'Chora'))
		expect(BB.parseTemplateParts(merged).factions).toEqual(['CAF'])
	})

	it('unions and dedupes applied filter lists', () => {
		const merged = mergeOk(
			FB.and([FB.includedIn('f1'), FB.includedIn('f2')]),
			FB.and([FB.includedIn('f2'), FB.includedIn('f3')]),
		)
		expect(BB.parseTemplateParts(merged).filterIds).toEqual(['f1', 'f2', 'f3'])
	})

	it('rejects a merge where a filter is applied regularly on one side and inverted on the other', () => {
		const res = BB.mergeTemplateFilters(FB.includedIn('f1'), FB.excludedFrom('f1'))
		expect(res).toEqual({ code: 'err:conflicting-filters', filterIds: ['f1'] })
	})

	it('applies exclusions from both templates', () => {
		const merged = mergeOk(FB.excludedFrom('f1'), FB.excludedFrom('f2'))
		expect(BB.parseTemplateParts(merged).excludedFilterIds).toEqual(['f1', 'f2'])
	})
})

describe('withPoolFilter', () => {
	it('adds the pool filter per its mode, without duplicating', () => {
		const base = FB.and([FB.eq('Map', 'Gorodok')])
		const included = BB.withPoolFilter(base, { filterId: 'pool', mode: 'include' })
		expect(BB.parseTemplateParts(included).filterIds).toEqual(['pool'])
		expect(BB.withPoolFilter(included, { filterId: 'pool', mode: 'include' })).toBe(included)

		const excluded = BB.withPoolFilter(base, { filterId: 'pool', mode: 'exclude' })
		expect(BB.parseTemplateParts(excluded).excludedFilterIds).toEqual(['pool'])
		expect(BB.withPoolFilter(base, null)).toBe(base)
	})
})

describe('diffMutations', () => {
	const item = (itemId: string, map: string): BB.BackburnerItem => ({
		itemId,
		filter: FB.and([FB.eq('Map', map)]),
		source: { discordId: 1n },
		createdAt: 0,
	})

	it('flags added, removed and edited items against the saved list', () => {
		const saved = [item('a', 'Gorodok'), item('b', 'Fallujah')]
		const draft = [item('a', 'Chora'), item('c', 'Kohat')]
		const m = BB.diffMutations(draft, saved)
		expect([...m.added]).toEqual(['c'])
		expect([...m.removed]).toEqual(['b'])
		expect([...m.edited]).toEqual(['a'])
		expect([...m.moved]).toEqual([])
	})

	it('marks only the item that jumped, not everything it shifted past', () => {
		const saved = [item('a', 'Gorodok'), item('b', 'Fallujah'), item('c', 'Kohat')]
		const draft = [item('c', 'Kohat'), item('a', 'Gorodok'), item('b', 'Fallujah')]
		const m = BB.diffMutations(draft, saved)
		expect([...m.moved]).toEqual(['c'])
		expect(m.added.size + m.removed.size + m.edited.size).toBe(0)
	})

	it('reports no mutations when the lists match', () => {
		const items = [item('a', 'Gorodok'), item('b', 'Fallujah')]
		const m = BB.diffMutations(items, items.map(i => ({ ...i })))
		expect(m.added.size + m.removed.size + m.edited.size + m.moved.size).toBe(0)
	})
})

describe('templateToMenuFieldValues', () => {
	it('slots the matchup left spec into Team 1 and right into Team 2', () => {
		const filter = FB.and([
			FB.eq('Map', 'Gorodok'),
			FB.allowMatchups([{ Faction: ['PLA'], Unit: ['PLA_Motorized'] }, { Faction: ['USA'] }]),
		])
		const fields = BB.templateToMenuFieldValues(filter)
		expect(fields.Map).toEqual(['Gorodok'])
		expect(fields.Faction_1).toEqual(['PLA'])
		expect(fields.Unit_1).toEqual(['PLA_Motorized'])
		expect(fields.Faction_2).toEqual(['USA'])
	})

	it('keeps multi-value components as lists and folds a single either-team faction onto Team 1', () => {
		const filter = FB.and([FB.inValues('Map', ['Chora', 'Fallujah']), FB.eq(FB.teamCol('Faction'), 'CAF')])
		const fields = BB.templateToMenuFieldValues(filter)
		expect(fields.Map).toEqual(['Chora', 'Fallujah'])
		expect(fields.Faction_1).toEqual(['CAF'])
		expect(fields.Faction_2).toBeUndefined()
	})
})

describe('templateFromLayer', () => {
	it('captures map/gamemode/version and both teams as a matchup', () => {
		const filter = BB.templateFromLayer({
			Map: 'Gorodok',
			Gamemode: 'RAAS',
			LayerVersion: 'v1',
			Faction_1: 'USA',
			Faction_2: 'RGF',
		})
		const parts = BB.parseTemplateParts(filter)
		expect(parts.maps).toEqual(['Gorodok'])
		expect(parts.gamemodes).toEqual(['RAAS'])
		expect(parts.versions).toEqual(['v1'])
		expect(parts.matchup?.teams[0].Faction).toEqual(['USA'])
		expect(parts.matchup?.teams[1].Faction).toEqual(['RGF'])
	})
})

describe('template parts', () => {
	it('roundtrips a structured template through build and parse', () => {
		const matchup: F.MatchupNode = { type: 'allow-matchups', locked: false, teams: [{ Faction: ['PLA'] }, { Faction: ['VDV'] }] }
		const parts = {
			...BB.emptyTemplateParts(),
			maps: ['Gorodok'],
			gamemodes: ['RAAS'],
			versions: ['v1'],
			collections: ['OWI'],
			matchup,
			filterIds: ['f1'],
		}
		const rebuilt = BB.parseTemplateParts(BB.buildTemplateFilter(parts))
		expect(rebuilt).toEqual(parts)
	})

	it('parses chat-built templates back into their parts', () => {
		const res = resolve(['fallu', 'adf', 'pla'])
		if (res.code !== 'ok') throw new Error('expected ok')
		const parts = BB.parseTemplateParts(res.value.filter)
		expect(parts.maps).toEqual(['Fallujah'])
		expect(parts.matchup).toEqual({ type: 'allow-matchups', locked: false, teams: [{ Faction: ['ADF'] }, { Faction: ['PLA'] }] })
		expect(parts.other).toEqual([])
	})

	it('preserves unrecognized conjuncts verbatim', () => {
		const custom = FB.gt('Asymmetry_Score', 2)
		const filter = FB.and([FB.eq('Map', 'Gorodok'), custom])
		const parts = BB.parseTemplateParts(filter)
		expect(parts.other).toEqual([custom])
		const rebuilt = BB.parseTemplateParts(BB.buildTemplateFilter(parts))
		expect(rebuilt).toEqual(parts)
	})

	it('describes templates from their parts', () => {
		const res = resolve(['fallu', 'adf', 'pla'])
		if (res.code !== 'ok') throw new Error('expected ok')
		expect(BB.describeTemplate(res.value.filter)).toBe('Fallujah, ADF vs PLA')
		expect(BB.describeTemplate(FB.and([FB.includedIn('f1')]), () => 'Cool Maps')).toBe('Cool Maps')
		expect(BB.describeTemplate(FB.and([]))).toBe('any layer')
	})
})

describe('ownership helpers', () => {
	it('matches on either id', () => {
		expect(BB.sameOwner({ discordId: 1n }, { discordId: 1n, steamId: 's1' })).toBe(true)
		expect(BB.sameOwner({ steamId: 's1' }, { discordId: 1n, steamId: 's1' })).toBe(true)
		expect(BB.sameOwner({ steamId: 's1' }, { discordId: 1n })).toBe(false)
		expect(BB.sameOwner({}, {})).toBe(false)
	})
})
