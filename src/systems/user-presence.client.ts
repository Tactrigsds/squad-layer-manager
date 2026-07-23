import { frameManager } from '@/frames/frame-manager'
import * as GenVoteFrame from '@/frames/gen-vote.frame'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Lifecycle from '@/lib/lifecycle'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import * as RxHelpers from '@/lib/react-rxjs-helpers'
import type * as ST from '@/lib/state-tree'
import * as ZusUtils from '@/lib/zustand'
import * as LL from '@/models/layer-list.models'

import * as UP from '@/models/user-presence'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import type * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'

// -------- Loader types --------
type ActivityLoaderConfig<Name extends string = string, Key = any, Data = any> = Lifecycle.LoaderConfig<
	Name,
	Key,
	Data,
	Store,
	UP.RootActivity
>
export type LoaderCacheEntry<Config extends ActivityLoaderConfig, Loaded extends boolean = boolean> = Lifecycle.LoaderCacheEntry<
	Config,
	Loaded
>
export type LoaderData<Config extends ActivityLoaderConfig> = Lifecycle.LoaderData<Config>
export type LoaderCacheKey<Config extends ActivityLoaderConfig> = Lifecycle.LoaderKey<Config>

// bridges non-component code to the currently-active squadServer frame. Relies on the frame
// already being alive (set up by the servers/$serverId route loader) -- ensureSetup just dedupes onto it.
function getCurrentServerKey() {
	const serverId = SquadServerClient.SelectedServerStore.getState().selectedServerId
	const serverConfig = SettingsClient.getSettings()?.servers.find(s => s.id === serverId)
	// don't build a frame for a server with no live slice -- it would just spam subscription errors
	if (!SettingsClient.isServerUsable(serverConfig)) return undefined
	return frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverConfig.id))
}

function getCurrentLayerList(): LL.Item[] {
	const key = getCurrentServerKey()
	return key ? frameManager.getState(key)?.queue.layerList ?? [] : []
}

export type ConfiguredLoaders = typeof ACTIVITY_LOADER_CONFIGS
export type ConfiguredLoaderConfig = ConfiguredLoaders[number]

/** Discriminated union of all loaded activity states - narrows automatically on `name` check */
export type LoadedActivityState = Lifecycle.LoaderCacheEntryUnion<ConfiguredLoaders, true>

function createActivityLoaderConfig<Name extends string, Key extends ST.Match.Node>(
	name: Name,
	match: (state: UP.RootActivity) => Key | undefined,
) {
	return <Data>(config: Lifecycle.LoaderConfigOptions<Key, Data, Store>) =>
		Lifecycle.createLoaderConfig<Name, Key, UP.RootActivity>(name, match)<Data, Store>(config)
}

export const ACTIVITY_LOADER_CONFIGS = [
	createActivityLoaderConfig(
		'selectLayers',
		s => {
			const node = UP.Trans.editingQueue(s.opts.serverId).match(s)?.chosen
			if (node?.id === 'ADDING_ITEM' || node?.id === 'EDITING_ITEM') return { serverId: s.opts.serverId, ...node }
			return undefined
		},
	)({
		unloadOnLeave: true,

		load(args) {
			let editedLayerId: string | undefined
			if (args.key.id === 'EDITING_ITEM') {
				const layerList = getCurrentLayerList()
				const { item } = Obj.destrNullable(LL.findItemById(layerList, args.key.opts.itemId))
				if (item) editedLayerId = item.layerId
			}
			const squadServerInput = SquadServerFrame.createInput(args.key.serverId)
			const squadServer = frameManager.ensureSetup(SquadServerFrame.frame, squadServerInput)
			const input = SelectLayersFrame.createInput({
				cursor: args.key.opts.cursor,
				initialEditedLayerId: editedLayerId,
				squadServer: squadServer,
			})
			const frameKey = frameManager.ensureSetup(SelectLayersFrame.frame, input)
			return { selectLayersFrame: frameKey, activity: args.key }
		},
		onEnter(_args) {},
		onUnload(args) {
			if (args.data) void requestIdleCallback(() => frameManager.teardown(args.data!.selectLayersFrame))
		},
		checkShouldUnload(args) {
			if (args.key.opts.cursor.type !== 'item-relative') return false
			const itemId = args.key.opts.cursor.itemId
			return !LL.findItemById(getCurrentLayerList(), itemId)
		},
	}),
	createActivityLoaderConfig(
		'genVote',
		s => {
			const node = UP.Trans.editingQueue(s.opts.serverId).match(s)?.chosen
			if (node?.id === 'GENERATING_VOTE') return { serverId: s.opts.serverId, ...node }
			return undefined
		},
	)({
		unloadOnLeave: true,
		load(args) {
			const squadServerInput = SquadServerFrame.createInput(args.key.serverId)
			const squadServer = frameManager.ensureSetup(SquadServerFrame.frame, squadServerInput)
			const input = GenVoteFrame.createInput({ cursor: { type: 'start' }, server: squadServer })
			const frameKey = frameManager.ensureSetup(GenVoteFrame.frame, input)
			return { genVoteFrame: frameKey, activity: args.key }
		},
		onUnload(args) {
			if (args.data) void requestIdleCallback(() => frameManager.teardown(args.data!.genVoteFrame))
		},
	}),
	createActivityLoaderConfig('pasteRotation', s => {
		const node = UP.Trans.editingQueue(s.opts.serverId).match(s)?.chosen
		if (node?.id === 'PASTE_ROTATION') return node
		return undefined
	})({
		unloadOnLeave: true,
		load(args) {
			return { activity: args.key }
		},
	}),
] as const

