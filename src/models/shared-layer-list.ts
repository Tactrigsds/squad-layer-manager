import { createId } from '@/lib/id'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import type * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as USR from '@/models/users.models'
import * as Im from 'immer'
import { z } from 'zod'
import * as L from './layer'

import * as ST from '@/lib/state-tree'

export const [ACTIVITIES] = (() => {
	const { variant, leaf, branch } = ST.Def

	const activities = branch('ON_QUEUE_PAGE', [
		variant('EDITING', [
			leaf('IDLE'),
			leaf(
				'ADDING_ITEM',
				z.object({
					cursor: LL.CursorSchema,
					action: LQY.LAYER_ITEM_ACTION.prefault('add'),
					title: z.string().optional(),
					variant: z.enum(['toggle-position']).optional(),
					selected: z.array(LL.ItemIdSchema).optional(),
				}),
			),
			leaf('ADDING_ITEM_FROM_HISTORY'),

			leaf('EDITING_ITEM', { itemId: LL.ItemIdSchema, cursor: LL.CursorSchema }),
			leaf('MOVING_ITEM', { itemId: LL.ItemIdSchema }),
			leaf('CONFIGURING_VOTE', { itemId: LL.ItemIdSchema }),
		]),
		branch('VIEWING_SETTINGS', [leaf('CHANGING_SETTINGS')]),
	]) satisfies ST.Def.Node
	return [activities] as const
})()

export const DEFAULT_ACTIVITY: RootActivity = {
	_tag: 'branch',
	id: 'ON_QUEUE_PAGE',
	opts: {},
	child: {},
}

const _editActivityVariants = ACTIVITIES.child.EDITING.child
type EditActivityVariant = (typeof _editActivityVariants)[keyof typeof _editActivityVariants]['id']

export type QueueEditActivity<
	K extends EditActivityVariant = EditActivityVariant,
> = ST.Match.Node<
	Extract<(typeof _editActivityVariants)[keyof typeof _editActivityVariants], { id: K }>
>

export function createEditActivityVariant<K extends EditActivityVariant>(
	activity: QueueEditActivity<K>,
): (prev: RootActivity) => RootActivity {
	return Im.produce((state: Im.WritableDraft<RootActivity>) => {
		state.child.EDITING = {
			_tag: 'variant',
			id: 'EDITING',
			opts: {},
			chosen: activity as any,
		}
	})
}

export const TOGGLE_EDITING_TRANSITIONS = {
	matchActivity: (root: RootActivity) => !!root.child?.EDITING,
	createActivity: Im.produce((root: Im.WritableDraft<RootActivity>) => {
		root.child.EDITING ??= {
			_tag: 'variant',
			id: 'EDITING',
			opts: {},
			chosen: ST.Match.leaf('IDLE', {}),
		}
	}),
	removeActivity: Im.produce((root: Im.WritableDraft<RootActivity>) => {
		delete root.child.EDITING
	}),
}

export function toEditIdleOrNone(match?: (root: RootActivity) => any): (prev: RootActivity) => RootActivity {
	return Im.produce((state: Im.WritableDraft<RootActivity>) => {
		if (!state.child.EDITING) return
		if (match && !match(state)) return
		state.child.EDITING = {
			_tag: 'variant',
			id: 'EDITING',
			opts: {},
			chosen: ST.Match.leaf('IDLE', {}),
		}
	})
}

export type ActivityCode = ST.Def.NodeIds<typeof ACTIVITIES>
export type RootActivity = ST.Match.Node<typeof ACTIVITIES>

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

export const UserPresenceActivitySchema = ST.MatchUtils.createMatchSchema(ACTIVITIES)
export const ITEM_OWNED_ACTIVITY_CODE = z.enum(['EDITING_ITEM', 'CONFIGURING_VOTE', 'MOVING_ITEM'])
type ItemOwnedActivityId = z.infer<typeof ITEM_OWNED_ACTIVITY_CODE>

export type ItemOwnedActivity = Extract<QueueEditActivity, { id: ItemOwnedActivityId }>
export function isItemOwnedActivity(activity: QueueEditActivity): activity is QueueEditActivity<ItemOwnedActivityId> {
	return (ITEM_OWNED_ACTIVITY_CODE.options as string[]).includes(activity.id)
}

// presence may evolve into its own system eventually if we're doing non SLL related stuff with it
export const ClientPresenceSchema = z.object({
	userId: USR.UserIdSchema,
	away: z.boolean(),
	lastSeen: z.number().positive().nullable(),
	activityState: UserPresenceActivitySchema.nullable(),
})

export type ClientPresence = z.infer<typeof ClientPresenceSchema>

export const PresenceStateSchema = z.map(z.string(), ClientPresenceSchema)
export type PresenceState = z.infer<typeof PresenceStateSchema>

export type EditSession = {
	list: LL.List
	editors: Set<USR.UserId>
	ops: Operation[]

	// TODO I would like to move away from this approach of calculating mutations when operations are applied
	mutations: ItemMut.Mutations
}

