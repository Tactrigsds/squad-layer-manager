import { describe, expect, it } from 'vitest'

import * as Obj from '@/lib/object-utils'
import type * as ODSM from '@/lib/odsm'
import * as BB from '@/models/backburner.models'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LTag from '@/models/layer-tags.models'
import * as SLL from '@/models/shared-layer-list'

const USER = 5n
const OTHER_USER = 6n
const OTHER_LAYER_ID = L.swapFactionsInId(L.DEFAULT_LAYER_ID)

let counter = 0
function bbItem(id: string, owner: bigint = USER, map: string = 'Gorodok'): BB.BackburnerItem {
	return {
		itemId: id,
		filter: FB.and([FB.eq('Map', map)]),
		source: { discordId: owner },
		createdAt: 1000 + counter++,
	}
}

function draftProps() {
	return { opId: `op-${counter++}`, userId: USER, editWindowSeqId: 0 }
}

function apply(state: SLL.State, ...ops: SLL.Operation[]) {
	const [next, sideEffects] = SLL.reducer(state, ops, [])
	return { state: next, sideEffects }
}

function backburnerSaves(sideEffects: SLL.SideEffect[]) {
	return sideEffects.filter((se) => se.code === 'request-backburner-save')
}

function listSaves(sideEffects: SLL.SideEffect[]) {
	return sideEffects.filter((se) => se.code === 'request-list-save')
}

function ids(items: BB.BackburnerItem[]) {
	return items.map((item) => item.itemId)
}

function queueItem() {
	return LL.createItem({ type: 'single-list-item', layerId: L.DEFAULT_LAYER_ID }, { type: 'generated' })
}

describe('backburner draft ops', () => {
	it('adds to the draft only, then save promotes and requests persistence', () => {
		const initial = SLL.createNewState([queueItem()])
		const { state } = apply(initial, { op: 'backburner-add', item: bbItem('a'), ...draftProps() })
		expect(ids(state.backburner)).toEqual(['a'])
		expect(state.savedBackburner).toEqual([])

		const { state: saved, sideEffects } = apply(state, { op: 'backburner-save', ...draftProps() })
		expect(ids(saved.savedBackburner)).toEqual(['a'])
		const saves = backburnerSaves(sideEffects)
		expect(saves).toHaveLength(1)
		expect(saves[0].trigger).toBe('user-save')
		// the queue draft was untouched, so a backburner-only save must not request a queue save
		expect(listSaves(sideEffects)).toHaveLength(0)
	})

	it('updates, reorders and combines within the draft', () => {
		const initial = SLL.createNewState([queueItem()], [bbItem('a'), bbItem('b', USER, 'Fallujah'), bbItem('c', USER, 'Chora')])
		const reordered = apply(initial, { op: 'backburner-reorder', itemId: 'c', newIndex: 0, ...draftProps() }).state
		expect(ids(reordered.backburner)).toEqual(['c', 'a', 'b'])
		// the saved list is untouched by draft edits
		expect(ids(reordered.savedBackburner)).toEqual(['a', 'b', 'c'])

		const updated = apply(reordered, {
			op: 'backburner-update',
			itemId: 'a',
			filter: FB.and([FB.eq('Gamemode', 'RAAS')]),
			...draftProps(),
		}).state
		expect(updated.backburner.find((i) => i.itemId === 'a')?.filter).toEqual(FB.and([FB.eq('Gamemode', 'RAAS')]))

		const combined = apply(updated, { op: 'backburner-combine', targetItemId: 'c', sourceItemId: 'b', ...draftProps() }).state
		expect(ids(combined.backburner)).toEqual(['c', 'a'])
		const target = combined.backburner.find((i) => i.itemId === 'c')!
		// combining ORs element-wise: the two single-map templates union into one in-values condition
		expect(BB.parseTemplateParts(target.filter).maps).toEqual(['Chora', 'Fallujah'])
	})

	it('backburner-reset discards backburner draft edits', () => {
		const initial = SLL.createNewState([queueItem()], [bbItem('a')])
		const withDraft = apply(initial, { op: 'backburner-add', item: bbItem('b'), ...draftProps() }).state
		const reset = apply(withDraft, { op: 'backburner-reset', ...draftProps() }).state
		expect(ids(reset.backburner)).toEqual(['a'])
	})

	it('skips draft ops from a stale edit window', () => {
		const initial = SLL.createNewState([queueItem()])
		expect(() => apply(initial, { op: 'backburner-add', item: bbItem('a'), opId: 'x', userId: USER, editWindowSeqId: 99 })).toThrowError()
	})

	it('is exempt from the pending-generation gate', () => {
		const initial = SLL.createNewState([queueItem()])
		initial.requestingGeneratedQueueItem = true
		const { state } = apply(initial, { op: 'backburner-add', item: bbItem('a'), ...draftProps() })
		expect(ids(state.backburner)).toEqual(['a'])
	})
})

