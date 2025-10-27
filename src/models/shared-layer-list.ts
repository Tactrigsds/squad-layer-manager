import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as LL from '@/models/layer-list.models'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as USR from '@/models/users.models'
import { z } from 'zod'
import * as L from './layer'

function buildItemOpSchemaEntries<T extends { [key: string]: z.ZodTypeAny }>(base: T) {
	return [
		z.object({
			...base,
			op: z.literal('move'),
			indexOrCursor: z.union([LL.LayerListItemIndex, LL.ItemRelativeCursorSchema]),
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
			otherLayers: z.array(LL.LayerListItemSchema),
		}),
		z.object({
			...base,
			op: z.literal('configure-vote'),

			// null means use defaults(remove), undefined means don't modify
			voteConfig: LL.NewLayerListItemSchema.shape.voteConfig.nullable(),
			displayProps: LL.NewLayerListItemSchema.shape.displayProps.nullable(),
		}),
		z.object({
			...base,
			op: z.literal('delete'),
		}),
	] as const
}

function buildOperationSchema<T extends { [key: string]: z.ZodTypeAny }, ItemSchema extends z.ZodSchema>(base: T, itemSchema: ItemSchema) {
	return z.discriminatedUnion('op', [
		z.object({
			...base,
			op: z.literal('add'),
			items: z.array(itemSchema),
			index: LL.LayerListItemIndex,
		}),
		...buildItemOpSchemaEntries({ ...base, itemId: LL.ItemIdSchema }),
		z.object({
			...base,
			op: z.literal('clear'),
			itemIds: z.array(LL.ItemIdSchema),
		}),
	])
}

export const OperationSchema = buildOperationSchema({ opId: z.string(), userId: USR.UserIdSchema }, LL.LayerListItemSchema)
export type Operation = z.infer<typeof OperationSchema>
export type OpCode = Operation['op']

export const NewOperationSchema = buildOperationSchema({}, LL.NewLayerListItemSchema)
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

export const UserPresenceActivitySchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('editing-item'), itemId: LL.ItemIdSchema }),
	z.object({ code: z.literal('configuring-vote'), itemId: LL.ItemIdSchema }),
	z.object({ code: z.literal('adding-item') }),
	z.object({ code: z.literal('moving-item'), itemId: LL.ItemIdSchema }),

	// for changing pool configuration
	z.object({ code: z.literal('changing-settings') }),
])

export const ITEM_OWNED_ACTIVITY_CODE = z.enum(['editing-item', 'configuring-vote', 'moving-item'])
export type ItemOwnedActivityCode = z.infer<typeof ITEM_OWNED_ACTIVITY_CODE>
export type ClientPresenceActivity = z.infer<typeof UserPresenceActivitySchema>


export function isEditingStateActivity(
	activity: ClientPresenceActivity,
): activity is Extract<ClientPresenceActivity, { code: 'editing-item' }> {
	return isItemOwnedActivity(activity) || activity.code === 'adding-item'
}

export type ItemOwnedActivity = Extract<ClientPresenceActivity, { code: ItemOwnedActivityCode }>
export function isItemOwnedActivity(activity: ClientPresenceActivity): activity is ItemOwnedActivity {
	return (ITEM_OWNED_ACTIVITY_CODE.options as string[]).includes(activity.code)
}

export function opToActivity(op: Operation): ClientPresenceActivity | undefined {
	switch (op.op) {
		case 'add':
			return { code: 'adding-item' }
		case 'move':
			return { code: 'moving-item', itemId: op.itemId }
		case 'configure-vote':
			return { code: 'configuring-vote', itemId: op.itemId }
		case 'edit-layer':
		case 'create-vote':
		case 'swap-factions':
			return { code: 'editing-item', itemId: op.itemId }
		case 'delete':
		case 'clear':
			return undefined
		default:
			assertNever(op)
	}
}

// presence may evolve into its own system eventually if we're doing non SLL related stuff with it
export const ClientPresenceSchema = z.object({
	userId: USR.UserIdSchema,
	away: z.boolean(),
	editing: z.boolean(),
	lastSeen: z.number().positive(),
	currentActivity: UserPresenceActivitySchema.nullable(),
})

export type ClientPresence = z.infer<typeof ClientPresenceSchema>

