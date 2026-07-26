import { describe, expect, it } from 'vitest'

import * as LL from '@/models/layer-list.models'
import * as LTag from '@/models/layer-tags.models'

function tag(label: string, color = '#ff0000'): LTag.Tag {
	return { id: LTag.createTagId(label), label, description: `${label} desc`, color }
}

function single(itemId: string, tags?: LTag.TagId[]): LL.SingleItem {
	return { type: 'single-list-item', itemId, layerId: 'L1', source: { type: 'generated' }, ...(tags ? { tags } : {}) }
}

describe('tag ids', () => {
	it('carries the original label and is schema-valid', () => {
		const id = LTag.createTagId('meta')
		expect(LTag.TagIdSchema.safeParse(id).success).toBe(true)
		expect(LTag.originalLabel(id)).toBe('meta')
	})

	it('is distinct for the same label, so two tags may share a label historically', () => {
		expect(LTag.createTagId('meta')).not.toBe(LTag.createTagId('meta'))
	})

	it('recovers the original label even when it contained a colon-free space', () => {
		expect(LTag.originalLabel(LTag.createTagId('inf heavy'))).toBe('inf heavy')
	})
})

describe('resolve', () => {
	it('resolves a configured tag', () => {
		const t = tag('meta')
		expect(LTag.resolve(t.id, [t])).toEqual({ ...t, deleted: false })
	})

	// the deletion contract: the id survives on the item and stays renderable/removable
	it('falls back to the raw id when the tag was deleted', () => {
		const id = LTag.createTagId('gone')
		const res = LTag.resolve(id, [])
		expect(res.deleted).toBe(true)
		expect(res.label).toBe(id)
		expect(res.description).toBe('')
	})

	it('resolveAll tolerates an absent tag list', () => {
		expect(LTag.resolveAll(undefined, [])).toEqual([])
	})

	it('keeps a renamed tag attached, since identity is the id', () => {
		const t = tag('meta')
		const renamed = { ...t, label: 'competitive' }
		expect(LTag.resolve(t.id, [renamed]).label).toBe('competitive')
		expect(LTag.resolve(t.id, [renamed]).deleted).toBe(false)
	})
})

describe('labelConflict', () => {
	const existing = [tag('meta')]

	it('is case and whitespace insensitive', () => {
		expect(LTag.labelConflict(existing, '  META ')).toBe(true)
	})

	it('ignores the tag being edited', () => {
		expect(LTag.labelConflict(existing, 'meta', existing[0].id)).toBe(false)
	})

	it('allows a genuinely new label', () => {
		expect(LTag.labelConflict(existing, 'inf-heavy')).toBe(false)
	})
})