describe('backburner-write-saved', () => {
	it('commits to both lists and requests persistence', () => {
		const initial = SLL.createNewState([queueItem()])
		const { state, sideEffects } = apply(initial, {
			op: 'backburner-write-saved',
			opId: 'w1',
			write: { kind: 'add', item: bbItem('a'), evictItemIds: [] },
			source: { steamId: 's1' },
		})
		expect(ids(state.savedBackburner)).toEqual(['a'])
		expect(ids(state.backburner)).toEqual(['a'])
		const saves = backburnerSaves(sideEffects)
		expect(saves).toHaveLength(1)
		expect(saves[0].trigger).toBe('chat-write')
	})

	it('preserves in-flight draft edits around a chat write', () => {
		const initial = SLL.createNewState([queueItem()], [bbItem('a')])
		const withDraft = apply(initial, { op: 'backburner-add', item: bbItem('draft-only'), ...draftProps() }).state
		const { state } = apply(withDraft, {
			op: 'backburner-write-saved',
			opId: 'w2',
			write: { kind: 'add', item: bbItem('chat'), evictItemIds: [] },
		})
		expect(ids(state.savedBackburner)).toEqual(['a', 'chat'])
		expect(ids(state.backburner)).toEqual(['a', 'draft-only', 'chat'])
	})

	it('evicts alongside the add in one op', () => {
		const initial = SLL.createNewState([queueItem()], [bbItem('oldest'), bbItem('other', OTHER_USER)])
		const { state } = apply(initial, {
			op: 'backburner-write-saved',
			opId: 'w3',
			write: { kind: 'add', item: bbItem('newest'), evictItemIds: ['oldest'] },
		})
		expect(ids(state.savedBackburner)).toEqual(['other', 'newest'])
	})
})

describe('generation consumption', () => {
	it('queue-item-generated removes consumed templates and reports the layer', () => {
		const initial = SLL.createNewState([], [bbItem('a'), bbItem('b')])
		initial.requestingGeneratedQueueItem = true
		const { state, sideEffects } = apply(initial, {
			op: 'queue-item-generated',
			opId: 'g1',
			item: queueItem(),
			consumedBackburnerItemIds: ['a'],
		})
		expect(ids(state.savedBackburner)).toEqual(['b'])
		expect(ids(state.backburner)).toEqual(['b'])
		expect(state.requestingGeneratedQueueItem).toBe(false)
		const saves = backburnerSaves(sideEffects)
		expect(saves).toHaveLength(1)
		expect(saves[0].trigger).toBe('consumed')
		expect(saves[0].layerId).toBe(L.DEFAULT_LAYER_ID)
		// the queue item itself still lands via the usual save path
		expect(listSaves(sideEffects)).toHaveLength(1)
	})

	it('tolerates consuming templates that were removed meanwhile', () => {
		const initial = SLL.createNewState([], [bbItem('b')])
		initial.requestingGeneratedQueueItem = true
		const { state, sideEffects } = apply(initial, {
			op: 'queue-item-generated',
			opId: 'g2',
			item: queueItem(),
			consumedBackburnerItemIds: ['gone'],
		})
		expect(ids(state.savedBackburner)).toEqual(['b'])
		expect(backburnerSaves(sideEffects)).toHaveLength(0)
	})
})

