import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import * as ST from '@/lib/state-tree'
import { assertNever } from '@/lib/type-guards'
import type { DistributiveOmit } from '@/lib/types'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as USR from '@/models/users.models'
import * as Im from 'immer'
import { z } from 'zod'

export const DISCONNECT_TIMEOUT = 5_000

// export const INTERACT_TIMEOUT = 5_000
export const INTERACT_TIMEOUT = 30_000

export const [ACTIVITIES, ACTIVITIES_FLATTENED] = (() => {
	const { variant, leaf, branch } = ST.Def

	const ACTIVITIES = branch('ON_DASHBOARD', { serverId: SS.ServerIdSchema }, [
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
		leaf('EDITING_TEAMSWITCHES'),
		variant('ON_PRIMARY_PANEL', [
			branch('VIEWING_QUEUE', [
				branch('VIEWING_QUEUE_SETTINGS', [leaf('CHANGING_QUEUE_SETTINGS')]),
			]),
			branch('VIEWING_TEAMS', [
				variant('PLAYER_DIALOGUE', [
					leaf('SWITCHING_PLAYERS'),
					leaf('WARNING_PLAYERS'),
					leaf('REMOVING_FROM_SQUAD'),
					leaf('DISBANDING_SQUAD'),
					leaf('RESETTING_SQUAD_NAME'),
					leaf('DEMOTING_COMMANDER'),
				]),
			]),
		]),
	]) satisfies ST.Def.Node

	const editingQueue = ACTIVITIES.child.EDITING_QUEUE
	const onPrimaryPanel = ACTIVITIES.child.ON_PRIMARY_PANEL
	const viewingQueue = onPrimaryPanel.child.VIEWING_QUEUE
	const viewingTeams = onPrimaryPanel.child.VIEWING_TEAMS
	const playerDialogue = viewingTeams.child.PLAYER_DIALOGUE

	const ACTIVITIES_FLATTENED = {
		ON_DASHBOARD: ACTIVITIES,

		EDITING_QUEUE: editingQueue,
		IDLE: editingQueue.child.IDLE,
		ADDING_ITEM: editingQueue.child.ADDING_ITEM,
		ADDING_ITEM_FROM_HISTORY: editingQueue.child.ADDING_ITEM_FROM_HISTORY,
		EDITING_ITEM: editingQueue.child.EDITING_ITEM,
		MOVING_ITEM: editingQueue.child.MOVING_ITEM,
		CONFIGURING_VOTE: editingQueue.child.CONFIGURING_VOTE,
		GENERATING_VOTE: editingQueue.child.GENERATING_VOTE,
		PASTE_ROTATION: editingQueue.child.PASTE_ROTATION,

		EDITING_TEAMSWITCHES: ACTIVITIES.child.EDITING_TEAMSWITCHES,

		ON_PRIMARY_PANEL: onPrimaryPanel,
		VIEWING_QUEUE: viewingQueue,
		VIEWING_QUEUE_SETTINGS: viewingQueue.child.VIEWING_QUEUE_SETTINGS,
		CHANGING_QUEUE_SETTINGS: viewingQueue.child.VIEWING_QUEUE_SETTINGS.child.CHANGING_QUEUE_SETTINGS,

		VIEWING_TEAMS: viewingTeams,
		PLAYER_DIALOGUE: playerDialogue,
		SWITCHING_PLAYERS: playerDialogue.child.SWITCHING_PLAYERS,
		WARNING_PLAYERS: playerDialogue.child.WARNING_PLAYERS,
		REMOVING_FROM_SQUAD: playerDialogue.child.REMOVING_FROM_SQUAD,
		DISBANDING_SQUAD: playerDialogue.child.DISBANDING_SQUAD,
		RESETTING_SQUAD_NAME: playerDialogue.child.RESETTING_SQUAD_NAME,
		DEMOTING_COMMANDER: playerDialogue.child.DEMOTING_COMMANDER,
	}

	return [ACTIVITIES, ACTIVITIES_FLATTENED] as const
})()