describe('suggestColor', () => {
	it('avoids colors already in use', () => {
		const used = ['#ef4444', '#f97316']
		const existing = used.map((c, i) => tag(`t${i}`, c))
		expect(used).not.toContain(LTag.suggestColor(existing).toLowerCase())
	})

	it('still returns a valid hex once the palette is exhausted', () => {
		const existing = Array.from({ length: 40 }, (_, i) => tag(`t${i}`, `#${i.toString(16).padStart(6, '0')}`))
		expect(LTag.suggestColor(existing)).toMatch(/^#[0-9a-f]{6}$/i)
	})
})

describe('withTags', () => {
	const t1 = LTag.createTagId('a')
	const t2 = LTag.createTagId('b')

	it('stamps every created single item', () => {
		const [item] = LL.withTags([{ type: 'single-list-item', layerId: 'L1' }], [t1])
		expect(item).toMatchObject({ tags: [t1] })
	})

	it('tags a vote item through its choices, never the vote itself', () => {
		const [item] = LL.withTags(
			[
				{
					type: 'vote-list-item',
					layerId: 'L1',
					choices: [single('c1'), single('c2')],
				},
			],
			[t1],
		)
		expect(item).not.toHaveProperty('tags')
		expect(item.type === 'vote-list-item' && item.choices.every((c) => c.tags?.includes(t1))).toBe(true)
	})

	it('merges with tags already present without duplicating', () => {
		const [item] = LL.withTags([single('a', [t1])], [t1, t2])
		expect(item).toMatchObject({ tags: [t1, t2] })
	})

	it('is a no-op for an empty tag list', () => {
		const items: LL.NewItem[] = [single('a')]
		expect(LL.withTags(items, [])).toBe(items)
	})
})

describe('addTag / removeTag', () => {
	const t1 = LTag.createTagId('a')
	const t2 = LTag.createTagId('b')

	it('appends in the order tags were added', () => {
		const list: LL.List = [single('a')]
		expect(LL.addTag(list, 'a', t1)).toBe(true)
		expect(LL.addTag(list, 'a', t2)).toBe(true)
		expect(list[0]).toMatchObject({ tags: [t1, t2] })
	})

	// ops replay against several base states, so re-adding the same tag must not duplicate it
	it('is idempotent for a tag already present', () => {
		const list: LL.List = [single('a', [t1])]
		expect(LL.addTag(list, 'a', t1)).toBe(false)
		expect(list[0]).toMatchObject({ tags: [t1] })
	})

	it('removes just the one tag', () => {
		const list: LL.List = [single('a', [t1, t2])]
		expect(LL.removeTag(list, 'a', t1)).toBe(true)
		expect(list[0]).toMatchObject({ tags: [t2] })
	})

	it('drops the field entirely once the last tag goes', () => {
		const list: LL.List = [single('a', [t1])]
		expect(LL.removeTag(list, 'a', t1)).toBe(true)
		expect(list[0]).not.toHaveProperty('tags')
	})

	it('reports no change for a tag that was never there', () => {
		const list: LL.List = [single('a', [t1])]
		expect(LL.removeTag(list, 'a', t2)).toBe(false)
	})

	// tags belong to layer items; a vote item holds none of its own
	it('is a no-op on a vote item', () => {
		const list: LL.List = [
			{
				type: 'vote-list-item',
				itemId: 'v1',
				layerId: 'L1',
				source: { type: 'generated' },
				choices: [single('c1')],
			},
		]
		expect(LL.addTag(list, 'v1', t1)).toBe(false)
		expect(list[0]).not.toHaveProperty('tags')
	})

	it('tags a vote choice addressed by its own id', () => {
		const list: LL.List = [
			{
				type: 'vote-list-item',
				itemId: 'v1',
				layerId: 'L1',
				source: { type: 'generated' },
				choices: [single('c1')],
			},
		]
		expect(LL.addTag(list, 'c1', t1)).toBe(true)
		expect(list[0].type === 'vote-list-item' && list[0].choices[0].tags).toEqual([t1])
	})
})

describe('attribution', () => {
	const t1 = LTag.createTagId('a')
	const t2 = LTag.createTagId('b')
	const alice = 1n
	const bob = 2n

	it('records who added each tag', () => {
		const list: LL.List = [single('a')]
		LL.addTag(list, 'a', t1, alice)
		expect(list[0]).toMatchObject({ tagsSetBy: { [t1]: alice } })
	})

	it('leaves an existing tag attributed to whoever added it', () => {
		const list: LL.List = [single('a')]
		LL.addTag(list, 'a', t1, alice)
		LL.addTag(list, 'a', t2, bob)
		expect(list[0]).toMatchObject({ tagsSetBy: { [t1]: alice, [t2]: bob } })
	})

	it('drops attribution for a tag that was removed', () => {
		const list: LL.List = [single('a')]
		LL.addTag(list, 'a', t1, alice)
		LL.addTag(list, 'a', t2, alice)
		LL.removeTag(list, 'a', t1)
		expect(list[0]).toMatchObject({ tagsSetBy: { [t2]: alice } })
	})

	it('drops the field entirely once nothing is attributed', () => {
		const list: LL.List = [single('a')]
		LL.addTag(list, 'a', t1, alice)
		LL.removeTag(list, 'a', t1)
		expect(list[0]).not.toHaveProperty('tagsSetBy')
	})

	// tags set by anything other than a user have nobody to show
	it('records nothing for a non-user source', () => {
		const list: LL.List = [single('a')]
		LL.addTag(list, 'a', t1)
		expect(list[0]).not.toHaveProperty('tagsSetBy')
	})

	it('takes attribution from the op source, not from the client-supplied item', () => {
		const items = LL.withTagAttribution([{ type: 'single-list-item', layerId: 'L1', tags: [t1], tagsSetBy: { [t1]: bob } }], {
			type: 'manual',
			userId: alice,
		})
		expect(items[0]).toMatchObject({ tagsSetBy: { [t1]: alice } })
	})

	it('strips forged attribution when the source is not a user', () => {
		const items = LL.withTagAttribution([{ type: 'single-list-item', layerId: 'L1', tags: [t1], tagsSetBy: { [t1]: bob } }], {
			type: 'generated',
		})
		expect(items[0]).not.toHaveProperty('tagsSetBy')
	})

	it('attributes a vote item through its choices', () => {
		const items = LL.withTagAttribution([{ type: 'vote-list-item', layerId: 'L1', choices: [single('c1', [t1])] }], {
			type: 'manual',
			userId: alice,
		})
		expect(items[0].type === 'vote-list-item' && items[0].choices[0].tagsSetBy).toEqual({ [t1]: alice })
	})
})
