import { createId } from '@/lib/id'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as LL from '@/models/layer-list.models'
import * as UP from '@/models/user-presence'
import type * as UPActions from '@/models/user-presence/actions'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import { z } from 'zod'
import * as L from './layer'

function buildItemOpSchemaEntries<T extends { [key: string]: z.ZodType }>(base: T) {
	return [
		z.object({
			...base,
			op: z.literal('move'),
			cursor: LL.CursorSchema,
			newFirstItemId: LL.ItemIdSchema,
		}),
		z.object({
			...base,
			op: z.literal('swap-factions'),
		}),
		z.object({
			...base,
			op: z.literal('edit-layer'),
			newLayerId: L.LayerIdSchema,
		}),
		z.object({
			...base,
			// create a vote from an existing item
			op: z.literal('create-vote'),
			newFirstItemId: LL.ItemIdSchema,
			otherLayers: z.array(LL.SingleItemSchema),
		}),
		z.object({
			...base,
			op: z.literal('configure-vote'),

			// null means use defaults(remove), undefined means don't modify
			config: V.AdvancedVoteConfigSchema.nullable(),
		}),
		z.object({
			...base,
			op: z.literal('delete'),
		}),
	] as const
}

function buildOperationSchema<T extends { [key: string]: z.ZodType }, ItemSchema extends z.ZodType>(base: T, itemSchema: ItemSchema) {
	return z.discriminatedUnion('op', [
		z.object({
			...base,
			op: z.literal('add'),
			items: z.array(itemSchema),
			index: LL.ItemIndexSchema,
		}),
		...buildItemOpSchemaEntries({ ...base, itemId: LL.ItemIdSchema }),
		z.object({
			...base,
			op: z.literal('clear'),
			itemIds: z.array(LL.ItemIdSchema),
		}),
		z.object({
			...base,
			// uses "source" to determine what user started editing
			op: z.literal('start-editing'),
		}),
		z.object({
			...base,
			// uses "source" to determine what user finished editing
			op: z.literal('finish-editing'),
			forceSave: z.boolean().optional(),
		}),
	])
}

export const OperationSchema = buildOperationSchema({ opId: z.string(), userId: USR.UserIdSchema }, LL.ItemSchema)
export type Operation = z.infer<typeof OperationSchema>
export type OpCode = Operation['op']

export const NewOperationSchema = buildOperationSchema({}, LL.NewItemSchema)
export type NewOperation = z.infer<typeof NewOperationSchema>

export function isOperation(obj: Operation | NewOperation): obj is Operation {
	if ('userId' in obj) {
		return true
	}
	return false
}

export const ItemOperationSchema = z.discriminatedUnion(
	'op',
	buildItemOpSchemaEntries({ opId: z.string(), userId: USR.UserIdSchema, itemId: LL.ItemIdSchema }),
)
export type ItemOperation = z.infer<typeof ItemOperationSchema>
export const NewItemOperationSchema = z.discriminatedUnion('op', buildItemOpSchemaEntries({ itemId: LL.ItemIdSchema }))
export type NewItemOperation = z.infer<typeof NewItemOperationSchema>

export const NewContextItemOperationSchema = z.discriminatedUnion('op', buildItemOpSchemaEntries({}))
export type NewContextItemOperation = z.infer<typeof NewContextItemOperationSchema>

// operations which are almost always non-associative, so for now we just always assume a conflict. this could be improved
export const UNSTABLE_OPS = ['delete', 'clear', 'add', 'move'] as const satisfies OpCode[]

export function isUnstableOp(op: Operation): op is ItemOperation {
	return (UNSTABLE_OPS as string[]).includes(op.op)
}

export function isOpForItem(op: Operation): op is ItemOperation {
	return (ItemOperationSchema.options.map(op => op.shape.op.value as string)).includes(op.op)
}

export function updatesLayer(op: Operation) {
	if (!isOpForItem(op)) return false
	return op.op === 'edit-layer' || op.op === 'swap-factions'
}

