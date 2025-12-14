import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import { z } from 'zod'
import type { StrKeys } from './types'

/**
 * Type-level utilities from fp-ts patterns
 */

// Tagged union base - similar to fp-ts ADT pattern
type Tagged<Tag extends string, T = Record<string, never>> = T & { readonly _tag: Tag }

type NodeOptions = Record<string, unknown>

export type NodeOptionsSchema<T extends NodeOptions = NodeOptions> = z.ZodType<T> | { [k in keyof T]: z.ZodType<T[k]> }
export type InferredOptions<T extends NodeOptionsSchema | undefined> = T extends NodeOptionsSchema<infer O> ? O
	: T extends undefined ? object
	: never

// Utility type to allow {} in place of undefined for optional options
type _OptionalOpts<T> = T extends undefined ? object | undefined : T

/**
 * Definition Node Types
 */
export namespace Def {
	export type Children = { [key: string]: Node }

	// Type that maps a node array to an object with node IDs as keys but allows flexible access
	export type NodesArrayToObject<T extends { [key: number]: Node }> = {
		[K in T[number]['id']]: Extract<T[number], { id: K }>
	}

	export type Variant<T extends { [key: string]: Node } = Children> = Tagged<
		'variant',
		{ id: string; child: T; opts: NodeOptionsSchema | undefined }
	>

	export type Branch<T extends { [key: string]: Node } = Children> = Tagged<
		'branch',
		{ id: string; child: T; opts: NodeOptionsSchema | undefined }
	>

	export type Leaf = Tagged<'leaf', { id: string; opts: NodeOptionsSchema | undefined }>

	export type Node = Variant | Branch | Leaf

	export function variant<ID extends string, T extends { [key: number]: Def.Node }>(
		id: ID,
		children: T,
	): Tagged<'variant', { id: ID; child: NodesArrayToObject<T>; opts: undefined }>
	export function variant<ID extends string, T extends { [key: string]: Def.Node }>(
		id: ID,
		children: T,
	): Tagged<'variant', { id: ID; child: T; opts: undefined }>
	export function variant<ID extends string, T extends { [key: number]: Def.Node }>(
		id: ID,
		opts: NodeOptionsSchema,
		children: T,
	): Tagged<'variant', { id: ID; child: NodesArrayToObject<T>; opts: NodeOptionsSchema }>
	export function variant<ID extends string, T extends { [key: string]: Def.Node }>(
		id: ID,
		opts: NodeOptionsSchema,
		children: T,
	): Tagged<'variant', { id: ID; child: T; opts: NodeOptionsSchema }>
	export function variant(
		id: string,
		optsOrChildren: NodeOptionsSchema | { [key: number]: Def.Node } | { [key: string]: Def.Node },
		maybeChildren?: readonly Def.Node[] | { [key: string]: Def.Node },
	) {
		if (maybeChildren !== undefined) {
			const node = {
				_tag: 'variant' as const,
				id,
				child: toChildrenObject(maybeChildren),
				opts: optsOrChildren as NodeOptionsSchema,
			}
			validateUniqueIds(node)
			return node
		}

		const node = {
			_tag: 'variant' as const,
			id,
			child: toChildrenObject(optsOrChildren as { [key: number]: Def.Node } | { [key: string]: Def.Node }),
			opts: undefined,
		}
		validateUniqueIds(node)
		return node satisfies Variant
	}

