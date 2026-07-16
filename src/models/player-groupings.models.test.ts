import type * as BM from '@/models/battlemetrics.models'
import * as PG from '@/models/player-groupings.models'
import { describe, expect, it } from 'vitest'

function flag(id: string, color: string | null = null): BM.PlayerFlag {
	return { id, name: id, color, description: null, icon: null }
}

function rule(flagId: string, group: string): PG.GroupRule {
	return { type: 'battlemetrics', flag: flagId, group }
}

const GROUPING: PG.Grouping = {
	rules: [rule('f-hq', 'HQ'), rule('f-mod', 'HQ'), rule('f-regular', 'Regulars')],
	groups: { HQ: { color: { type: 'flag', flag: 'f-hq' } }, Regulars: { color: { type: 'custom', color: '#00ff00' } } },
}

const ORG_FLAGS = [flag('f-hq', '#ff0000'), flag('f-mod', '#0000ff'), flag('f-regular', '#123456')]

describe('resolveGroup', () => {
	it('assigns the group of the first matching rule', () => {
		expect(PG.resolveGroup(GROUPING, [flag('f-regular')])).toBe('Regulars')
		expect(PG.resolveGroup(GROUPING, [flag('f-mod')])).toBe('HQ')
	})

	it('rule order decides priority when a player matches several rules', () => {
		// carries both: HQ wins because its rule sits higher, regardless of the flags' own order
		expect(PG.resolveGroup(GROUPING, [flag('f-regular'), flag('f-hq')])).toBe('HQ')

		const reordered: PG.Grouping = { ...GROUPING, rules: [...GROUPING.rules].reverse() }
		expect(PG.resolveGroup(reordered, [flag('f-regular'), flag('f-hq')])).toBe('Regulars')
	})

	it('leaves a player ungrouped when no rule matches', () => {
		expect(PG.resolveGroup(GROUPING, [flag('f-unknown')])).toBeUndefined()
		expect(PG.resolveGroup(GROUPING, [])).toBeUndefined()
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

describe('getGroupFlags', () => {
	// the colour picker offers these, so a group must never be offered another group's flag
	it('lists only the flags of rules naming that group, deduped and in order', () => {
		expect(PG.getGroupFlags(GROUPING, 'HQ')).toEqual(['f-hq', 'f-mod'])
		expect(PG.getGroupFlags(GROUPING, 'Regulars')).toEqual(['f-regular'])
	})

	it('skips rules with no flag picked yet', () => {
		expect(PG.getGroupFlags({ rules: [rule('', 'HQ'), rule('f-hq', 'HQ')], groups: {} }, 'HQ')).toEqual(['f-hq'])
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
		const players: [string, BM.PlayerFlag[]][] = [
			['p1', [flag('f-hq')]],
			['p2', [flag('f-regular')]],
			['p3', [flag('f-nothing')]],
		]
		expect(PG.resolvePlayerGroups(players, groupings, 'admin')).toEqual(new Map([['p1', 'HQ'], ['p2', 'Regulars']]))
		// the same roster buckets differently under another grouping -- that is the point of having several
		expect(PG.resolvePlayerGroups(players, groupings, 'watchlist')).toEqual(new Map([['p2', 'Watched']]))
	})

	it('groups nobody for a missing or unset grouping', () => {
		const players: [string, BM.PlayerFlag[]][] = [['p1', [flag('f-hq')]]]
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

	it('takes both color variants and rejects an untagged one', () => {
		const groups = { HQ: { color: { type: 'flag', flag: 'f-hq' } }, Other: { color: { type: 'custom', color: '#fff' } } }
		expect(PG.PlayerGroupingsSchema.safeParse({ admin: { rules: [rule('f-hq', 'HQ')], groups } }).success).toBe(true)
		// the old shape stored a bare string that meant either variant; it must not parse as one of them by accident
		expect(PG.PlayerGroupingsSchema.safeParse({ admin: { rules: [], groups: { HQ: { color: '#fff' } } } }).success).toBe(false)
	})
})