export const UserPresenceActivitySchema = ST.MatchUtils.createMatchSchema(ACTIVITIES)

export function getDefaultDashActivity(serverId: string): RootActivity {
	return {
		_tag: 'branch',
		id: 'ON_DASHBOARD',
		opts: { serverId },
		child: {
			ON_PRIMARY_PANEL: {
				_tag: 'variant',
				id: 'ON_PRIMARY_PANEL',
				opts: {},
				chosen: {
					_tag: 'branch',
					id: 'VIEWING_TEAMS',
					opts: {},
					child: {},
				},
			},
		},
	}
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

export const OpSchema = z.discriminatedUnion('code', [
	// ------ basic presence tracking ------
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
		code: z.literal('update-activity'),
		update: z.lazy(() => ActivityUpdateSchema),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('sll:end-all-editing'),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('disconnected-timeout'),
		clientId: z.string(),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('clean-stale-presence'),
		clientIdsToRemove: z.array(z.string()),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('broadcast-activity-update'),
		update: z.lazy(() => ActivityUpdateSchema),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('set-enabled-servers'),
		serverIds: z.array(SS.ServerIdSchema),
	}),
])
export function createOpId(): string {
	return createId(24)
}

export const CLIENT_OP_CODE = z.enum([
	'page-interaction',
	'interaction-timeout',
	'navigated-away',
	'update-activity',
])
type ClientOpCode = z.infer<typeof CLIENT_OP_CODE>

export type Op = z.infer<typeof OpSchema>
export type ClientOp = Extract<Op, { code: ClientOpCode }>
export type NewClientOp = DistributiveOmit<Op, 'userId' | 'clientId' | 'opId' | 'time'>

export type SideEffects = { code: 'op-outcome'; op: Op; success: boolean }

// the typed payload carried by a RejectedError thrown from the reducer: an op that threw while being
// applied, or a benign no-op batch that changed nothing
export type Rejection = { code: 'op-error'; op: Op; error: unknown } | { code: 'noop' }

export type ItemLocks = Map<LL.ItemId, string>

// the set of servers that currently have a live slice (enabled + non-broken). a client can only be present on one of
// these; presence for any other server is collapsed to null. kept in sync by the server via 'set-enabled-servers' ops.
export type State = { presence: PresenceState; itemLocks: ItemLocks; enabledServers: Set<string> }
export function initState(): State {
	return {
		presence: new Map(),
		itemLocks: new Map(),
		enabledServers: new Set(),
	}
}

// collapses an activity to null when its server isn't currently enabled -- users can't be present on a server with no live slice
function gateActivityToEnabled(activity: RootActivity | null, enabledServers: Set<string>): RootActivity | null {
	if (activity && !enabledServers.has(activity.opts.serverId)) return null
	return activity
}

