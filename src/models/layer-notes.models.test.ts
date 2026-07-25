import { describe, expect, it } from 'vitest'

import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'

const alice = 1n
const bob = 2n

function single(itemId: string, notes?: LNote.Note[]): LL.SingleItem {
	return { type: 'single-list-item', itemId, layerId: 'L1', source: { type: 'generated' }, ...(notes ? { notes } : {}) }
}

function note(id: string, author = alice, text = `note ${id}`): LNote.Note {
	return { id, author, text }
}

describe('note ids', () => {
	it('are schema-valid', () => {
		expect(LNote.NoteIdSchema.safeParse(LNote.createNoteId()).success).toBe(true)
	})
})

describe('ownership', () => {
	it('recognizes the author', () => {
		expect(LNote.isAuthor(note('n1', alice), alice)).toBe(true)
		expect(LNote.isAuthor(note('n1', alice), bob)).toBe(false)
	})

	it('treats an anonymous viewer as not the author', () => {
		expect(LNote.isAuthor(note('n1', alice), undefined)).toBe(false)
	})
})

describe('addNote', () => {
	it('appends in the order notes were added', () => {
		const list: LL.List = [single('a')]
		LL.addNote(list, 'a', note('n1'))
		LL.addNote(list, 'a', note('n2'))
		expect(list[0].type === 'single-list-item' && list[0].notes?.map((n) => n.id)).toEqual(['n1', 'n2'])
	})

	// ops can be replayed against several base states, so re-adding the same note must not duplicate it
	it('is idempotent for a note id already present', () => {
		const list: LL.List = [single('a', [note('n1')])]
		expect(LL.addNote(list, 'a', note('n1'))).toBe(false)
		expect(list[0].type === 'single-list-item' && list[0].notes?.length).toBe(1)
	})

	it('is a no-op on a vote item, whose choices carry their own notes', () => {
		const list: LL.List = [
			{
				type: 'vote-list-item',
				itemId: 'v1',
				layerId: 'L1',
				source: { type: 'generated' },
				choices: [single('c1')],
			},
		]
		expect(LL.addNote(list, 'v1', note('n1'))).toBe(false)
		expect(LL.addNote(list, 'c1', note('n1'))).toBe(true)
	})
})

describe('editNote', () => {
	it('rewords in place, keeping position and author', () => {
		const list: LL.List = [single('a', [note('n1', alice), note('n2', bob)])]
		expect(LL.editNote(list, 'a', 'n1', 'reworded')).toBe(true)
		expect(list[0].type === 'single-list-item' && list[0].notes).toEqual([
			{ id: 'n1', author: alice, text: 'reworded' },
			note('n2', bob),
		])
	})

	it('reports no change for identical text or an unknown note', () => {
		const list: LL.List = [single('a', [note('n1', alice, 'same')])]
		expect(LL.editNote(list, 'a', 'n1', 'same')).toBe(false)
		expect(LL.editNote(list, 'a', 'nope', 'other')).toBe(false)
	})
})

describe('deleteNote', () => {
	it('removes just the one note', () => {
		const list: LL.List = [single('a', [note('n1'), note('n2')])]
		expect(LL.deleteNote(list, 'a', 'n1')).toBe(true)
		expect(list[0].type === 'single-list-item' && list[0].notes?.map((n) => n.id)).toEqual(['n2'])
	})

	it('drops the field entirely once the last note goes', () => {
		const list: LL.List = [single('a', [note('n1')])]
		LL.deleteNote(list, 'a', 'n1')
		expect(list[0]).not.toHaveProperty('notes')
	})

	it('reports no change for an unknown note', () => {
		const list: LL.List = [single('a', [note('n1')])]
		expect(LL.deleteNote(list, 'a', 'nope')).toBe(false)
	})
})

describe('findNote', () => {
	it('finds a note on a vote choice by the choice id', () => {
		const list: LL.List = [
			{
				type: 'vote-list-item',
				itemId: 'v1',
				layerId: 'L1',
				source: { type: 'generated' },
				choices: [single('c1', [note('n1', bob)])],
			},
		]
		expect(LL.findNote(list, 'c1', 'n1')?.author).toBe(bob)
		expect(LL.findNote(list, 'v1', 'n1')).toBeUndefined()
	})
})

describe('displayInline', () => {
	it('shows a couple of short notes inline', () => {
		expect(LNote.displayInline([note('n1', alice, 'short'), note('n2', alice, 'also short')])).toBe(true)
	})

	it('collapses once there are more notes than fit the row', () => {
		const notes = Array.from({ length: LNote.MAX_INLINE + 1 }, (_, i) => note(`n${i}`, alice, 'x'))
		expect(LNote.displayInline(notes)).toBe(false)
	})

	it('collapses a single note long enough to crowd out the row', () => {
		expect(LNote.displayInline([note('n1', alice, 'x'.repeat(LNote.INLINE_CHAR_BUDGET + 1))])).toBe(false)
	})

	it('renders nothing when there are no notes', () => {
		expect(LNote.displayInline([])).toBe(false)
	})
})
