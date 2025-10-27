// TODO rats nest from manic debugging, need to straighten out naming conventions & break out some modules
import type * as SchemaModels from '$root/drizzle/schema.models'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as NodeMap from '@/lib/node-map'
import * as Obj from '@/lib/object'
import * as Sparse from '@/lib/sparse-tree'
import { assertNever } from '@/lib/type-guards'
import * as EFB from '@/models/editable-filter-builders'
import { type SQL } from 'drizzle-orm'
import * as Im from 'immer'
import * as React from 'react'
import { z } from 'zod'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import * as LC from './layer-columns'

export type ComparisonType = {
	coltype: LC.ColumnType
	code: string
	displayName: string
	default?: boolean
}

export const COMPARISON_TYPES = [
	{ coltype: 'float', code: 'lt', displayName: '<' },
	{ coltype: 'float', code: 'gt', displayName: '>' },
	{ coltype: 'float', code: 'inrange', displayName: '[..]' },
	{ coltype: 'string', code: 'in', displayName: 'in' },
	{ coltype: 'string', code: 'notin', displayName: 'not in' },
	{ coltype: 'string', code: 'eq', displayName: '=' },
	{ coltype: 'string', code: 'neq', displayName: '!=' },
	{ coltype: 'boolean', code: 'is-true', displayName: 'true' },
] as const satisfies ComparisonType[]

export const DEFAULT_COMPARISONS = {
	float: 'inrange',
	string: 'eq',
	boolean: 'is-true',
} satisfies Record<
	Exclude<LC.ColumnType, 'integer'>,
	ComparisonCode
>
export function getColumnTypeWithComposite(column: string, cfg = LC.BASE_COLUMN_CONFIG) {
	const colDef = LC.getColumnDef(column, cfg)
	if (!colDef) return undefined
	return colDef.type
}

export function getDefaultComparison(
	columnType: LC.ColumnType,
) {
	const result = DEFAULT_COMPARISONS[columnType as keyof typeof DEFAULT_COMPARISONS]
	if (!result) throw new Error(`No default comparison for ${columnType}`)
	return result
}

export type Comparison = z.infer<typeof ComparisonSchema>
export type FilterNode =
	| {
		type: 'and'
		neg: boolean
		children: FilterNode[]
	}
	| {
		type: 'or'
		neg: boolean
		children: FilterNode[]
	}
	| {
		type: 'comp'
		neg: boolean
		comp: Comparison
	}
	| {
		type: 'apply-filter'
		neg: boolean
		filterId: string
	}
	| {
		type: 'allow-matchups'
		allowMatchups: FactionsAllowMatchups
		neg: boolean
	}

export type EditableFilterNodeCommon =
	| {
		type: 'comp'
		neg: boolean
		comp: EditableComparison
	}
	| {
		type: 'apply-filter'
		neg: boolean
		filterId?: string
	}
	| {
		type: 'allow-matchups'
		allowMatchups: FactionsAllowMatchups
		neg: boolean
	}

export type EditableFilterNode = EditableFilterNodeCommon | {
	type: BlockType
	neg: boolean
	children: EditableFilterNode[]
}

export type ShallowEditableFilterNode = EditableFilterNodeCommon | { type: BlockType; neg: boolean }

export type ShallowEditableFilterNodeOfType<T extends NodeType> = Extract<ShallowEditableFilterNode, { type: T }>

export type BlockTypeEditableFilterNode = Extract<
	EditableFilterNode,
	{ type: BlockType }
>

export const BLOCK_TYPES = ['and', 'or'] as const
export const VALUE_TYPES = ['comp', 'apply-filter', 'allow-matchups'] as const
export type NodeType = FilterNode['type']

export function isBlockType(type: string): type is BlockType {
	return BLOCK_TYPES.includes(type as BlockType)
}
export function isBlockNode<T extends FilterNode>(
	node: T,
): node is Extract<T, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}

// --------  numeric --------
export const LessThanComparison = z.object({
	code: z.literal('lt'),
	value: z.number(),
	column: z.string(),
})
export type LessThanComparison = z.infer<typeof LessThanComparison>

