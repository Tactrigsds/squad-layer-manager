import type * as BM from '@/models/battlemetrics.models'
import * as PG from '@/models/player-groupings.models'
import { describe, expect, it } from 'vitest'

function flag(id: string, color: string | null = null): BM.PlayerFlag {
	return { id, name: id, color, description: null, icon: null }
}

function rule(flagId: string, group: string): PG.GroupRule {
	return { type: 'battlemetrics', flag: flagId, group }
}

function adminRule(adminGroup: string, group: string): PG.GroupRule {
	return { type: 'admin-list', adminGroup, group }
}

// a player carrying the given flags and no admin-list membership
function withFlags(...ids: string[]): PG.PlayerFacts {
	return { flags: ids.map((id) => flag(id)), adminGroups: [] }
}

const GROUPING: PG.Grouping = {
	rules: [rule('f-hq', 'HQ'), rule('f-mod', 'HQ'), rule('f-regular', 'Regulars')],
	groups: { HQ: { color: { type: 'flag', flag: 'f-hq' } }, Regulars: { color: { type: 'custom', color: '#00ff00' } } },
}

const ORG_FLAGS = [flag('f-hq', '#ff0000'), flag('f-mod', '#0000ff'), flag('f-regular', '#123456')]

describe('resolveGroup', () => {
	it('assigns the group of the first matching rule', () => {
		expect(PG.resolveGroup(GROUPING, withFlags('f-regular'))).toBe('Regulars')
		expect(PG.resolveGroup(GROUPING, withFlags('f-mod'))).toBe('HQ')
	})

	it('rule order decides priority when a player matches several rules', () => {
		// carries both: HQ wins because its rule sits higher, regardless of the flags' own order
		expect(PG.resolveGroup(GROUPING, withFlags('f-regular', 'f-hq'))).toBe('HQ')

		const reordered: PG.Grouping = { ...GROUPING, rules: [...GROUPING.rules].reverse() }
		expect(PG.resolveGroup(reordered, withFlags('f-regular', 'f-hq'))).toBe('Regulars')
	})

	it('leaves a player ungrouped when no rule matches', () => {
		expect(PG.resolveGroup(GROUPING, withFlags('f-unknown'))).toBeUndefined()
		expect(PG.resolveGroup(GROUPING, withFlags())).toBeUndefined()
	})

	it('matches admin-list group membership', () => {
		const g: PG.Grouping = { rules: [adminRule('Admins', 'Staff'), adminRule('Whitelist', 'Members')], groups: {} }
		expect(PG.resolveGroup(g, { flags: [], adminGroups: ['Whitelist'] })).toBe('Members')
		// a player in several admin groups takes the higher rule, same as flags
		expect(PG.resolveGroup(g, { flags: [], adminGroups: ['Whitelist', 'Admins'] })).toBe('Staff')
		expect(PG.resolveGroup(g, { flags: [], adminGroups: ['Cameraman'] })).toBeUndefined()
	})

	// the whole point of the source discriminator: one grouping can mix them, and priority is still just rule order
	it('mixes sources in one priority order', () => {
		const g: PG.Grouping = { rules: [adminRule('Admins', 'Staff'), rule('f-regular', 'Regulars')], groups: {} }
		const both: PG.PlayerFacts = { flags: [flag('f-regular')], adminGroups: ['Admins'] }
		expect(PG.resolveGroup(g, both)).toBe('Staff')
		const flipped: PG.Grouping = { ...g, rules: [...g.rules].reverse() }
		expect(PG.resolveGroup(flipped, both)).toBe('Regulars')
	})

	// a rule only ever reads its own source's facts
	it('does not match an admin group against a flag of the same name', () => {
		const g: PG.Grouping = { rules: [adminRule('Whitelist', 'Members')], groups: {} }
		expect(PG.resolveGroup(g, { flags: [flag('Whitelist')], adminGroups: [] })).toBeUndefined()
	})
})

describe('getGroupNames', () => {
	it('dedupes by first appearance so the order is the groups own priority', () => {
		expect(PG.getGroupNames(GROUPING)).toEqual(['HQ', 'Regulars'])
	})

	// membership comes from the rules alone, so a stale `groups` entry must not invent a group
	it('ignores groups no rule names', () => {
		const stale: PG.Grouping = {
			rules: [rule('f-hq', 'HQ')],
			groups: { HQ: { color: { type: 'custom', color: '#fff' } }, Gone: { color: { type: 'custom', color: '#000' } } },
		}
		expect(PG.getGroupNames(stale)).toEqual(['HQ'])
	})
})

