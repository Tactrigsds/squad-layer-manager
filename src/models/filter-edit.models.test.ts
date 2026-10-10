import { describe, expect, it } from 'vitest'

import * as Obj from '@/lib/object-utils'
import * as FB from '@/models/filter-builders.models'
import * as FE from '@/models/filter-edit.models'
import * as F from '@/models/filter.models'

// The reducer is copy-on-write, and ODSM replays it against several base states that share structure with
// each other -- the optimistic one, the synced one, and on the server the authoritative one. A mutation of
// anything reachable from the state it was handed corrupts all of them at once, and the cheap version of
// that mistake (deep-cloning the whole draft per op) is exactly what this replaced. So these tests are
// about what the reducer leaves alone, not about what it changes.

const USER = 900000000000000001n

function baseState(): FE.State {
	return FE.localState('collab', FB.and([FB.eq('Gamemode', 'RAAS'), FB.eq('Map', 'Harju')]) as F.EditableFilterNode)
}

// a block with children of its own, so a clone has to carry more than one node
function nestedState(): FE.State {
	const filter = FB.and([FB.eq('Gamemode', 'RAAS'), FB.or([FB.eq('Map', 'Harju'), FB.eq('Map', 'Skorpo')])])
	return FE.localState('collab', filter as F.EditableFilterNode)
}

// the tree mints its own node ids, so ops are aimed by position instead
function idAt(state: FE.State, path: number[]): string {
	let id = state.draft.tree.rootId
	for (const index of path) {
		const child = state.draft.tree.children.get(id)?.[index]
		if (child === undefined) throw new Error(`no node at ${path.join('.')}`)
		id = child
	}
	return id
}

function childrenOf(state: FE.State, id: string) {
	return state.draft.tree.children.get(id)
}

function apply(state: FE.State, ...ops: FE.NewClientOp[]): FE.State {
	const built = ops.map((op) => ({ ...op, opId: FE.createOpId(), userId: USER }) as FE.Op)
	return FE.reducer(state, built, [])[0]
}

const EVERY_OP: Array<(state: FE.State) => FE.NewClientOp> = [
	(s) => ({ code: 'add-node', parentId: idAt(s, []), nodeId: FE.createNodeId(), node: { type: 'and' } }),
	(s) => ({ code: 'delete-node', nodeId: idAt(s, [1]) }),
	(s) => ({ code: 'update-node', nodeId: idAt(s, [0]), node: FB.eq('Map', 'Skorpo') }),
	(s) => ({ code: 'set-comment', nodeId: idAt(s, [0]), comment: 'why this is here' }),
	(s) => ({ code: 'move-node', nodeId: idAt(s, [1]), parentId: idAt(s, []), index: 0 }),
	(s) => ({ code: 'add-node', parentId: idAt(s, []), nodeId: FE.createNodeId(), node: { type: 'and' }, index: 0 }),
	(s) => ({ code: 'clone-node', nodeId: idAt(s, [1]), subtree: F.copySubtree(s.draft.tree, idAt(s, [1]))! }),
	() => ({ code: 'set-meta', patch: { name: 'renamed' } }),
	() => ({ code: 'save' }),
]

