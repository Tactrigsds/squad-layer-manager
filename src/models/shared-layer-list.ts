import { createId } from '@/lib/id'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import { assertNever } from '@/lib/type-guards'

import * as LL from '@/models/layer-list.models'

import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'

import { z } from 'zod'
import * as L from './layer'

const opPropsBase = { opId: z.string() }
const opPropsClient = { userId: USR.UserIdSchema }
const opPropsEditWindow = { editWindowSeqId: z.number() }

// when present ensures that this op is only applied during the edit window it was intended for
function getItemOpEntries<
	Props extends { [key: string]: z.ZodType },
>(
	props: Props,
) {
	return [
		z.object({
			...props,
			op: z.literal('move'),
			cursor: LL.CursorSchema,
			newFirstItemId: LL.ItemIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('swap-factions'),
		}),
		z.object({
			...props,
			op: z.literal('edit-layer'),
			newLayerId: L.LayerIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('clone'),
			itemId: LL.ItemIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('configure-vote'),

			// null means use defaults(remove), undefined means don't modify
			config: V.AdvancedVoteConfigSchema.nullable(),
		}),
		z.object({
			...props,
			op: z.literal('delete'),
		}),
	] as const
}

const ItemOperationSchema = z.discriminatedUnion(
	'op',
	getItemOpEntries({ ...opPropsBase, ...opPropsClient, ...opPropsEditWindow, itemId: LL.ItemIdSchema }),
)
export type ItemOperation = z.infer<typeof ItemOperationSchema>

export const NewContextItemOperationSchema = z.discriminatedUnion('op', getItemOpEntries({}))
export type NewContextItemOperation = z.infer<typeof NewContextItemOperationSchema>

function buildOperationSchema<
	Item extends z.ZodType,
	BaseProps extends { [key: string]: z.ZodType },
	ClientProps extends { [key: string]: z.ZodType },
	EditWindowProps extends { [key: string]: z.ZodType },
>(
	itemSchema: Item,
	baseProps: BaseProps,
	clientProps: ClientProps,
	editWindowProps: EditWindowProps,
) {
	return z.discriminatedUnion('op', [
		z.object({
			...baseProps,
			op: z.literal('init'),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('add'),
			items: z.array(itemSchema),
			index: LL.ItemIndexSchema,
		}),
		z.object({
			...opPropsBase,
			op: z.literal('shift-first-saved-layer'),
		}),
		z.object({
			...baseProps,
			// server-only op, used to insert first layer into the savedItems if it's changed on the server
			op: z.literal('unshift-first-saved-layer'),
			layerId: L.LayerIdSchema,
			itemSource: LL.SourceSchema,
			itemId: LL.ItemIdSchema,
		}),
		z.object({
			...baseProps,
			op: z.literal('set-vote-result'),
			voteItemId: LL.ItemIdSchema,
			result: V.EndingVoteStateSchema.nullable(),
		}),
		z.object({
			...baseProps,
			op: z.literal('queue-item-generated'),
			item: itemSchema,
		}),
		...getItemOpEntries({ ...baseProps, ...clientProps, ...editWindowProps, itemId: LL.ItemIdSchema }),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('clear'),
			itemIds: z.array(LL.ItemIdSchema),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			// uses "source" to determine what user finished editing
			op: z.literal('save'),
		}),
		z.object({
			...baseProps,
			op: z.literal('save-completed'),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('reset-to-saved'),
		}),
	])
}

const CLIENT_OPCODE = z.enum([
	'add',
	'move',
	'swap-factions',
	'edit-layer',
	'clone',
	'configure-vote',
	'delete',
	'clear',
	'save',
	'reset-to-saved',
])
type ClientOpcode = z.infer<typeof CLIENT_OPCODE>

export const OperationSchema = buildOperationSchema(LL.ItemSchema, opPropsBase, opPropsClient, opPropsEditWindow)
export type Operation = z.infer<typeof OperationSchema>
export type OpCode = Operation['op']

export const NewOperationSchema = buildOperationSchema(LL.NewItemSchema, {}, {}, {})
export type NewOperation = z.infer<typeof NewOperationSchema>
export type NewClientOperation = Extract<NewOperation, { op: ClientOpcode }>

export function isOpForItem(op: Operation): op is ItemOperation {
	return (ItemOperationSchema.options.map(op => op.shape.op.value as string)).includes(op.op)
}

export type State = {
	list: LL.List
	// incremented whenever we save or reset the list. used to throw away latent operations that were intended for a previous edit window
	editWindowSeqId: number
	savedList: LL.List
	saving: boolean
	mutations: ItemMut.Mutations
	requestingGeneratedQueueItem: boolean
}

// the typed payload carried by a RejectedError thrown from the reducer, for the dispatcher to surface
// or log. an op is skipped when it is stale (edit window changed, pending generation); the schema
// variants indicate the op would have produced structurally invalid state
export type Rejection =
	| { code: 'op-skipped'; op: Operation }
	| { code: 'invalid-list'; error: z.ZodError }
	| { code: 'invalid-saved-list'; error: z.ZodError }