export const GreaterThanComparison = z.object({
	code: z.literal('gt'),
	value: z.number(),
	column: z.string(),
})
export type GreaterThanComparison = z.infer<typeof GreaterThanComparison>

export const InRangeComparisonSchema = z
	.object({
		code: z.literal('inrange'),
		range: z
			.tuple([z.number().optional(), z.number().optional()])
			.describe(
				"smallest value is always the start of the range, even if it's larger",
			)
			.refine(
				(range) => {
					return range.some((value) => value !== undefined)
				},
				{ message: 'Range must have at least one value' },
			),
		column: z.string(),
	})
	.describe('Inclusive Range')

export type InRangeComparison = z.infer<typeof InRangeComparisonSchema>

export type NumericComparison =
	| LessThanComparison
	| GreaterThanComparison
	| InRangeComparison
// --------  numeric end --------

// --------  string --------
export const InComparison = z.object({
	code: z.literal('in'),
	values: z.array(z.string().nullable()),
	column: z.string(),
})
export type InComparison = z.infer<typeof InComparison>

export const NotInComparison = z.object({
	code: z.literal('notin'),
	values: z.array(z.string().nullable()),
	column: z.string(),
})
export type NotInComparison = z.infer<typeof NotInComparison>

export const EqualComparison = z.object({
	code: z.literal('eq'),
	value: z.string().nullable(),
	column: z.string(),
})
export type EqualComparison = z.infer<typeof EqualComparison>

export const NotEqualComparison = z.object({
	code: z.literal('neq'),
	value: z.string().nullable(),
	column: z.string(),
})
export type NotEqualComparison = z.infer<typeof NotEqualComparison>

export type StringComparison = InComparison | EqualComparison
// --------  string end --------

const IsTrueComparison = z.object({
	code: z.literal('is-true'),
	column: z.string(),
})

export const FactionMaskSchema = z.object({
	// null is only semantically different for edit state
	alliance: z.array(z.string()).nullable().optional(),
	faction: z.array(z.string()).nullable().optional(),
	unit: z.array(z.string()).nullable().optional(),
})
export type FactionMask = z.infer<typeof FactionMaskSchema>

export const FACTION_MODE = z.enum(['split', 'both', 'either'])
export type FactionMaskMode = z.infer<typeof FACTION_MODE>

// --------  factions --------
export const FactionsAllowMatchupsSchema = z.object({
	allMasks: z
		.array(z.array(FactionMaskSchema))
		.refine((teams) => teams.length > 0 && teams.length <= 2, {
			message: 'At least one team is required and at most two teams are allowed',
		}),
	// default either
	mode: FACTION_MODE.optional(),
})

export type FactionsAllowMatchups = z.infer<typeof FactionsAllowMatchupsSchema>

// --------  factionsend --------

// Combine into the final ComparisonSchema
export const ComparisonSchema = z
	.discriminatedUnion('code', [
		LessThanComparison,
		GreaterThanComparison,
		InRangeComparisonSchema,
		InComparison,
		NotInComparison,
		EqualComparison,
		NotEqualComparison,
		IsTrueComparison,
	])
	.refine((comp) => COMPARISON_TYPES.some((type) => type.code === comp.code), {
		message: 'Invalid comparison type',
	})

// TODO add 'not'
export const BaseFilterNodeSchema = z.object({
	type: z.union([
		z.literal('and'),
		z.literal('or'),
		z.literal('comp'),
		z.literal('apply-filter'),
		z.literal('allow-matchups'),
	]),
	comp: ComparisonSchema.optional(),
	// negations
	neg: z.boolean().default(false),
	filterId: z.lazy(() => FilterEntityIdSchema).optional(),
	allowMatchups: FactionsAllowMatchupsSchema.optional(),
})

export function isValidComparison(
	comp: EditableComparison,
): comp is Comparison {
	const res = ComparisonSchema.safeParse(comp)
	return res.success
}
export function isValidApplyFilterNode(
	node: EditableFilterNode & { type: 'apply-filter' },
): node is FilterNode & { type: 'apply-filter' } {
	return !!node.filterId
}