// no presence instances older than this should be displayed
export const DISPLAYED_AWAY_PRESENCE_WINDOW = 1000 * 60 * 10

export function applyOperation(session: EditSession, newOp: Operation | NewOperation, mutations?: ItemMut.Mutations) {
	const list = session.list
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
			if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			break
		}
		case 'move': {
			const { merged, modified } = LL.moveItem(list, source, newOp.itemId, newOp.newFirstItemId, newOp.cursor)
			if (modified) {
				if (merged) {
					const { item } = Obj.destrNullable(LL.findItemById(list, merged))
					if (item) {
						if (!LL.isParentVoteItem(item)) throw new Error('Expected parent vote item')
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
			const swapped = LL.swapFactions(item, source)
			if (!swapped) break

			// maybe mirror matchups will be a thing at some point who knows
			if (swapped.layerId === item.layerId) break
			ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			LL.splice(list, index, 1, swapped)
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
			LL.configureVote(list, source, newOp.itemId, newOp.voteConfig, newOp.displayProps)
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
		sideEffectOps: z.array(OperationSchema).optional().meta({ description: 'Extra operations to be applied as a result of this update' }),
	}),
])

export type ClientUpdate = z.infer<typeof ClientUpdateSchema>

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

export function itemsToLockForActivity(list: LL.List, activity: RootActivity): LL.ItemId[] {
	const dialogActivity = activity.child.EDITING?.chosen
	if (!dialogActivity || !isItemOwnedActivity(dialogActivity)) return []
	const itemId = dialogActivity.opts.itemId
	const item = LL.findItemById(list, itemId)?.item
	if (!item) return []
	const ids: LL.ItemId[] = [itemId]
	const parentItem = LL.findParentItem(list, itemId)
	if (parentItem) {
		ids.push(parentItem.itemId)
	}
	if (LL.isVoteItem(item)) {
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

export function endAllEditing(state: PresenceState, session: EditSession) {
	for (const presence of state.values()) {
		if (presence.activityState?.child.EDITING) {
			updateClientPresence(presence, { activityState: null })
		}
	}
	session.editors.clear()
}

export function getOpsForActivityStateUpdate(
	session: EditSession,
	state: PresenceState,
	wsClientId: string,
	userId: bigint,
	output: PresenceActions.ActionOutput,
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

export const getHumanReadableActivity = (activity: RootActivity, listOrIndex: LL.List | LL.ItemIndex, withItemName?: boolean) => {
	const editingActivity = activity.child.EDITING
	const settingsActivity = activity.child.VIEWING_SETTINGS

	if (settingsActivity) {
		if (settingsActivity.child.CHANGING_SETTINGS) {
			return 'Changing Pool Settings'
		}
	}

	if (!editingActivity) return null
	if (editingActivity.chosen.id === 'IDLE') {
		return `Editing Queue`
	}
	if (editingActivity.chosen.id === 'ADDING_ITEM') {
		return 'Adding layers'
	}
	if (editingActivity.chosen.id === 'ADDING_ITEM_FROM_HISTORY') {
		return 'Adding layer from History'
	}
	if (!withItemName) {
		switch (editingActivity.chosen.id) {
			case 'EDITING_ITEM':
				return `Editing`
			case 'CONFIGURING_VOTE':
				return `Configuring vote`
			case 'MOVING_ITEM':
				return `Moving`
			default:
				assertNever(editingActivity.chosen)
		}
	}

	let index: LL.ItemIndex
	if (Array.isArray(listOrIndex)) {
		const foundIndex = Obj.destrNullable(LL.findItemById(listOrIndex, editingActivity.chosen.opts.itemId))?.index
		if (!foundIndex) {
			console.warn(`Item ${editingActivity.chosen.opts.itemId} not found in list`, listOrIndex)
			index = { outerIndex: 0, innerIndex: null }
		} else {
			index = foundIndex
		}
	} else {
		index = listOrIndex
	}

	const itemName = index ? LL.getItemNumber(index) : 'Item'
	switch (editingActivity.chosen.id) {
		case 'EDITING_ITEM':
			return `Editing ${itemName}`
		case 'CONFIGURING_VOTE':
			return ` Configuring vote for ${itemName}`
		case 'MOVING_ITEM':
			return `Moving ${itemName}`
		default:
			assertNever(editingActivity.chosen)
	}
}

export const getAttributedHumanReadableActivity = (
	activity: RootActivity,
	listOrIndex: LL.List | LL.ItemIndex,
	displayName: string,
	withItemName?: boolean,
) => {
	const activityText = getHumanReadableActivity(activity, listOrIndex)
	if (!activityText) return null
	return `${displayName} is ${activityText.toLowerCase()}`
}

export function* iterActivities(state: PresenceState) {
	for (const [wsClientId, presence] of state.entries()) {
		if (!presence.activityState) continue
		yield [presence.activityState, wsClientId] as const
	}
}
