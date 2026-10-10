import * as CD from '@/lib/ctx-def'
import { createId } from '@/lib/id'
import type { IsolatedSubject } from '@/lib/isolated-subject'
import * as MapUtils from '@/lib/map-utils'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import { assertNever } from '@/lib/type-guards'
import type { DistributiveOmit } from '@/lib/types'
import { z } from '@/lib/zod'
import type * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as USR from '@/models/users.models'

export const DISCONNECT_TIMEOUT = 5_000

export const INTERACT_TIMEOUT = 30_000

// How often an active session repeats page-interaction. Every one is broadcast to every client, and all it changes
// past the first is lastSeen; interaction-timeout stamps the session's end on its own.
export const INTERACTION_HEARTBEAT = 15_000

// -------- activity --------

export const QueueEditingActivitySchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('IDLE') }),
	z.object({
		code: z.literal('ADDING_ITEM'),
		cursor: LL.CursorSchema,
		action: LQY.LAYER_ITEM_ACTION.prefault('add'),
		title: z.string().optional(),
		variant: z.enum(['toggle-position']).optional(),
		selected: z.array(LL.ItemIdSchema).optional(),
	}),
	z.object({ code: z.literal('ADDING_ITEM_FROM_HISTORY') }),
	z.object({ code: z.literal('EDITING_ITEM'), itemId: LL.ItemIdSchema, cursor: LL.CursorSchema }),
	z.object({ code: z.literal('MOVING_ITEM'), itemId: LL.ItemIdSchema }),
	z.object({ code: z.literal('CONFIGURING_VOTE'), itemId: LL.ItemIdSchema }),
	z.object({ code: z.literal('GENERATING_VOTE'), cursor: LL.CursorSchema }),
	z.object({ code: z.literal('PASTE_ROTATION') }),
])
type AnyQueueEditingActivity = z.infer<typeof QueueEditingActivitySchema>
export type QueueEditingCode = AnyQueueEditingActivity['code']
export type QueueEditingActivity<C extends QueueEditingCode = QueueEditingCode> = Extract<AnyQueueEditingActivity, { code: C }>
const QUEUE_EDITING_CODES = QueueEditingActivitySchema.options.map((o) => o.shape.code.value)

const ITEM_OWNED_CODES = new Set<string>(['EDITING_ITEM', 'CONFIGURING_VOTE', 'MOVING_ITEM'] satisfies QueueEditingCode[])
export type ItemOwnedActivity = QueueEditingActivity<'EDITING_ITEM' | 'CONFIGURING_VOTE' | 'MOVING_ITEM'>
export function isItemOwnedActivity(activity: { code: string }): activity is ItemOwnedActivity {
	return ITEM_OWNED_CODES.has(activity.code)
}

export const PLAYER_DIALOGUE_ID = z.enum([
	'SWITCHING_PLAYERS',
	'WARNING_PLAYERS',
	'REMOVING_FROM_SQUAD',
	'DISBANDING_SQUAD',
	'RESETTING_SQUAD_NAME',
	'DEMOTING_COMMANDER',
])
export type PlayerDialogueId = z.infer<typeof PLAYER_DIALOGUE_ID>

const PrimaryPanelSchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('VIEWING_QUEUE'), settings: z.enum(['viewing', 'changing']).optional() }),
	z.object({ code: z.literal('VIEWING_TEAMS'), playerDialogue: PLAYER_DIALOGUE_ID.optional() }),
])
type PrimaryPanel = z.infer<typeof PrimaryPanelSchema>

// Flags are `true` or absent, never `false`, so that one activity has one representation and deepEqual can tell
// when an update changed nothing.
const DashboardActivitySchema = z.object({
	place: z.literal('dashboard'),
	serverId: SS.ServerIdSchema,
	primaryPanel: PrimaryPanelSchema.optional(),
	editingQueue: QueueEditingActivitySchema.optional(),
	editingTeamswaps: z.literal(true).optional(),
	editingLayerRequests: z.literal(true).optional(),
})

const FilterActivitySchema = z.object({
	place: z.literal('filter'),
	filterId: F.FilterEntityIdSchema,
	editingFilter: z.literal(true).optional(),
})

// A client is present in one place at a time, and the places have nothing in common: a server dashboard is
// scoped by serverId, a filter page by filterId.
export const RootActivitySchema = z.discriminatedUnion('place', [DashboardActivitySchema, FilterActivitySchema])
export type DashboardActivity = z.infer<typeof DashboardActivitySchema>
export type FilterActivity = z.infer<typeof FilterActivitySchema>
export type RootActivity = z.infer<typeof RootActivitySchema>