// TODO Implement isValidAllowMatchupsNode
export function isValidAllowMatchupsNode(
	node: EditableFilterNode & { type: 'allow-matchups' },
): node is FilterNode & { type: 'allow-matchups' } {
	return !!node.allowMatchups
}

export const FilterNodeSchema = BaseFilterNodeSchema.extend({
	children: z.lazy(() => FilterNodeSchema.array().optional()),
})
	.refine((node) => node.type !== 'comp' || node.comp !== undefined, {
		message: 'comp must be defined for type "comp"',
	})
	.refine((node) => node.type !== 'comp' || node.children === undefined, {
		message: 'children must not be defined for type "comp"',
	})
	.refine(
		(node) => node.type !== 'apply-filter' || typeof node.filterId === 'string',
		{
			message: 'filterId must be defined for type "apply-filter"',
		},
	)
	.refine((node) => !(['and', 'or'].includes(node.type) && !node.children), {
		message: 'children must be defined for type "and" or "or"',
	}) as z.ZodType<FilterNode>

export const RootFilterNodeSchema = FilterNodeSchema.refine(
	(root) => isBlockNode(root),
	{ message: 'Root node must be a block type' },
)

export function isValidFilterNode(
	node: EditableFilterNode,
): node is FilterNode {
	return FilterNodeSchema.safeParse(node).success
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode) {
	if (isEditableBlockNode(node)) return true
	if (node.type === 'comp') return isValidComparison(node.comp)
	if (node.type === 'apply-filter') return isValidApplyFilterNode(node)
	if (node.type === 'allow-matchups') return isValidAllowMatchupsNode(node)
	assertNever(node)
}

export function isEditableBlockNode<T extends { type: NodeType }>(
	node: T,
): node is Extract<T, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}

export type BlockType = (typeof BLOCK_TYPES)[number]
export type ValueType = (typeof VALUE_TYPES)[number]

export const getComparisonTypesForColumn = LC.coalesceLookupErrors(
	(column: string, cfg = LC.BASE_COLUMN_CONFIG) => {
		const colType = LC.getColumnDef(column, cfg)!.type
		return {
			code: 'ok' as const,
			comparisonTypes: COMPARISON_TYPES.filter(
				(type) => type.coltype === colType,
			),
		}
	},
)
export const EditableComparisonSchema = z.object({
	column: z.string().optional(),
	code: z
		.enum(
			COMPARISON_TYPES.map((type) => type.code) as [
				ComparisonCode,
				...ComparisonCode[],
			],
		)
		.optional(),
	value: z.union([z.number(), z.string(), z.null()]).optional(),
	values: z.array(z.string().nullable()).optional(),
	range: z.tuple([z.number().optional(), z.number().optional()]).optional(),
	allMasks: z.array(z.array(FactionMaskSchema)).optional(),
	mode: z.enum(['split', 'both', 'either']).optional(),
})
export type EditableComparison = z.infer<typeof EditableComparisonSchema>
export type EditableBlockNode = Extract<EditableFilterNode, { type: BlockType }>
export type EditableValueNode = Extract<EditableFilterNode, { type: 'value' }>
export type EditableFilterNodeOfType<T extends NodeType> = Extract<EditableFilterNode, { type: T }>

export function isEditableValueNode(node: EditableFilterNode): node is EditableValueNode {
	return VALUE_TYPES.includes(node.type as ValueType)
}

export function editableComparisonHasValue(comp: EditableComparison) {
	return (
		comp.code === 'is-true'
		|| comp.value !== undefined
		|| comp.values !== undefined
		|| (comp.range !== undefined
			&& !Obj.deepEqual(comp.range, [undefined, undefined]))
		|| comp.allMasks?.some((side) => side.length > 0)
	)
}

export const FilterEntityIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9-_]+$/, {
		message: '"Must contain only lowercase letters, numbers, hyphens, and underscores"',
	})
	.min(3)
	.max(64)
	.refine((id) => id !== '_id' && id !== 'new', {
		message: 'Disallow particular magic strings',
	})