function itemsRelated(list: LL.List, itemIdA: LL.ItemId, itemIdB: LL.ItemId) {
	if (itemIdA === itemIdB) return true
	const itemA = LL.findItemById(list, itemIdA)?.item
	const itemB = LL.findItemById(list, itemIdB)?.item
	if (!itemA || !itemB) return false
	const parentItemA = LL.findParentItem(list, itemIdA)
	const parentItemB = LL.findParentItem(list, itemIdB)
	if (parentItemA && itemIdB === parentItemA.itemId) return true
	if (parentItemB && itemIdA === parentItemB.itemId) return true
	if (parentItemA && parentItemA.itemId === parentItemB?.itemId) return true
	return false
}

// check if newOp is associative with respect to other new operations (anything at or past the "expected" index)
// expectedIndex represents where the source client expects to insert their operation, assuming no other clients
// have made modifications. Any operations at or after this index are potential conflicts we need to check.
//
// TODO we can reduce the cases where we have to rollback here substantially if we're smart about it
export function containsConflict(session: EditSession, expectedIndex: number, newOp: Operation) {
	// peer operations are operations that have happened since the last sync for the source client for newOp
	const peerOps = session.ops.slice(expectedIndex)
	const peerPushedUnstable = !!peerOps.find(isUnstableOp)
	if (peerPushedUnstable && isUnstableOp(newOp)) return true

	if (isOpForItem(newOp)) {
		const peerOpsForItem = peerOps.filter(op => isOpForItem(op) && itemsRelated(session.list, op.itemId, newOp.itemId))
		if (peerOpsForItem.length === 0) return false
		for (const peerOp of peerOpsForItem) {
			if (peerOp.op === newOp.op) return true
			if (updatesLayer(peerOp) && updatesLayer(newOp)) return true
		}
	}

	return false
}

export type EditSession = {
	list: LL.List
	editors: Set<USR.UserId>
	ops: Operation[]

	// TODO I would like to move away from this approach of calculating mutations when operations are applied
	mutations: ItemMut.Mutations
}

export type Update =
	| {
		code: 'init'
		session: EditSession
		sessionSeqId: SessionSequenceId
	}
	| {
		code: 'commit-started'
	}
	| {
		code: 'commit-completed'
		list: LL.List
		committer: USR.User
		sessionSeqId: SessionSequenceId
		newSessionSeqId: SessionSequenceId
		initiator: string
	}
	| { code: 'commit-rejected'; reason: string; msg: string; sessionSeqId: SessionSequenceId; committer: USR.User }
	| {
		code: 'reset-completed'
		list: LL.List
		sessionSeqId: SessionSequenceId
		newSessionSeqId: SessionSequenceId
		// username
		initiator: string
	}
	| {
		code: 'list-updated'
		list: LL.List
		sessionSeqId: SessionSequenceId
		newSessionSeqId: SessionSequenceId
	}
	| {
		code: 'locks-modified'
		mutations: [LL.ItemId, string | null][]
	}
	| ClientUpdate
	| {
		// sent through SLL stream when presence actions trigger SLL side effects (editing ops)
		code: 'update-presence'
		wsClientId: string
		userId: bigint
		changes: Partial<Omit<UP.ClientPresence, 'userId'>>
		fromServer?: boolean
		sideEffectOps: Operation[]
	}

export type Rollback = {
	// the index of the first replacement
	toIndex: number

	replacements: Operation[]
}

// the sequence id of the base queue the session
const QueueSequenceId = z.number()
export type SessionSequenceId = z.infer<typeof QueueSequenceId>

export const ClientUpdateSchema = z.discriminatedUnion('code', [
	z.object({
		code: z.literal('op'),
		sessionSeqId: QueueSequenceId,
		expectedIndex: z.number(),
		op: OperationSchema,
	}),
	z.object({
		code: z.literal('commit'),
		sessionSeqId: QueueSequenceId,
	}),
	z.object({
		code: z.literal('reset'),
		sessionSeqId: QueueSequenceId,
	}),
])

export type ClientUpdate = z.infer<typeof ClientUpdateSchema>

export type ItemLocks = Map<LL.ItemId, string>
export type LockMutation = [LL.ItemId, string]