const IDLE: QueueEditingActivity<'IDLE'> = { code: 'IDLE' }

export function dashRoot(activity: RootActivity | null | undefined): DashboardActivity | null {
	return activity?.place === 'dashboard' ? activity : null
}

export function filterRoot(activity: RootActivity | null | undefined): FilterActivity | null {
	return activity?.place === 'filter' ? activity : null
}

// the server whose dashboard the client is on, or undefined if they are somewhere else entirely
export function activityServerId(activity: RootActivity | null | undefined): string | undefined {
	return dashRoot(activity)?.serverId
}

export function activityFilterId(activity: RootActivity | null | undefined): F.FilterEntityId | undefined {
	return filterRoot(activity)?.filterId
}

// What the client is doing in whatever place it is in, without having to name the server or filter first.
// `Trans.editingX(id)` is for asking about a specific one.
export function editingQueue(activity: RootActivity | null | undefined): QueueEditingActivity | undefined {
	return dashRoot(activity)?.editingQueue
}

export function editingTeamswaps(activity: RootActivity | null | undefined): boolean {
	return !!dashRoot(activity)?.editingTeamswaps
}

export function editingLayerRequests(activity: RootActivity | null | undefined): boolean {
	return !!dashRoot(activity)?.editingLayerRequests
}

export function editingFilter(activity: RootActivity | null | undefined): boolean {
	return !!filterRoot(activity)?.editingFilter
}

// `obj` with `key` set to `value`, or removed when `value` is undefined. Returns `obj` itself when nothing changes.
function withField<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
	if (Obj.deepEqual(obj[key], value)) return obj
	const next = { ...obj }
	if (value === undefined) delete next[key]
	else next[key] = value
	return next
}

export const ActivityUpdateSchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('enter-server-dashboard'), serverId: SS.ServerIdSchema }),
	z.object({ code: z.literal('leave-server-dashboard') }),
	z.object({
		code: z.literal('set-primary-panel'),
		to: z.enum(['VIEWING_QUEUE', 'VIEWING_TEAMS']),
		serverId: SS.ServerIdSchema.optional(),
	}),
	z.object({ code: z.literal('clear-primary-panel') }),
	z.object({ code: z.literal('set-editing-teamswaps') }),
	z.object({ code: z.literal('clear-editing-teamswaps') }),
	z.object({ code: z.literal('set-editing-layer-requests') }),
	z.object({ code: z.literal('clear-editing-layer-requests') }),
	z.object({ code: z.literal('set-player-dialogue'), dialog: PLAYER_DIALOGUE_ID }),
	z.object({ code: z.literal('clear-player-dialogue') }),
	z.object({ code: z.literal('set-editing-queue'), activity: QueueEditingActivitySchema }),
	z.object({ code: z.literal('set-editing-queue-idle-if'), currentCodes: z.array(z.string()) }),
	z.object({ code: z.literal('clear-editing-queue') }),
	z.object({ code: z.literal('set-viewing-queue-settings') }),
	z.object({ code: z.literal('clear-viewing-queue-settings') }),
	z.object({ code: z.literal('set-changing-queue-settings') }),
	z.object({ code: z.literal('clear-changing-queue-settings') }),
	z.object({ code: z.literal('enter-filter'), filterId: F.FilterEntityIdSchema }),
	z.object({ code: z.literal('leave-filter') }),
	z.object({ code: z.literal('set-editing-filter') }),
	z.object({ code: z.literal('clear-editing-filter') }),
])
export type ActivityUpdate = z.infer<typeof ActivityUpdateSchema>

export function createEditingQueueVariant(activity: QueueEditingActivity): () => ActivityUpdate {
	return () => ({ code: 'set-editing-queue', activity })
}

export function toEditingQueueIdleOrNone(): ActivityUpdate {
	return { code: 'set-editing-queue', activity: IDLE }
}

// updates aimed at a place the client is not in do nothing: the two places share no activities, so a
// dashboard update reaching a client sitting on a filter page has nothing to apply.
type FilterUpdate = Extract<ActivityUpdate, { code: 'enter-filter' | 'leave-filter' | 'set-editing-filter' | 'clear-editing-filter' }>
type DashboardUpdate = Exclude<ActivityUpdate, FilterUpdate | { code: 'enter-server-dashboard' }>

