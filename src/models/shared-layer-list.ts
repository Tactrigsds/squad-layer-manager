import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as LL from '@/models/layer-list.models'
import * as SS from '@/models/server-state.models'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import { z } from 'zod'
import * as L from './layer'

const OperationShared = {
	opId: z.string(),
	userId: USR.UserIdSchema,
}

export const OperationSchema = z.discriminatedUnion('op', [
	z.object({
		...OperationShared,
		op: z.literal('add'),
		items: z.array(LL.NewLayerListItemSchema),
		index: LL.LayerListItemIndex,
	}),
	z.object({
		...OperationShared,
		op: z.literal('move'),
		itemId: LL.ItemIdSchema,
		indexOrCursor: z.union([LL.LayerListItemIndex, LL.ItemRelativeCursorSchema]),
	}),
	z.object({
		...OperationShared,
		op: z.literal('swap-factions'),
		itemId: LL.ItemIdSchema,
	}),
	z.object({
		...OperationShared,
		op: z.literal('edit-layer'),
		itemId: LL.ItemIdSchema,
		newLayerId: L.LayerIdSchema,
	}),
	z.object({
		...OperationShared,
		op: z.literal('configure-vote'),
		itemId: LL.ItemIdSchema,
		// null means use defaults
		voteConfig: V.AdvancedVoteConfigSchema.partial().nullable(),
	}),
	z.object({
		...OperationShared,
		op: z.literal('delete'),
		itemId: LL.ItemIdSchema,
	}),
	z.object({
		...OperationShared,
		op: z.literal('clear'),
	}),
])

export type Operation = z.infer<typeof OperationSchema>
export type OpCode = Operation['op']

// operations which are almost always non-associative, so for now we just always assume a conflict. this could be improved
export const UNSTABLE_OPS = ['delete', 'clear', 'add', 'move'] as const satisfies OpCode[]

export function isUnstableOp(op: Operation): op is Extract<Operation, { op: typeof UNSTABLE_OPS[number] }> {
	return (UNSTABLE_OPS as string[]).includes(op.op)
}

export const FOR_ITEM = ['edit-layer', 'configure-vote', 'move', 'delete', 'swap-factions'] as const satisfies OpCode[]
type OpForItem = Extract<Operation, { op: typeof FOR_ITEM[number] }>
function isOpForItem(op: Operation): op is OpForItem {
	return (FOR_ITEM as string[]).includes(op.op)
}

// operations that are idempotent with respect to the entire list
export const IDEMPOTENT_OPS = ['clear'] as const satisfies OpCode[]
function isResetOp(op: Operation): op is Extract<Operation, { op: typeof IDEMPOTENT_OPS[number] }> {
	return (IDEMPOTENT_OPS as string[]).includes(op.op)
}

function updatesLayer(op: Operation) {
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

export function getOperationMutationType(op: OpCode): ItemMut.MutType {
	switch (op) {
		case 'add':
			return 'added'
		case 'move':
			return 'moved'
		case 'swap-factions':
		case 'edit-layer':
		case 'configure-vote':
			return 'edited'
		case 'delete':
		case 'clear':
			return 'removed'
		default:
			assertNever(op)
	}
}

export const UserPresenceActivity = z.discriminatedUnion('code', [
	z.object({ code: z.literal('editing-item'), itemIz: LL.ItemIdSchema }),
	z.object({ code: z.literal('editing-settings') }),
	z.object({ code: z.literal('adding-item') }),
	z.object({ code: z.literal('moving-item'), itemId: LL.ItemIdSchema }),
])

export const UserPresenceSchema = z.object({
	away: z.boolean(),
	editing: z.boolean(),
	lastActive: z.number().int().optional(),
	currentActivity: UserPresenceActivity.optional(),
})
export type UserPresence = z.infer<typeof UserPresenceSchema>

export const PresenceStateSchema = z.object({
	users: z.map(z.bigint(), UserPresenceSchema),
})

export const EditSessionSchema = z.object({
	layerQueueSeqId: z.number(),
	list: LL.ListSchema,
	presence: z.map(z.bigint(), UserPresenceSchema),
	ops: z.array(OperationSchema),
})

export type EditSession = z.infer<typeof EditSessionSchema>

export function applyOperations(s: EditSession, defaultVoteConfig: V.AdvancedVoteConfig, ops: Operation[]) {
	let startIndex = 0
	for (let i = ops.length - 1; i > 0; i--) {
		if (isResetOp(ops[i])) {
			startIndex = i
			break
		}
	}

	for (let i = startIndex; i < ops.length; i++) {
		const newOp = ops[i]
		const source: LL.Source = { type: 'manual', userId: newOp.userId }
		switch (newOp.op) {
			case 'add':
				LL.addItem(s.list, source, newOp.index, ...newOp.items)
				break
			case 'move':
				LL.moveItem(s.list, source, newOp.itemId, newOp.indexOrCursor)
				break
			case 'swap-factions': {
				const itemRes = LL.findItemById(s.list, newOp.itemId)
				if (!itemRes) throw new Error('Item not found')
				const swapped = LL.swapFactions(itemRes.item, source)
				LL.splice(s.list, itemRes, 1, swapped)
				break
			}
			case 'edit-layer':
				LL.editLayer(s.list, source, newOp.itemId, newOp.newLayerId)
				break
			case 'configure-vote':
				LL.configureVote(s.list, source, newOp.itemId, defaultVoteConfig, newOp.voteConfig)
				break
			case 'delete':
				LL.deleteItem(s.list, newOp.itemId)
				break
			case 'clear':
				s.list.length = 0
				break
			default:
				assertNever(newOp)
		}
	}
	s.ops.push(...ops)
}

export type Update =
	| {
		code: 'rollback'
		toIndex: number
		add: Operation[]
	}
	| {
		code: 'init'
		state: EditSession
	}
	| ClientUpdate

export const ClientUpdateSchema = z.discriminatedUnion('code', [
	z.object({
		code: z.literal('op'),
		expectedIndex: z.number(),
		op: OperationSchema,
	}),
	z.object({
		code: z.literal('rollback'),
		to: z.number(),
		add: z.array(OperationSchema),
	}),
	z.object({
		code: z.literal('update-presence'),
		userId: USR.UserIdSchema,
		state: UserPresenceSchema,
	}),
])

export type ClientUpdate = z.infer<typeof ClientUpdateSchema>