export type SideEffect =
	| {
		// saved list has changed, and needs to be written to the database and/or published to the squad server
		code: 'request-list-save'
		list: LL.List
	}
	| {
		// requests that a queue item be generated before the list is saved. happens when the saved list would be empty
		code: 'request-queue-item-generation'
	}
	| {
		// success is false when the op was skipped (stale edit window, pending generation)
		code: 'op-outcome'
		op: Operation
		success: boolean
	}
	| {
		// no more sideEffects for this reducer call
		code: 'complete'
	}

export type Update =
	| {
		code: 'init'
		state: State
		ops: Operation[]
	}
	| {
		code: 'op'
		op: Operation
	}
	| {
		// the client's own op was accepted -- ops are deterministic, so the originator only needs the
		// id back and replays its pending copy locally instead of receiving the full op again
		code: 'ack'
		opId: string
	}

// the sequence id of the base queue the session
const QueueSequenceId = z.number()
export type SessionSequenceId = z.infer<typeof QueueSequenceId>

export function createOpId(): string {
	return createId(16)
}

export const reducer: ODSM.Reducer<Operation, State, SideEffect> = (oldState, ops, _prevOps) => {
	const state = Obj.deepClone(oldState)
	const sideEffects: SideEffect[] = []
	const emit = (se: SideEffect) => sideEffects.push(se)
	// ops in a batch are dependent, so a single skipped op rejects the whole batch (RejectedError)
	// rather than applying a partial result
	for (const op of ops) {
		const success = applyOperation(state, op, emit)
		emit({ code: 'op-outcome', op, success })
		if (!success) throw new ODSM.RejectedError<Rejection>({ code: 'op-skipped', op }, { message: `operation ${op.op} skipped` })
	}
	const result = LL.ListSchema.safeParse(state.list)
	if (!result.success) {
		throw new ODSM.RejectedError<Rejection>({ code: 'invalid-list', error: result.error }, {
			message: 'list failed schema validation',
			cause: result.error,
		})
	}
	const savedResult = LL.ListSchema.safeParse(state.savedList)
	if (!savedResult.success) {
		throw new ODSM.RejectedError<Rejection>({ code: 'invalid-saved-list', error: savedResult.error }, {
			message: 'savedList failed schema validation',
			cause: savedResult.error,
		})
	}
	emit({ code: 'complete' })
	return [state, sideEffects]
}