// -------- PresenceStore --------

export type Store = {
	userPresence: Map<bigint, UP.ClientPresence>

	hoveredActivityUserId: USR.UserId | null

	activityLoaderCache: LoaderCacheEntry<ConfiguredLoaderConfig>[]

	session: ODSM.Client.Session<UP.Op, UP.State>

	presence: UP.PresenceState
	editors: Set<USR.UserId>
	teamswapEditors: Set<USR.UserId>
	layerRequestEditors: Set<USR.UserId>
	// derived: resolved per-user presence (latest session wins per userId)
}

// assigned during createPresenceStore -- module-level so Actions.preloadActivity can reach it
let loaderCtx: Lifecycle.LoaderManagerContext<ConfiguredLoaderConfig, Store>

// the server opens with an 'init' update, so silence here is a genuine fault rather than an idle event feed
const [_usePresenceUpdate, presenceUpdate$] = RxHelpers.bind<UP.PresenceUpdate>(
	'userPresence.presenceUpdate',
	RPC.observe('userPresence.watchUpdates', () => RPC.orpc.userPresence.watchUpdates.call()),
)

export const Store = createPresenceStore()

function createPresenceStore() {
	const store = Zus.createStore<Store>((set, get, store) => {
		loaderCtx = {
			configs: ACTIVITY_LOADER_CONFIGS,
			getCache: (draft: Im.Draft<Store>) => draft.activityLoaderCache as Lifecycle.LoaderCacheEntry<ConfiguredLoaderConfig>[],
			setCache: (draft: Im.Draft<Store>, cache: Lifecycle.LoaderCacheEntry<ConfiguredLoaderConfig>[]) => {
				draft.activityLoaderCache = cache
			},
			set: (updater: (state: Store) => Store) => set(updater),
			getCurrentState: () => get(),
		}

		store.subscribe((state, prev) => {
			const presence = state.session.localState.presence
			let toUpdate: Partial<Store> = {}
			if (presence !== state.presence) {
				toUpdate.presence = presence
				toUpdate.userPresence = UP.resolveUserPresence(presence)
				const config = ConfigClient.getConfig()
				if (config) {
					const wsClientId = config.wsClientId
					const prevClientActivityState = prev.presence.get(wsClientId)?.activityState ?? null
					const clientActivityState = presence.get(wsClientId)?.activityState ?? null
					// compare by value, not reference: a reconnect re-inits from a fresh server snapshot, so an
					// activityState preserved through a connection interruption comes back as a new (deep-equal)
					// object. Reference equality would spuriously re-fire loader events and reload the frames.
					if (!Obj.deepEqual(prevClientActivityState, clientActivityState)) {
						Lifecycle.dispatchLoaderEvents(loaderCtx, clientActivityState, prevClientActivityState, false)
					}
				}
				const editors = new Set<USR.UserId>()
				const teamswapEditors = new Set<USR.UserId>()
				const layerRequestEditors = new Set<USR.UserId>()
				for (const client of presence.values()) {
					const activity = client.activityState
					if (activity && UP.Trans.editingQueue(activity.opts.serverId).match(activity)) {
						editors.add(client.userId)
					}
					if (activity && UP.Trans.editingTeamswaps(activity.opts.serverId).match(activity)) {
						teamswapEditors.add(client.userId)
					}
					if (activity && UP.Trans.editingLayerRequests(activity.opts.serverId).match(activity)) {
						layerRequestEditors.add(client.userId)
					}
				}
				if (!Obj.deepEqual(editors, state.editors)) {
					toUpdate.editors = editors
				}
				if (!Obj.deepEqual(teamswapEditors, state.teamswapEditors)) {
					toUpdate.teamswapEditors = teamswapEditors
				}
				if (!Obj.deepEqual(layerRequestEditors, state.layerRequestEditors)) {
					toUpdate.layerRequestEditors = layerRequestEditors
				}
			}

			if (!Obj.isEmpty(toUpdate)) {
				set(toUpdate)
			}

			Lifecycle.checkAndUnloadStaleEntries(loaderCtx, state)
		})

		const session = ODSM.Client.initSession<UP.Op, UP.State>(UP.initState())
		return {
			session,
			presence: session.localState.presence,
			editors: new Set(),
			teamswapEditors: new Set(),
			layerRequestEditors: new Set(),
			userPresence: new Map(),
			activityLoaderCache: [],

			hoveredActivityUserId: null,
		}
	})

	return store
}

