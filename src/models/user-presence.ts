import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import * as ST from '@/lib/state-tree'
import { assertNever } from '@/lib/type-guards'
import { DistributiveOmit } from '@/lib/types'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as USR from '@/models/users.models'
import * as Im from 'immer'
import { z } from 'zod'

export const DISCONNECT_TIMEOUT = 5_000

// export const INTERACT_TIMEOUT = 5_000
export const INTERACT_TIMEOUT = 30_000

export const [ACTIVITIES] = (() => {
	const { variant, leaf, branch } = ST.Def

	const activities = branch('ON_DASHBOARD', [
		variant('EDITING_QUEUE', [
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
			leaf('GENERATING_VOTE', { cursor: LL.CursorSchema }),
			leaf('PASTE_ROTATION'),
		]),
		leaf('EDITING_TEAMSWAPS'),
		branch('VIEWING_SETTINGS', [leaf('CHANGING_SETTINGS')]),
	]) satisfies ST.Def.Node

	return [activities] as const
})()

export const UserPresenceActivitySchema = ST.MatchUtils.createMatchSchema(ACTIVITIES)

export const DEFAULT_ACTIVITY: RootActivity = {
	_tag: 'branch',
	id: 'ON_DASHBOARD',
	opts: {},
	child: {},
}

const serverOpBase = {
	opId: z.string(),
	time: z.number(),
}
const clientOpBase = {
	...serverOpBase,
	clientId: z.string(),
	userId: z.bigint(),
}
const editActivities = ACTIVITIES.child.EDITING_QUEUE.child

export const OpSchema = z.discriminatedUnion('code', [
	// ------ basic presence tracking ------
	z.object({
		...clientOpBase,
		code: z.literal('page-loaded'),
	}),

	z.object({
		...clientOpBase,

		code: z.literal('page-interaction'),
	}),

	z.object({
		...clientOpBase,
		code: z.literal('interaction-timeout'),
	}),

	z.object({
		...clientOpBase,
		code: z.literal('navigated-away'),
	}),

	z.object({
		...clientOpBase,
		code: z.literal('disconnected-timeout'),
	}),

	z.object({
		...clientOpBase,
		code: z.literal('set-activity'),
		activity: UserPresenceActivitySchema,
	}),

	z.object({
		...serverOpBase,
		code: z.literal('sll:end-all-editing'),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('clean-stale-presence'),
		clientIdsToRemove: z.array(z.string()),
	}),
])
export function createOpId(): string {
	return createId(24)
}

export const CLIENT_OP_CODE = z.enum([
	'page-loaded',
	'page-interaction',
	'interaction-timeout',
	'navigated-away',
	'disconnected-timeout',
	'set-activity',
])
type ClientOpCode = z.infer<typeof CLIENT_OP_CODE>

export type Op = z.infer<typeof OpSchema>
export type ClientOp = Extract<Op, { code: ClientOpCode }>
export type NewClientOp = DistributiveOmit<Op, 'userId' | 'clientId' | 'opId' | 'time'>

export type SideEffects = { code: 'error'; error: unknown } | { code: 'op-outcome'; op: Op; success: boolean }

export type ItemLocks = Map<LL.ItemId, string>

export type State = { presence: PresenceState; itemLocks: ItemLocks }
export function initState(): State {
	return {
		presence: new Map(),
		itemLocks: new Map(),
	}
}