export const reducer: ODSM.Reducer<Op, State, SideEffects> = (prevState, ops, _prevOps) => {
	const state: State = {
		presence: new Map(prevState.presence),
		itemLocks: new Map(prevState.itemLocks),
		enabledServers: new Set(prevState.enabledServers),
	}
	const sideEffects: SideEffects[] = []
	const emit = (se: SideEffects) => sideEffects.push(se)
	// the first op that throws rejects the whole (dependent) batch; recorded here and thrown below
	let firstError: Rejection | undefined

	for (const op of ops) {
		let success = false
		try {
			if (op.code === 'disconnected-timeout') {
				const clientState = state.presence.get(op.clientId)
				if (clientState) {
					state.presence.set(op.clientId, { ...clientState, away: true, activityState: null })
				}
				MapUtils.deleteByValue(state.itemLocks, op.clientId)
				success = true
			} else if (op.code === 'clean-stale-presence') {
				for (const clientId of op.clientIdsToRemove) {
					state.presence.delete(clientId)
				}

				MapUtils.deleteByValue(state.itemLocks, ...op.clientIdsToRemove)
				success = true
			} else if (op.code === 'sll:end-all-editing') {
				state.itemLocks.clear()
				for (const [clientId, clientState] of state.presence.entries()) {
					state.presence.set(clientId, { ...clientState, activityState: clearQueueEditingActivity(clientState.activityState) })
				}
				success = true
				break
			} else if (op.code === 'set-enabled-servers') {
				state.enabledServers = new Set(op.serverIds)
				// any user sitting on a server that just lost its slice is no longer meaningfully present there
				for (const [clientId, clientState] of state.presence.entries()) {
					const gated = gateActivityToEnabled(clientState.activityState, state.enabledServers)
					if (gated === clientState.activityState) continue
					state.presence.set(clientId, { ...clientState, activityState: gated })
					MapUtils.deleteByValue(state.itemLocks, clientId)
				}
				success = true
			} else if (op.code === 'broadcast-activity-update') {
				for (const [clientId, clientState] of state.presence.entries()) {
					const prevActivity = clientState.activityState ?? null
					const newActivity = gateActivityToEnabled(applyActivityUpdate(prevActivity, op.update), state.enabledServers)
					if (newActivity === prevActivity) continue
					const prevEditingSll = prevActivity ? Trans.editingQueue(prevActivity.opts.serverId).match(prevActivity) : null
					const sllEditNode = newActivity ? Trans.editingQueue(newActivity.opts.serverId).match(newActivity) : null
					if (!sllEditNode && prevEditingSll) {
						MapUtils.deleteByValue(state.itemLocks, clientId)
					} else if (sllEditNode && !isItemOwnedActivity(sllEditNode.chosen)) {
						MapUtils.deleteByValue(state.itemLocks, clientId)
					}
					state.presence.set(clientId, { ...clientState, activityState: newActivity })
				}
				success = true
			} else {
				// client ops
				const clientState: ClientPresence = state.presence.get(op.clientId)
					?? { userId: op.userId, away: true, activityState: null, lastSeen: null }
				let newClientState: ClientPresence | undefined
				opSwitch: switch (op.code) {
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

					case 'update-activity': {
						const prevActivity = clientState.activityState
						// gate here so any op that would put the client ON_DASHBOARD of a non-enabled server collapses to null instead
						const newActivity = gateActivityToEnabled(applyActivityUpdate(prevActivity, op.update), state.enabledServers)

						const prevEditingSll = prevActivity ? Trans.editingQueue(prevActivity.opts.serverId).match(prevActivity) : null
						const sllEditNode = newActivity ? Trans.editingQueue(newActivity.opts.serverId).match(newActivity) : null
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
							activityState: newActivity,
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
			firstError ??= { code: 'op-error', op, error: e }
		}
		emit({ code: 'op-outcome', op, success })
	}
	// an op that threw rejects the whole dependent batch, carrying the error for the dispatcher to log
	if (firstError) throw new ODSM.RejectedError<Rejection>(firstError)
	// the reducer always allocates fresh maps, so compare contents to tell whether the batch changed
	// anything; a batch that changed nothing is a benign no-op we reject so it's dropped, not broadcast
	if (Obj.deepEqual(state, prevState)) throw new ODSM.RejectedError<Rejection>({ code: 'noop' })
	return [state, sideEffects]
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

const _playerDialogueVariants = ACTIVITIES.child.ON_PRIMARY_PANEL.child.VIEWING_TEAMS.child.PLAYER_DIALOGUE.child
export const PLAYER_DIALOGUE_ID = z.enum([
	'SWITCHING_PLAYERS',
	'WARNING_PLAYERS',
	'REMOVING_FROM_SQUAD',
	'DISBANDING_SQUAD',
	'RESETTING_SQUAD_NAME',
	'DEMOTING_COMMANDER',
])
export type PlayerDialogueId = z.infer<typeof PLAYER_DIALOGUE_ID>
type PlayerDialogueVariant = (typeof _playerDialogueVariants)[keyof typeof _playerDialogueVariants]['id']
export type PlayerDialogueActivity<
	K extends PlayerDialogueVariant = PlayerDialogueVariant,
> = ST.Match.Node<
	Extract<(typeof _playerDialogueVariants)[keyof typeof _playerDialogueVariants], { id: K }>
>

export const ActivityUpdateSchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('enter-server-dashboard'), serverId: SS.ServerIdSchema }),
	z.object({ code: z.literal('leave-server-dashboard') }),
	z.object({
		code: z.literal('set-primary-panel'),
		to: z.enum(['VIEWING_QUEUE', 'VIEWING_TEAMS']),
		serverId: SS.ServerIdSchema.optional(),
	}),
	z.object({ code: z.literal('clear-primary-panel') }),
	z.object({ code: z.literal('set-editing-teamswitches') }),
	z.object({ code: z.literal('clear-editing-teamswitches') }),
	z.object({ code: z.literal('set-player-dialogue'), dialog: PLAYER_DIALOGUE_ID }),
	z.object({ code: z.literal('clear-player-dialogue') }),
	z.object({ code: z.literal('set-editing-queue'), variant: z.any() }),
	z.object({ code: z.literal('set-editing-queue-idle-if'), currentIds: z.array(z.string()) }),
	z.object({ code: z.literal('clear-editing-queue') }),
	z.object({ code: z.literal('set-viewing-queue-settings') }),
	z.object({ code: z.literal('clear-viewing-queue-settings') }),
	z.object({ code: z.literal('set-changing-queue-settings') }),
	z.object({ code: z.literal('clear-changing-queue-settings') }),
])
export type ActivityUpdate = z.infer<typeof ActivityUpdateSchema>

