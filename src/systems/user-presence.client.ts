import { frameManager } from '@/frames/frame-manager'
import * as GenVoteFrame from '@/frames/gen-vote.frame'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
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
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as UsersClient from '@/systems/users.client'
import * as ReactRx from '@react-rxjs/core'
import * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'
import { useShallow } from 'zustand/react/shallow'

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
			const node = UP.getEditingQueueNode(s)?.chosen
			if (node?.id === 'ADDING_ITEM' || node?.id === 'EDITING_ITEM') return node
			return undefined
		},
	)({
		unloadOnLeave: true,

		load(args) {
			let editedLayerId: string | undefined
			if (args.key.id === 'EDITING_ITEM') {
				const layerList = SLLClient.Store.getState().layerList
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
			return !LL.findItemById(SLLClient.Store.getState().layerList, itemId)
		},
	}),
	createActivityLoaderConfig(
		'genVote',
		s => {
			const node = UP.getEditingQueueNode(s)?.chosen
			if (node?.id === 'GENERATING_VOTE') return node
			return undefined
		},
	)({
		unloadOnLeave: true,
		load(args) {
			const input = GenVoteFrame.createInput({ cursor: { type: 'start' } })
			const frameKey = frameManager.ensureSetup(GenVoteFrame.frame, input)
			return { genVoteFrame: frameKey, activity: args.key }
		},
		onUnload(args) {
			if (args.data) void requestIdleCallback(() => frameManager.teardown(args.data!.genVoteFrame))
		},
	}),
	createActivityLoaderConfig('pasteRotation', s => {
		const node = UP.getEditingQueueNode(s)?.chosen
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
	setHoveredActivityUserId(userId: USR.UserId, hovered: boolean): void

	activityLoaderCache: LoaderCacheEntry<ConfiguredLoaderConfig>[]
	handleIncomingPresenceUpdate(update: UP.PresenceUpdate): void

	session: RbSyncState.Client.Session<UP.Op, UP.State, UP.SideEffects>

	presence: UP.PresenceState
	editors: Set<USR.UserId>
	// derived: resolved per-user presence (latest session wins per userId)

	dispatch(op: UP.NewClientOp): void
	updateActivity(update: (prev: UP.RootActivity) => UP.RootActivity): void
	preloadActivity(update: (prev: UP.RootActivity) => UP.RootActivity): void
}

const [_usePresenceUpdate, presenceUpdate$] = ReactRx.bind<UP.PresenceUpdate>(
	RPC.observe(() => RPC.orpc.userPresence.watchUpdates.call()),
)

export const Store = createPresenceStore()

function createPresenceStore() {
	const store = Zus.createStore<Store>((set, get, store) => {
		const loaderCtx: Lifecycle.LoaderManagerContext<ConfiguredLoaderConfig, Store> = {
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
				for (const client of presence.values()) {
					if (UP.getEditingQueueNode(client.activityState)) {
						editors.add(client.userId)
					}
				}
				if (!Obj.deepEqual(editors, state.editors)) {
					toUpdate.editors = editors
				}
			}

			if (!Obj.isEmpty(toUpdate)) {
				set(toUpdate)
			}

			Lifecycle.checkAndUnloadStaleEntries(loaderCtx, state)
		})

		function onSideEffect(se: UP.SideEffects) {
			console.log('side effect', se)
		}

		const session = RbSyncState.Client.initSession<UP.Op, UP.State, UP.SideEffects>(UP.initState(), { onSideEffect })
		return {
			session,
			presence: session.localState.presence,
			editors: new Set(),
			userPresence: new Map(),
			activityLoaderCache: [],

			hoveredActivityUserId: null,
			setHoveredActivityUserId(userId, hovered) {
				if (!hovered) {
					if (userId !== get().hoveredActivityUserId) return
					else set({ hoveredActivityUserId: null })
					return
				}
				set({ hoveredActivityUserId: userId })
			},

			handleIncomingPresenceUpdate(update) {
				if (update.code === 'init') {
					const newSession = RbSyncState.Client.initSession(UP.initState(), { onSideEffect, ops: update.ops })
					set({ session: newSession })
				} else if (update.code === 'op') {
					const newSession = RbSyncState.Client.processIncomingOps(get().session, [update.op], UP.reducer)
					set({ session: newSession })
				}
			},

			dispatch(newOp) {
				const userId = UsersClient.loggedInUserId
				const config = ConfigClient.getConfig()
				if (!config || !userId) return
				if (newOp.code !== 'page-interaction') console.log(newOp)
				const op: UP.ClientOp = { ...newOp, userId, clientId: config.wsClientId, time: Date.now(), opId: UP.createOpId() } as UP.ClientOp
				const newSession = RbSyncState.Client.processOutgoingOps(get().session, [op], UP.reducer)
				set({ session: newSession })
				void RPC.orpc.userPresence.dispatchOp.call(op)
			},

			updateActivity(update) {
				const config = ConfigClient.getConfig()
				if (!config) return
				const prev = get().presence.get(config.wsClientId)?.activityState ?? UP.DEFAULT_ACTIVITY
				const next = update(prev)
				this.dispatch({ code: 'set-activity', activity: next })
			},

			preloadActivity(update) {
				requestIdleCallback(() => {
					const config = ConfigClient.getConfig()
					if (!config) return
					const prev = get().presence.get(config.wsClientId)?.activityState ?? UP.DEFAULT_ACTIVITY
					const next = update(prev)
					Lifecycle.dispatchLoaderEvents(loaderCtx, next, prev, true)
				})
			},
		}
	})

	return store
}