export const PresenceStateSchema = z.map(z.string(), ClientPresenceSchema)
export type PresenceState = z.infer<typeof PresenceStateSchema>

export type EditSession = {
	list: LL.List
	ops: Operation[]

	mutations: ItemMut.Mutations
}

// no presence instances older than this should be displayed
export const DISPLAYED_AWAY_PRESENCE_WINDOW = 1000 * 60 * 10

export function applyOperation(list: LL.List, newOp: Operation | NewOperation, mutations?: ItemMut.Mutations) {
	const source: LL.Source = isOperation(newOp) ? { type: 'manual', userId: newOp.userId } : { type: 'unknown' }
	switch (newOp.op) {
		case 'add': {
			let items: LL.Item[]
			if (isOperation(newOp)) {
				items = newOp.items
			} else {
				items = newOp.items.map(item => LL.createLayerListItem(item, source))
			}
			LL.addItemsDeterministic(list, source, newOp.index, ...items)
			ItemMut.tryApplyMutation('added', items.map(item => item.itemId), mutations)
			break
		}
		case 'move': {
			const { merged, modified } = LL.moveItem(list, source, newOp.itemId, newOp.newFirstItemId, newOp.indexOrCursor)
			if (modified) {
				if (merged) {
					const item = LL.findItemById(list, merged)!.item as LL.ParentVoteItem
					ItemMut.tryApplyMutation('edited', [item.itemId], mutations)
					ItemMut.tryApplyMutation('added', [item.choices[0].itemId], mutations)
					ItemMut.tryApplyMutation('moved', item.choices.slice(1).map(choice => choice.itemId), mutations)
				} else {
					ItemMut.tryApplyMutation('moved', [newOp.itemId], mutations)
				}
			}
			break
		}

		case 'swap-factions': {
			const itemRes = LL.findItemById(list, newOp.itemId)
			if (!itemRes) return
			const swapped = LL.swapFactions(itemRes.item, source)
			ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			LL.splice(list, itemRes, 1, swapped)
			break
		}

		case 'edit-layer': {
			const beforeEdit = LL.findItemById(list, newOp.itemId)?.item.layerId
			LL.editLayer(list, source, newOp.itemId, newOp.newLayerId)
			const afterEdit = LL.findItemById(list, newOp.itemId)?.item.layerId
			if (beforeEdit && afterEdit && beforeEdit !== afterEdit) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'configure-vote': {
			LL.configureVote(list, source, newOp.itemId, newOp.voteConfig, newOp.displayProps)
			const itemRes = LL.findItemById(list, newOp.itemId)
			if (itemRes) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'delete': {
			const itemRes = LL.findItemById(list, newOp.itemId)
			if (itemRes) {
				LL.deleteItem(list, newOp.itemId)
				ItemMut.tryApplyMutation('removed', [newOp.itemId], mutations)
			}

			break
		}
		case 'clear':
			for (const itemId of newOp.itemIds) {
				const itemRes = LL.findItemById(list, itemId)
				if (itemRes) {
					LL.deleteItem(list, itemId)
					ItemMut.tryApplyMutation('removed', [itemId], mutations)
				}
			}
			break

		case 'create-vote': {
			LL.createVoteOutOfItem(list, source, newOp.itemId, newOp.newFirstItemId, newOp.otherLayers)
			const itemRes = LL.findItemById(list, newOp.itemId)
			if (itemRes && LL.isParentVoteItem(itemRes.item)) {
				ItemMut.tryApplyMutation('added', itemRes.item.choices.map(choice => choice.itemId), mutations)
			}
			break
		}

		default:
			assertNever(newOp)
	}
}

export function applyOperations(s: EditSession, ops: Operation[]) {
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]
		applyOperation(s.list, op, s.mutations)
	}
	s.ops.push(...ops)
}

export type Update =
	| {
		code: 'init'
		session: EditSession
		presence: PresenceState
		sessionSeqId: SessionSequenceId
	}
	| {
		code: 'commit-completed'
		list: LL.List
		committer: USR.User
		sessionSeqId: SessionSequenceId
		newSessionSeqId: SessionSequenceId
		initiator: string
	}
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
	| { code: 'commit-rejected'; reason: string; msg: string; sessionSeqId: SessionSequenceId; committer: USR.User }
	| {
		code: 'locks-modified'
		mutations: [LL.ItemId, string | null][]
	}
	| ClientUpdate

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
	z.object({
		code: z.literal('update-presence'),
		wsClientId: z.string(),
		userId: z.bigint(),
		changes: ClientPresenceSchema.partial(),
		fromServer: z.boolean().optional(),
	}),
])