describe('moveRule', () => {
	const rules = [rule('a', 'A'), rule('b', 'B'), rule('c', 'C'), rule('d', 'D')]
	const flags = (rs: PG.GroupRule[]) => rs.map((r) => r.type === 'battlemetrics' ? r.flag : '')

	it('moves a rule up, before and after the target', () => {
		expect(flags(PG.moveRule(rules, 2, 0, 'before'))).toEqual(['c', 'a', 'b', 'd'])
		expect(flags(PG.moveRule(rules, 2, 0, 'after'))).toEqual(['a', 'c', 'b', 'd'])
	})

	// moving down is where naive index math goes wrong: pulling the dragged rule out shifts every later index down one
	it('moves a rule down, before and after the target', () => {
		expect(flags(PG.moveRule(rules, 0, 2, 'after'))).toEqual(['b', 'c', 'a', 'd'])
		expect(flags(PG.moveRule(rules, 0, 2, 'before'))).toEqual(['b', 'a', 'c', 'd'])
	})

	it('moves a rule to either end', () => {
		expect(flags(PG.moveRule(rules, 3, 0, 'before'))).toEqual(['d', 'a', 'b', 'c'])
		expect(flags(PG.moveRule(rules, 0, 3, 'after'))).toEqual(['b', 'c', 'd', 'a'])
	})

	it('is a no-op when dropped on itself or out of range', () => {
		expect(PG.moveRule(rules, 1, 1, 'before')).toBe(rules)
		expect(PG.moveRule(rules, 1, 1, 'after')).toBe(rules)
		expect(PG.moveRule(rules, 9, 0, 'before')).toBe(rules)
		expect(PG.moveRule(rules, 0, 9, 'before')).toBe(rules)
	})

	it('never drops or duplicates a rule', () => {
		for (const from of [0, 1, 2, 3]) {
			for (const to of [0, 1, 2, 3]) {
				for (const position of ['before', 'after'] as const) {
					const next = PG.moveRule(rules, from, to, position)
					expect(next).toHaveLength(rules.length)
					expect([...flags(next)].sort()).toEqual(['a', 'b', 'c', 'd'])
				}
			}
		}
	})
})

describe('getGroupFlags', () => {
	// the colour picker offers these, so a group must never be offered another group's flag
	it('lists only the flags of rules naming that group, deduped and in order', () => {
		expect(PG.getGroupFlags(GROUPING, 'HQ')).toEqual(['f-hq', 'f-mod'])
		expect(PG.getGroupFlags(GROUPING, 'Regulars')).toEqual(['f-regular'])
	})

	it('skips rules with no flag picked yet', () => {
		expect(PG.getGroupFlags({ rules: [rule('', 'HQ'), rule('f-hq', 'HQ')], groups: {} }, 'HQ')).toEqual(['f-hq'])
	})

	// an admin list carries no colors, so such a group has nothing to follow and takes a custom color instead
	it('offers nothing for a group defined only by admin-list rules', () => {
		const g: PG.Grouping = { rules: [adminRule('Whitelist', 'Members')], groups: {} }
		expect(PG.getGroupFlags(g, 'Members')).toEqual([])
		expect(PG.defaultGroupColor(g, 'Members', ORG_FLAGS)).toBeUndefined()
		expect(PG.getGroupColor(g, 'Members', ORG_FLAGS)).toBe(PG.DEFAULT_GROUP_COLOR)
	})

	// a group fed by both sources can still follow its flag
	it('offers only the flag rules of a mixed group', () => {
		const g: PG.Grouping = { rules: [adminRule('Admins', 'Staff'), rule('f-hq', 'Staff')], groups: {} }
		expect(PG.getGroupFlags(g, 'Staff')).toEqual(['f-hq'])
		expect(PG.defaultGroupColor(g, 'Staff', ORG_FLAGS)).toEqual({ type: 'flag', flag: 'f-hq' })
	})
})

describe('getGroupColor', () => {
	it('follows the flag reference rather than a stored copy', () => {
		expect(PG.getGroupColor(GROUPING, 'HQ', ORG_FLAGS)).toBe('#ff0000')
		// the whole point: recolouring the flag in battlemetrics moves the group with it, no settings edit
		const recoloured = [flag('f-hq', '#abcdef'), ...ORG_FLAGS.slice(1)]
		expect(PG.getGroupColor(GROUPING, 'HQ', recoloured)).toBe('#abcdef')
	})

	it('leaves a custom color pinned when its flags change', () => {
		const recoloured = [flag('f-regular', '#abcdef')]
		expect(PG.getGroupColor(GROUPING, 'Regulars', recoloured)).toBe('#00ff00')
	})

	it('falls back for a missing entry, an unknown flag, or a flag with no color', () => {
		expect(PG.getGroupColor({ rules: GROUPING.rules, groups: {} }, 'HQ', ORG_FLAGS)).toBe(PG.DEFAULT_GROUP_COLOR)
		expect(PG.getGroupColor(GROUPING, 'HQ', [])).toBe(PG.DEFAULT_GROUP_COLOR)
		expect(PG.getGroupColor(GROUPING, 'HQ', [flag('f-hq', null)])).toBe(PG.DEFAULT_GROUP_COLOR)
	})
})

