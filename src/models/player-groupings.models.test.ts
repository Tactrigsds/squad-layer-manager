import type * as BM from '@/models/battlemetrics.models'
import * as PG from '@/models/player-groupings.models'
import { describe, expect, it } from 'vitest'

function flag(id: string): BM.PlayerFlag {
	return { id, name: id, color: null, description: null, icon: null }
}

function rule(flagId: string, group: string): PG.GroupRule {
	return { type: 'battlemetrics', flag: flagId, group }
}

const GROUPING: PG.Grouping = {
	rules: [rule('f-hq', 'HQ'), rule('f-mod', 'HQ'), rule('f-regular', 'Regulars')],
	groups: { HQ: { color: '#ff0000' }, Regulars: { color: '#00ff00' } },
}

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
		const stale: PG.Grouping = { rules: [rule('f-hq', 'HQ')], groups: { HQ: { color: '#fff' }, Gone: { color: '#000' } } }
		expect(PG.getGroupNames(stale)).toEqual(['HQ'])
	})
})

describe('getGroupColor', () => {
	it('reads the configured color, falling back when the group has no entry', () => {
		expect(PG.getGroupColor(GROUPING, 'HQ')).toBe('#ff0000')
		expect(PG.getGroupColor({ rules: GROUPING.rules, groups: {} }, 'HQ')).toBe(PG.DEFAULT_GROUP_COLOR)
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
})