describe('queue saves reset mutation state', () => {
	function manualItem(layerId: L.LayerId = L.DEFAULT_LAYER_ID) {
		return LL.createItem({ type: 'single-list-item', layerId }, { type: 'manual', userId: USER })
	}

	function queueProps(state: SLL.State) {
		return { opId: `op-${counter++}`, userId: USER, editWindowSeqId: state.editWindowSeqId }
	}

	function editWindowClosures(sideEffects: SLL.SideEffect[]) {
		return sideEffects.filter((se) => se.code === 'edit-window-closed')
	}

	it('clears mutations when the save writes a changed list', () => {
		const [first, second] = [manualItem(), manualItem()]
		const initial = SLL.createNewState([first, second])
		const edited = apply(initial, { op: 'delete', itemId: second.itemId, ...queueProps(initial) }).state
		expect(edited.mutations.removed.has(second.itemId)).toBe(true)

		const { state, sideEffects } = apply(edited, { op: 'save', ...queueProps(edited) })
		expect(SLL.hasMutations(state)).toBe(false)
		expect(listSaves(sideEffects)).toHaveLength(1)
	})

	// edits that cancel each other out leave the list identical to the saved one, so there is nothing to write --
	// but the edit window still closed, and a deliberate finish-editing suppresses the abandoned-draft discard,
	// so nothing else would ever clear the leftover mutations
	it('clears mutations when the edits net out to no list change', () => {
		const item = manualItem()
		const initial = SLL.createNewState([item])
		const there = apply(initial, { op: 'edit-layer', itemId: item.itemId, newLayerId: OTHER_LAYER_ID, ...queueProps(initial) }).state
		const back = apply(there, { op: 'edit-layer', itemId: item.itemId, newLayerId: item.layerId, ...queueProps(there) }).state
		expect(back.list).toEqual(back.savedList)
		expect(SLL.hasMutations(back)).toBe(true)

		const { state, sideEffects } = apply(back, { op: 'save', ...queueProps(back) })
		expect(SLL.hasMutations(state)).toBe(false)
		expect(state.editWindowSeqId).toBe(back.editWindowSeqId + 1)
		expect(listSaves(sideEffects)).toHaveLength(0)
		expect(editWindowClosures(sideEffects)).toHaveLength(1)
	})

	it('clears mutations when the save empties the queue and waits on generation', () => {
		const item = manualItem()
		const initial = SLL.createNewState([item])
		const cleared = apply(initial, { op: 'clear', itemIds: [item.itemId], ...queueProps(initial) }).state

		const { state, sideEffects } = apply(cleared, { op: 'save', ...queueProps(cleared) })
		expect(sideEffects.some((se) => se.code === 'request-queue-item-generation')).toBe(true)
		expect(SLL.hasMutations(state)).toBe(false)

		const generated = apply(state, { op: 'queue-item-generated', opId: 'gen', item: queueItem() }).state
		expect(SLL.hasMutations(generated)).toBe(false)
		expect(generated.list).toHaveLength(1)
	})

	it('clears mutations when a roll saves the list out from under an editor', () => {
		const [first, second] = [manualItem(), manualItem()]
		const initial = SLL.createNewState([first, second])
		const edited = apply(initial, { op: 'edit-layer', itemId: second.itemId, newLayerId: OTHER_LAYER_ID, ...queueProps(initial) }).state
		expect(SLL.hasMutations(edited)).toBe(true)

		const { state } = apply(edited, { op: 'shift-first-saved-layer', opId: 'roll' })
		expect(SLL.hasMutations(state)).toBe(false)
	})

	it('skips a queue op authored against the first edit window once it has closed', () => {
		const [first, second] = [manualItem(), manualItem()]
		const initial = SLL.createNewState([first, second])
		expect(initial.editWindowSeqId).toBe(0)
		const staleOp: SLL.Operation = { op: 'delete', itemId: second.itemId, ...queueProps(initial) }

		const reset = apply(initial, { op: 'reset-to-saved', ...queueProps(initial) }).state
		expect(reset.editWindowSeqId).toBe(1)
		expect(() => apply(reset, staleOp)).toThrowError()
	})
})