describe('defaultGroupColor', () => {
	it('references the first flag of the group that has a color', () => {
		expect(PG.defaultGroupColor(GROUPING, 'HQ', ORG_FLAGS)).toEqual({ type: 'flag', flag: 'f-hq' })
		// f-hq carries no color here, so the next flag of the group supplies it
		expect(PG.defaultGroupColor(GROUPING, 'HQ', [flag('f-hq', null), flag('f-mod', '#0000ff')]))
			.toEqual({ type: 'flag', flag: 'f-mod' })
	})

	// callers leave the entry out entirely, so the fallback covers it and a later flag pick can still seed it
	it('is undefined when no flag of the group offers a color', () => {
		expect(PG.defaultGroupColor(GROUPING, 'HQ', [])).toBeUndefined()
	})
})

describe('resolvePlayerGroups', () => {
	const groupings: PG.PlayerGroupings = {
		admin: GROUPING,
		watchlist: { rules: [rule('f-regular', 'Watched')], groups: {} },
	}

	it('resolves every player under the named grouping only', () => {
		const players: [string, PG.PlayerFacts][] = [
			['p1', withFlags('f-hq')],
			['p2', withFlags('f-regular')],
			['p3', withFlags('f-nothing')],
		]
		expect(PG.resolvePlayerGroups(players, groupings, 'admin')).toEqual(new Map([['p1', 'HQ'], ['p2', 'Regulars']]))
		// the same roster buckets differently under another grouping -- that is the point of having several
		expect(PG.resolvePlayerGroups(players, groupings, 'watchlist')).toEqual(new Map([['p2', 'Watched']]))
	})

	it('groups nobody for a missing or unset grouping', () => {
		const players: [string, PG.PlayerFacts][] = [['p1', withFlags('f-hq')]]
		expect(PG.resolvePlayerGroups(players, groupings, 'deleted').size).toBe(0)
		expect(PG.resolvePlayerGroups(players, groupings, null).size).toBe(0)
	})
})

describe('PlayerGroupingsSchema', () => {
	it('accepts the record shape and fills in the halves of a grouping', () => {
		const parsed = PG.PlayerGroupingsSchema.parse({ admin: { rules: [rule('f-hq', 'HQ')] } })
		expect(parsed.admin).toEqual({ rules: [rule('f-hq', 'HQ')], groups: {} })
	})

	it('rejects a rule with no group, which could never be told apart in the UI', () => {
		expect(PG.PlayerGroupingsSchema.safeParse({ admin: { rules: [rule('f-hq', '')] } }).success).toBe(false)
	})

	it('takes admin-list rules and keeps the sources apart', () => {
		const parsed = PG.PlayerGroupingsSchema.parse({ a: { rules: [adminRule('Whitelist', 'Members'), rule('f-hq', 'HQ')] } })
		expect(parsed.a.rules).toEqual([adminRule('Whitelist', 'Members'), rule('f-hq', 'HQ')])
		// each variant carries only its own source field
		expect(PG.PlayerGroupingsSchema.safeParse({ a: { rules: [{ type: 'admin-list', flag: 'f-hq', group: 'HQ' }] } }).success).toBe(false)
		expect(PG.PlayerGroupingsSchema.safeParse({ a: { rules: [{ type: 'admin-list', adminGroup: '', group: 'HQ' }] } }).success).toBe(false)
	})

	it('takes both color variants and rejects an untagged one', () => {
		const groups = { HQ: { color: { type: 'flag', flag: 'f-hq' } }, Other: { color: { type: 'custom', color: '#fff' } } }
		expect(PG.PlayerGroupingsSchema.safeParse({ admin: { rules: [rule('f-hq', 'HQ')], groups } }).success).toBe(true)
		// the old shape stored a bare string that meant either variant; it must not parse as one of them by accident
		expect(PG.PlayerGroupingsSchema.safeParse({ admin: { rules: [], groups: { HQ: { color: '#fff' } } } }).success).toBe(false)
	})
})