export function createEditingQueueVariant<K extends EditingQueueVariant>(
	activity: QueueEditingActivity<K>,
): () => ActivityUpdate {
	return () => ({ code: 'set-editing-queue', variant: activity })
}

export function toEditingQueueIdleOrNone(): ActivityUpdate {
	return { code: 'set-editing-queue', variant: ST.Match.leaf('IDLE', {}) as QueueEditingActivity<'IDLE'> }
}

export type ActivityTransitions<M = any> = {
	match: (root: RootActivity | undefined | null) => M
	create: () => ActivityUpdate
	destroy: () => ActivityUpdate
}

export type Resolver<T = any> = (root: RootActivity | undefined | null) => T

// transitions
export namespace Trans {
	export const onDashboard = (serverId: string): ActivityTransitions => ({
		match: (root: RootActivity | undefined | null) => root?.opts.serverId === serverId,
		create: () => ({ code: 'enter-server-dashboard', serverId }),
		destroy: () => ({ code: 'leave-server-dashboard' }),
	})

	export const viewingQueue = (serverId: string) => ({
		match: (root: RootActivity | undefined | null) => {
			if (serverId && !onDashboard(serverId).match(root)) return null
			const primaryPanelChoice = root?.child.ON_PRIMARY_PANEL?.chosen
			if (primaryPanelChoice?.id === 'VIEWING_QUEUE') return primaryPanelChoice
			return null
		},
		create: (): ActivityUpdate => ({ code: 'set-primary-panel', to: 'VIEWING_QUEUE', serverId }),
		destroy: (): ActivityUpdate => ({ code: 'clear-primary-panel' }),
	} satisfies ActivityTransitions)

	export const viewingTeams = (serverId: string) => ({
		match: (root: RootActivity | undefined | null) => {
			if (serverId && !onDashboard(serverId).match(root)) return null
			const primaryPanelChoice = root?.child.ON_PRIMARY_PANEL?.chosen
			if (primaryPanelChoice?.id === 'VIEWING_TEAMS') return primaryPanelChoice
			return null
		},
		create: (): ActivityUpdate => ({ code: 'set-primary-panel', to: 'VIEWING_TEAMS' }),
		destroy: (): ActivityUpdate => ({ code: 'clear-primary-panel' }),
	} satisfies ActivityTransitions)