	export function branch<ID extends string, T extends { [key: number]: Def.Node }>(
		id: ID,
		children: T,
	): Tagged<'branch', {
		id: ID
		child: NodesArrayToObject<T>
		opts: undefined
	}>
	export function branch<ID extends string, Opts extends NodeOptionsSchema, T extends { [key: number]: Def.Node }>(
		id: ID,
		opts: Opts,
		children: T,
	): Tagged<'branch', {
		id: ID
		child: NodesArrayToObject<T>
		opts: Opts
	}>
	export function branch<ID extends string, T extends { [key: string]: Def.Node }>(
		id: ID,
		children: T,
	): Tagged<'branch', {
		id: ID
		child: T
		opts: undefined
	}>
	export function branch<ID extends string, Opts extends NodeOptionsSchema, T extends { [key: string]: Def.Node }>(
		id: ID,
		opts: Opts,
		children: T,
	): Tagged<'branch', {
		id: ID
		child: T
		opts: Opts
	}>
	export function branch<ID extends string>(
		id: ID,
		optsOrChildren: NodeOptionsSchema | readonly Def.Node[] | { [key: string]: Def.Node },
		maybeChildren?: readonly Def.Node[] | { [key: string]: Def.Node },
	) {
		if (maybeChildren !== undefined) {
			const node = {
				_tag: 'branch' as const,
				id,
				child: toChildrenObject(maybeChildren),
				opts: optsOrChildren as NodeOptionsSchema,
			}
			validateUniqueIds(node)
			return node
		}

		const node = {
			_tag: 'branch' as const,
			id,
			child: toChildrenObject(optsOrChildren as readonly Def.Node[] | { [key: string]: Def.Node }),
			opts: undefined,
		}
		validateUniqueIds(node)
		return node
	}

	function validateUniqueIds(node: Def.Node, visitedIds = new Set<string>()): void {
		// Check if this node's ID is unique
		if (visitedIds.has(node.id)) {
			throw new Error(`Duplicate node ID found: "${node.id}"`)
		}
		visitedIds.add(node.id)

		// Recursively validate children
		if (node._tag === 'branch') {
			for (const child of Object.values(node.child)) {
				validateUniqueIds(child, visitedIds)
			}
		} else if (node._tag === 'variant') {
			for (const variant of Object.values(node.child)) {
				validateUniqueIds(variant, visitedIds)
			}
		}
		// Leaf nodes have no children to validate
	}

	function toChildrenObject<T extends readonly Def.Node[] | { [key: string]: Def.Node }>(
		input: T,
	): T extends readonly Def.Node[] ? NodesArrayToObject<T> : T {
		if (Array.isArray(input)) {
			const obj: any = {}
			for (const node of input) {
				obj[node.id] = node
			}
			return obj
		}
		return input as any
	}

	export function leaf<ID extends string>(id: ID): {
		_tag: 'leaf'
		id: ID
		opts: undefined
	}
	export function leaf<ID extends string, Opts extends NodeOptionsSchema>(id: ID, opts: Opts): {
		_tag: 'leaf'
		id: ID
		opts: Opts
	}
	export function leaf<ID extends string, Opts extends NodeOptionsSchema>(id: ID, opts?: Opts): Def.Leaf {
		return {
			_tag: 'leaf' as const,
			id,
			opts,
		}
	}

	export type NodeIds<N extends Def.Node> = N extends Def.Variant ? N['id'] | NodeIds<N['child'][keyof N['child']]>
		: N extends Def.Branch ? N['id'] | NodeIds<N['child'][keyof N['child']]>
		: N extends Def.Leaf ? N['id']
		: never

	/**
	 * Type guards (refinements)
	 */

	export function isVariant(node: Def.Node): node is Def.Variant {
		return node._tag === 'variant'
	}

	export function isBranch(node: Def.Node): node is Def.Branch {
		return node._tag === 'branch'
	}

	export function isLeaf(node: Def.Node): node is Def.Leaf {
		return node._tag === 'leaf'
	}

	/**
	 * Getters
	 */

	export function getChild<N extends Def.Branch, K extends StrKeys<N['child']>>(node: N, key: K) {
		return node.child[key] as N['child'][K]
	}

	export function getVariant<N extends Def.Variant, K extends StrKeys<N['child']>>(node: N, key: K) {
		return node.child[key] as N['child'][K]
	}

	export function getOpts<T extends Def.Node>(node: T): T['opts'] {
		return node.opts
	}
}

/**
 * Match Node Types (Active/Matched Nodes)
 */
export namespace Match {
	export type Variant<V extends Def.Variant = Def.Variant, K extends StrKeys<V['child']> = StrKeys<V['child']>> = Tagged<
		'variant',
		{
			id: V['id']
			opts: InferredOptions<V['opts']>
			chosen: Node<V['child'][K]>
		}
	>

