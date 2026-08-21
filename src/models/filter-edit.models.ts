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
	}),
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
	return { filterId: entity.id, draft: Obj.deepClone(saved), saved }
}

// A tree built from a bare filter node gets fresh ids from createId, so it can only be built where one
// replica decides for all of them: session setup on the server, or the originating client of a
// replace-tree op. Never inside the reducer.
export function toTree(filter: F.EditableFilterNode): F.FilterNodeTree {
	return F.upsertFilterNodeTreeInPlace(filter)
}

export function isModified(state: State): boolean {
	return !Obj.deepEqual(state.draft, state.saved)
}

export function draftFilter(state: State): F.EditableFilterNode {
	return F.treeToFilterNode(state.draft.tree)
}

export const reducer: ODSM.Reducer<Op, State, SideEffect> = (oldState, ops, _prevOps) => {
	const state = Obj.deepClone(oldState)
	const sideEffects: SideEffect[] = []
	const emit = (se: SideEffect) => sideEffects.push(se)
	for (const op of ops) {
		const success = applyOp(state, op, emit)
		emit({ code: 'op-outcome', op, success })
		// ops in a batch are dependent, so one skipped op rejects the whole batch rather than applying part of it
		if (!success) throw new ODSM.RejectedError<Rejection>({ code: 'op-skipped', op }, { message: `filter-edit op ${op.code} skipped` })
	}
	if (Obj.deepEqual(state, oldState)) throw new ODSM.RejectedError<Rejection>({ code: 'noop' })
	return [state, sideEffects]
}

// returns whether the op applied (as opposed to being skipped against this base state)
function applyOp(state: State, op: Op, emit: ODSM.OnSideEffect<SideEffect>): boolean {
	const tree = state.draft.tree
	switch (op.code) {
		case 'add-node': {
			const parentPath = tree.paths.get(op.parentId)
			if (!parentPath || tree.nodes.has(op.nodeId)) return false
			tree.nodes.set(op.nodeId, op.node)
			tree.paths.set(op.nodeId, [...parentPath, nextChildIndex(tree, parentPath)])
			return true
		}
		case 'delete-node': {
			if (!tree.paths.has(op.nodeId)) return false
			// the root has no parent to be removed from
			if (tree.paths.get(op.nodeId)!.length === 0) return false
			F.deleteTreeNode(tree, op.nodeId)
			return true
		}
		case 'update-node': {
			if (!tree.nodes.has(op.nodeId)) return false
			tree.nodes.set(op.nodeId, op.node)
			return true
		}
		case 'set-comment': {
			const node = tree.nodes.get(op.nodeId)
			if (!node) return false
			if (op.comment) node.comment = op.comment
			else delete node.comment
			return true
		}
		case 'move-node': {
			const sourcePath = tree.paths.get(op.nodeId)
			const parentPath = tree.paths.get(op.parentId)
			if (!sourcePath || !parentPath) return false
			F.moveTreeNodeInPlace(tree, sourcePath, [...parentPath, op.index])
			return true
		}
		case 'replace-tree': {
			state.draft.tree = op.tree
			return true
		}
		case 'set-meta': {
			state.draft.meta = { ...state.draft.meta, ...Obj.trimUndefined(op.patch) }
			return true
		}
		case 'save': {
			if (!isModified(state)) return false
			const filter = draftFilter(state)
			// a half-filled tree is a normal state to be editing in but not one to persist. Checked here rather
			// than at the dispatcher so every replica agrees on which saves are refused.
			if (!F.isValidFilterNode(filter)) return false
			state.saved = Obj.deepClone(state.draft)
			emit({ code: 'request-filter-save', opId: op.opId, filterId: state.filterId, meta: state.saved.meta, filter, userId: op.userId })
			return true
		}
		case 'reset-to-saved': {
			if (!isModified(state)) return false
			state.draft = Obj.deepClone(state.saved)
			return true
		}
		case 'discard-abandoned-edits': {
			if (!isModified(state)) return false
			state.draft = Obj.deepClone(state.saved)
			return true
		}
		default:
			assertNever(op)
	}
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
