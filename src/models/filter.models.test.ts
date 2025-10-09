import * as EFB from '@/models/editable-filter-builders'
import { beforeEach, describe, expect, it } from 'vitest'
import { type FilterNodeTree, moveTreeNodeInPlace, type NodePath } from './filter.models'

describe('moveTreeNodeInPlace', () => {
	let tree: Pick<FilterNodeTree, 'paths'>

	beforeEach(() => {
		tree = {
			paths: new Map<string, NodePath>(),
		}
		tree.paths.set('__root__', [])
	})

	describe('basic move operations', () => {
		it('should move a single node from one position to another', () => {
			// Setup: tree with nodes at [0], [1], [2]
			//
			//
			//
			tree.paths.set('node1', [0])
			tree.paths.set('node2', [1])
			tree.paths.set('node3', [2])

			// Move node1 from [0] to [2]
			moveTreeNodeInPlace(tree, [0], [2])

			expect(tree.paths.get('node1')).toEqual([2])
			expect(tree.paths.get('node2')).toEqual([0]) // shifted left
			expect(tree.paths.get('node3')).toEqual([1]) // shifted left
		})

		it('should move a node forward in the same level', () => {
			tree.paths.set('node1', [0])
			tree.paths.set('node2', [1])
			tree.paths.set('node3', [2])
			tree.paths.set('node4', [3])

			// Move node2 from [1] to [3]
			moveTreeNodeInPlace(tree, [1], [3])

			expect(tree.paths.get('node1')).toEqual([0]) // unchanged
			expect(tree.paths.get('node2')).toEqual([3]) // moved to target
			expect(tree.paths.get('node3')).toEqual([1]) // shifted left
			expect(tree.paths.get('node4')).toEqual([2]) // shifted left
		})

		it('should move a node backward in the same level', () => {
			tree.paths.set('node1', [0])
			tree.paths.set('node2', [1])
			tree.paths.set('node3', [2])
			tree.paths.set('node4', [3])

			// Move node4 from [3] to [1]
			moveTreeNodeInPlace(tree, [3], [1])

			expect(tree.paths.get('node1')).toEqual([0]) // unchanged
			expect(tree.paths.get('node2')).toEqual([2]) // shifted right
			expect(tree.paths.get('node3')).toEqual([3]) // shifted right
			expect(tree.paths.get('node4')).toEqual([1]) // moved to target
		})
	})

	describe('moving nodes with children', () => {
		it('should move a node and all its children together', () => {
			tree.paths.set('parent1', [0])
			tree.paths.set('child1', [0, 0])
			tree.paths.set('child2', [0, 1])
			tree.paths.set('grandchild1', [0, 0, 0])
			tree.paths.set('parent2', [1])
			tree.paths.set('parent3', [2])

			// Move parent1 and all children from [0] to [2]
			moveTreeNodeInPlace(tree, [0], [2])

			expect(tree.paths.get('parent1')).toEqual([2])
			expect(tree.paths.get('child1')).toEqual([2, 0]) // preserved relative path
			expect(tree.paths.get('child2')).toEqual([2, 1]) // preserved relative path
			expect(tree.paths.get('grandchild1')).toEqual([2, 0, 0]) // preserved relative path
			expect(tree.paths.get('parent2')).toEqual([0]) // shifted left
			expect(tree.paths.get('parent3')).toEqual([1]) // shifted left
		})

		it('should move a deep nested subtree correctly', () => {
			tree.paths.set('root', [0])
			tree.paths.set('level1', [0, 0])
			tree.paths.set('level2a', [0, 0, 0])
			tree.paths.set('level2b', [0, 0, 1])
			tree.paths.set('level3', [0, 0, 0, 0])
			tree.paths.set('other', [1])

			// Move the level1 subtree from [0, 0] to [1, 0]
			moveTreeNodeInPlace(tree, [0, 0], [1, 0])

			expect(tree.paths.get('root')).toEqual([0]) // unchanged
			expect(tree.paths.get('level1')).toEqual([1, 0])
			expect(tree.paths.get('level2a')).toEqual([1, 0, 0])
			expect(tree.paths.get('level2b')).toEqual([1, 0, 1])
			expect(tree.paths.get('level3')).toEqual([1, 0, 0, 0])
			expect(tree.paths.get('other')).toEqual([1]) // unchanged - becomes parent of moved subtree
		})
	})

	describe('moving within the same parent', () => {
		it('should handle moving within the same parent correctly', () => {
			tree.paths.set('parent', [0])
			tree.paths.set('child1', [0, 0])
			tree.paths.set('child2', [0, 1])
			tree.paths.set('child3', [0, 2])
			tree.paths.set('child4', [0, 3])

			// Move child2 from position 1 to position 3 within the same parent
			moveTreeNodeInPlace(tree, [0, 1], [0, 3])

			expect(tree.paths.get('parent')).toEqual([0])
			expect(tree.paths.get('child1')).toEqual([0, 0]) // unchanged
			expect(tree.paths.get('child2')).toEqual([0, 3]) // moved to target
			expect(tree.paths.get('child3')).toEqual([0, 1]) // shifted left
			expect(tree.paths.get('child4')).toEqual([0, 2]) // shifted left
		})

		it('should handle moving backward within the same parent', () => {
			tree.paths.set('parent', [0])
			tree.paths.set('child1', [0, 0])
			tree.paths.set('child2', [0, 1])
			tree.paths.set('child3', [0, 2])
			tree.paths.set('child4', [0, 3])

			// Move child4 from position 3 to position 1 within the same parent
			moveTreeNodeInPlace(tree, [0, 3], [0, 1])

			expect(tree.paths.get('parent')).toEqual([0])
			expect(tree.paths.get('child1')).toEqual([0, 0]) // unchanged
			expect(tree.paths.get('child2')).toEqual([0, 2]) // shifted right
			expect(tree.paths.get('child3')).toEqual([0, 3]) // shifted right
			expect(tree.paths.get('child4')).toEqual([0, 1]) // moved to target
		})

		it('should handle same-parent moves correctly without double-shifting', () => {
			// This test verifies that nodes are correctly positioned when moving
			// within the same parent, ensuring no double-shifting occurs
			tree.paths.set('parent', [0])
			tree.paths.set('child0', [0, 0])
			tree.paths.set('child1', [0, 1])
			tree.paths.set('child2', [0, 2])
			tree.paths.set('child3', [0, 3]) // source - will be moved
			tree.paths.set('child4', [0, 4]) // this node is the critical test case
			tree.paths.set('child5', [0, 5])

			// Move child3 from position 3 to position 1
			moveTreeNodeInPlace(tree, [0, 3], [0, 1])

			expect(tree.paths.get('parent')).toEqual([0])
			expect(tree.paths.get('child0')).toEqual([0, 0]) // unchanged
			expect(tree.paths.get('child1')).toEqual([0, 2]) // shifted right to make room
			expect(tree.paths.get('child2')).toEqual([0, 3]) // shifted right to make room
			expect(tree.paths.get('child3')).toEqual([0, 1]) // moved to target

			// CORRECT: child4 and child5 are after the source position and should remain unchanged
			// The gap at position 3 gets filled by child2 moving from position 2 to 3
			// Nodes beyond the source position don't need to shift
			expect(tree.paths.get('child4')).toEqual([0, 4]) // unchanged - after source
			expect(tree.paths.get('child5')).toEqual([0, 5]) // unchanged - after source
		})
	})

	describe('moving between different parents', () => {
		it('should move a node from one parent to another', () => {
			tree.paths.set('parent1', [0])
			tree.paths.set('parent2', [1])
			tree.paths.set('child1', [0, 0])
			tree.paths.set('child2', [0, 1])
			tree.paths.set('child3', [1, 0])

			// Move child2 from parent1 to parent2
			moveTreeNodeInPlace(tree, [0, 1], [1, 1])

			expect(tree.paths.get('parent1')).toEqual([0])
			expect(tree.paths.get('parent2')).toEqual([1])
			expect(tree.paths.get('child1')).toEqual([0, 0]) // unchanged
			expect(tree.paths.get('child2')).toEqual([1, 1]) // moved to new parent
			expect(tree.paths.get('child3')).toEqual([1, 0]) // unchanged
		})

		it('should handle complex cross-parent moves with multiple children', () => {
			tree.paths.set('parent1', [0])
			tree.paths.set('parent2', [1])
			tree.paths.set('parent3', [2])
			tree.paths.set('child1a', [0, 0])
			tree.paths.set('child1b', [0, 1])
			tree.paths.set('child2a', [1, 0])
			tree.paths.set('child3a', [2, 0])
			tree.paths.set('child3b', [2, 1])

			// Move child1a from parent1 to parent3
			moveTreeNodeInPlace(tree, [0, 0], [2, 2])

			expect(tree.paths.get('child1a')).toEqual([2, 2])
			expect(tree.paths.get('child1b')).toEqual([0, 0]) // shifted left in source parent
			expect(tree.paths.get('child2a')).toEqual([1, 0]) // unchanged
			expect(tree.paths.get('child3a')).toEqual([2, 0]) // unchanged
			expect(tree.paths.get('child3b')).toEqual([2, 1]) // unchanged
		})
	})

	describe('edge cases and error conditions', () => {
		it('should not move a node into itself (isOwnedPath check)', () => {
			tree.paths.set('parent', [0])
			tree.paths.set('child', [0, 0])

			// Try to move parent into its own child - should be prevented
			const originalPaths = new Map(tree.paths)
			moveTreeNodeInPlace(tree, [0], [0, 0])

			// Paths should remain unchanged
			expect(tree.paths.get('parent')).toEqual([0])
			expect(tree.paths.get('child')).toEqual([0, 0])
			expect(tree.paths).toEqual(originalPaths)
		})

		it('should not move a node into its descendant', () => {
			tree.paths.set('parent', [0])
			tree.paths.set('child', [0, 0])
			tree.paths.set('grandchild', [0, 0, 0])

			// Try to move parent into its grandchild - should be prevented
			const originalPaths = new Map(tree.paths)
			moveTreeNodeInPlace(tree, [0], [0, 0, 0])

			expect(tree.paths).toEqual(originalPaths)
		})

		it('should handle empty tree gracefully', () => {
			// Empty tree
			expect(() => {
				moveTreeNodeInPlace(tree, [0], [1])
			}).not.toThrow()
		})

		it('should handle single node tree', () => {
			tree.paths.set('only', [0])

			// Try to move the only node - nothing should change since there's nowhere to move
			moveTreeNodeInPlace(tree, [0], [1])

			expect(tree.paths.get('only')).toEqual([1])
		})
	})

	describe('complex hierarchical scenarios', () => {
		it('should handle moving a subtree to a different level', () => {
			// Create a more complex tree structure
			tree.paths.set('root1', [0])
			tree.paths.set('root2', [1])
			tree.paths.set('child1', [0, 0])
			tree.paths.set('child2', [0, 1])
			tree.paths.set('grandchild1', [0, 0, 0])
			tree.paths.set('grandchild2', [0, 0, 1])
			tree.paths.set('child3', [1, 0])

			// Move child1 (with its children) from [0, 0] to root level at [2]
			moveTreeNodeInPlace(tree, [0, 0], [2])

			expect(tree.paths.get('root1')).toEqual([0])
			expect(tree.paths.get('root2')).toEqual([1])
			expect(tree.paths.get('child1')).toEqual([2]) // moved to root level
			expect(tree.paths.get('child2')).toEqual([0, 0]) // shifted left in original parent
			expect(tree.paths.get('grandchild1')).toEqual([2, 0]) // moved with parent
			expect(tree.paths.get('grandchild2')).toEqual([2, 1]) // moved with parent
			expect(tree.paths.get('child3')).toEqual([1, 0]) // unchanged
		})

		it('should handle moving from root level to nested level', () => {
			tree.paths.set('root1', [0])
			tree.paths.set('root2', [1])
			tree.paths.set('root3', [2])
			tree.paths.set('child1', [1, 0])
			tree.paths.set('child2', [1, 1])

			// Move root3 from [2] to be a child of root2 at [1, 2]
			moveTreeNodeInPlace(tree, [2], [1, 2])

			expect(tree.paths.get('root1')).toEqual([0])
			expect(tree.paths.get('root2')).toEqual([1])
			expect(tree.paths.get('root3')).toEqual([1, 2]) // moved to be a child
			expect(tree.paths.get('child1')).toEqual([1, 0])
			expect(tree.paths.get('child2')).toEqual([1, 1])
		})
	})

	describe('boundary conditions', () => {
		it('should handle moving to position 0', () => {
			tree.paths.set('node1', [0])
			tree.paths.set('node2', [1])
			tree.paths.set('node3', [2])

			// Move node3 to position 0
			moveTreeNodeInPlace(tree, [2], [0])

			expect(tree.paths.get('node1')).toEqual([1]) // shifted right
			expect(tree.paths.get('node2')).toEqual([2]) // shifted right
			expect(tree.paths.get('node3')).toEqual([0]) // moved to beginning
		})

		it('should handle moving from position 0', () => {
			tree.paths.set('node1', [0])
			tree.paths.set('node2', [1])
			tree.paths.set('node3', [2])

			// Move node1 from position 0 to end
			moveTreeNodeInPlace(tree, [0], [2])

			expect(tree.paths.get('node1')).toEqual([2]) // moved to end
			expect(tree.paths.get('node2')).toEqual([0]) // shifted left
			expect(tree.paths.get('node3')).toEqual([1]) // shifted left
		})
	})
})