export function tryAcquireAllLocks(locks: ItemLocks, itemIds: LL.ItemId[], wsClientId: string): boolean {
	for (const itemId of itemIds) {
		const existingLock = locks.get(itemId)
		if (existingLock && wsClientId !== existingLock) return false
	}
	for (const itemId of itemIds) {
		locks.set(itemId, wsClientId)
	}
	return true
}

export function anyLocksInaccessible(locks: ItemLocks, ids: LL.ItemId[], wsClientId: string): boolean {
	for (const id of ids) {
		const existingLock = locks.get(id)
		if (existingLock && existingLock !== wsClientId) return true
	}
	return false
}

export function endAllEditing(state: UP.PresenceState, session: EditSession) {
	for (const presence of state.values()) {
		if (presence.activityState?.child.EDITING) {
			UP.updateClientPresence(presence, { activityState: null })
		}
	}
	session.editors.clear()
}

export function getOpsForActivityStateUpdate(
	session: EditSession,
	state: UP.PresenceState,
	wsClientId: string,
	userId: bigint,
	output: UPActions.ActionOutput,
) {
	let ops: Operation[] = []

	// this isn't super necessary given the way the frontend locks out users  but it's here for completeness
	startEditing: {
		if (session.editors.has(userId) || !output.activityState?.child.EDITING) break startEditing
		let firstEditor = true
		for (const [clientId, presence] of state.entries()) {
			if (wsClientId === clientId) continue
			if (presence.activityState?.child.EDITING) {
				firstEditor = false
				break
			}
		}

		if (firstEditor) {
			ops.push(
				{
					op: 'start-editing',
					opId: createId(5),
					userId,
				} satisfies Operation,
			)
		}
	}

	finishEditing: {
		if (!session.editors.has(userId) || output.activityState?.child.EDITING) break finishEditing
		let lastEditor = true
		for (const [clientId, presence] of state.entries()) {
			if (wsClientId === clientId) continue
			if (presence.activityState?.child.EDITING) {
				lastEditor = false
				break
			}
		}

		if (lastEditor) {
			ops.push(
				{
					op: 'finish-editing',
					opId: createId(6),
					userId,
				} satisfies Operation,
			)
		}
	}

	return ops
}

export function applyOperation(session: EditSession, newOp: Operation | NewOperation, mutations?: ItemMut.Mutations) {
	const list = session.list
	const source: LL.Source = isOperation(newOp) ? { type: 'manual', userId: newOp.userId } : { type: 'unknown' }
	switch (newOp.op) {
		case 'add': {
			let items: LL.Item[]
			if (isOperation(newOp)) {
				items = newOp.items
			} else {
				items = newOp.items.map(item => LL.createItem(item, source))
			}
			LL.addItemsDeterministic(list, source, newOp.index, ...items)
			ItemMut.tryApplyMutation('added', items.map(item => item.itemId), mutations)
			if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
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

		case 'create-vote': {
			LL.createVoteOutOfItem(list, source, newOp.itemId, newOp.newFirstItemId, newOp.otherLayers)
			const { item } = Obj.destrNullable(LL.findItemById(list, newOp.itemId))
			if (item && LL.isVoteItem(item)) {
				ItemMut.tryApplyMutation('added', item.choices.map(choice => choice.itemId), mutations)
				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}
			break
		}

		case 'start-editing': {
			if (source.type === 'unknown') break
			session.editors.add(source.userId)
			break
		}

		case 'finish-editing': {
			if (source.type === 'unknown') break
			session.editors.delete(source.userId)
			break
		}

		default:
			assertNever(newOp)
	}
}

export function applyOperations(s: EditSession, ops: Operation[]) {
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]
		applyOperation(s, op, s.mutations)
	}
	// catch any invalid operations early, hopefully on the client
	LL.ListSchema.parse(s.list)
	s.ops.push(...ops)
}

export function createNewSession(list?: LL.List): EditSession {
	return {
		list: list ?? [],
		editors: new Set(),
		ops: [],
		mutations: ItemMut.initMutations(),
	}
}

export function hasMutations(session: EditSession, userId?: USR.UserId) {
	for (const op of session.ops) {
		if (op.op === 'start-editing' || op.op === 'finish-editing') {
			continue
		}
		if (!userId || userId === op.userId) return true
	}
	return false
}