export const FilterEntityDescriptionSchema = z.string().trim().min(3).max(2048)
export type FilterEntityId = z.infer<typeof FilterEntityIdSchema>

export const BaseFilterEntitySchema = z.object({
	id: FilterEntityIdSchema,
	name: z.string().trim().min(3).max(128),
	description: FilterEntityDescriptionSchema.nullable(),
	filter: FilterNodeSchema,
	owner: z.bigint(),
	emoji: z.string().nullable(),
})

export type ComparisonCode = (typeof COMPARISON_TYPES)[number]['code']
export const COMPARISON_CODES = z.enum(
	COMPARISON_TYPES.map((type) => type.code) as [
		ComparisonCode,
		...ComparisonCode[],
	],
)

export function filterContainsId(id: string, node: FilterNode): boolean {
	switch (node.type) {
		case 'and':
		case 'or':
			return node.children.some((n) => filterContainsId(id, n))
		case 'comp':
		case 'allow-matchups':
			return false
		case 'apply-filter':
			return node.filterId === id
		default:
			assertNever(node)
	}
}

export const FilterEntitySchema = BaseFilterEntitySchema
	// this refinement does not deal with mutual recustion
	.refine((e) => !filterContainsId(e.id, e.filter), {
		message: 'filter cannot be recursive',
	}) satisfies z.ZodType<SchemaModels.Filter>

export const UpdateFilterEntitySchema = BaseFilterEntitySchema.omit({
	id: true,
	owner: true,
})
export const NewFilterEntitySchema = BaseFilterEntitySchema.omit({
	owner: true,
})

export type FilterEntityUpdate = z.infer<typeof UpdateFilterEntitySchema>
export type FilterEntity = z.infer<typeof FilterEntitySchema>

export type InvalidFilterNodeResult = { code: 'err:invalid-node'; errors: NodeValidationError[] }
export type SQLConditionsResult = { code: 'ok'; condition: SQL } | InvalidFilterNodeResult

type ErrorBase = {
	path: string[]
	msg: string
}

export type NodeValidationError =
	| ErrorBase & { type: 'unmapped-column'; column: string }
	| ErrorBase & {
		type: 'unmapped-value'
		column: string
		value: LC.InputValue
	}
	| ErrorBase & {
		type: 'recursive-filter' | 'unknown-filter'
		filterId: string
	}

export type NodeValidationErrorStore = {
	errors?: NodeValidationError[]
	setErrors: (errors: NodeValidationError[]) => void
}

export function buildNodePath(parent: Sparse.NodePath, childIndex: number) {
	return parent.concat(childIndex)
}

export function tryDerefPath(root: EditableFilterNode, path: Sparse.NodePath) {
	let node = root
	for (const index of path) {
		if (!isEditableBlockNode(node)) return null
		node = node.children[index]
	}
	return node
}

function derefPath(root: EditableFilterNode, path: Sparse.NodePath) {
	const node = tryDerefPath(root, path)
	if (!node) {
		throw new Error('Invalid path ' + path + ' for node ' + JSON.stringify(root))
	}
	return node
}

export function* walkNodes(
	filter: EditableFilterNode,
	path: Sparse.NodePath = [],
): IterableIterator<[EditableFilterNode, Sparse.NodePath]> {
	yield [filter, path]
	if (isEditableBlockNode(filter)) {
		for (const [child, index] of filter.children.map((child, index) => [child, index] as const)) {
			yield* walkNodes(child, [...path, index])
		}
	}
}

export type FilterNodeTree = {
	nodes: Map<string, ShallowEditableFilterNode>
	paths: Map<string, Sparse.NodePath>
}

export function* iterChildIdsForPath(tree: FilterNodeTree, targetPath: Sparse.NodePath) {
	for (const [id, path] of tree.paths.entries()) {
		if (path.length === targetPath.length + 1 && Sparse.isChildPath(targetPath, path)) {
			yield id
		}
	}
}