export const reducer: RbSyncState.Reducer<Op, State, SideEffects> = (prevState, ops, prevOps, onSideEffect) => {
	const state: State = {
		presence: new Map(prevState.presence),
		itemLocks: new Map(prevState.itemLocks),
	}

	for (const op of ops) {
		let success = false
		try {
			if (op.code === 'clean-stale-presence') {
				for (const clientId of op.clientIdsToRemove) {
					state.presence.delete(clientId)
				}

				MapUtils.deleteByValue(state.itemLocks, ...op.clientIdsToRemove)
				success = true
			} else if (op.code === 'sll:end-all-editing') {
				state.itemLocks.clear()
				for (const [clientId, clientState] of state.presence.entries()) {
					state.presence.set(clientId, { ...clientState, activityState: clearSllEditingActivity(clientState.activityState) })
				}
				success = true
				break
			} else {
				// client ops
				const clientState: ClientPresence = state.presence.get(op.clientId)
					?? { userId: op.userId, away: true, activityState: null, lastSeen: null }
				let newClientState: ClientPresence | undefined
				opSwitch: switch (op.code) {
					case 'page-loaded': {
						newClientState = {
							...clientState,
							away: false,
							activityState: null,
						}
						success = true
						break
					}

					case 'page-interaction': {
						newClientState = {
							...clientState,
							away: false,
							lastSeen: op.time,
						}
						success = true
						break
					}

					case 'interaction-timeout': {
						newClientState = {
							...clientState,
							away: true,
						}
						success = true
						break
					}

					case 'navigated-away': {
						newClientState = {
							...clientState,
							away: true,
							activityState: null,
						}
						MapUtils.deleteByValue(state.itemLocks, op.clientId)
						success = true
						break
					}

					case 'disconnected-timeout': {
						newClientState = {
							...clientState,
							away: true,
							activityState: null,
						}
						MapUtils.deleteByValue(state.itemLocks, op.clientId)
						success = true
						break
					}

					case 'set-activity': {
						const prevActivity = clientState.activityState

						const prevEditingSll = getSllEditingQueueNode(prevActivity)
						const sllEditNode = getSllEditingQueueNode(op.activity)
						if (!sllEditNode && prevEditingSll) {
							MapUtils.deleteByValue(state.itemLocks, op.clientId)
						} else if (sllEditNode && !isItemOwnedActivity(sllEditNode.chosen)) {
							MapUtils.deleteByValue(state.itemLocks, op.clientId)
						} else if (sllEditNode && isItemOwnedActivity(sllEditNode.chosen)) {
							switch (sllEditNode.chosen.id) {
								case 'MOVING_ITEM':
								case 'EDITING_ITEM':
								case 'CONFIGURING_VOTE': {
									const itemId = sllEditNode.chosen.opts.itemId
									if (state.itemLocks.has(itemId)) {
										break opSwitch
									}
									state.itemLocks.set(itemId, op.clientId)
									break
								}
								default:
									assertNever(sllEditNode.chosen)
							}
						}

						newClientState = {
							...clientState,
							away: false,
							activityState: op.activity,
							lastSeen: op.time,
						}
						success = true
						break
					}

					default:
						assertNever(op)
				}
				if (newClientState) state.presence.set(op.clientId, newClientState)
			}
		} catch (e) {
			onSideEffect?.({ code: 'error', error: e })
		}
		onSideEffect?.({ code: 'op-outcome', op, success })
	}
	return state
}

export function anyLocksInaccessible(locks: ItemLocks, ids: LL.ItemId[], wsClientId: string): boolean {
	for (const id of ids) {
		const existingLock = locks.get(id)
		if (existingLock && existingLock !== wsClientId) return true
	}
	return false
}

const _editingQueueVariants = ACTIVITIES.child.EDITING_QUEUE.child
type EditingQueueVariant = (typeof _editingQueueVariants)[keyof typeof _editingQueueVariants]['id']

export type QueueEditingActivity<
	K extends EditingQueueVariant = EditingQueueVariant,
> = ST.Match.Node<
	Extract<(typeof _editingQueueVariants)[keyof typeof _editingQueueVariants], { id: K }>
>

export function createEditingQueueVariant<K extends EditingQueueVariant>(
	activity: QueueEditingActivity<K>,
): (prev: RootActivity | undefined | null) => RootActivity {
	return (prev: RootActivity | undefined | null) => {
		const base = prev ?? DEFAULT_ACTIVITY
		return Im.produce((state: Im.WritableDraft<RootActivity>) => {
			state.child.EDITING_QUEUE = {
				_tag: 'variant',
				id: 'EDITING_QUEUE',
				opts: {},
				chosen: activity as any,
			}
		})(base)
	}
}

export type Resolver<T = any> = (root: RootActivity | undefined | null) => T