export function applyActivityUpdate(activity: RootActivity | null, update: ActivityUpdate): RootActivity | null {
	switch (update.code) {
		// entering a place replaces whichever place the client was in before
		case 'enter-server-dashboard': {
			const dash = dashRoot(activity)
			return dash?.serverId === update.serverId ? dash : { place: 'dashboard', serverId: update.serverId }
		}
		case 'enter-filter': {
			const filter = filterRoot(activity)
			return filter?.filterId === update.filterId ? filter : { place: 'filter', filterId: update.filterId }
		}
		case 'leave-filter':
			return filterRoot(activity) ? null : activity
		case 'set-editing-filter':
		case 'clear-editing-filter': {
			const filter = filterRoot(activity)
			if (!filter) return activity
			return withField(filter, 'editingFilter', update.code === 'set-editing-filter' || undefined)
		}
		default:
			return applyDashboardUpdate(activity, update)
	}
}

function applyDashboardUpdate(activity: RootActivity | null, update: DashboardUpdate): RootActivity | null {
	let dash = dashRoot(activity)
	if (!dash) {
		if (update.code !== 'set-primary-panel' || !update.serverId) return activity
		dash = { place: 'dashboard', serverId: update.serverId }
	}
	const panel = dash.primaryPanel
	const withQueueSettings = (settings: 'viewing' | 'changing' | undefined) =>
		panel?.code === 'VIEWING_QUEUE' ? withField(dash, 'primaryPanel', withField(panel, 'settings', settings)) : dash

	switch (update.code) {
		case 'leave-server-dashboard':
			return null
		case 'set-primary-panel':
			return withField(dash, 'primaryPanel', { code: update.to })
		case 'clear-primary-panel':
			return withField(dash, 'primaryPanel', undefined)
		case 'set-editing-teamswaps':
		case 'clear-editing-teamswaps':
			return withField(dash, 'editingTeamswaps', update.code === 'set-editing-teamswaps' || undefined)
		case 'set-editing-layer-requests':
		case 'clear-editing-layer-requests':
			return withField(dash, 'editingLayerRequests', update.code === 'set-editing-layer-requests' || undefined)
		case 'set-player-dialogue':
			return withField(dash, 'primaryPanel', { code: 'VIEWING_TEAMS', playerDialogue: update.dialog })
		case 'clear-player-dialogue':
			if (panel?.code !== 'VIEWING_TEAMS') return dash
			return withField(dash, 'primaryPanel', withField(panel, 'playerDialogue', undefined))
		case 'set-editing-queue':
			return withField(dash, 'editingQueue', update.activity)
		case 'set-editing-queue-idle-if':
			if (!dash.editingQueue || !update.currentCodes.includes(dash.editingQueue.code)) return dash
			return withField(dash, 'editingQueue', IDLE)
		case 'clear-editing-queue':
			return withField(dash, 'editingQueue', undefined)
		case 'set-viewing-queue-settings':
			return withQueueSettings('viewing')
		case 'clear-viewing-queue-settings':
			return withQueueSettings(undefined)
		case 'set-changing-queue-settings':
			return panel?.code === 'VIEWING_QUEUE' && panel.settings ? withQueueSettings('changing') : dash
		case 'clear-changing-queue-settings':
			return panel?.code === 'VIEWING_QUEUE' && panel.settings === 'changing' ? withQueueSettings('viewing') : dash
		default:
			assertNever(update)
	}
}

export type ActiveActivity =
	| QueueEditingActivity
	| { code: 'VIEWING_QUEUE' | 'VIEWING_QUEUE_SETTINGS' | 'CHANGING_QUEUE_SETTINGS' | 'VIEWING_TEAMS' | PlayerDialogueId }
	| { code: 'EDITING_TEAMSWAPS' | 'EDITING_LAYER_REQUESTS' | 'EDITING_FILTER' }
export type ActivityCode = ActiveActivity['code']

// Everything the client is doing, outermost first.
export function activeActivities(activity: RootActivity): ActiveActivity[] {
	if (activity.place === 'filter') return activity.editingFilter ? [{ code: 'EDITING_FILTER' }] : []
	const active: ActiveActivity[] = []
	const panel = activity.primaryPanel
	if (panel?.code === 'VIEWING_QUEUE') {
		active.push({ code: 'VIEWING_QUEUE' })
		if (panel.settings) active.push({ code: 'VIEWING_QUEUE_SETTINGS' })
		if (panel.settings === 'changing') active.push({ code: 'CHANGING_QUEUE_SETTINGS' })
	} else if (panel?.code === 'VIEWING_TEAMS') {
		active.push({ code: 'VIEWING_TEAMS' })
		if (panel.playerDialogue) active.push({ code: panel.playerDialogue })
	}
	if (activity.editingQueue) active.push(activity.editingQueue)
	if (activity.editingLayerRequests) active.push({ code: 'EDITING_LAYER_REQUESTS' })
	if (activity.editingTeamswaps) active.push({ code: 'EDITING_TEAMSWAPS' })
	return active
}

