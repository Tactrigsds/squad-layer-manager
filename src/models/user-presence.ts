import * as Obj from '@/lib/object'
import * as ST from '@/lib/state-tree'
import { assertNever } from '@/lib/type-guards'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as USR from '@/models/users.models'
import * as Im from 'immer'
import { z } from 'zod'

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
		branch('VIEWING_SETTINGS', [leaf('CHANGING_SETTINGS')]),
	]) satisfies ST.Def.Node
	return [activities] as const
})()

export const DEFAULT_ACTIVITY: RootActivity = {
	_tag: 'branch',
	id: 'ON_DASHBOARD',
	opts: {},
	child: {},
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
): (prev: RootActivity) => RootActivity {
	return Im.produce((state: Im.WritableDraft<RootActivity>) => {
		state.child.EDITING_QUEUE = {
			_tag: 'variant',
			id: 'EDITING_QUEUE',
			opts: {},
			chosen: activity as any,
		}
	})
}

export const TOGGLE_EDITING_QUEUE_TRANSITIONS = {
	matchActivity: (root: RootActivity) => !!root.child?.EDITING_QUEUE,
	createActivity: Im.produce((root: Im.WritableDraft<RootActivity>) => {
		root.child.EDITING_QUEUE ??= {
			_tag: 'variant',
			id: 'EDITING_QUEUE',
			opts: {},
			chosen: ST.Match.leaf('IDLE', {}),
		}
	}),
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

export const UserPresenceActivitySchema = ST.MatchUtils.createMatchSchema(ACTIVITIES)
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

export const PresenceUpdateSchema = z.object({
	wsClientId: z.string(),
	userId: z.bigint(),
	changes: ClientPresenceSchema.partial(),
})
export type PresenceUpdate = z.infer<typeof PresenceUpdateSchema>

export type PresenceBroadcast =
	| {
		code: 'init'
		presence: PresenceState
	}
	| {
		code: 'update'
		wsClientId: string
		userId: bigint
		changes: Partial<Omit<ClientPresence, 'userId'>>
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

export function* iterActivities(state: PresenceState) {
	for (const [wsClientId, presence] of state.entries()) {
		if (!presence.activityState) continue
		yield [presence.activityState, wsClientId] as const
	}
}

export function itemsToLockForActivity(list: LL.List, activity: RootActivity): LL.ItemId[] {
	const dialogActivity = activity.child.EDITING_QUEUE?.chosen
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
	const editingActivity = activity.child.EDITING_QUEUE
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