describe('rejections', () => {
	function rejectionOf(run: () => unknown): SLL.Rejection {
		try {
			run()
		} catch (error) {
			return (error as ODSM.RejectedError<SLL.Rejection>).data
		}
		throw new Error('expected the batch to be rejected')
	}

	it('reports stale-window backburner ops as skipped', () => {
		const initial = SLL.createNewState([queueItem()])
		const rejection = rejectionOf(() =>
			apply(initial, { op: 'backburner-add', item: bbItem('a'), opId: 'x', userId: USER, editWindowSeqId: 42 }),
		)
		expect(rejection.code).toBe('op-skipped')
	})
})

// ODSM replays the reducer against the optimistic, synced and authoritative base states, and those share their
// items with each other. Mutating anything reachable from the state the reducer was handed corrupts all three
// at once, and the symptom surfaces as divergence somewhere else entirely -- so these tests are about what the
// reducer leaves alone, not about what it changes.
describe('copy-on-write', () => {
	const TAG = LTag.createTagId('meta')
	const OTHER_TAG = LTag.createTagId('inf')
	const NOTE_ID = 'note0001'

	function singleItem(): LL.SingleItem {
		return {
			type: 'single-list-item',
			itemId: 'item001',
			layerId: L.DEFAULT_LAYER_ID,
			source: { type: 'manual', userId: USER },
			tags: [TAG],
			tagsSetBy: { [TAG]: USER },
			notes: [{ id: NOTE_ID, author: USER, text: 'a note' }],
		}
	}

	function voteItem(): LL.VoteItem {
		const choices: LL.SingleItem[] = [
			{ type: 'single-list-item', itemId: 'vote001c0', layerId: L.DEFAULT_LAYER_ID, source: { type: 'generated' } },
			{ type: 'single-list-item', itemId: 'vote001c1', layerId: OTHER_LAYER_ID, source: { type: 'generated' } },
		]
		return { type: 'vote-list-item', itemId: 'vote001', layerId: choices[0].layerId, choices, source: { type: 'generated' } }
	}

	function baseState() {
		return SLL.createNewState([singleItem(), voteItem()], [bbItem('a'), bbItem('b', USER, 'Fallujah')])
	}

	function queueProps(state: SLL.State) {
		return { opId: `op-${counter++}`, userId: USER, editWindowSeqId: state.editWindowSeqId }
	}

	const EVERY_OP: Array<(state: SLL.State) => SLL.Operation> = [
		(s) => ({ op: 'add', items: [queueItem()], index: { outerIndex: 0, innerIndex: null }, ...queueProps(s) }),
		// into the vote's choices, so the parent item is rebuilt on both the removal and the insertion
		(s) => ({
			op: 'move',
			itemId: 'item001',
			newFirstItemId: 'newfirst01',
			cursor: { type: 'item-relative', itemId: 'vote001c0', position: 'after' },
			...queueProps(s),
		}),
		// out of the vote, collapsing it back to a single item
		(s) => ({ op: 'move', itemId: 'vote001c1', newFirstItemId: 'newfirst02', cursor: { type: 'start' }, ...queueProps(s) }),
		(s) => ({ op: 'swap-factions', itemId: 'vote001', ...queueProps(s) }),
		(s) => ({ op: 'swap-factions', itemId: 'vote001c0', ...queueProps(s) }),
		(s) => ({ op: 'edit-layer', itemId: 'vote001c0', newLayerId: OTHER_LAYER_ID, ...queueProps(s) }),
		(s) => ({ op: 'add-tag', itemId: 'item001', tagId: OTHER_TAG, ...queueProps(s) }),
		(s) => ({ op: 'remove-tag', itemId: 'item001', tagId: TAG, ...queueProps(s) }),
		(s) => ({ op: 'add-note', itemId: 'vote001c0', noteId: 'note0002', text: 'another', ...queueProps(s) }),
		(s) => ({ op: 'edit-note', itemId: 'item001', noteId: NOTE_ID, text: 'reworded', ...queueProps(s) }),
		(s) => ({ op: 'delete-note', itemId: 'item001', noteId: NOTE_ID, ...queueProps(s) }),
		(s) => ({ op: 'clone', itemId: 'vote001', ...queueProps(s) }),
		(s) => ({ op: 'configure-vote', itemId: 'vote001', config: { duration: 60_000 }, ...queueProps(s) }),
		(s) => ({ op: 'delete', itemId: 'vote001c0', ...queueProps(s) }),
		(s) => ({ op: 'clear', itemIds: ['item001'], ...queueProps(s) }),
		(s) => ({ op: 'save', ...queueProps(s) }),
		(s) => ({ op: 'reset-to-saved', ...queueProps(s) }),
		() => ({ op: 'shift-first-saved-layer', opId: `op-${counter++}` }),
		() => ({
			op: 'unshift-first-saved-layer',
			opId: `op-${counter++}`,
			layerId: OTHER_LAYER_ID,
			itemSource: { type: 'gameserver' },
			itemId: 'unshift001',
		}),
		() => ({ op: 'set-vote-result', opId: `op-${counter++}`, voteItemId: 'vote001', result: null }),
		() => ({ op: 'queue-item-generated', opId: `op-${counter++}`, item: queueItem(), consumedBackburnerItemIds: ['a'] }),
		() => ({ op: 'backburner-add', item: bbItem('c'), ...draftProps() }),
		() => ({ op: 'backburner-update', itemId: 'a', filter: FB.and([FB.eq('Gamemode', 'RAAS')]), ...draftProps() }),
		() => ({ op: 'backburner-remove', itemIds: ['a'], ...draftProps() }),
		() => ({ op: 'backburner-reorder', itemId: 'b', newIndex: 0, ...draftProps() }),
		() => ({ op: 'backburner-combine', targetItemId: 'a', sourceItemId: 'b', ...draftProps() }),
		() => ({ op: 'backburner-write-saved', opId: `op-${counter++}`, write: { kind: 'remove', itemIds: ['a'] } }),
		() => ({ op: 'backburner-save', ...draftProps() }),
		() => ({ op: 'backburner-reset', ...draftProps() }),
	]

	it('leaves the state it was given untouched', () => {
		for (const build of EVERY_OP) {
			const state = baseState()
			const before = Obj.deepClone(state)
			const op = build(state)
			// an op the reducer edits its way into rejecting must not have left anything behind either
			try {
				apply(state, op)
			} catch {}
			expect(state, `after ${op.op}`).toEqual(before)
		}
	})

	it('shares what the op left alone', () => {
		const state = baseState()
		const next = apply(state, { op: 'add-tag', itemId: 'item001', tagId: OTHER_TAG, ...queueProps(state) }).state
		expect(next.savedList).toBe(state.savedList)
		expect(next.backburner).toBe(state.backburner)
		expect(next.list[1]).toBe(state.list[1])
		expect(next.list[0]).not.toBe(state.list[0])
	})

	it('hands back the base collections an op never touched', () => {
		const state = baseState()
		const next = apply(state, { op: 'backburner-reorder', itemId: 'b', newIndex: 0, ...draftProps() }).state
		expect(next.list).toBe(state.list)
		expect(next.savedList).toBe(state.savedList)
		expect(next.mutations).toBe(state.mutations)
		expect(next.savedBackburner).toBe(state.savedBackburner)
	})
})
