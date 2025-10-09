// this is probably named poorly

export type NodePath = number[]
import * as Obj from '@/lib/object'
export type SparseNode = { id: string; children?: SparseNode[] }

const movePlaceholder = Symbol('movePlaceholder')
export function moveNode(root: SparseNode, sourcePath: NodePath, targetPath: NodePath) {
	if (Obj.deepEqual(sourcePath, targetPath)) {
		return root
	}

	// Check if targetPath is a child of sourcePath
	if (isChildPath(sourcePath, targetPath)) {
		throw new Error('Cannot move a node into its own child')
	}

	root = Obj.deepClone(root)

	const sourceParent = derefPath(root, sourcePath.slice(0, -1))
	if (!sourceParent.children) {
		throw new Error('Invalid source parent')
	}
	const targetParent = derefPath(root, targetPath.slice(0, -1))
	if (!targetParent.children) {
		throw new Error('Invalid target parent')
	}

	const child = sourceParent.children[sourcePath[sourcePath.length - 1]]
	// use a placeholder so that indexes aren't shifed when inserting at the target
	sourceParent.children.splice(sourcePath[sourcePath.length - 1], 1, movePlaceholder as any)
	targetParent.children.splice(targetPath[targetPath.length - 1], 0, child)

	const placeholderIndex = sourceParent.children.indexOf(movePlaceholder as any)
	sourceParent.children.splice(placeholderIndex, 1)

	return root
}

export function isChildPath(parentPath: NodePath, childPath: NodePath) {
	if (childPath.length <= parentPath.length) return false
	return parentPath.every((val, index) => val === childPath[index])
}

export function isOwnedPath(targetPath: NodePath, toCheckPath: NodePath) {
	return Obj.deepEqual(targetPath, toCheckPath.slice(0, targetPath.length))
}

export function derefPath(root: SparseNode, path: NodePath) {
	const node = tryDerefPath(root, path)
	if (!node) {
		console.log('Invalid path', path, 'for node', JSON.stringify(root))
		throw new Error('Invalid path ' + path + ' for node ' + JSON.stringify(root))
	}
	return node
}

export function tryDerefPath(root: SparseNode, path: NodePath) {
	let node = root
	for (const index of path) {
		if (!node.children) return null
		node = node.children[index]
	}
	return node
}

export function* walkNodes(tree: SparseNode, path: NodePath = []): IterableIterator<[SparseNode, NodePath]> {
	yield [tree, path]
	if (tree.children) {
		for (const [child, index] of tree.children.map((child, index) => [child, index] as const)) {
			yield* walkNodes(child, [...path, index])
		}
	}
}
