import { describe, expect, it } from 'vitest'

import * as ItemMut from '@/lib/item-mutations'
import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'

// every case below warns on ids the list does not carry, which is the plain single-item shape: only vote choices need
// the list, and the one case that does builds its own
const LIST: LL.List = []

function single(itemId: string): LL.SingleItem {
	return { type: 'single-list-item', itemId, layerId: 'L1', source: { type: 'generated' } }
}

function mutations(sets: Partial<Record<ItemMut.MutType, string[]>>): ItemMut.Mutations {
	const muts = ItemMut.initMutations()
	for (const [type, ids] of Object.entries(sets)) ItemMut.tryApplyMutation(type as ItemMut.MutType, ids, muts)
	return muts
}

type RepeatOpts = { field?: LQY.RepeatMatchDescriptorField; offset?: number; rule?: string }

function descriptor(sourceItemId: LQY.ItemId, opts?: RepeatOpts): LQY.RepeatMatchDescriptor {
	const field = opts?.field ?? 'Map'
	return {
		type: 'repeat-rule',
		constraintId: `layer-pool:main:${opts?.rule ?? 'Map'}`,
		field,
		layerId: 'L1',
		repeatOffset: opts?.offset ?? 1,
		sourceItemId,
		sourceLayerId: 'L1',
		sourceField: field,
	}
}

function repeat(itemId: LQY.ItemId, sourceItemId: LQY.ItemId, opts?: RepeatOpts) {
	return { itemId, type: 'repeat-rule-violation-warning', descriptors: [descriptor(sourceItemId, opts)] } satisfies LQY.QueueWarning
}

function pool(itemId: LQY.ItemId): LQY.QueueWarning {
	return { itemId, type: 'filter-entity-warning', matched: true, constraintId: 'filter-cfg:f1' }
}

describe('filterEditInducedWarnings', () => {
	it('reports everything when the saved queue has no statuses yet', () => {
		const warns = [pool('a'), repeat('b', 'a')]
		expect(LQY.filterEditInducedWarnings(warns, null, LIST, mutations({}))).toEqual(warns)
	})

	it('drops warnings on layers nobody touched', () => {
		const warns = [pool('a'), repeat('b', 'a')]
		expect(LQY.filterEditInducedWarnings(warns, warns, LIST, mutations({ edited: ['c'] }))).toEqual([])
	})

	it('keeps warnings on layers the session touched, even when they predate it', () => {
		const warns = [pool('a'), repeat('b', 'a')]
		expect(LQY.filterEditInducedWarnings(warns, warns, LIST, mutations({ edited: ['a'] }))).toEqual([pool('a')])
		expect(LQY.filterEditInducedWarnings(warns, warns, LIST, mutations({ moved: ['b'] }))).toEqual([repeat('b', 'a')])
	})

	it('keeps a repeat violation the session created between layers it did not touch', () => {
		// deleting the item between 'a' and 'b' pulled them inside the rule's window
		const warns = [repeat('b', 'a')]
		expect(LQY.filterEditInducedWarnings(warns, [], LIST, mutations({ removed: ['x'] }))).toEqual(warns)
	})

	it('ignores an offset change on a violation that already existed', () => {
		const before = [repeat('b', 'a', { offset: 3 })]
		const after = [repeat('b', 'a', { offset: 1 })]
		expect(LQY.filterEditInducedWarnings(after, before, LIST, mutations({ removed: ['x'] }))).toEqual([])
	})

	it('ignores the team slot a faction repeat is normalized to, which an index shift flips', () => {
		const before = [repeat('b', 'a', { rule: 'Faction', field: 'Faction_A' })]
		const after = [repeat('b', 'a', { rule: 'Faction', field: 'Faction_B' })]
		expect(LQY.filterEditInducedWarnings(after, before, LIST, mutations({ removed: ['x'] }))).toEqual([])
	})

	it('keeps only the rules the session newly tripped', () => {
		const before = [repeat('b', 'a', { rule: 'Map' })]
		const after = [
			{ ...repeat('b', 'a', { rule: 'Map' }), descriptors: [descriptor('a', { rule: 'Map' }), descriptor('a', { rule: 'Faction' })] },
		]
		const result = LQY.filterEditInducedWarnings(after, before, LIST, mutations({ removed: ['x'] }))
		expect(result).toEqual([repeat('b', 'a', { rule: 'Faction' })])
	})

	it('treats a repeat against a different source layer as a new violation', () => {
		const before = [repeat('b', 'a')]
		const after = [repeat('b', 'z')]
		expect(LQY.filterEditInducedWarnings(after, before, LIST, mutations({ moved: ['z'] }))).toEqual(after)
	})

	it('keeps a repeat against match history that a move created', () => {
		const after = [repeat('b', 12)]
		expect(LQY.filterEditInducedWarnings(after, [], LIST, mutations({ removed: ['x'] }))).toEqual(after)
	})

	it('counts a choice of an edited vote as edited', () => {
		const vote: LL.Item = {
			type: 'vote-list-item',
			itemId: 'v',
			layerId: 'L1',
			source: { type: 'generated' },
			choices: [single('c1'), single('c2')],
		}
		const warns = [pool('c1'), pool('c2')]
		expect(LQY.filterEditInducedWarnings(warns, warns, [vote], mutations({ added: ['v'] }))).toEqual(warns)
		expect(LQY.filterEditInducedWarnings(warns, warns, [vote], mutations({ added: ['other'] }))).toEqual([])
	})
})
