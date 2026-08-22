// The shared draft of one filter entity: an ODSM state machine each editing client replays locally and
// the server holds authoritatively. Draft-and-save, like the layer queue -- ops build the draft, `save`
// persists it, and a draft nobody is left editing is discarded rather than committed.
import type { MutexInterface } from 'async-mutex'
import { z } from 'zod'

import * as CD from '@/lib/ctx-def'
import { createId } from '@/lib/id'
import type { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import * as Sparse from '@/lib/sparse-tree'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as USR from '@/models/users.models'

export function createOpId(): string {
	return createId(16)
}

export function createNodeId(): string {
	return createId(4)
}

// the entity fields the details form edits, i.e. everything persisted about a filter except its id, its
// owner and the tree itself
export const MetaSchema = F.UpdateFilterEntitySchema.omit({ filter: true })
export type Meta = z.infer<typeof MetaSchema>

export type Draft = { meta: Meta; tree: F.FilterNodeTree }

export type State = {
	filterId: F.FilterEntityId
	draft: Draft
	// the last state written to the db. `save` copies draft over it, `reset-to-saved` copies it back
	saved: Draft
}

const baseProps = { opId: z.string() }
const clientProps = { ...baseProps, userId: USR.UserIdSchema }

export const OpSchema = z.discriminatedUnion('code', [
	z.object({
		...clientProps,
		code: z.literal('add-node'),
		parentId: z.string(),
		nodeId: z.string(),
		node: F.ShallowEditableFilterNodeSchema,
		// omitted means append, which is what the block header's own add button does
		index: z.number().int().min(0).optional(),
	}),
	// carries the copy rather than making one, for the same reason replace-tree carries a tree: the copy
	// needs a fresh id per node, and a reducer minting them would give every replica a different subtree
	z.object({ ...clientProps, code: z.literal('clone-node'), nodeId: z.string(), subtree: F.FilterNodeTreeSchema }),
	z.object({ ...clientProps, code: z.literal('delete-node'), nodeId: z.string() }),
	// the whole shallow node, not a patch: an operator change rewrites a comparison's arguments wholesale
	z.object({ ...clientProps, code: z.literal('update-node'), nodeId: z.string(), node: F.ShallowEditableFilterNodeSchema }),
	z.object({ ...clientProps, code: z.literal('set-comment'), nodeId: z.string(), comment: F.NodeCommentSchema.nullable() }),
	z.object({ ...clientProps, code: z.literal('move-node'), nodeId: z.string(), parentId: z.string(), index: z.number().int().min(0) }),
	// carries a tree rather than a filter node because node ids are minted by the originating client:
	// upsertFilterNodeTreeInPlace would mint different ids on every replica (see the note on determinism below)
	z.object({ ...clientProps, code: z.literal('replace-tree'), tree: F.FilterNodeTreeSchema }),
	z.object({ ...clientProps, code: z.literal('set-meta'), patch: MetaSchema.partial() }),
	z.object({ ...clientProps, code: z.literal('save') }),
	z.object({ ...clientProps, code: z.literal('reset-to-saved') }),
	// server-only: the last client editing this filter went away without saving, so nobody is left to
	// commit the draft and it is dropped
	z.object({ ...baseProps, code: z.literal('discard-abandoned-edits') }),
])

export type Op = z.infer<typeof OpSchema>
export type OpCode = Op['code']
export type NewClientOp = DistributiveOmitOpFields<Extract<Op, { userId: USR.UserId }>>
type DistributiveOmitOpFields<T> = T extends unknown ? Omit<T, 'opId' | 'userId'> : never

export const CLIENT_OP_CODE = z.enum([
	'add-node',
	'clone-node',
	'delete-node',
	'update-node',
	'set-comment',
	'move-node',
	'replace-tree',
	'set-meta',
	'save',
	'reset-to-saved',
])

export type Rejection = { code: 'op-skipped'; op: Op } | { code: 'noop' }

export type SideEffect =
	| { code: 'op-outcome'; op: Op; success: boolean }
	// the draft was saved: the dispatcher persists it and ends everyone's editing session
	| { code: 'request-filter-save'; opId: string; filterId: F.FilterEntityId; meta: Meta; filter: F.EditableFilterNode; userId: USR.UserId }

export type Update = ODSM.ClientUpdate<State, Op, Rejection['code']>

export function initState(entity: F.FilterEntity): State {
	const saved: Draft = {
		meta: {
			name: entity.name,
			description: entity.description,
			alertMessage: entity.alertMessage,
			emoji: entity.emoji,
			invertedAlertMessage: entity.invertedAlertMessage,
			invertedEmoji: entity.invertedEmoji,
		},
		tree: F.upsertFilterNodeTreeInPlace(entity.filter),
	}
	return { filterId: entity.id, draft: saved, saved }
}

// A filter that has no entity behind it yet (the "new filter" page) runs the same reducer against the same
// shape; its session simply never leaves the client that owns it.
export function localState(filterId: F.FilterEntityId, filter: F.EditableFilterNode, meta?: Partial<Meta>): State {
	const saved: Draft = {
		meta: { name: '', description: null, alertMessage: null, emoji: null, invertedAlertMessage: null, invertedEmoji: null, ...meta },
		tree: toTree(filter),
	}
	return { filterId, draft: saved, saved }
}

// A tree built from a bare filter node gets fresh ids from createId, so it can only be built where one
// replica decides for all of them: session setup on the server, or the originating client of a
// replace-tree op. Never inside the reducer.
export function toTree(filter: F.EditableFilterNode): F.FilterNodeTree {
	return F.upsertFilterNodeTreeInPlace(filter)
}

export function isModified(state: State): boolean {
	// a draft that has never diverged is the saved object itself, which is the common case by far
	if (state.draft === state.saved) return false
	return !Obj.deepEqual(state.draft, state.saved)
}

export function draftFilter(state: State): F.EditableFilterNode {
	return F.treeToFilterNode(state.draft.tree)
}

export const reducer: ODSM.Reducer<Op, State, SideEffect> = (oldState, ops, _prevOps) => {
	let state = oldState
	const sideEffects: SideEffect[] = []
	const emit = (se: SideEffect) => sideEffects.push(se)
	for (const op of ops) {
		const next = applyOp(state, op, emit)
		emit({ code: 'op-outcome', op, success: next !== null })
		// ops in a batch are dependent, so one skipped op rejects the whole batch rather than applying part of it
		if (next === null) {
			throw new ODSM.RejectedError<Rejection>({ code: 'op-skipped', op }, { message: `filter-edit op ${op.code} skipped` })
		}
		state = next
	}
	// an op that changed nothing hands back the state it was given, so this is a reference check rather than a
	// walk of the whole draft
	if (state === oldState) throw new ODSM.RejectedError<Rejection>({ code: 'noop' })
	return [state, sideEffects]
}

// Copy-on-write, and the reducer replays against several base states (optimistic, synced, authoritative) that
// share structure with each other -- so nothing reachable from `state` may be mutated. Each op rebuilds only
// what lies between the state root and what it changed: an edit to one node leaves every other node, the
// paths, and the whole saved baseline shared with the state before it.
//
// Returns null when the op is skipped against this base state.
function applyOp(state: State, op: Op, emit: ODSM.OnSideEffect<SideEffect>): State | null {
	const tree = state.draft.tree
	switch (op.code) {
		case 'add-node': {
			const parentPath = tree.paths.get(op.parentId)
			if (!parentPath || tree.nodes.has(op.nodeId)) return null
			if (op.index === undefined) {
				// appending moves no sibling, so the new path is the only one that changes
				const nodes = new Map(tree.nodes).set(op.nodeId, op.node)
				const paths = new Map(tree.paths).set(op.nodeId, [...parentPath, nextChildIndex(tree, parentPath)])
				return withTree(state, { nodes, paths })
			}
			const next = { nodes: new Map(tree.nodes), paths: new Map(tree.paths) }
			const inserted: F.FilterNodeTree = { nodes: new Map([[op.nodeId, op.node]]), paths: new Map([[op.nodeId, []]]) }
			F.insertTreeSubtreeInPlace(next, parentPath, op.index, inserted)
			return withTree(state, next)
		}
		case 'clone-node': {
			const sourcePath = tree.paths.get(op.nodeId)
			// the root has no parent for the copy to sit beside
			if (!sourcePath || sourcePath.length === 0) return null
			if (!isGraftableSubtree(op.subtree)) return null
			for (const id of op.subtree.nodes.keys()) {
				if (tree.nodes.has(id)) return null
			}
			const next = { nodes: new Map(tree.nodes), paths: new Map(tree.paths) }
			F.insertTreeSubtreeInPlace(next, sourcePath.slice(0, -1), sourcePath[sourcePath.length - 1] + 1, op.subtree)
			return withTree(state, next)
		}
		case 'delete-node': {
			const path = tree.paths.get(op.nodeId)
			// the root has no parent to be removed from
			if (!path || path.length === 0) return null
			// deleteTreeNode rewrites the maps in place, so it gets copies to work on. The node objects they
			// hold are untouched either way, and stay shared.
			const next = { nodes: new Map(tree.nodes), paths: new Map(tree.paths) }
			F.deleteTreeNode(next, op.nodeId)
			return withTree(state, next)
		}
		case 'update-node': {
			const existing = tree.nodes.get(op.nodeId)
			if (!existing) return null
			if (Obj.deepEqual(existing, op.node)) return state
			// only the nodes map moves; every path is still where it was
			return withTree(state, { nodes: new Map(tree.nodes).set(op.nodeId, op.node), paths: tree.paths })
		}
		case 'set-comment': {
			const existing = tree.nodes.get(op.nodeId)
			if (!existing) return null
			if ((existing.comment ?? null) === op.comment) return state
			const node = { ...existing }
			if (op.comment) node.comment = op.comment
			else delete node.comment
			return withTree(state, { nodes: new Map(tree.nodes).set(op.nodeId, node), paths: tree.paths })
		}
		case 'move-node': {
			const sourcePath = tree.paths.get(op.nodeId)
			const parentPath = tree.paths.get(op.parentId)
			if (!sourcePath || !parentPath) return null
			const next = { nodes: new Map(tree.nodes), paths: new Map(tree.paths) }
			F.moveTreeNodeInPlace(next, sourcePath, [...parentPath, op.index])
			return withTree(state, next)
		}
		case 'replace-tree':
			return withTree(state, op.tree)
		case 'set-meta': {
			const meta = { ...state.draft.meta, ...Obj.trimUndefined(op.patch) }
			if (Obj.deepEqual(meta, state.draft.meta)) return state
			// the tree is untouched, so the draft keeps pointing at the same one
			return { ...state, draft: { ...state.draft, meta } }
		}
		case 'save': {
			if (!isModified(state)) return null
			const filter = draftFilter(state)
			// a half-filled tree is a normal state to be editing in but not one to persist. Checked here rather
			// than at the dispatcher so every replica agrees on which saves are refused.
			if (!F.isValidFilterNode(filter)) return null
			emit({ code: 'request-filter-save', opId: op.opId, filterId: state.filterId, meta: state.draft.meta, filter, userId: op.userId })
			// the baseline becomes the draft itself rather than a copy of it -- neither is ever mutated
			return { ...state, saved: state.draft }
		}
		case 'reset-to-saved':
		case 'discard-abandoned-edits': {
			if (!isModified(state)) return null
			return { ...state, draft: state.saved }
		}
		default:
			assertNever(op)
	}
}

// a subtree can only be grafted in if it has exactly one root and a node behind every path, which the
// schema alone does not guarantee
function isGraftableSubtree(subtree: F.FilterNodeTree): boolean {
	if (subtree.nodes.size !== subtree.paths.size) return false
	let roots = 0
	for (const [id, path] of subtree.paths) {
		if (!subtree.nodes.has(id)) return false
		if (path.length === 0) roots++
	}
	return roots === 1
}

function withTree(state: State, tree: F.FilterNodeTree): State {
	return { ...state, draft: { ...state.draft, tree } }
}

// the index a new child of `parentPath` takes. Descendants deeper than a direct child share their
// ancestor's index at this position, so scanning every path is still correct.
function nextChildIndex(tree: F.FilterNodeTree, parentPath: Sparse.NodePath): number {
	let last = -1
	for (const path of tree.paths.values()) {
		if (!Sparse.isChildPath(parentPath, path)) continue
		last = Math.max(last, path[parentPath.length])
	}
	return last + 1
}

export type Ctx = CS.Ctx & { filterEdit: Ctx.Payload }
export const CtxDef = CD.defCtx<Ctx>()(['filterEdit'], { name: 'filterEdit' })

export namespace Ctx {
	export type Payload = {
		filterId: F.FilterEntityId
		session: ODSM.Server.Session<Op, State>
		op$: IsolatedSubject<ODSM.Server.Dispatched<Op, Rejection>>
		dispatchMtx: MutexInterface
	}
}