describe('the filter draft reducer', () => {
	it('leaves the state it was given untouched', () => {
		for (const build of EVERY_OP) {
			// already modified, so `save` has something to commit; the node paths are untouched by a meta change
			const state = apply(baseState(), { code: 'set-meta', patch: { name: 'named' } })
			const before = Obj.deepClone(state)
			apply(state, build(state))
			expect(state).toEqual(before)
		}
	})

	it('shares what the op did not touch', () => {
		const state = apply(baseState(), { code: 'set-meta', patch: { name: 'named' } })
		const editedId = idAt(state, [0])
		const untouchedId = idAt(state, [1])

		// editing one node moves that node and nothing else: the links, its siblings and the saved baseline
		// are all still the objects they were
		const edited = apply(state, { code: 'update-node', nodeId: editedId, node: FB.eq('Map', 'Skorpo') })
		expect(edited.draft.tree.children).toBe(state.draft.tree.children)
		expect(edited.draft.tree.parents).toBe(state.draft.tree.parents)
		expect(edited.draft.tree.nodes.get(untouchedId)).toBe(state.draft.tree.nodes.get(untouchedId))
		expect(edited.draft.meta).toBe(state.draft.meta)
		expect(edited.saved).toBe(state.saved)

		// and a change to the details leaves the whole tree where it was
		const renamed = apply(state, { code: 'set-meta', patch: { name: 'renamed again' } })
		expect(renamed.draft.tree).toBe(state.draft.tree)
	})

	it('hands back the same state for an op that changes nothing', () => {
		const start = baseState()
		const id = idAt(start, [0])
		const state = apply(start, { code: 'set-comment', nodeId: id, comment: 'a note' })
		// a batch the reducer resolves to a no-op is rejected rather than broadcast, and the check for that is
		// a reference comparison -- so an op that re-sets a value it already holds has to return `state` itself
		expect(() => apply(state, { code: 'set-comment', nodeId: id, comment: 'a note' })).toThrow(/operation rejected/)
		expect(() => apply(state, { code: 'update-node', nodeId: id, node: state.draft.tree.nodes.get(id)! })).toThrow(/operation rejected/)
	})

	it('inserts at a position, shifting only the siblings after it', () => {
		const start = baseState()
		const first = idAt(start, [0])
		const second = idAt(start, [1])
		const inserted = FE.createNodeId()

		const next = apply(start, { code: 'add-node', parentId: idAt(start, []), nodeId: inserted, node: { type: 'and' }, index: 1 })
		expect(childrenOf(next, idAt(start, []))).toEqual([first, inserted, second])
		expect(childrenOf(next, inserted)).toEqual([])
		expect(F.isWellFormedTree(next.draft.tree)).toBe(true)
	})

	it('moves by the slot a drop names, counted before the move', () => {
		const start = nestedState()
		const rootId = idAt(start, [])
		const [leaf, block] = childrenOf(start, rootId)!
		const [harju, skorpo] = childrenOf(start, block)!

		// the slot after the last sibling
		const forward = apply(start, { code: 'move-node', nodeId: leaf, parentId: rootId, index: 2 })
		expect(childrenOf(forward, rootId)).toEqual([block, leaf])

		const intoBlock = apply(start, { code: 'move-node', nodeId: leaf, parentId: block, index: 1 })
		expect(childrenOf(intoBlock, rootId)).toEqual([block])
		expect(childrenOf(intoBlock, block)).toEqual([harju, leaf, skorpo])
		expect(intoBlock.draft.tree.parents.get(leaf)).toBe(block)
		expect(F.isWellFormedTree(intoBlock.draft.tree)).toBe(true)

		// the slots either side of a node both leave it where it is
		expect(() => apply(start, { code: 'move-node', nodeId: leaf, parentId: rootId, index: 1 })).toThrow(/operation rejected/)
		expect(() => apply(start, { code: 'move-node', nodeId: block, parentId: harju, index: 0 })).toThrow(/move-node skipped/)
		expect(() => apply(start, { code: 'move-node', nodeId: block, parentId: block, index: 0 })).toThrow(/move-node skipped/)
		expect(() => apply(start, { code: 'move-node', nodeId: rootId, parentId: block, index: 0 })).toThrow(/move-node skipped/)
	})

	it('deletes a node with everything below it', () => {
		const start = nestedState()
		const block = idAt(start, [1])
		const next = apply(start, { code: 'delete-node', nodeId: block })
		expect(next.draft.tree.nodes.size).toBe(2)
		expect(childrenOf(next, idAt(start, []))).toEqual([idAt(start, [0])])
		expect(F.isWellFormedTree(next.draft.tree)).toBe(true)
	})

	it('refuses an update that turns a block into a leaf', () => {
		const start = nestedState()
		expect(() => apply(start, { code: 'update-node', nodeId: idAt(start, [1]), node: FB.eq('Map', 'Harju') })).toThrow(
			/update-node skipped/,
		)
	})

	it('refuses a replacement tree whose links do not form one tree', () => {
		const start = nestedState()
		const tree = start.draft.tree
		const [leaf, block] = childrenOf(start, tree.rootId)!
		const malformed: Array<[string, F.FilterNodeTree]> = [
			['a node with no parent link', { ...tree, parents: new Map([...tree.parents].filter(([id]) => id !== leaf)) }],
			['a child with no node', { ...tree, nodes: new Map([...tree.nodes].filter(([id]) => id !== leaf)) }],
			['a node under two parents', { ...tree, children: new Map(tree.children).set(block, [...childrenOf(start, block)!, leaf]) }],
			['a cycle', { ...tree, children: new Map(tree.children).set(block, [tree.rootId]) }],
			['a leaf with a child list', { ...tree, children: new Map(tree.children).set(leaf, []) }],
		]
		for (const [what, replacement] of malformed) {
			expect(() => apply(start, { code: 'replace-tree', tree: replacement }), what).toThrow(/replace-tree skipped/)
		}
	})

	it('clones a subtree in below the original, with ids of its own', () => {
		const start = nestedState()
		const blockId = idAt(start, [1])
		const subtree = F.copySubtree(start.draft.tree, blockId)!
		expect(subtree.nodes.size).toBe(3)
		for (const id of subtree.nodes.keys()) {
			expect(start.draft.tree.nodes.has(id)).toBe(false)
		}

		// the copy is the original one place along: same shape, same nodes, under the new ids
		const next = apply(start, { code: 'clone-node', nodeId: blockId, subtree })
		expect(childrenOf(next, idAt(start, []))).toEqual([idAt(start, [0]), blockId, subtree.rootId])
		expect(F.treeToFilterNode(next.draft.tree, subtree.rootId)).toEqual(F.treeToFilterNode(start.draft.tree, blockId))
		expect(F.isWellFormedTree(next.draft.tree)).toBe(true)

		// an op carrying ids the tree already holds would overwrite live nodes, so it is refused
		expect(() => apply(next, { code: 'clone-node', nodeId: blockId, subtree })).toThrow(/clone-node skipped/)
	})

	it('saves by adopting the draft, and resets by adopting the baseline', () => {
		const edited = apply(baseState(), { code: 'set-meta', patch: { name: 'ready to save' } })
		expect(FE.isModified(edited)).toBe(true)

		const saved = apply(edited, { code: 'save' })
		expect(saved.saved).toBe(saved.draft)
		expect(FE.isModified(saved)).toBe(false)

		const dirtied = apply(saved, { code: 'set-meta', patch: { name: 'dirty again' } })
		const reset = apply(dirtied, { code: 'reset-to-saved' })
		expect(reset.draft).toBe(saved.saved)
		expect(FE.isModified(reset)).toBe(false)
	})
})