	export type Branch<
		B extends Def.Branch = Def.Branch,
	> = Tagged<
		'branch',
		{
			id: B['id']
			opts: InferredOptions<B['opts']>
			child: { [k in StrKeys<B['child']>]?: Match.Node<B['child'][k]> }
		}
	>

	export type Leaf<
		L extends Def.Leaf = Def.Leaf,
	> = Tagged<'leaf', {
		id: L['id']
		opts: InferredOptions<L['opts']>
	}>

	export type Node<N extends Def.Node = Def.Node> = N extends Def.Variant
		? { [k in StrKeys<N['child']>]: Variant<N, k> }[StrKeys<N['child']>]
		: N extends Def.Branch ? Branch<N>
		: N extends Def.Leaf ? Leaf<N>
		: never

	export type AccumulatedOpts<MN extends Node> =
		& MN['opts']
		& (
			MN extends Variant ? AccumulatedOpts<MN['chosen']>
				: MN extends Branch ? {
						[k in StrKeys<MN['child']>]: MN['child'][k] extends Node ? AccumulatedOpts<MN['child'][k]> : never
					}[StrKeys<MN['child']>]
				: MN extends { _tag: 'leaf' } ? object
				: never
		)

	export type Parent = Variant | Branch

	/**
	 * Constructors
	 */

	export function branch<
		Id extends string,
		Opts extends NodeOptions | undefined | object,
		Child extends { [key: string]: Match.Node },
	>(
		id: Id,
		opts: Opts,
		child: Child,
	): {
		_tag: 'branch'
		id: Id
		opts: Opts
		child: Child
	} {
		return {
			_tag: 'branch' as const,
			id: id,
			opts: opts,
			child: child,
		}
	}

	export function variant<
		Id extends string,
		Opts extends NodeOptions | undefined,
		Child extends Match.Node,
	>(
		id: Id,
		opts: Opts,
		child: Child,
	) {
		return {
			_tag: 'variant' as const,
			id,
			opts: opts ?? {},
			chosen: child,
		} satisfies Match.Variant
	}

	export function leaf<Id extends string, Opts extends NodeOptions | undefined>(
		id: Id,
		opts: Opts,
	): {
		_tag: 'leaf'
		id: Id
		opts: Opts
	} {
		return {
			_tag: 'leaf' as const,
			id,
			opts: opts,
		}
	}

	/**
	 * Fold (pattern matching)
	 */

	export function fold<R>(
		patterns: {
			variant: <V extends Def.Variant>(v: Match.Variant<V>) => R
			branch: <B extends Def.Branch>(b: Match.Branch<B>) => R
			leaf: (l: Match.Leaf) => R
		},
		node: Match.Node,
	): R {
		switch (node._tag) {
			case 'variant':
				return patterns.variant(node as any)
			case 'branch':
				return patterns.branch(node as any)
			case 'leaf':
				return patterns.leaf(node as any)
			default:
				assertNever(node)
		}
	}

	/**
	 * Type guards (refinements) for Match nodes
	 */

	export function isVariant<N extends Match.Node>(node: N): node is N & Match.Variant {
		return node._tag === 'variant'
	}

	export function isBranch<N extends Match.Node>(node: N): node is Extract<N, Tagged<'branch'>> {
		return node._tag === 'branch'
	}

	export function isLeaf<N extends Match.Node>(node: N): node is N & Match.Leaf {
		return node._tag === 'leaf'
	}

	/**
	 * Utility functions for state checking
	 */

	export function isChosen<V extends Match.Variant, C extends V['chosen']['id']>(
		choice: C,
		variant: V,
	): variant is V & { child: { id: C } } {
		return variant.chosen.id === choice
	}

	export function hasChild<B extends Match.Branch, K extends string>(childId: K, branch: B): boolean {
		return childId in branch.child && branch.child[childId] !== undefined
	}

	export function getChosenVariant<V extends Match.Variant>(variant: V): V['chosen'] {
		return variant.chosen
	}