export const TOGGLE_EDITING_QUEUE_TRANSITIONS = {
	matchActivity: (root: RootActivity | undefined | null) => !!getSllEditingQueueNode(root),
	createActivity: (_activity: RootActivity | undefined | null): RootActivity => {
		let activity = _activity ?? DEFAULT_ACTIVITY
		if (activity.child.EDITING_QUEUE) return activity
		return {
			...activity,
			child: {
				...activity.child,
				EDITING_QUEUE: {
					_tag: 'variant',
					id: 'EDITING_QUEUE',
					opts: {},
					chosen: ST.Match.leaf('IDLE', {}),
				},
			},
		}
	},
	removeActivity: Im.produce((root: Im.WritableDraft<RootActivity>) => {
		delete root.child.EDITING_QUEUE
	}),
}

export function toEditingQueueIdleOrNone(match?: (root: RootActivity) => any): (prev: RootActivity) => RootActivity {
	return Im.produce((state: Im.WritableDraft<RootActivity>) => {
		if (!state.child.EDITING_QUEUE) return
		if (match && !match(state)) return
		state.child.EDITING_QUEUE = {
			_tag: 'variant',
			id: 'EDITING_QUEUE',
			opts: {},
			chosen: ST.Match.leaf('IDLE', {}),
		}
	})
}

export type ActivityCode = ST.Def.NodeIds<typeof ACTIVITIES>
export type RootActivity = ST.Match.Node<typeof ACTIVITIES>

export const ITEM_OWNED_ACTIVITY_CODE = z.enum(['EDITING_ITEM', 'CONFIGURING_VOTE', 'MOVING_ITEM'])
type ItemOwnedActivityId = z.infer<typeof ITEM_OWNED_ACTIVITY_CODE>

export type ItemOwnedActivity = Extract<QueueEditingActivity, { id: ItemOwnedActivityId }>
export function isItemOwnedActivity(activity: QueueEditingActivity): activity is QueueEditingActivity<ItemOwnedActivityId> {
	return (ITEM_OWNED_ACTIVITY_CODE.options as string[]).includes(activity.id)
}

export const ClientPresenceSchema = z.object({
	userId: USR.UserIdSchema,
	away: z.boolean(),
	lastSeen: z.number().positive().nullable(),
	activityState: UserPresenceActivitySchema.nullable(),
})

export type ClientPresence = z.infer<typeof ClientPresenceSchema>

export const PresenceStateSchema = z.map(z.string(), ClientPresenceSchema)
export type PresenceState = z.infer<typeof PresenceStateSchema>

// the shape of the data flowing from server to client
export type PresenceUpdate =
	| {
		code: 'init'
		state: State
		ops: Op[]
	}
	| {
		code: 'op'
		op: Op
	}

// no presence instances older than this should be displayed
export const DISPLAYED_AWAY_PRESENCE_WINDOW = 1000 * 60 * 10

export function updateClientPresence(
	presence: ClientPresence,
	updates: Partial<Omit<ClientPresence, 'userId'>>,
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

export function getSllEditingQueueNode(activity: RootActivity | null | undefined) {
	return activity?.child.EDITING_QUEUE
}

export function clearSllEditingActivity(activity: RootActivity | null | undefined): RootActivity | null {
	if (!activity) return null
	if (!activity.child.EDITING_QUEUE) return activity
	return {
		...activity,
		child: Obj.omit(activity.child, ['EDITING_QUEUE']),
	}
}

export function* iterActivities(state: PresenceState) {
	for (const [wsClientId, presence] of state.entries()) {
		if (!presence.activityState) continue
		yield [presence.activityState, wsClientId] as const
	}
}

export function itemsToLockForActivity(list: LL.List, activity: RootActivity): LL.ItemId[] {
	const dialogActivity = getSllEditingQueueNode(activity)?.chosen
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

export const getHumanReadableActivity = (activity: RootActivity, listOrIndex: LL.List | LL.ItemIndex, withItemName?: boolean) => {
	const editingActivity = getSllEditingQueueNode(activity)
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
	if (editingActivity.chosen.id === 'GENERATING_VOTE') {
		return 'Generating vote'
	}
	if (editingActivity.chosen.id === 'ADDING_ITEM_FROM_HISTORY') {
		return 'Adding layer from History'
	}
	if (editingActivity.chosen.id === 'PASTE_ROTATION') {
		return 'Pasting rotation'
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