// The activities a presence is described by, highest priority first. UP_Msgs.activity words each one.
export const DESCRIBED_ACTIVITIES = [
	'EDITING_FILTER',
	'EDITING_TEAMSWAPS',
	'EDITING_LAYER_REQUESTS',
	'SWITCHING_PLAYERS',
	'WARNING_PLAYERS',
	'REMOVING_FROM_SQUAD',
	'DISBANDING_SQUAD',
	'RESETTING_SQUAD_NAME',
	'DEMOTING_COMMANDER',
	'CHANGING_QUEUE_SETTINGS',
	'ADDING_ITEM',
	'GENERATING_VOTE',
	'ADDING_ITEM_FROM_HISTORY',
	'PASTE_ROTATION',
	'EDITING_ITEM',
	'CONFIGURING_VOTE',
	'MOVING_ITEM',
	'IDLE',
] as const satisfies ActivityCode[]
export type DescribedActivity = (typeof DESCRIBED_ACTIVITIES)[number]
const ACTIVITY_PRIORITY = new Map<ActivityCode, number>(DESCRIBED_ACTIVITIES.map((code, i) => [code, i]))

// The activities each presence panel describes its users by.
export const QUEUE_PANEL_ACTIVITIES: ReadonlySet<ActivityCode> = new Set<ActivityCode>([
	...QUEUE_EDITING_CODES,
	'EDITING_LAYER_REQUESTS',
	'CHANGING_QUEUE_SETTINGS',
])
export const TEAMS_PANEL_ACTIVITIES: ReadonlySet<ActivityCode> = new Set<ActivityCode>([...PLAYER_DIALOGUE_ID.options, 'EDITING_TEAMSWAPS'])
export const FILTER_PAGE_ACTIVITIES: ReadonlySet<ActivityCode> = new Set<ActivityCode>(['EDITING_FILTER'])

// itemName is only set for the activities that act on one queue item, and only when asked for
export type ActivityDescriptor = { id: DescribedActivity; itemName?: string }

function resolveItemName(itemId: LL.ItemId, listOrIndex: LL.List | LL.ItemIndex): string {
	if (!Array.isArray(listOrIndex)) return LL.getItemNumber(listOrIndex)
	const index = Obj.destrNullable(LL.findItemById(listOrIndex, itemId))?.index
	if (!index) console.warn(`Item ${itemId} not found in list`, listOrIndex)
	return LL.getItemNumber(index ?? { outerIndex: 0, innerIndex: null })
}

// The highest-priority described activity, considering only those in `among` when it is given.
export function describeActivity(
	activity: RootActivity,
	listOrIndex: LL.List | LL.ItemIndex,
	opts: { withItemName?: boolean; among?: ReadonlySet<ActivityCode> } = {},
): ActivityDescriptor | null {
	let best: ActiveActivity | undefined
	let bestIdx = Infinity
	for (const active of activeActivities(activity)) {
		if (opts.among && !opts.among.has(active.code)) continue
		const idx = ACTIVITY_PRIORITY.get(active.code)
		if (idx !== undefined && idx < bestIdx) {
			bestIdx = idx
			best = active
		}
	}
	if (!best) return null
	const id = DESCRIBED_ACTIVITIES[bestIdx]
	if (!opts.withItemName || !isItemOwnedActivity(best)) return { id }
	return { id, itemName: resolveItemName(best.itemId, listOrIndex) }
}

export type Resolver<T = any> = (root: RootActivity | undefined | null) => T

export type ActivityTransitions<M = any> = {
	match: Resolver<M>
	create: () => ActivityUpdate
	destroy: () => ActivityUpdate
}

function trans<M>(match: Resolver<M>, create: ActivityUpdate, destroy: ActivityUpdate): ActivityTransitions<M> {
	return { match, create: () => create, destroy: () => destroy }
}

export namespace Trans {
	// the dashboard, but only when it is the one for `serverId`. An empty serverId matches any dashboard, which is
	// what the panels rendering outside a server scope rely on.
	function dashFor(serverId: string, root: RootActivity | undefined | null) {
		const dash = dashRoot(root)
		return dash && (!serverId || dash.serverId === serverId) ? dash : null
	}

