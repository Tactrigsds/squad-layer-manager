import { frameManager } from '@/frames/frame-manager'
import * as GenVoteFrame from '@/frames/gen-vote.frame'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Lifecycle from '@/lib/lifecycle'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import * as ST from '@/lib/state-tree'
import * as ZusUtils from '@/lib/zustand'
import * as LL from '@/models/layer-list.models'
import type * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import * as ReactRx from '@react-rxjs/core'
import * as Im from 'immer'
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
	return frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverId))
}

function getCurrentLayerList(): LL.Item[] {
	return frameManager.getState(getCurrentServerKey())?.queue.layerList ?? []
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
			if (node?.id === 'ADDING_ITEM' || node?.id === 'EDITING_ITEM') return node
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
			const input = SelectLayersFrame.createInput({
				cursor: args.key.opts.cursor,
				initialEditedLayerId: editedLayerId,
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
			if (node?.id === 'GENERATING_VOTE') return node
			return undefined
		},
	)({
		unloadOnLeave: true,
		load(args) {
			const input = GenVoteFrame.createInput({ cursor: { type: 'start' }, server: getCurrentServerKey() })
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

	session: RbSyncState.Client.Session<UP.Op, UP.State, UP.SideEffects>

	presence: UP.PresenceState
	editors: Set<USR.UserId>
	teamswitchEditors: Set<USR.UserId>
	// derived: resolved per-user presence (latest session wins per userId)
}

// assigned during createPresenceStore -- module-level so Actions.preloadActivity can reach it
let loaderCtx: Lifecycle.LoaderManagerContext<ConfiguredLoaderConfig, Store>

const [_usePresenceUpdate, presenceUpdate$] = ReactRx.bind<UP.PresenceUpdate>(
	RPC.observe(() => RPC.orpc.userPresence.watchUpdates.call()),
)

export const Store = createPresenceStore()

function onSideEffect(_se: UP.SideEffects) {}

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
					if (prevClientActivityState !== clientActivityState) {
						Lifecycle.dispatchLoaderEvents(loaderCtx, clientActivityState, prevClientActivityState, false)
					}
				}
				const editors = new Set<USR.UserId>()
				const teamswitchEditors = new Set<USR.UserId>()
				for (const client of presence.values()) {
					const activity = client.activityState
					if (activity && UP.Trans.editingQueue(activity.opts.serverId).match(activity)) {
						editors.add(client.userId)
					}
					if (activity && UP.Trans.editingTeamswitches(activity.opts.serverId).match(activity)) {
						teamswitchEditors.add(client.userId)
					}
				}
				if (!Obj.deepEqual(editors, state.editors)) {
					toUpdate.editors = editors
				}
				if (!Obj.deepEqual(teamswitchEditors, state.teamswitchEditors)) {
					toUpdate.teamswitchEditors = teamswitchEditors
				}
			}

			if (!Obj.isEmpty(toUpdate)) {
				set(toUpdate)
			}

			Lifecycle.checkAndUnloadStaleEntries(loaderCtx, state)
		})

		const session = RbSyncState.Client.initSession<UP.Op, UP.State, UP.SideEffects>(UP.initState(), { onSideEffect })
		return {
			session,
			presence: session.localState.presence,
			editors: new Set(),
			teamswitchEditors: new Set(),
			userPresence: new Map(),
			activityLoaderCache: [],

			hoveredActivityUserId: null,
		}
	})

	return store
}

function handleIncomingPresenceUpdate(update: UP.PresenceUpdate) {
	if (update.code === 'init') {
		const newSession = RbSyncState.Client.initSession(UP.initState(), { onSideEffect, ops: update.ops })
		Store.setState({ session: newSession })
	} else if (update.code === 'op') {
		const newSession = RbSyncState.Client.processIncomingOps(Store.getState().session, update.ops, UP.reducer)
		Store.setState({ session: newSession })
	} else if (update.code === 'ack') {
		// ops are deterministic, so the server only sends back the ids -- replay our pending copies
		const session = Store.getState().session
		const pendingIds = new Set(session.pendingOps.map(op => op.opId))
		if (!update.opIds.every(id => pendingIds.has(id))) {
			console.warn('received ack for unknown presence ops', update.opIds)
			return
		}
		Store.setState({ session: RbSyncState.Client.processAckedOps(session, update.opIds, UP.reducer) })
	}
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
		const newSession = RbSyncState.Client.processOutgoingOps(Store.getState().session, ops, UP.reducer)
		Store.setState({ session: newSession })
		for (const op of ops) {
			console.log('dispatch ', op.code, op.code === 'update-activity' ? op.update.code : null)
		}
		void RPC.orpc.userPresence.dispatchOp.call(ops)
	}

	export function updateActivity(...updates: UP.ActivityUpdate[]) {
		dispatch(...updates.map((update): UP.NewClientOp => ({ code: 'update-activity', update })))
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
	export const isSllItemLocked = (itemId: string) => (state: Store) => state.session.localState.itemLocks.has(itemId)

	// config comes from ConfigClient.Store -- use with ZusUtils.useStore(ConfigClient.Store, UPClient.Store, Sel.clientPresence)
	export function clientPresence(config: ReturnType<typeof ConfigClient.getConfig>, state: Store) {
		return config ? state.presence.get(config.wsClientId) : undefined
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

export function useEditingTeamswitchesState(serverId: string) {
	return useActivityState(UP.Trans.editingTeamswitches(serverId))
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
		const storeState = Store.getState()
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

export function useVariantActivityState<Variants extends Record<string, UP.ActivityTransitions>>(
	variants: Variants,
) {
	const variantsRef = React.useRef(variants)
	variantsRef.current = variants

	const currentVariant = ZusUtils.useStore(
		Store,
		ZusUtils.useDeep(React.useCallback((): keyof Variants | null => {
			const config = ConfigClient.getConfig()
			const state = (config ? Store.getState().presence.get(config?.wsClientId)?.activityState : undefined) ?? null
			for (const key of Object.keys(variantsRef.current) as (keyof Variants)[]) {
				if (variantsRef.current[key].match(state)) return key
			}
			return null
		}, [])),
	)

	const setVariant = React.useCallback((newVariant: keyof Variants | null) => {
		const config = ConfigClient.getConfig()
		if (!config) return
		const storeState = Store.getState()
		const state = storeState.presence.get(config?.wsClientId)?.activityState ?? null

		let currentKey: keyof Variants | null = null
		for (const key of Object.keys(variantsRef.current) as (keyof Variants)[]) {
			if (variantsRef.current[key].match(state)) {
				currentKey = key
				break
			}
		}

		if (currentKey === newVariant) return

		if (currentKey !== null) {
			Actions.updateActivity(variantsRef.current[currentKey].destroy())
		}
		if (newVariant !== null) {
			Actions.updateActivity(variantsRef.current[newVariant].create())
		}
	}, [])

	return [currentVariant, setVariant] as [keyof Variants | null, (variant: keyof Variants | null) => void]
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
	presenceUpdate$.subscribe(update => {
		handleIncomingPresenceUpdate(update)
	})

	const settingsModified$ = ZusUtils.toObservable(SquadServerClient.SelectedServerStore, true).pipe(
		Rx.map(([s]) => s.selectedServerId),
		Rx.distinctUntilChanged(),
		Rx.switchMap(serverId => {
			const key = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverId))
			return toStream(ZusUtils.resolveReadStore(key)).pipe(Rx.map(s => s.settings.modified), Rx.distinctUntilChanged())
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