export function nextChildIndex(tree: FilterNodeTree, parentPath: Sparse.NodePath) {
	let last = -1
	for (const id of iterChildIdsForPath(tree, parentPath)) {
		const path = tree.paths.get(id)
		if (!path) continue
		last = Math.max(last, path[path.length - 1])
	}
	return last + 1
}

function toShallowNode(node: EditableFilterNode): ShallowEditableFilterNode {
	if (isEditableBlockNode(node)) {
		const { children: _c, _id, ...shallowNode } = node as any
		return shallowNode
	}
	return node
}
function upsertTreeInPlaceFromSparse(
	sparseTree: SparseTree,
	basePath: Sparse.NodePath = [],
	tree?: Partial<FilterNodeTree>,
) {
	basePath ??= []
	tree ??= {
		nodes: new Map(),
		paths: new Map(),
	}
	tree.paths ??= new Map()

	const idsLeft = new Set<string>()

	// add/update nodes
	for (const [node, _path] of Sparse.walkNodes(sparseTree)) {
		const path = [...basePath, ..._path]
		tree.paths.set(node.id, path)
		idsLeft.add(node.id)
	}

	// delete nodes that are no longer in the tree
	for (const [id, path] of tree.paths.entries()) {
		if (idsLeft.has(id)) continue
		if (!Sparse.isOwnedPath(basePath, path)) continue
		tree.nodes?.delete(id)
		tree.paths.delete(id)
	}

	return tree
}

function upsertFilterNodeTreeInPlace(
	filter: EditableFilterNode,
	baseFilterPath?: Sparse.NodePath,
	tree?: FilterNodeTree,
): FilterNodeTree {
	baseFilterPath ??= []
	tree ??= {
		nodes: new Map(),
		paths: new Map(),
	}

	const idsLeft = new Set<string>()

	// add/update nodes
	for (const [node, _path] of walkNodes(filter)) {
		const path = [...baseFilterPath, ..._path]
		const id: string = (node as any)._id ?? createId(4)
		const shallowNode = toShallowNode(node)
		if (Obj.deepEqual(shallowNode, tree.nodes.get(id))) {
			continue
		}
		tree.nodes.set(id, shallowNode)
		tree.paths.set(id, path)
		idsLeft.add(id)
	}

	// delete nodes that are no longer in the tree
	for (const id of tree.paths.keys()) {
		if (idsLeft.has(id)) continue
		tree.nodes.delete(id)
		tree.paths.delete(id)
	}

	return tree
}

function resolveImmediateChildren(tree: FilterNodeTree, id: string): string[] {
	const targetPath = tree.paths.get(id)
	if (!targetPath) return []
	const children: string[] = []

	for (const [id, path] of tree.paths) {
		if (targetPath.length + 1 !== path.length) continue
		if (!Sparse.isChildPath(targetPath, path)) continue
		children[path[targetPath.length]] = id
	}

	return children
}
function treeToSparseTree(tree: Pick<FilterNodeTree, 'paths'>, subtreePath: Sparse.NodePath = []): Sparse.SparseNode {
	let root!: Sparse.SparseNode

	for (const [id, path] of toBreadthFirstTreePathEntries(tree.paths)) {
		if (!Sparse.isOwnedPath(subtreePath, path)) continue
		const sparseNode: Sparse.SparseNode = { id }

		if (!root) {
			root = sparseNode
			continue
		}

		const parent = Sparse.derefPath(root, path.slice(subtreePath.length, -1))!
		parent.children ??= []
		parent.children[path[path.length - 1]] = sparseNode
	}

	return root
}

export function treeToFilterNode(tree: FilterNodeTree, subtree: Sparse.NodePath = []): EditableFilterNode {
	let root!: EditableFilterNode

	for (const [id, path] of toBreadthFirstTreePathEntries(tree.paths)) {
		if (!Sparse.isOwnedPath(subtree, path)) continue
		const shallowNode = tree.nodes.get(id)!
		const node: EditableFilterNode = isEditableBlockNode(shallowNode)
			? { ...shallowNode, children: [] }
			: { ...shallowNode }
		if (!root) {
			root = node
			continue
		}
		;(derefPath(root, path.slice(0, -1)) as EditableBlockNode).children[path[path.length - 1]] = node
	}

	return root
}