	export const editingTeamswitches = (serverId: string) => ({
		match: (root: RootActivity | undefined | null) => {
			if (serverId && !onDashboard(serverId).match(root)) return null
			return root?.child.EDITING_TEAMSWITCHES ?? null
		},
		create: (): ActivityUpdate => ({ code: 'set-editing-teamswitches' }),
		destroy: (): ActivityUpdate => ({ code: 'clear-editing-teamswitches' }),
	} satisfies ActivityTransitions)

	export const editingQueue = (serverId: string) => ({
		match: (root: RootActivity | undefined | null) => {
			if (serverId && !onDashboard(serverId).match(root)) return null
			return root?.child.EDITING_QUEUE ?? null
		},
		create: (): ActivityUpdate => ({
			code: 'set-editing-queue',
			variant: ST.Match.leaf('IDLE', {}) as QueueEditingActivity<'IDLE'>,
		}),
		destroy: (): ActivityUpdate => ({ code: 'clear-editing-queue' }),
	} satisfies ActivityTransitions)

	export const viewingSettings = (serverId: string) => ({
		match: (root: RootActivity | undefined | null) => {
			return viewingQueue(serverId).match(root)?.child.VIEWING_QUEUE_SETTINGS ?? null
		},
		create: (): ActivityUpdate => ({ code: 'set-viewing-queue-settings' }),
		destroy: (): ActivityUpdate => ({ code: 'clear-viewing-queue-settings' }),
	} satisfies ActivityTransitions)

	export const changingQueueSettings = (serverId: string) => ({
		match: (root: RootActivity | undefined | null) => {
			return viewingSettings(serverId).match(root)?.child.CHANGING_QUEUE_SETTINGS ?? null
		},
		create: (): ActivityUpdate => ({ code: 'set-changing-queue-settings' }),
		destroy: (): ActivityUpdate => ({ code: 'clear-changing-queue-settings' }),
	} satisfies ActivityTransitions)
}

function getServerId(activity: RootActivity) {
	return activity.opts.serverId
}