function handleIncomingPresenceUpdate(update: UP.PresenceUpdate) {
	const prev = Store.getState().session
	// presence has no client-side side effects, so the onSideEffects hook is omitted
	const next = ODSM.Client.applyUpdate(prev, update, UP.reducer, {
		onDiverged: (phase, error) =>
			console.error(`${phase === 'op' ? 'incoming' : 'acked'} presence ops diverged from the server:`, error.data),
		onRejected: reason => {
			if (reason !== 'noop') console.error('presence ops rejected by the server:', reason)
		},
		onUnknownAcks: opIds => console.warn('received ack for unknown presence ops', opIds),
	})
	if (next !== prev) Store.setState({ session: next })
}

export namespace Actions {
	export function setHoveredActivityUserId(userId: USR.UserId, hovered: boolean) {
		if (!hovered) {
			if (userId !== Store.getState().hoveredActivityUserId) return
			Store.setState({ hoveredActivityUserId: null })
			return
		}
		Store.setState({ hoveredActivityUserId: userId })
	}

	export function dispatch(...newOps: UP.NewClientOp[]) {
		const userId = UsersClient.loggedInUserId
		const config = ConfigClient.getConfig()
		if (!config || !userId) return
		const ops: UP.ClientOp[] = []
		for (const newOp of newOps) {
			const op: UP.ClientOp = { ...newOp, userId, clientId: config.wsClientId, time: Date.now(), opId: UP.createOpId() } as UP.ClientOp
			ops.push(op)
		}
		const prev = Store.getState().session
		const res = ODSM.Client.processOutgoingOps(prev, ops, UP.reducer)
		if (res.rejected) {
			// batch is a no-op (or an op threw) against local state; drop it without sending
			const rejection = res.error.data as UP.Rejection
			if (rejection.code === 'op-error') console.error('presence op errored:', rejection.error)
			return
		}
		Store.setState({ session: res.session })
		for (const op of ops) {
			console.log('dispatch ', op.code, op.code === 'update-activity' ? op.update.code : null)
		}
		void RPC.orpc.userPresence.dispatchOp.call(ops)
	}

	export function updateActivity(...updates: UP.ActivityUpdate[]) {
		dispatch(...updates.map((update): UP.NewClientOp => ({ code: 'update-activity', update })))
	}

	// remotely reset one of the current user's OTHER clients (clears its activity, marks it away). the
	// reducer enforces same-user ownership.
	export function resetClient(targetClientId: string) {
		dispatch({ code: 'reset-client', targetClientId })
	}