// returns whether the op was applied (as opposed to skipped)
export function applyOperation(session: State, newOp: Operation, onSideEffect?: ODSM.OnSideEffect<SideEffect>): boolean {
	const opWindowSeqId = (newOp as { editWindowSeqId?: number })?.editWindowSeqId
	if (opWindowSeqId && opWindowSeqId !== session.editWindowSeqId) {
		return false
	}
	if (newOp.op === 'queue-item-generated') {
		saveList(session, [newOp.item], onSideEffect)
		session.requestingGeneratedQueueItem = false
		return true
	}
	if (session.requestingGeneratedQueueItem) {
		return false
	}
	let source: LL.Source
	{
		const userId = (newOp as { userId?: USR.UserId })?.userId
		if (userId) {
			source = { type: 'manual', userId }
		} else {
			source = { type: 'unknown' }
		}
	}
	// don't write to mutations if we're applying changes to the saved list, just throw them away instead
	const mutations = session.mutations
	const list = session.list

	switch (newOp.op) {
		case 'init': {
			if (session.savedList.length === 0) {
				session.requestingGeneratedQueueItem = true
				onSideEffect?.({ code: 'request-queue-item-generation' })
				return true
			}
			break
		}

		case 'shift-first-saved-layer': {
			LL.splice(session.savedList, { outerIndex: 0, innerIndex: null }, 1)
			saveList(session, session.savedList, onSideEffect)
			break
		}

		case 'unshift-first-saved-layer': {
			LL.addItemsDeterministic(session.savedList, newOp.itemSource, { outerIndex: 0, innerIndex: null }, {
				type: 'single-list-item',
				itemId: newOp.itemId,
				layerId: newOp.layerId,
				source: newOp.itemSource,
			})
			saveList(session, session.savedList, onSideEffect)
			break
		}

		case 'set-vote-result': {
			const { item: voteItem } = Obj.destrNullable(LL.findItemById(session.savedList, newOp.voteItemId))
			if (!voteItem || !LL.isParentVoteItem(voteItem)) return false
			LL.setEndingVoteStateInPlace(voteItem, newOp.result)
			saveList(session, session.savedList, onSideEffect)
			break
		}

		case 'add': {
			const items = newOp.items
			LL.addItemsDeterministic(list, source, newOp.index, ...items)
			ItemMut.tryApplyMutation('added', items.map(item => item.itemId), mutations)
			if (source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			break
		}

		case 'move': {
			const { merged, modified } = LL.moveItem(list, source, newOp.itemId, newOp.newFirstItemId, newOp.cursor)
			if (modified) {
				if (merged) {
					const { item } = Obj.destrNullable(LL.findItemById(list, merged))
					if (item) {
						if (!LL.isVoteItem(item)) throw new Error('Expected parent vote item')
						ItemMut.tryApplyMutation('edited', [item.itemId], mutations)
						ItemMut.tryApplyMutation('added', [item.choices[0].itemId], mutations)
						ItemMut.tryApplyMutation('moved', item.choices.slice(1).map(choice => choice.itemId), mutations)
					}
				} else {
					ItemMut.tryApplyMutation('moved', [newOp.itemId], mutations)
				}

				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}
			break
		}

		case 'swap-factions': {
			const { index, item } = Obj.destrNullable(LL.findItemById(list, newOp.itemId))
			if (!index || !item) break
			const originalLayerId = item.layerId
			const swapped = LL.swapFactionsInPlace(list, item.itemId, source)
			if (!swapped) break

			// maybe mirror matchups will be a thing at some point who knows
			if (L.layersEqual(item.layerId, originalLayerId)) break
			LL.splice(list, index, 1, item)
			ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			break
		}

		case 'edit-layer': {
			const beforeEdit = LL.findItemById(list, newOp.itemId)?.item.layerId
			LL.editLayer(list, source, newOp.itemId, newOp.newLayerId)
			const afterEdit = LL.findItemById(list, newOp.itemId)?.item.layerId
			if (beforeEdit && afterEdit && beforeEdit !== afterEdit) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}
			break
		}

		case 'clone': {
			const { item } = Obj.destrNullable(LL.cloneAndInsertItem(list, newOp.itemId, source))
			if (item) {
				ItemMut.tryApplyMutation('added', [item.itemId], mutations)
				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}
			break
		}

		case 'configure-vote': {
			LL.configureVote(list, source, newOp.itemId, newOp.config)
			const itemRes = LL.findItemById(list, newOp.itemId)
			if (itemRes) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'delete': {
			const { index } = Obj.destrNullable(LL.findItemById(list, newOp.itemId))
			if (index) {
				LL.deleteItem(list, newOp.itemId)
				ItemMut.tryApplyMutation('removed', [newOp.itemId], mutations)
				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}

			break
		}
		case 'clear':
			for (const itemId of newOp.itemIds) {
				const { index } = Obj.destrNullable(LL.findItemById(list, itemId))
				if (index) {
					LL.deleteItem(list, itemId)
					ItemMut.tryApplyMutation('removed', [itemId], mutations)
				}
			}
			break

		case 'save': {
			saveList(session, session.list, onSideEffect)
			break
		}

		case 'save-completed': {
			session.saving = false
			break
		}

		case 'reset-to-saved': {
			session.list = Obj.deepClone(session.savedList)
			session.mutations = ItemMut.initMutations()
			session.editWindowSeqId++
			break
		}

		default:
			assertNever(newOp)
	}

	return true
}

function saveList(session: State, list: LL.List, onSideEffect: ODSM.OnSideEffect<SideEffect> | undefined) {
	session.saving = true
	if (list.length === 0) {
		session.requestingGeneratedQueueItem = true
		onSideEffect?.({ code: 'request-queue-item-generation' })
		return
	}
	session.list = list === session.list && list !== session.savedList ? list : Obj.deepClone(list)
	session.savedList = list === session.savedList && list !== session.list ? list : Obj.deepClone(list)
	session.mutations = ItemMut.initMutations()
	session.editWindowSeqId++
	onSideEffect?.({ code: 'request-list-save', list: session.savedList })
}

export function mergeMutations(base: ItemMut.Mutations, additions: ItemMut.Mutations): ItemMut.Mutations {
	const result: ItemMut.Mutations = {
		added: new Set(base.added),
		removed: new Set(base.removed),
		moved: new Set(base.moved),
		edited: new Set(base.edited),
	}
	for (const id of additions.added) ItemMut.tryApplyMutation('added', id, result)
	for (const id of additions.removed) ItemMut.tryApplyMutation('removed', id, result)
	for (const id of additions.moved) ItemMut.tryApplyMutation('moved', id, result)
	for (const id of additions.edited) ItemMut.tryApplyMutation('edited', id, result)
	return result
}

export function createNewState(list?: LL.List): State {
	return {
		list: list ? Obj.deepClone(list) : [],
		editWindowSeqId: 0,
		saving: false,
		mutations: ItemMut.initMutations(),
		savedList: list ? Obj.deepClone(list) : [],
		requestingGeneratedQueueItem: false,
	}
}

export function hasMutations(session: State): boolean {
	return ItemMut.hasMutations(session.mutations)
}

export function hasUserMutations(ops: Operation[], state: State, userId: USR.UserId): boolean {
	const windowSeqId = state.editWindowSeqId
	for (let i = ops.length - 1; i >= 0; i--) {
		const op = ops[i]
		if (op.op === 'save') continue
		const currWindowSeqId = (op as { windowSeqId?: number })?.windowSeqId
		if (currWindowSeqId === undefined) continue
		if (windowSeqId !== currWindowSeqId) break
		const opUserId = (op as { userId?: USR.UserId })?.userId
		if (opUserId && opUserId === userId) return true
	}
	return false
}