// outputs entries sorted in primarily order of depth, and secondarily in order of index
export function toBreadthFirstTreePathEntries(paths: Map<string, Sparse.NodePath>): [string, Sparse.NodePath][] {
	const pathsArr = Array.from(paths.entries())
	pathsArr.sort(([_idA, pathA], [_idB, pathB]) => {
		if (pathA.length !== pathB.length) {
			return pathA.length - pathB.length
		}
		for (let i = 0; i < pathA.length; i++) {
			if (pathA[i] !== pathB[i]) {
				return pathA[i] - pathB[i]
			}
		}
		return 0
	})
	return pathsArr
}
type SparseTree = { id: string; children?: SparseTree[] }

export function moveTreeNodeInPlace(tree: Pick<FilterNodeTree, 'paths'>, sourcePath: Sparse.NodePath, targetPath: Sparse.NodePath) {
	if (Sparse.isChildPath(sourcePath, targetPath)) {
		return
	}
	const commonAncestor = Sparse.getCommonAncestorPath(sourcePath, targetPath)
	if (Obj.deepEqual(sourcePath, commonAncestor) || Obj.deepEqual(targetPath, commonAncestor)) {
		commonAncestor.pop()
	}
	let sparseTree = treeToSparseTree(tree, commonAncestor)
	sparseTree = Sparse.moveNode(sparseTree, sourcePath.slice(commonAncestor.length), targetPath.slice(commonAncestor.length))
	upsertTreeInPlaceFromSparse(sparseTree, commonAncestor, tree)
}

export function deleteTreeNode(tree: FilterNodeTree, targetId: string): void {
	const targetPath = tree.paths.get(targetId)!

	for (const [id, path] of tree.paths.entries()) {
		if (Sparse.isChildPath(targetPath, path)) {
			tree.paths.delete(id)
			tree.nodes.delete(id)
		}
	}

	tree.paths.delete(targetId)
	tree.nodes.delete(targetId)
}

export type FilterEditStore =
	& {
		tree: FilterNodeTree
		getIdForPath: (path: Sparse.NodePath) => string | undefined
		validatedFilter: FilterNode | null
		editedFilterId?: string
		isValid: boolean
		startingFilter: EditableFilterNode
		moveNode(sourcePath: Sparse.NodePath, targetPath: Sparse.NodePath): void
		updateRoot(filter: EditableFilterNode): void
		updateNode(id: string, cb: (draft: Im.Draft<ShallowEditableFilterNode>) => void): void
		deleteNode(id: string): void
		addChild(parentId: string, type: NodeType): void
		reset(filter?: EditableFilterNode): void
		modified: boolean
	}
	& NodeValidationErrorStore
	& NodeMap.NodeMapStore

type FilterEditStoreViewCommonActions = {
	delete(): void
	setNegation(negative: boolean): void
}

type ViewActionsOfType<T extends NodeType> = Extract<FilterEditStoreViewActions, { type: T }>
type FilterEditStoreViewActions =
	& FilterEditStoreViewCommonActions
	& (
		| {
			type: BlockType
			setBlockType: (type: BlockType) => void
			addChild: (type: NodeType) => void
		}
		| {
			type: 'comp'
			setComp: React.Dispatch<React.SetStateAction<EditableComparison>>
		}
		| {
			type: 'apply-filter'
			setFilterId: (filterId: FilterEntityId) => void
		}
		| {
			type: 'allow-matchups'
			setMasks: React.Dispatch<React.SetStateAction<FactionMask[][]>>
			setMode: React.Dispatch<React.SetStateAction<FactionMaskMode>>
		}
	)

export type FilterEditStoreView<T extends NodeType = NodeType> = ShallowEditableFilterNodeOfType<T> & ViewActionsOfType<T>