export type ClientUpdate = z.infer<typeof ClientUpdateSchema>

export function getClientPresenceDefaults(userId: bigint): ClientPresence {
	return {
		userId,
		away: false,
		editing: false,
		currentActivity: null,
		lastSeen: Date.now(),
	}
}

export function updateClientPresence(
	presence: ClientPresence,
	updates: PresenceActions.ActionOutput,
) {
	updates = Obj.trimUndefined(updates)
	if (Object.keys(updates).length === 0) {
		return false
	}
	let modified = false
	for (const [key, value] of Obj.objEntries(updates)) {
		modified = modified || !Obj.deepEqual(presence[key], value)
		// @ts-expect-error idgaf
		presence[key] = value
	}
	return modified
}

export function resolveUserPresence(state: PresenceState) {
	const presenceByUser = new Map<bigint, ClientPresence>()
	for (const presence of state.values()) {
		const existing = presenceByUser.get(presence.userId)
		if (!existing) {
			presenceByUser.set(presence.userId, presence)
			continue
		}
		if (presence.lastSeen && !existing.lastSeen) {
			presenceByUser.set(presence.userId, presence)
			continue
		}
		if (presence.lastSeen && existing.lastSeen && presence.lastSeen > existing.lastSeen) {
			presenceByUser.set(presence.userId, presence)
			continue
		}
	}
	return presenceByUser
}

export type ItemLocks = Map<LL.ItemId, string>
export type LockMutation = [LL.ItemId, string]

export function itemsToLockForActivity(list: LL.List, activity: ClientPresenceActivity): LL.ItemId[] {
	if (!isItemOwnedActivity(activity)) return []
	const itemId = activity.itemId
	const item = LL.findItemById(list, itemId)?.item
	if (!item) return []
	const ids: LL.ItemId[] = [itemId]
	const parentItem = LL.findParentItem(list, itemId)
	if (parentItem) {
		ids.push(parentItem.itemId)
	}
	if (LL.isParentVoteItem(item)) {
		ids.push(...item.choices.map(choice => choice.itemId))
	}
	return ids
}

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

export function endAllEditing(state: PresenceState) {
	for (const presence of state.values()) {
		if (presence.editing) {
			updateClientPresence(presence, { editing: false, currentActivity: null })
		}
	}
}

export function createNewSession(list?: LL.List): EditSession {
	return {
		list: list ?? [],
		ops: [],
		mutations: ItemMut.initMutations(),
	}
}

export function applyListUpdate(session: EditSession, list: LL.List) {
	session.list = Obj.deepClone(list)
	session.ops = []
	session.mutations = ItemMut.initMutations()
}

export function checkUserHasEdits(session: EditSession, userId: USR.UserId) {
	for (const { item } of LL.iterLayerList(session.list)) {
		if (!ItemMut.idMutated(session.mutations, item.itemId)) continue
		if (item.source.type === 'manual' && item.source.userId === userId) return true
	}
	return false
}

export const getHumanReadableActivity = (activityCode: ClientPresenceActivity['code'], index?: LL.ItemIndex) => {
	const name = index ? LL.getItemNumber(index) : 'Item'
	switch (activityCode) {
		case 'editing-item':
			return `Editing ${name} `
		case 'configuring-vote':
			return ` Configuring vote for ${name}`
		case 'adding-item':
			return 'Adding an item'
		case 'moving-item':
			return `Moving ${name}`
		case 'changing-settings':
			return 'Changing Settings'
		default:
			assertNever(activityCode)
	}
}

export const getHumanReadableActivityWithUser = (activityCode: ClientPresenceActivity['code'], displayName: string) => {
	switch (activityCode) {
		case 'editing-item':
			return `${displayName} is editing`
		case 'configuring-vote':
			return `${displayName} is configuring vote`
		case 'adding-item':
			return `${displayName} is adding`
		case 'moving-item':
			return `${displayName} is moving`
		case 'changing-settings':
			return `${displayName} is changing settings`
		default:
			assertNever(activityCode)
	}
}