// -------- Hooks --------

export function useItemPresence(itemId: LL.ItemId) {
	const [presence, activityHovered] = Zus.useStore(
		Store,
		ZusUtils.useDeep(state => {
			const res = MapUtils.find(
				state.presence,
				(_, v) => {
					const activity = UP.getEditingQueueNode(v.activityState)?.chosen
					return !!activity && UP.isItemOwnedActivity(activity) && activity.opts.itemId === itemId
				},
			)
			if (!res) return [undefined, undefined] as const
			const root = res[1].activityState!
			const presence = {
				...res?.[1],
				itemActivity: UP.getEditingQueueNode(root)!.chosen as UP.ItemOwnedActivity,
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
export function useIsSllItemLocked(itemId: string) {
	return Zus.useStore(Store, state => state.session.localState.itemLocks.has(itemId))
}

export function useClientPresence() {
	const config = ConfigClient.useConfig()
	const presence = Zus.useStore(Store, state => config ? state.presence.get(config?.wsClientId) : undefined)
	return presence
}

export function useEditingState() {
	return useActivityState(UP.TOGGLE_EDITING_QUEUE_TRANSITIONS)
}

export function useIsEditing() {
	const user = UsersClient.useLoggedInUser()
	return Zus.useStore(Store, store => user ? selectIsEditing(store, user?.discordId) : false)
}
export function selectUserPresence(store: Store, userId: USR.UserId) {
	if (!userId) return
	return store.userPresence.get(userId)
}

export function selectIsEditing(store: Store, userId: USR.UserId) {
	const presence = selectUserPresence(store, userId)
	return UP.TOGGLE_EDITING_QUEUE_TRANSITIONS.matchActivity(presence?.activityState)
}

// allows familiar useState binding to a presence activity
export function useActivityState<P>(
	opts: {
		createActivity: (prev: UP.RootActivity | null | undefined) => UP.RootActivity
		removeActivity: (prev: UP.RootActivity) => UP.RootActivity
		matchActivity: (prev: UP.RootActivity | null | undefined) => P
	},
) {
	const { matchActivity, createActivity, removeActivity } = opts

	const createActivityRef = React.useRef(createActivity)
	const removeActivityRef = React.useRef(removeActivity)
	createActivityRef.current = createActivity
	removeActivityRef.current = removeActivity

	const predicate = Zus.useStore(
		Store,
		ZusUtils.useDeep(React.useCallback(() => {
			const config = ConfigClient.getConfig()
			const state = (config ? Store.getState().presence.get(config?.wsClientId)?.activityState : undefined) ?? UP.DEFAULT_ACTIVITY
			return matchActivity(state)
		}, [matchActivity])),
	)
	const setActive: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		const config = ConfigClient.getConfig()
		if (!config) return
		const storeState = Store.getState()
		const state = Store.getState().presence.get(config?.wsClientId)?.activityState ?? UP.DEFAULT_ACTIVITY

		const alreadyActive = !!matchActivity(state)
		const newActive = typeof update === 'function' ? update(alreadyActive) : update

		if (newActive && !alreadyActive) {
			storeState.updateActivity(createActivityRef.current)
		}
		if (!newActive && alreadyActive) {
			storeState.updateActivity(removeActivityRef.current)
		}
	}, [matchActivity])
	return [!!predicate, setActive] as const
}

type VariantConfig = {
	createActivity: (prev: UP.RootActivity | null | undefined) => UP.RootActivity
	removeActivity: (prev: UP.RootActivity) => UP.RootActivity
	matchActivity: (prev: UP.RootActivity | null | undefined) => any
}

export function useVariantActivityState<Variants extends Record<string, VariantConfig>>(
	variants: Variants,
) {
	const variantsRef = React.useRef(variants)
	variantsRef.current = variants

	const currentVariant = Zus.useStore(
		Store,
		ZusUtils.useDeep(React.useCallback((): keyof Variants | null => {
			const config = ConfigClient.getConfig()
			const state = (config ? Store.getState().presence.get(config?.wsClientId)?.activityState : undefined) ?? UP.DEFAULT_ACTIVITY
			for (const key of Object.keys(variantsRef.current) as (keyof Variants)[]) {
				if (variantsRef.current[key].matchActivity(state)) return key
			}
			return null
		}, [])),
	)

	const setVariant = React.useCallback((newVariant: keyof Variants | null) => {
		const config = ConfigClient.getConfig()
		if (!config) return
		const storeState = Store.getState()
		const state = storeState.presence.get(config?.wsClientId)?.activityState ?? UP.DEFAULT_ACTIVITY

		let currentKey: keyof Variants | null = null
		for (const key of Object.keys(variantsRef.current) as (keyof Variants)[]) {
			if (variantsRef.current[key].matchActivity(state)) {
				currentKey = key
				break
			}
		}

		if (currentKey === newVariant) return
		let ops: ((prev: UP.RootActivity) => UP.RootActivity)[] = []

		if (currentKey !== null) {
			ops.push(variantsRef.current[currentKey].removeActivity)
		}
		if (newVariant !== null) {
			ops.push(variantsRef.current[newVariant].createActivity)
		}
		if (ops.length > 0) storeState.updateActivity((s) => ops.reduce((prev, op) => op(prev), s))
	}, [])

	return [currentVariant, setVariant] as [keyof Variants | null, (variant: keyof Variants | null) => void]
}

export function useHoveredActivityUser() {
	const [hovered, setHovered] = Zus.useStore(
		Store,
		useShallow((state) => [state.hoveredActivityUserId, state.setHoveredActivityUserId]),
	)
	return [hovered, setHovered] as const
}

export const selectActivityPresent = (targetActivity: UP.RootActivity) => (state: Store) => {
	for (const [activity] of UP.iterActivities(state.presence)) {
		if (Obj.deepEqual(activity, targetActivity)) {
			return true
		}
	}
	return false
}

export function useLoadedActivities() {
	return Zus.useStore(
		Store,
		ZusUtils.useShallow(state => {
			const loadedEntries = state.activityLoaderCache.filter(entry => !!entry.data)
			return loadedEntries as unknown as LoadedActivityState[]
		}),
	)
}

export function useActivityLoaded(_matchActivity: (state: UP.RootActivity) => boolean) {
	return Zus.useStore(
		Store,
		ZusUtils.useShallow(state => {
			return state.activityLoaderCache.some(entry => entry.data !== undefined)
		}),
	)
}

export function useActivityLoaderData<Loader extends ConfiguredLoaderConfig, O = LoaderCacheEntry<Loader>['data']>(opts: {
	loaderName: Loader['name']
	matchKey?: (predicate: LoaderCacheKey<Loader>) => boolean
	trace?: string
	select?: (data: LoaderCacheEntry<Loader> | undefined) => O
}) {
	const { loaderName, matchKey: matchPredicate = () => true, trace, select = (entry) => entry?.data } = opts
	return Zus.useStore(
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
		Store.getState().handleIncomingPresenceUpdate(update)
	})

	const settingsModified$ = toStream(ServerSettingsClient.Store).pipe(Rx.map(s => s.modified), Rx.distinctUntilChanged())
	const wsClientId$ = ConfigClient.fetchConfig().then(config => config.wsClientId)
	settingsModified$.pipe(
		Rx.withLatestFrom(wsClientId$),
	).subscribe(([modified, wsClientId]) => {
		try {
			const currentActivity = Store.getState().presence.get(wsClientId)?.activityState
			const dialogActivity = UP.VIEWING_SETTINGS_TRANSITIONS.matchActivity(currentActivity)
			const inChangingSettingsActivity = !!dialogActivity?.child.CHANGING_QUEUE_SETTINGS
			if (!modified && inChangingSettingsActivity) {
				Store.getState().updateActivity(Im.produce(draft => {
					const node = UP.VIEWING_SETTINGS_TRANSITIONS.matchActivity(draft)
					if (!node) return
					delete node.child.CHANGING_QUEUE_SETTINGS
				}))
			}
			if (modified) {
				Store.getState().updateActivity(Im.produce(draft => {
					const node = UP.VIEWING_SETTINGS_TRANSITIONS.matchActivity(draft)
					if (!node?.child) return
					node.child.CHANGING_QUEUE_SETTINGS = ST.Match.leaf('CHANGING_QUEUE_SETTINGS', {})
				}))
			}
		} catch (error) {
			console.error('Error handling settings modification:', error)
		}
	})
}