export function useEditableFilterNodeStore(startingFilter: EditableFilterNode) {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const [store, subHandle] = React.useMemo(() => createEditableFilterNodeStore(startingFilter), [])
	React.useEffect(() => {
		const subscription = subHandle.subscribe()
		return () => subscription.unsubscribe()
	}, [subHandle])
	React.useEffect(() => {
		const state = store.getState()
		if (state.startingFilter !== startingFilter) state.reset(startingFilter)
	}, [store, startingFilter])
	return store
}

function createEditableFilterNodeStore(startingFilter: EditableFilterNode, filterEntityId?: string) {
	const store = Zus.createStore<FilterEditStore>((set, get, store) => {
		const validatedFilter = isValidFilterNode(startingFilter) ? startingFilter : null

		return {
			startingFilter,
			validatedFilter,
			tree: upsertFilterNodeTreeInPlace(startingFilter),
			isValid: !!validatedFilter,
			getIdForPath(path) {
				return MapUtils.revLookup(get().tree.paths, path, Sparse.serializeNodePath)
			},
			moveNode(sourcePath, targetPath) {
				set(state => {
					const tree = Obj.deepClone(state.tree)
					moveTreeNodeInPlace(tree, sourcePath, targetPath)
					return ({ tree })
				})
			},
			updateRoot(filter) {
				set({ tree: upsertFilterNodeTreeInPlace(filter) })
			},
			updateNode(id, update) {
				set({
					tree: Im.produce(get().tree, draft => {
						update(draft.nodes.get(id)!)
					}),
				})
			},
			deleteNode(id) {
				set({
					tree: Im.produce(get().tree, draft => {
						deleteTreeNode(draft, id)
					}),
				})
			},
			addChild(parentId, type) {
				set({
					tree: Im.produce(get().tree, draft => {
						const node: ShallowEditableFilterNode = toShallowNode(EFB.nodeOfType(type))
						const id = createId(4)
						const parentPath = draft.paths.get(parentId)!
						let last: number = -1
						for (const path of draft.paths.values()) {
							if (!Sparse.isChildPath(parentPath, path)) continue
							last = Math.max(last, path[parentPath.length])
						}

						const newPath = [...parentPath, last + 1]
						draft.paths.set(id, newPath)
						draft.nodes.set(id, node)
					}),
				})
			},
			reset(filter?: EditableFilterNode) {
				filter ??= this.startingFilter
				set({
					startingFilter: filter,
					tree: upsertFilterNodeTreeInPlace(filter),
				})
			},

			// these are for errors returned from server-side validation from running queries
			errors: [],
			setErrors(errors) {
				set({ errors })
			},
			editedFilterId: filterEntityId,
			modified: false,

			...NodeMap.initNodeMap(store),
		} satisfies FilterEditStore
	})
	const subHandle: { subscribe: () => { unsubscribe: () => void } } = {
		subscribe: () => {
			const unsubscribe = store.subscribe((state, prev) => {
				if (state.tree !== prev.tree) {
					const filter = treeToFilterNode(state.tree)
					const validatedFilter = isValidFilterNode(filter) ? filter : null
					store.setState({
						validatedFilter,
						isValid: !!validatedFilter,
						modified: !Obj.deepEqual(state.startingFilter, filter),
					})
				}

				if (state.startingFilter !== prev.startingFilter) {
					store.setState({
						modified: !Obj.deepEqual(state.startingFilter, prev.startingFilter),
						tree: upsertFilterNodeTreeInPlace(state.startingFilter, []),
					})
				}
			})
			return { unsubscribe }
		},
	}
	return [store, subHandle] as const
}

export function useNodePath(id: string | undefined, rootStore: Zus.StoreApi<FilterEditStore>) {
	return Zus.useStore(rootStore, useShallow((s) => id ? s.tree.paths.get(id) : undefined))
}

export function useImmediateChildren(id: string, store: Zus.StoreApi<FilterEditStore>) {
	return Zus.useStore(store, useShallow(s => resolveImmediateChildren(s.tree, id)))
}