	export function getVariantChoice<V extends Match.Variant>(variant: V): V['chosen']['id'] {
		return variant.chosen.id
	}

	export function foldVariant<V extends Match.Variant, R>(
		handlers: Record<V['chosen']['id'], (child: V['chosen'], opts: V['opts']) => R>,
		variant: V,
	): R {
		const handler = handlers[variant.chosen.id as keyof typeof handlers]
		return handler(variant.chosen, variant.opts)
	}

	/**
	 * Additional utility functions for common operations
	 */

	export function mapVariant<V extends Match.Variant, R>(
		mapper: (child: V['chosen'], opts: V['opts'], chosen: V['chosen']['id']) => R,
		variant: V,
	): R {
		return mapper(variant.chosen, variant.opts, variant.chosen.id)
	}

	export function mapBranch<B extends Match.Branch, R>(
		mapper: (children: B['child'], opts: B['opts']) => R,
		branch: B,
	): R {
		return mapper(branch.child, branch.opts)
	}

	export function mapLeaf<L extends Match.Leaf, R>(
		mapper: (opts: L['opts']) => R,
		leaf: L,
	): R {
		return mapper(leaf.opts)
	}

	export function hasNonEmptyOpts<N extends Match.Node>(node: N): boolean {
		return node.opts !== undefined && Object.keys(node.opts).length > 0
	}

	export function getNodePath<N extends Match.Node>(node: N): string {
		if (isVariant(node)) {
			return node.chosen.id
		}
		if (isBranch(node)) {
			return Object.keys(node.child).join('/')
		}
		return (node as Match.Leaf).id
	}

	export function isActive(state: Match.Node, predicate: Match.Node): boolean {
		// Check if both nodes have the same tag type
		if (state.id !== predicate.id) return false
		if (state._tag !== predicate._tag) {
			return false
		}

		if (!Obj.deepEqual(state.opts, predicate.opts)) {
			return false
		}

		// Handle different node types with explicit casting
		if (state._tag === 'variant' && predicate._tag === 'variant') {
			// For variants, check that chosen variant matches and child is active
			if (state.chosen.id !== predicate.chosen.id) {
				return false
			}
			return isActive(state.chosen, predicate.chosen)
		}

		if (state._tag === 'branch' && predicate._tag === 'branch') {
			for (const [childId, predicateChild] of Object.entries(predicate.child)) {
				if (!predicateChild) continue
				const stateChild = state.child[childId]
				if (!stateChild || !isActive(stateChild, predicateChild)) {
					return false
				}
			}
			return true
		}

		if (state._tag === 'leaf' && predicate._tag === 'leaf') {
			return true
		}

		return false
	}
}

export const startWith = <N extends Def.Node, MN extends Match.Node<N>>(_node: N, matchNode: MN): MN => {
	return matchNode
}

/**
 * Additional Def utility functions
 */

export namespace DefUtils {
	export function hasOpts<N extends Def.Node>(node: N): node is N & { opts: NonNullable<N['opts']> } {
		return node.opts !== undefined
	}

	export function* iterNodes(node: Def.Node): Generator<Def.Node> {
		yield node
		if (node._tag === 'branch') {
			for (const child of Object.values(node.child)) {
				yield* iterNodes(child)
			}
		} else if (node._tag === 'variant') {
			for (const child of Object.values(node.child)) {
				yield* iterNodes(child)
			}
		}
	}

	/**
	//  * Retrieves a node with the given ID from the tree recursively.
	//  * Type-safe: when the ID is a literal type that exists in the tree,
	//  * TypeScript will enforce that the ID is valid.
	//  */
	// export function getNodeById<Root extends Def.Node, ID extends string>(
	// 	root: Root,
	// 	id: ID extends Def.NodeIds<Root> ? ID : string,
	// ): ID extends Def.NodeIds<Root> ? Def.Node & { id: ID } : Def.Node

	// /**
	//  * Retrieves a node with the given ID from the tree recursively.
	//  * Generic overload for when you want to cast to a specific node type.
	//  */
	// export function getNodeById<T extends Def.Node>(
	// 	root: Def.Node,
	// 	id: string,
	// ): T