export function applyActivityUpdate(_activity: RootActivity | null, update: ActivityUpdate): RootActivity | null {
	let activity = _activity
	if (update.code === 'enter-server-dashboard') {
		if (activity && activity.opts.serverId === update.serverId) return activity
		return {
			_tag: 'branch',
			id: 'ON_DASHBOARD',
			opts: { serverId: update.serverId },
			child: {},
		}
	}
	checkActivity: if (!activity) {
		if (update.code === 'set-primary-panel' && update.serverId) {
			activity = {
				_tag: 'branch',
				id: 'ON_DASHBOARD',
				opts: { serverId: update.serverId },
				child: {},
			}
			break checkActivity
		}
		return null
	}
	const serverId = getServerId(activity)
	switch (update.code) {
		case 'leave-server-dashboard': {
			return null
		}
		case 'set-primary-panel':
			return Im.produce(activity, draft => {
				draft.child.ON_PRIMARY_PANEL = {
					_tag: 'variant',
					id: 'ON_PRIMARY_PANEL',
					opts: {},
					chosen: (update.to === 'VIEWING_QUEUE'
						? ST.Match.branch('VIEWING_QUEUE', {}, {})
						: ST.Match.branch('VIEWING_TEAMS', {}, {})) as any,
				}
			})
		case 'clear-primary-panel':
			return Im.produce(activity, draft => {
				delete draft.child.ON_PRIMARY_PANEL
			})
		case 'set-editing-teamswitches':
			return Im.produce(activity, draft => {
				draft.child.EDITING_TEAMSWITCHES = ST.Match.leaf('EDITING_TEAMSWITCHES', {})
			})
		case 'clear-editing-teamswitches':
			return Im.produce(activity, draft => {
				delete draft.child.EDITING_TEAMSWITCHES
			})
		case 'set-player-dialogue': {
			const withTeams = Trans.viewingTeams(serverId).match(activity)
				? activity
				: applyActivityUpdate(activity, { code: 'set-primary-panel', to: 'VIEWING_TEAMS' })
			return Im.produce(withTeams, draft => {
				const teamsNode = Trans.viewingTeams(serverId).match(draft)
				if (!teamsNode) return
				teamsNode.child.PLAYER_DIALOGUE = {
					_tag: 'variant',
					id: 'PLAYER_DIALOGUE',
					opts: {},
					chosen: ST.Match.leaf(update.dialog, {}) as any,
				}
			})
		}
		case 'clear-player-dialogue':
			return Im.produce(activity, draft => {
				const teamsNode = Trans.viewingTeams(serverId).match(draft)
				if (!teamsNode) return
				delete teamsNode.child.PLAYER_DIALOGUE
			})
		case 'set-editing-queue':
			return Im.produce(activity, draft => {
				draft.child.EDITING_QUEUE = {
					_tag: 'variant',
					id: 'EDITING_QUEUE',
					opts: {},
					chosen: update.variant as any,
				}
			})
		case 'set-editing-queue-idle-if': {
			const currentId = Trans.editingQueue(serverId).match(activity)?.chosen?.id
			if (!currentId || !update.currentIds.includes(currentId)) return activity
			return applyActivityUpdate(activity, {
				code: 'set-editing-queue',
				variant: ST.Match.leaf('IDLE', {}) as QueueEditingActivity<'IDLE'>,
			})
		}
		case 'clear-editing-queue':
			return Im.produce(activity, draft => {
				delete draft.child.EDITING_QUEUE
			})
		case 'set-viewing-queue-settings':
			return Im.produce(activity, draft => {
				const queueNode = Trans.viewingQueue(serverId).match(draft)
				if (!queueNode) return
				queueNode.child.VIEWING_QUEUE_SETTINGS = {
					_tag: 'branch',
					id: 'VIEWING_QUEUE_SETTINGS',
					opts: {},
					child: {},
				}
			})
		case 'clear-viewing-queue-settings':
			return Im.produce(activity, draft => {
				const queueNode = Trans.viewingQueue(serverId).match(draft)
				if (!queueNode) return
				delete queueNode.child.VIEWING_QUEUE_SETTINGS
			})
		case 'set-changing-queue-settings':
			return Im.produce(activity, draft => {
				const settingsNode = Trans.viewingSettings(serverId).match(draft)
				if (!settingsNode) return
				settingsNode.child.CHANGING_QUEUE_SETTINGS = ST.Match.leaf('CHANGING_QUEUE_SETTINGS', {})
			})
		case 'clear-changing-queue-settings':
			return Im.produce(activity, draft => {
				const settingsNode = Trans.viewingSettings(serverId).match(draft)
				if (!settingsNode) return
				delete settingsNode.child.CHANGING_QUEUE_SETTINGS
			})
		default:
			assertNever(update)
	}
}