	// reset every one of the current user's clients except this one
	export function resetOtherClients() {
		const config = ConfigClient.getConfig()
		const userId = UsersClient.loggedInUserId
		if (!config || !userId) return
		const ops: UP.NewClientOp[] = []
		for (const [clientId, presence] of Store.getState().presence) {
			if (presence.userId !== userId || clientId === config.wsClientId) continue
			ops.push({ code: 'reset-client', targetClientId: clientId })
		}
		if (ops.length > 0) dispatch(...ops)
	}

	// Establishes (or corrects) the local client's dashboard presence so it reflects the panel they're
	// viewing. Idempotent: only dispatches when the dashboard or panel differs, so it never clobbers a
	// sub-activity (queue settings, player dialogue) when the panel is already correct. Used by the
	// dashboard route once the client is engaged (navigated in, or has interacted).
	export function ensureViewingPanel(serverId: string, panel: 'VIEWING_QUEUE' | 'VIEWING_TEAMS') {
		const config = ConfigClient.getConfig()
		if (!config) return
		const activity = Store.getState().presence.get(config.wsClientId)?.activityState ?? null
		const onDashboard = !!UP.Trans.onDashboard(serverId).match(activity)
		const currentPanel = UP.Trans.viewingQueue(serverId).match(activity)
			? 'VIEWING_QUEUE'
			: UP.Trans.viewingTeams(serverId).match(activity)
			? 'VIEWING_TEAMS'
			: null
		const updates: UP.ActivityUpdate[] = []
		if (!onDashboard) updates.push({ code: 'enter-server-dashboard', serverId })
		if (currentPanel !== panel) updates.push({ code: 'set-primary-panel', to: panel, serverId })
		if (updates.length > 0) updateActivity(...updates)
	}

	// Registers the local client as editing, so an edit made without pressing "Start Editing" still claims
	// an editing session. Idempotent, so they never clobber a sub-activity already in progress.
	export function ensureEditingQueue(serverId: string) {
		ensureEditing(UP.Trans.editingQueue(serverId))
	}

	export function ensureEditingLayerRequests(serverId: string) {
		ensureEditing(UP.Trans.editingLayerRequests(serverId))
	}

	function ensureEditing(trans: UP.ActivityTransitions) {
		const config = ConfigClient.getConfig()
		if (!config) return
		const activity = Store.getState().presence.get(config.wsClientId)?.activityState ?? null
		if (trans.match(activity)) return
		updateActivity(trans.create())
	}

	// Wraps an async player-management flow: marks the given player dialogue active for presence, then
	// clears it once the flow settles (resolves, rejects, or is cancelled). Callers should still call
	// ensureViewingTeams() themselves before invoking, since not every flow needs it.
	export async function withPlayerDialogue<T>(dialog: UP.PlayerDialogueId, fn: () => Promise<T>): Promise<T> {
		updateActivity({ code: 'set-player-dialogue', dialog })
		try {
			return await fn()
		} finally {
			updateActivity({ code: 'clear-player-dialogue' })
		}
	}

	export function preloadActivity(update: UP.ActivityUpdate) {
		requestIdleCallback(() => {
			const config = ConfigClient.getConfig()
			if (!config) return
			const prev = Store.getState().presence.get(config.wsClientId)?.activityState ?? null
			const next = UP.applyActivityUpdate(prev, update)
			Lifecycle.dispatchLoaderEvents(loaderCtx, next, prev, true)
		})
	}
}

// -------- Hooks --------

export function useItemPresence(itemId: LL.ItemId) {
	const [presence, activityHovered] = ZusUtils.useStore(
		Store,
		ZusUtils.useDeep(state => {
			const res = MapUtils.find(
				state.presence,
				(_, v) => {
					const root = v.activityState
					const activity = root ? UP.Trans.editingQueue(root.opts.serverId).match(root)?.chosen : null
					return !!activity && UP.isItemOwnedActivity(activity) && activity.opts.itemId === itemId
				},
			)
			if (!res) return [undefined, undefined] as const
			const root = res[1].activityState!
			const presence = {
				...res?.[1],
				itemActivity: UP.Trans.editingQueue(root.opts.serverId).match(root)!.chosen as UP.ItemOwnedActivity,
			}
			if (!presence) return [undefined, undefined] as const
			const hovered = state.hoveredActivityUserId === presence.userId
			return [presence, hovered] as const
		}),
	)

	const userRes = UsersClient.useUser(presence?.userId)

	if (!presence || userRes.data?.code !== 'ok') return [undefined, undefined, undefined] as const

	return [presence, userRes.data.user, activityHovered] as const
}
export namespace Sel {
	// locked for the local client: a lock we hold ourselves (e.g. via CONFIGURING_VOTE) shouldn't block our own editing
	export const isSllItemLocked = (itemId: string) => (state: Store) => {
		const lockedClientId = state.session.localState.itemLocks.get(itemId)
		if (!lockedClientId) return false
		const config = ConfigClient.getConfig()
		return !config || lockedClientId !== config.wsClientId
	}

