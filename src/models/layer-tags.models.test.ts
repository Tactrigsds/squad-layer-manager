import * as LL from '@/models/layer-list.models'
import * as LTag from '@/models/layer-tags.models'
import { describe, expect, it } from 'vitest'

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
		const [item] = LL.withTags([{
			type: 'vote-list-item',
			layerId: 'L1',
			choices: [single('c1'), single('c2')],
		}], [t1])
		expect(item).not.toHaveProperty('tags')
		expect(item.type === 'vote-list-item' && item.choices.every(c => c.tags?.includes(t1))).toBe(true)
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

describe('setTags', () => {
	const t1 = LTag.createTagId('a')
	const t2 = LTag.createTagId('b')

	it('sets tags on a layer item and reports the change', () => {
		const list: LL.List = [single('a')]
		expect(LL.setTags(list, 'a', [t1])).toBe(true)
		expect(list[0]).toMatchObject({ tags: [t1] })
	})

	it('reports no change when the tags are identical', () => {
		const list: LL.List = [single('a', [t1])]
		expect(LL.setTags(list, 'a', [t1])).toBe(false)
	})

	it('drops the field entirely when cleared', () => {
		const list: LL.List = [single('a', [t1])]
		expect(LL.setTags(list, 'a', [])).toBe(true)
		expect(list[0]).not.toHaveProperty('tags')
	})

	it('dedupes', () => {
		const list: LL.List = [single('a')]
		LL.setTags(list, 'a', [t1, t1, t2])
		expect(list[0]).toMatchObject({ tags: [t1, t2] })
	})

	// tags belong to layer items; a vote item holds none of its own
	it('is a no-op on a vote item', () => {
		const list: LL.List = [{
			type: 'vote-list-item',
			itemId: 'v1',
			layerId: 'L1',
			source: { type: 'generated' },
			choices: [single('c1')],
		}]
		expect(LL.setTags(list, 'v1', [t1])).toBe(false)
		expect(list[0]).not.toHaveProperty('tags')
	})

	it('tags a vote choice addressed by its own id', () => {
		const list: LL.List = [{
			type: 'vote-list-item',
			itemId: 'v1',
			layerId: 'L1',
			source: { type: 'generated' },
			choices: [single('c1')],
		}]
		expect(LL.setTags(list, 'c1', [t1])).toBe(true)
		expect(list[0].type === 'vote-list-item' && list[0].choices[0].tags).toEqual([t1])
	})
})