// Serializes a resolved activity tree back into the sequence of ActivityUpdates that rebuilds it
// from scratch (applyActivityUpdate(null, ...) applied in order reproduces `activity`). Used to
// re-establish presence after a websocket reconnect, where a fresh wsClientId is minted and our
// prior activity is only known client-side.
export function activityToUpdates(activity: RootActivity): ActivityUpdate[] {
	const serverId = activity.opts.serverId
	const updates: ActivityUpdate[] = [{ code: 'enter-server-dashboard', serverId }]

	const primaryPanel = activity.child.ON_PRIMARY_PANEL?.chosen
	if (primaryPanel?.id === 'VIEWING_QUEUE') {
		updates.push({ code: 'set-primary-panel', to: 'VIEWING_QUEUE', serverId })
		if (primaryPanel.child.VIEWING_QUEUE_SETTINGS) {
			updates.push({ code: 'set-viewing-queue-settings' })
			if (primaryPanel.child.VIEWING_QUEUE_SETTINGS.child.CHANGING_QUEUE_SETTINGS) {
				updates.push({ code: 'set-changing-queue-settings' })
			}
		}
	} else if (primaryPanel?.id === 'VIEWING_TEAMS') {
		updates.push({ code: 'set-primary-panel', to: 'VIEWING_TEAMS', serverId })
		const dialogue = primaryPanel.child.PLAYER_DIALOGUE?.chosen
		if (dialogue) updates.push({ code: 'set-player-dialogue', dialog: dialogue.id })
	}

	if (activity.child.EDITING_QUEUE) {
		updates.push({ code: 'set-editing-queue', variant: activity.child.EDITING_QUEUE.chosen })
	}
	if (activity.child.EDITING_TEAMSWITCHES) {
		updates.push({ code: 'set-editing-teamswitches' })
	}

	return updates
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
		ops: Op[]
	}
	| {
		// ops are deterministic, so the originator only receives the ids of its own acked ops and
		// replays its pending copies
		code: 'ack'
		opIds: string[]
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

export function clearQueueEditingActivity(activity: RootActivity | null | undefined): RootActivity | null {
	if (!activity) return null
	return Im.produce(activity, draft => {
		delete draft.child.EDITING_QUEUE
	})
}

export function* iterActivities(state: PresenceState) {
	for (const [wsClientId, presence] of state.entries()) {
		if (!presence.activityState) continue
		yield [presence.activityState, wsClientId] as const
	}
}

export function itemsToLockForActivity(list: LL.List, activity: RootActivity): LL.ItemId[] {
	const dialogActivity = Trans.editingQueue(getServerId(activity)).match(activity)?.chosen
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

export type AnyActivityNode = ST.Match.Node<(typeof ACTIVITIES_FLATTENED)[keyof typeof ACTIVITIES_FLATTENED]>

type ActivityFormatCtx = { listOrIndex: LL.List | LL.ItemIndex; withItemName?: boolean }

type ActivityMessageFormat = {
	id: ActivityCode
	format: string | ((node: ST.Match.Node, ctx: ActivityFormatCtx) => string | null)
}

function resolveItemName(itemId: LL.ItemId, ctx: ActivityFormatCtx): string {
	let index: LL.ItemIndex
	if (Array.isArray(ctx.listOrIndex)) {
		const foundIndex = Obj.destrNullable(LL.findItemById(ctx.listOrIndex, itemId))?.index
		if (!foundIndex) {
			console.warn(`Item ${itemId} not found in list`, ctx.listOrIndex)
			index = { outerIndex: 0, innerIndex: null }
		} else {
			index = foundIndex
		}
	} else {
		index = ctx.listOrIndex
	}
	return index ? LL.getItemNumber(index) : 'Item'
}

const fmt = <K extends keyof typeof ACTIVITIES_FLATTENED>(
	id: K,
	format: string | ((node: ST.Match.Node<(typeof ACTIVITIES_FLATTENED)[K]>, ctx: ActivityFormatCtx) => string | null),
): ActivityMessageFormat => ({ id, format: format as ActivityMessageFormat['format'] })

// lower index -> higher priority
export const ACTIVITY_MESSAGE_FORMATS: ActivityMessageFormat[] = [
	fmt('EDITING_TEAMSWITCHES', 'Editing Scheduled Teamswitches'),
	fmt('SWITCHING_PLAYERS', 'Switching players Now'),
	fmt('WARNING_PLAYERS', 'Warning players'),
	fmt('REMOVING_FROM_SQUAD', 'Removing from squad'),
	fmt('DISBANDING_SQUAD', 'Disbanding squad'),
	fmt('RESETTING_SQUAD_NAME', 'Resetting squad name'),
	fmt('DEMOTING_COMMANDER', 'Demoting commander'),
	fmt('CHANGING_QUEUE_SETTINGS', 'Changing Pool Settings'),
	fmt('ADDING_ITEM', 'Adding layers'),
	fmt('GENERATING_VOTE', 'Generating vote'),
	fmt('ADDING_ITEM_FROM_HISTORY', 'Adding layer from History'),
	fmt('PASTE_ROTATION', 'Pasting rotation'),
	fmt('EDITING_ITEM', (node, ctx) => ctx.withItemName ? `Editing ${resolveItemName(node.opts.itemId, ctx)}` : 'Editing'),
	fmt(
		'CONFIGURING_VOTE',
		(node, ctx) => ctx.withItemName ? `Configuring vote for ${resolveItemName(node.opts.itemId, ctx)}` : 'Configuring vote',
	),
	fmt('MOVING_ITEM', (node, ctx) => ctx.withItemName ? `Moving ${resolveItemName(node.opts.itemId, ctx)}` : 'Moving'),
	fmt('IDLE', 'Editing Queue'),
]

const ACTIVITY_FORMAT_PRIORITY: Map<string, number> = new Map(ACTIVITY_MESSAGE_FORMATS.map((f, i) => [f.id, i]))

export const getHumanReadableActivity = (
	activity: AnyActivityNode,
	listOrIndex: LL.List | LL.ItemIndex,
	withItemName?: boolean,
) => {
	let bestIdx = Infinity
	let bestNode: ST.Match.Node | null = null

	const stack: ST.Match.Node[] = [activity as ST.Match.Node]
	while (stack.length > 0) {
		const node = stack.pop()!
		const idx = ACTIVITY_FORMAT_PRIORITY.get(node.id)
		if (idx !== undefined && idx < bestIdx) {
			bestIdx = idx
			bestNode = node
			if (idx === 0) break
		}
		if (node._tag === 'variant') {
			stack.push(node.chosen)
		} else if (node._tag === 'branch') {
			for (const key in node.child) {
				const child = node.child[key]
				if (child) stack.push(child)
			}
		}
	}

	if (!bestNode) return null
	const { format } = ACTIVITY_MESSAGE_FORMATS[bestIdx]
	return typeof format === 'string' ? format : format(bestNode, { listOrIndex, withItemName })
}

// -------- transient presence events --------
// fed to the presence panel by the SLL/teamswitch onSideEffect handlers when an op lands on the
// synced timeline; displayed briefly as event text next to the user's avatar
export const PRESENCE_EVENT_TEXT = {
	'added-layers': 'Added layers',
	'swapped-factions': 'Swapped factions',
	'deleted-item': 'Deleted an item',
	'cloned-item': 'Cloned an item',
	'moved-item': 'Moved an item',
	'saved-queue': 'Saved the queue',
	'discarded-queue-edits': 'Discarded queue edits',
	'saved-teamswitches': 'Saved teamswitches',
	'executed-teamswitches': 'Executed teamswitches',
	'added-teamswitch': 'Added a teamswitch',
	'removed-teamswitch': 'Removed a teamswitch',
	'cleared-teamswitches': 'Cleared teamswitches',
	'discarded-teamswitch-edits': 'Discarded teamswitch edits',
	'switched-players-now': 'Switched players',
} as const satisfies Record<string, string>
export type PresenceEventAction = keyof typeof PRESENCE_EVENT_TEXT
export type PresenceEvent = { userId: USR.UserId; action: PresenceEventAction }

export const getAttributedHumanReadableActivity = (
	activity: AnyActivityNode,
	listOrIndex: LL.List | LL.ItemIndex,
	displayName: string,
	withItemName?: boolean,
) => {
	const activityText = getHumanReadableActivity(activity, listOrIndex, withItemName)
	if (!activityText) return null
	return `${displayName} is ${activityText.toLowerCase()}`
}