	// config comes from ConfigClient.Store -- use with ZusUtils.useStore(ConfigClient.Store, UPClient.Store, Sel.clientPresence)
	export function clientPresence(config: ReturnType<typeof ConfigClient.getConfig>, state: Store) {
		return config ? state.presence.get(config.wsClientId) : undefined
	}

	// count of the user's OTHER clients (excluding `exceptClientId`) that are actively present --
	// connected and not away. drives the "reset my other sessions" toast, shown while this is > 0.
	export const activeOtherClientCount = (userId: USR.UserId | undefined, exceptClientId: string | undefined) => (state: Store) => {
		if (!userId) return 0
		let count = 0
		for (const [clientId, presence] of state.presence) {
			if (presence.userId !== userId || clientId === exceptClientId) continue
			if (presence.connectionState === 'connected' && !presence.away) count++
		}
		return count
	}

	// clients (not users) holding an editing session on one of the server's shared drafts. The server discards
	// the draft once this reaches zero, so the last one out is who has to be warned before they leave.
	export const editingClientCount = (serverId: string, scope: 'queue' | 'layer-requests') => (state: Store) => {
		const trans = scope === 'queue' ? UP.Trans.editingQueue(serverId) : UP.Trans.editingLayerRequests(serverId)
		let count = 0
		for (const presence of state.presence.values()) {
			if (presence.activityState && trans.match(presence.activityState)) count++
		}
		return count
	}

	export const userPresence = (userId: USR.UserId) => (store: Store) => {
		if (!userId) return
		return store.userPresence.get(userId)
	}

	export const isEditing = (userId: USR.UserId) => (store: Store) => {
		const presence = userPresence(userId)(store)
		const activity = presence?.activityState
		return activity ? UP.Trans.editingQueue(activity.opts.serverId).match(activity) : null
	}

	export const activityPresent = (targetActivity: UP.RootActivity) => (state: Store) => {
		for (const [activity] of UP.iterActivities(state.presence)) {
			if (Obj.deepEqual(activity, targetActivity)) {
				return true
			}
		}
		return false
	}

	export const hoveredActivityUserId = (state: Store) => state.hoveredActivityUserId

	export function loadedActivities(state: Store) {
		const loadedEntries = state.activityLoaderCache.filter(entry => !!entry.data)
		return loadedEntries as unknown as LoadedActivityState[]
	}

	export function activityLoaded(state: Store) {
		return state.activityLoaderCache.some(entry => entry.data !== undefined)
	}
}

export function useEditingQueueState(serverId: string) {
	return useActivityState(UP.Trans.editingQueue(serverId))
}

export function useEditingTeamswapsState(serverId: string) {
	return useActivityState(UP.Trans.editingTeamswaps(serverId))
}

export function useEditingLayerRequestsState(serverId: string) {
	return useActivityState(UP.Trans.editingLayerRequests(serverId))
}

export function useIsEditing() {
	const user = UsersClient.useLoggedInUser()
	return ZusUtils.useStore(Store, store => user ? Sel.isEditing(user.discordId)(store) : false)
}

// allows familiar useState binding to a presence activity
export function useActivityState<P>(opts: UP.ActivityTransitions<P>) {
	const { match: matchActivity, create: createActivity, destroy: removeActivity } = opts

	const createActivityRef = React.useRef(createActivity)
	const removeActivityRef = React.useRef(removeActivity)
	createActivityRef.current = createActivity
	removeActivityRef.current = removeActivity

	const predicate = ZusUtils.useStore(
		Store,
		ZusUtils.useDeep(React.useCallback(() => {
			const config = ConfigClient.getConfig()
			const state = (config ? Store.getState().presence.get(config?.wsClientId)?.activityState : undefined) ?? null
			return matchActivity(state)
		}, [matchActivity])),
	)
	const setActive: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		const config = ConfigClient.getConfig()
		const state = config ? Store.getState().presence.get(config?.wsClientId)?.activityState : undefined

		const alreadyActive = !!matchActivity(state ?? null)
		const newActive = typeof update === 'function' ? update(alreadyActive) : update

		if (newActive && !alreadyActive) {
			Actions.updateActivity(createActivityRef.current())
		}
		if (!newActive && alreadyActive) {
			Actions.updateActivity(removeActivityRef.current())
		}
	}, [matchActivity])
	return [!!predicate, setActive] as const
}