export function useEditStoreView(id: string, rootStore: Zus.StoreApi<FilterEditStore>) {
	const [store, subHandle] = React.useMemo(() => deriveEditStoreView(id, rootStore), [id, rootStore])
	React.useEffect(() => {
		const sub = subHandle.subscribe()
		return () => sub.unsubscribe()
	}, [subHandle])
	return Zus.useStore(store)
}

export function deriveEditStoreView(id: string, rootStore: Zus.StoreApi<FilterEditStore>) {
	const updateNode: UpdateNodeFn = (cb) => rootStore.getState().updateNode(id, (draft) => cb(draft))
	const deleteNode = () => rootStore.getState().deleteNode(id)
	const addChild = (type: NodeType) => {
		rootStore.getState().addChild(id, type)
	}

	const viewStore = Zus.createStore<FilterEditStoreView>(() => {
		const node = rootStore.getState().tree.nodes.get(id)!
		const actions = getViewActions(node.type, updateNode, deleteNode, addChild)
		return { ...node, ...actions } as FilterEditStoreView
	})

	const subscription: { subscribe: () => { unsubscribe: () => void } } = {
		subscribe: () => {
			const unsubscribe = rootStore.subscribe(
				(rootState, prevRootState) => {
					const node = rootState.tree.nodes.get(id)
					const prevNode = prevRootState.tree.nodes.get(id)
					if (!node || !prevNode) return
					if (node == prevNode) return
					if (node.type !== prevNode.type) {
						viewStore.setState({
							...getViewActions(node.type, updateNode, deleteNode, addChild),
						})
					}

					viewStore.setState({ ...node })
				},
			)
			return { unsubscribe }
		},
	}
	return [viewStore, subscription] as const
}

type UpdateNodeFn = (cb: (draft: Im.Draft<ShallowEditableFilterNode>) => void) => void
function getViewActions<T extends NodeType>(
	type: T,
	updateNode: UpdateNodeFn,
	deleteNode: () => void,
	addChild: (type: NodeType) => void,
): FilterEditStoreViewActions {
	const common: FilterEditStoreViewCommonActions = {
		delete() {
			deleteNode()
		},
		setNegation(neg: boolean) {
			updateNode(draft => {
				draft.neg = neg
			})
		},
	}
	let actions: FilterEditStoreViewActions

	if (isBlockType(type)) {
		actions = {
			...common,
			type,
			setBlockType(type) {
				updateNode(draft => {
					draft.type = type
				})
			},
			addChild,
		}
	}

	if (type === 'comp') {
		actions = {
			...common,
			type,
			setComp(update) {
				updateNode(draft => {
					if (draft.type !== 'comp') return
					draft.comp = typeof update === 'function' ? update(draft.comp) : update
				})
			},
		}
	}

	if (type === 'apply-filter') {
		actions = {
			...common,
			type,
			setFilterId(id) {
				updateNode(draft => {
					if (draft.type !== 'apply-filter') return
					draft.filterId = id
				})
			},
		}
	}

	if (type === 'allow-matchups') {
		actions = {
			...common,
			type,
			setMasks(update) {
				updateNode(draft => {
					if (draft.type !== 'allow-matchups') return
					draft.allowMatchups.allMasks = typeof update === 'function' ? update(draft.allowMatchups.allMasks) : update
				})
			},
			setMode(update) {
				updateNode(draft => {
					if (draft.type !== 'allow-matchups') return
					draft.allowMatchups.mode = typeof update === 'function' ? update(draft.allowMatchups.mode ?? 'either') : update
				})
			},
		}
	}

	return actions!
}

export function areFilterNodesLocallyEqual(a: EditableFilterNode, b: EditableFilterNode): boolean {
	if (isEditableBlockNode(a) && isEditableBlockNode(b)) {
		return a.children.length === b.children.length
	}
	if (a.type === 'comp' && b.type === 'comp') return a.comp === b.comp
	if (a.type === 'apply-filter' && b.type === 'apply-filter') return a.filterId === b.filterId
	if (a.type === 'allow-matchups' && b.type === 'allow-matchups') {
		return a.allowMatchups.allMasks === b.allowMatchups.allMasks && a.allowMatchups.mode === b.allowMatchups.mode
	}
	return false
}