	function primaryPanel<C extends PrimaryPanel['code']>(serverId: string, code: C) {
		return (root: RootActivity | undefined | null) => {
			const panel = dashFor(serverId, root)?.primaryPanel
			return panel?.code === code ? (panel as Extract<PrimaryPanel, { code: C }>) : null
		}
	}

	export const onDashboard = (serverId: string) =>
		trans((root) => activityServerId(root) === serverId, { code: 'enter-server-dashboard', serverId }, { code: 'leave-server-dashboard' })

	export const onFilter = (filterId: F.FilterEntityId) =>
		trans((root) => activityFilterId(root) === filterId, { code: 'enter-filter', filterId }, { code: 'leave-filter' })

	export const editingFilter = (filterId: F.FilterEntityId) =>
		trans(
			(root) => {
				const filter = filterRoot(root)
				return !!filter?.editingFilter && (!filterId || filter.filterId === filterId)
			},
			{ code: 'set-editing-filter' },
			{ code: 'clear-editing-filter' },
		)

	export const viewingQueue = (serverId: string) =>
		trans(
			primaryPanel(serverId, 'VIEWING_QUEUE'),
			{ code: 'set-primary-panel', to: 'VIEWING_QUEUE', serverId },
			{
				code: 'clear-primary-panel',
			},
		)

	export const viewingTeams = (serverId: string) =>
		trans(primaryPanel(serverId, 'VIEWING_TEAMS'), { code: 'set-primary-panel', to: 'VIEWING_TEAMS' }, { code: 'clear-primary-panel' })

	export const editingTeamswaps = (serverId: string) =>
		trans((root) => !!dashFor(serverId, root)?.editingTeamswaps, { code: 'set-editing-teamswaps' }, { code: 'clear-editing-teamswaps' })

	export const editingLayerRequests = (serverId: string) =>
		trans(
			(root) => !!dashFor(serverId, root)?.editingLayerRequests,
			{ code: 'set-editing-layer-requests' },
			{
				code: 'clear-editing-layer-requests',
			},
		)

	export const editingQueue = (serverId: string) =>
		trans((root) => dashFor(serverId, root)?.editingQueue ?? null, toEditingQueueIdleOrNone(), { code: 'clear-editing-queue' })

	export const viewingSettings = (serverId: string) =>
		trans(
			(root) => !!viewingQueue(serverId).match(root)?.settings,
			{ code: 'set-viewing-queue-settings' },
			{
				code: 'clear-viewing-queue-settings',
			},
		)

	export const changingQueueSettings = (serverId: string) =>
		trans(
			(root) => viewingQueue(serverId).match(root)?.settings === 'changing',
			{ code: 'set-changing-queue-settings' },
			{
				code: 'clear-changing-queue-settings',
			},
		)
}