export function useActivityMatch<P>(matchActivity: (prev: UP.RootActivity | null | undefined) => P) {
	return ZusUtils.useStore(
		Store,
		ZusUtils.useDeep(React.useCallback(() => {
			const config = ConfigClient.getConfig()
			const state = (config ? Store.getState().presence.get(config?.wsClientId)?.activityState : undefined) ?? null
			return matchActivity(state)
		}, [matchActivity])),
	)
}

export function useActivityLoaderData<Loader extends ConfiguredLoaderConfig, O = LoaderCacheEntry<Loader>['data']>(opts: {
	loaderName: Loader['name']
	matchKey?: (predicate: LoaderCacheKey<Loader>) => boolean
	trace?: string
	select?: (data: LoaderCacheEntry<Loader> | undefined) => O
}) {
	const { loaderName, matchKey: matchPredicate = () => true, trace, select = (entry) => entry?.data } = opts
	return ZusUtils.useStore(
		Store,
		state => {
			const loadedEntries = state.activityLoaderCache.filter(entry => entry.name === loaderName && matchPredicate(entry.key as any))
			if (loadedEntries.length > 1) console.warn(`Multiple activities loaded for ${trace ?? loaderName}`)
			const entry = loadedEntries[0] as LoaderCacheEntry<Loader> | undefined
			return select(entry)
		},
	) as O
}

// -------- setup --------

export async function setup() {
	// Subscribe to presence broadcast stream
	presenceUpdate$.pipe(RxHelpers.retryHot()).subscribe(update => {
		handleIncomingPresenceUpdate(update)
	})

	// Presence after a websocket reconnect is re-established server-side: our new socket sends the id we
	// last held as `?prior=`, and the server reclaims that same wsClientId with its activity and locks
	// intact (see reclaimClientId in user-presence.server.ts). So there's nothing to replay from the client here.

	const settingsModified$ = Rx.combineLatest([
		ZusUtils.toObservable(SquadServerClient.SelectedServerStore, true).pipe(Rx.map(([s]) => s.selectedServerId)),
		// see squad-server.client: toStream needs fireImmediately to carry the store's current value
		toStream(SettingsClient.PublicSettingsStore, undefined, { fireImmediately: true }),
	]).pipe(
		Rx.map(([serverId, settings]) => settings?.servers.find(s => s.id === serverId)),
		Rx.distinctUntilChanged(),
		Rx.switchMap(serverConfig => {
			// only track settings-modified for a usable server; otherwise there's no frame to read and no edits to flush
			if (!SettingsClient.isServerUsable(serverConfig)) return Rx.of(false)
			const key = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverConfig.id))
			return toStream(ZusUtils.resolveReadStore(key), undefined, { fireImmediately: true }).pipe(
				Rx.map(s => s.settings.modified),
				Rx.distinctUntilChanged(),
			)
		}),
	)
	const wsClientId$ = ConfigClient.fetchConfig().then(config => config.wsClientId)
	settingsModified$.pipe(
		Rx.withLatestFrom(wsClientId$),
	).subscribe(([modified, wsClientId]) => {
		try {
			const currentActivity = Store.getState().presence.get(wsClientId)?.activityState
			const inChangingSettingsActivity = !!(
				currentActivity
				&& UP.Trans.changingQueueSettings(currentActivity.opts.serverId).match(currentActivity)
			)
			if (!modified && inChangingSettingsActivity) {
				Actions.updateActivity({ code: 'clear-changing-queue-settings' })
			}
			if (modified) {
				Actions.updateActivity({ code: 'set-changing-queue-settings' })
			}
		} catch (error) {
			console.error('Error handling settings modification:', error)
		}
	})
}