	// Implementation
	export function getNodeById(
		root: Def.Node,
		id: string,
	): Def.Node {
		const result = searchNode(root)
		if (result === null) {
			throw new Error(`Node with id "${id}" not found`)
		}
		return result

		function searchNode(node: Def.Node): Def.Node | null {
			if (node.id === id) {
				return node
			}

			if (node._tag === 'branch') {
				for (const child of Object.values(node.child)) {
					const result = searchNode(child)
					if (result !== null) {
						return result
					}
				}
			} else if (node._tag === 'variant') {
				for (const child of Object.values(node.child)) {
					const result = searchNode(child)
					if (result !== null) {
						return result
					}
				}
			}

			return null
		}
	}
}

/**
 * Additional Match utility functions
 */
export namespace MatchUtils {
	export function isFullyBuilt<B extends Match.Branch>(branch: B): boolean {
		// Check if all possible children from the definition are present
		// This would need the original definition to compare against
		return Object.keys(branch.child).length > 0
	}

	export function getChildCount<B extends Match.Branch>(branch: B): number {
		return Object.values(branch.child).filter(child => child !== undefined).length
	}

	export function hasAnyChildren<B extends Match.Branch>(branch: B): boolean {
		return MatchUtils.getChildCount(branch) > 0
	}

	export function mapBranchChildren<B extends Match.Branch, R>(
		branch: B,
		mapper: (child: Match.Node, id: string) => R,
	): Record<string, R> {
		const result: Record<string, R> = {}
		for (const [id, child] of Object.entries(branch.child)) {
			if (child) {
				result[id] = mapper(child as Match.Node, id)
			}
		}
		return result
	}

	/**
	 * Creates a Zod schema for a Match.Node type given a Def.Node definition
	 */
	export function createMatchSchema<N extends Def.Node>(defNode: N): z.ZodType<Match.Node<N>> {
		// Handle options schema if present
		const optsSchema = defNode.opts
			? (typeof defNode.opts === 'object' && 'parse' in defNode.opts
				? defNode.opts as z.ZodType
				: z.record(z.string(), z.any()))
			: z.any()

		switch (defNode._tag) {
			case 'variant': {
				// Create schemas for each variant child
				const variantChildSchemas: Record<string, z.ZodType<any>> = {}
				for (const [childId, childDef] of Object.entries(defNode.child)) {
					variantChildSchemas[childId] = createMatchSchema(childDef)
				}

				const childKeys = Object.keys(defNode.child)

				// Create union options for each variant
				const variantOptions = childKeys.map(childId =>
					z.object({
						id: z.literal(defNode.id),
						_tag: z.literal('variant' as const),
						opts: optsSchema,
						chosen: variantChildSchemas[childId],
					})
				)

				// Use regular union since child schemas should be different enough to discriminate
				if (childKeys.length === 1) {
					return variantOptions[0] as unknown as z.ZodType<Match.Node<N>>
				}

				return z.union(variantOptions as any) as unknown as z.ZodType<Match.Node<N>>
			}

			case 'branch': {
				// Create schemas for each branch child
				const branchChildSchemas: Record<string, z.ZodType<any>> = {}
				for (const [childId, childDef] of Object.entries(defNode.child)) {
					branchChildSchemas[childId] = createMatchSchema(childDef)
				}

				// Create a proper object schema with typed optional properties for each child
				const childObjectSchema = z.object(
					Object.fromEntries(
						Object.entries(branchChildSchemas).map(([childId, schema]) => [
							childId,
							schema.optional(),
						]),
					),
				)

				return z.object({
					id: z.string(),
					_tag: z.literal('branch'),
					opts: optsSchema,
					child: childObjectSchema,
				}) as unknown as z.ZodType<Match.Node<N>>
			}

			case 'leaf': {
				return z.object({
					id: z.literal(defNode.id),
					_tag: z.literal('leaf'),
					opts: optsSchema,
				}) as unknown as z.ZodType<Match.Node<N>>
			}

			default: {
				throw new Error(`Unknown node type: ${(defNode as any)._tag}`)
			}
		}
	}
}