// -------- ops --------

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
		update: ActivityUpdateSchema,
	}),

	// remotely reset one of the dispatching user's other clients (clears its activity, marks it away).
	// the reducer enforces that targetClientId belongs to the same user as the dispatching client.
	z.object({
		...clientOpBase,
		code: z.literal('reset-client'),
		targetClientId: z.string(),
	}),

	// the server's layer queue / teamswaps were saved (or otherwise resolved), so nobody is editing them
	// anymore. scoped to the server whose state was resolved: clients on other servers are untouched
	z.object({
		...serverOpBase,
		code: z.literal('sll:end-all-editing'),
		serverId: z.string(),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('teamswaps:end-all-editing'),
		serverId: z.string(),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('layer-requests:end-all-editing'),
		serverId: z.string(),
	}),

	// a filter's shared draft was saved, so nobody is editing it anymore. Scoped to that filter: clients
	// on any other filter are untouched
	z.object({
		...serverOpBase,
		code: z.literal('filter:end-all-editing'),
		filterId: F.FilterEntityIdSchema,
	}),

	// the filter was deleted, so there is nothing left to be present on
	z.object({
		...serverOpBase,
		code: z.literal('filter:removed'),
		filterId: F.FilterEntityIdSchema,
	}),

	// the socket dropped without a clean close -- hold the client's activity (and locks) so a
	// reconnecting client can steal it; a spinner is shown until it resolves
	z.object({
		...serverOpBase,
		code: z.literal('connection-interrupted'),
		clientId: z.string(),
	}),

	// the client is gone for good (clean close, or interrupted past DISCONNECT_TIMEOUT): clear its
	// activity and release its locks
	z.object({
		...serverOpBase,
		code: z.literal('client-disconnected'),
		clientId: z.string(),
	}),

	// a reconnecting socket reclaimed this interrupted client's id, so its activity and locks carry over
	// untouched -- just mark it live again
	z.object({
		...serverOpBase,
		code: z.literal('connection-restored'),
		clientId: z.string(),
	}),

	z.object({
		...serverOpBase,
		code: z.literal('clean-stale-presence'),
		clientIdsToRemove: z.array(z.string()),
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

export const CLIENT_OP_CODE = z.enum(['page-interaction', 'interaction-timeout', 'navigated-away', 'update-activity', 'reset-client'])
type ClientOpCode = z.infer<typeof CLIENT_OP_CODE>

export type Op = z.infer<typeof OpSchema>
export type ClientOp = Extract<Op, { code: ClientOpCode }>
export type NewClientOp = DistributiveOmit<Op, 'userId' | 'clientId' | 'opId' | 'time'>

export type SideEffects = { code: 'op-outcome'; op: Op; success: boolean }

// the typed payload carried by a RejectedError thrown from the reducer: an op that threw while being
// applied, or a benign no-op batch that changed nothing
export type Rejection = { code: 'op-error'; op: Op; error: unknown } | { code: 'noop' }

// -------- state --------

// 'connected': a live socket. 'connection-interrupted': the socket dropped without a clean close
// (network blip) -- we keep the activityState around so a reconnecting client can steal it, and show a
// spinner meanwhile. 'disconnected': cleanly closed, or interrupted past DISCONNECT_TIMEOUT; activity
// is cleared.
export const ConnectionStateSchema = z.enum(['connected', 'connection-interrupted', 'disconnected'])
export type ConnectionState = z.infer<typeof ConnectionStateSchema>

export const ClientPresenceSchema = z.object({
	userId: USR.UserIdSchema,
	away: z.boolean(),
	connectionState: ConnectionStateSchema,
	lastSeen: z.number().positive().nullable(),
	activityState: RootActivitySchema.nullable(),
})

export type ClientPresence = z.infer<typeof ClientPresenceSchema>

export const PresenceStateSchema = z.map(z.string(), ClientPresenceSchema)
export type PresenceState = z.infer<typeof PresenceStateSchema>

export type ItemLocks = Map<LL.ItemId, string>

// enabledServers: the servers that currently have a live managed server (enabled + non-broken). a client can only be
// present on one of these; presence for any other server is collapsed to null. kept in sync by the server via
// 'set-enabled-servers' ops.
export type State = { presence: PresenceState; itemLocks: ItemLocks; enabledServers: Set<string> }
export function initState(): State {
	return {
		presence: new Map(),
		itemLocks: new Map(),
		enabledServers: new Set(),
	}
}

// the shape of the data flowing from server to client
export type PresenceUpdate = ODSM.ClientUpdate<State, Op, Rejection['code']>

// -------- reducer --------

export const reducer: ODSM.Reducer<Op, State, SideEffects> = (prevState, ops, _prevOps) => {
	const state: State = {
		presence: new Map(prevState.presence),
		itemLocks: new Map(prevState.itemLocks),
		enabledServers: new Set(prevState.enabledServers),
	}
	const sideEffects: SideEffects[] = []
	// the first op that throws rejects the whole (dependent) batch; recorded here and thrown below
	let firstError: Rejection | undefined

	for (const op of ops) {
		let success = false
		try {
			success = applyOp(state, op)
		} catch (e) {
			firstError ??= { code: 'op-error', op, error: e }
		}
		sideEffects.push({ code: 'op-outcome', op, success })
	}
	// an op that threw rejects the whole dependent batch, carrying the error for the dispatcher to log
	if (firstError) throw new ODSM.RejectedError<Rejection>(firstError)
	// the reducer always allocates fresh maps, so compare contents to tell whether the batch changed
	// anything; a batch that changed nothing is a benign no-op we reject so it's dropped, not broadcast
	if (Obj.deepEqual(state, prevState)) throw new ODSM.RejectedError<Rejection>({ code: 'noop' })
	return [state, sideEffects]
}

const END_EDITING_UPDATE = {
	'sll:end-all-editing': 'clear-editing-queue',
	'teamswaps:end-all-editing': 'clear-editing-teamswaps',
	'layer-requests:end-all-editing': 'clear-editing-layer-requests',
} as const

// ending one of these editing sessions is a user-level intent, so it applies to all of the user's clients
const USER_LEVEL_UPDATES = new Set<ActivityUpdate['code']>([
	'clear-editing-queue',
	'clear-editing-teamswaps',
	'clear-editing-layer-requests',
])

// applies one op to `state` in place, returning whether it took effect
function applyOp(state: State, op: Op): boolean {
	switch (op.code) {
		case 'connection-interrupted':
			// activityState and locks are kept, so a reconnecting client of the same user can steal them back
			patchClient(state, op.clientId, { connectionState: 'connection-interrupted' })
			return true
		case 'connection-restored':
			patchClient(state, op.clientId, { connectionState: 'connected' })
			return true
		case 'client-disconnected':
			patchClient(state, op.clientId, { connectionState: 'disconnected', away: true, activityState: null })
			return true
		case 'clean-stale-presence':
			for (const clientId of op.clientIdsToRemove) state.presence.delete(clientId)
			MapUtils.deleteByValue(state.itemLocks, ...op.clientIdsToRemove)
			return true
		case 'sll:end-all-editing':
		case 'teamswaps:end-all-editing':
		case 'layer-requests:end-all-editing': {
			// the draft is shared by everyone on the server, so resolving it (save, revert, execute...) ends every
			// one of their editing sessions at once
			const update: ActivityUpdate = { code: END_EDITING_UPDATE[op.code] }
			for (const [clientId, client] of state.presence) {
				if (activityServerId(client.activityState) === op.serverId) updateClientActivity(state, clientId, update)
			}
			return true
		}
		case 'filter:end-all-editing':
			for (const [clientId, client] of state.presence) {
				if (activityFilterId(client.activityState) === op.filterId)
					updateClientActivity(state, clientId, { code: 'clear-editing-filter' })
			}
			return true
		case 'filter:removed':
			for (const [clientId, client] of state.presence) {
				if (activityFilterId(client.activityState) === op.filterId) patchClient(state, clientId, { activityState: null })
			}
			return true
		case 'set-enabled-servers':
			state.enabledServers = new Set(op.serverIds)
			for (const [clientId, client] of state.presence) {
				patchClient(state, clientId, { activityState: gateActivityToEnabled(client.activityState, state.enabledServers) })
			}
			return true
		case 'page-interaction':
			// the user is back on this client, so their other clients that went away stop showing what they were doing
			for (const [clientId, other] of otherClientsOf(state, op)) {
				if (other.away && other.activityState) patchClient(state, clientId, { activityState: null })
			}
			putClient(state, op.clientId, { ...clientOf(state, op), away: false, lastSeen: op.time })
			return true
		case 'interaction-timeout': {
			const client = clientOf(state, op)
			let otherActive = false
			for (const [, other] of otherClientsOf(state, op)) otherActive ||= !other.away && !!other.activityState
			putClient(state, op.clientId, {
				...client,
				away: true,
				// with another of the user's clients active, this one disappears instead of going away
				activityState: otherActive ? null : client.activityState,
				// the timeout fires INTERACT_TIMEOUT after the last activity, which the heartbeat stamped only roughly
				lastSeen: Math.max(client.lastSeen ?? 0, op.time - INTERACT_TIMEOUT),
			})
			return true
		}
		case 'navigated-away':
			putClient(state, op.clientId, { ...clientOf(state, op), away: true, activityState: null })
			return true
		case 'reset-client': {
			const target = state.presence.get(op.targetClientId)
			if (target?.userId !== op.userId) return false
			putClient(state, op.targetClientId, { ...target, away: true, activityState: null })
			return true
		}
		case 'update-activity': {
			const client = clientOf(state, op)
			const activityState = gateActivityToEnabled(applyActivityUpdate(client.activityState, op.update), state.enabledServers)
			if (!putClient(state, op.clientId, { ...client, away: false, activityState, lastSeen: op.time })) return false
			if (USER_LEVEL_UPDATES.has(op.update.code)) {
				for (const [clientId] of otherClientsOf(state, op)) updateClientActivity(state, clientId, op.update)
			}
			return true
		}
		default:
			assertNever(op)
	}
}

// the dispatching client's presence, which is connected because it just sent an op
function clientOf(state: State, op: ClientOp): ClientPresence {
	const client = state.presence.get(op.clientId)
	if (!client) return { userId: op.userId, away: true, connectionState: 'connected', activityState: null, lastSeen: null }
	return { ...client, connectionState: 'connected' }
}

function* otherClientsOf(state: State, op: ClientOp) {
	for (const entry of state.presence) {
		if (entry[0] !== op.clientId && entry[1].userId === op.userId) yield entry
	}
}

// Records a client's presence and moves its queue item lock to match its activity. Records nothing and returns
// false when the activity is on an item another client holds.
function putClient(state: State, clientId: string, next: ClientPresence): boolean {
	if (state.presence.get(clientId)?.activityState !== next.activityState) {
		const edit = editingQueue(next.activityState)
		const itemId = edit && isItemOwnedActivity(edit) ? edit.itemId : undefined
		const holder = itemId === undefined ? undefined : state.itemLocks.get(itemId)
		if (holder !== undefined && holder !== clientId) return false
		MapUtils.deleteByValue(state.itemLocks, clientId)
		if (itemId !== undefined) state.itemLocks.set(itemId, clientId)
	}
	state.presence.set(clientId, next)
	return true
}

// a client that isn't present is left absent
function patchClient(state: State, clientId: string, patch: Partial<ClientPresence>) {
	const client = state.presence.get(clientId)
	if (client) putClient(state, clientId, { ...client, ...patch })
}

function updateClientActivity(state: State, clientId: string, update: ActivityUpdate) {
	const client = state.presence.get(clientId)
	if (!client) return
	const activityState = gateActivityToEnabled(applyActivityUpdate(client.activityState, update), state.enabledServers)
	if (activityState !== client.activityState) putClient(state, clientId, { ...client, activityState })
}

// collapses a dashboard activity to null when its server isn't currently enabled -- users can't be present on
// a server with no live managed server. A filter page has no server to be gated by.
function gateActivityToEnabled(activity: RootActivity | null, enabledServers: Set<string>): RootActivity | null {
	const serverId = activityServerId(activity)
	if (serverId !== undefined && !enabledServers.has(serverId)) return null
	return activity
}

export function anyLocksInaccessible(locks: ItemLocks, ids: LL.ItemId[], wsClientId: string): boolean {
	for (const id of ids) {
		const existingLock = locks.get(id)
		if (existingLock && existingLock !== wsClientId) return true
	}
	return false
}

export function itemsToLockForActivity(list: LL.List, activity: RootActivity): LL.ItemId[] {
	const edit = editingQueue(activity)
	if (!edit || !isItemOwnedActivity(edit)) return []
	const item = LL.findItemById(list, edit.itemId)?.item
	if (!item) return []
	const ids: LL.ItemId[] = [edit.itemId]
	const parentItem = LL.findParentItem(list, edit.itemId)
	if (parentItem) ids.push(parentItem.itemId)
	if (LL.isVoteItem(item)) ids.push(...item.choices.map((choice) => choice.itemId))
	return ids
}

// no presence instances older than this should be displayed
export const DISPLAYED_AWAY_PRESENCE_WINDOW = 1000 * 60 * 10

// each user's most recently seen client
export function resolveUserPresence(state: PresenceState) {
	const presenceByUser = new Map<bigint, ClientPresence>()
	for (const presence of state.values()) {
		const existing = presenceByUser.get(presence.userId)
		if (!existing || (presence.lastSeen && (!existing.lastSeen || presence.lastSeen > existing.lastSeen))) {
			presenceByUser.set(presence.userId, presence)
		}
	}
	return presenceByUser
}

// -------- transient presence events --------
// emitted by the SLL/teamswap onSideEffect handlers when an op lands on the synced timeline; the presence
// panel displays UP_Msgs.presenceEventText briefly next to the user's avatar
export const PRESENCE_EVENT_ACTIONS = [
	'added-layers',
	'swapped-factions',
	'deleted-item',
	'cloned-item',
	'moved-item',
	'added-tag',
	'added-note',
	'saved-queue',
	'discarded-queue-edits',
	'saved-teamswaps',
	'executed-teamswaps',
	'added-teamswap',
	'removed-teamswap',
	'cleared-teamswaps',
	'discarded-teamswap-edits',
	'swapped-players-now',
	'added-layer-request',
	'edited-layer-request',
	'removed-layer-request',
	'moved-layer-request',
	'combined-layer-requests',
	'saved-layer-requests',
	'discarded-layer-request-edits',
	'saved-filter',
	'discarded-filter-edits',
] as const
export type PresenceEventAction = (typeof PRESENCE_EVENT_ACTIONS)[number]
export type PresenceEvent = { userId: USR.UserId; action: PresenceEventAction }

export type Ctx = CS.Ctx & {
	userPresence: {
		session: ODSM.Server.Session<Op, State>
		op$: IsolatedSubject<ODSM.Server.Dispatched<Op, Rejection>>
		abandoned$: IsolatedSubject<{ serverId: string; scope: Ctx.DraftScope }>
		// filter drafts are keyed by filter rather than by server, so they get their own signal
		filterAbandoned$: IsolatedSubject<string>
	}
}

export const CtxDef = CD.defCtx<Ctx>()(['userPresence'], { name: 'userPresence' })

export namespace Ctx {
	export type DraftScope = 'queue' | 'layer-requests'
}
