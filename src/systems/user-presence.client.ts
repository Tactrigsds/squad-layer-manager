import { frameManager } from '@/frames/frame-manager'
import * as GenVoteFrame from '@/frames/gen-vote.frame'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import * as Lifecycle from '@/lib/lifecycle'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ST from '@/lib/state-tree'
import * as ZusUtils from '@/lib/zustand'
import * as LL from '@/models/layer-list.models'
import * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import * as UPActions from '@/models/user-presence/actions'
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
	PresenceStore,
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
	return <Data>(config: Lifecycle.LoaderConfigOptions<Key, Data, PresenceStore>) =>
		Lifecycle.createLoaderConfig<Name, Key, UP.RootActivity>(name, match)<Data, PresenceStore>(config)
}

export const ACTIVITY_LOADER_CONFIGS = [
	createActivityLoaderConfig(
		'selectLayers',
		s => {
			const node = s.child.EDITING_QUEUE?.chosen
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
			const node = s.child.EDITING_QUEUE?.chosen
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
		const node = s.child.EDITING_QUEUE?.chosen
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

export type PresenceStore = {
	presence: UP.PresenceState
	// derived: resolved per-user presence (latest session wins per userId)
	userPresence: Map<bigint, UP.ClientPresence>

	hoveredActivityUserId: USR.UserId | null
	setHoveredActivityUserId(userId: USR.UserId, hovered: boolean): void

	activityLoaderCache: LoaderCacheEntry<ConfiguredLoaderConfig>[]

	handlePresenceUpdate(update: UP.PresenceBroadcast): void

	// applies editSessionChanged action to all presence entries (called when session resets)
	onSessionChanged(session: SLL.EditSession): void

	pushPresenceAction(action: UPActions.Action): void
	updateActivity(update: (prev: UP.RootActivity) => UP.RootActivity): void
	preloadActivity(update: (prev: UP.RootActivity) => UP.RootActivity): void
}

const [_usePresenceUpdate, presenceUpdate$] = ReactRx.bind<UP.PresenceBroadcast>(
	RPC.observe(() => RPC.orpc.userPresence.watchUpdates.call()),
)

export const PresenceStore = createPresenceStore()

function createPresenceStore() {
	const store = Zus.createStore<PresenceStore>((set, get, store) => {
		const loaderCtx: Lifecycle.LoaderManagerContext<ConfiguredLoaderConfig, PresenceStore> = {
			configs: ACTIVITY_LOADER_CONFIGS,
			getCache: (draft: Im.Draft<PresenceStore>) => draft.activityLoaderCache as Lifecycle.LoaderCacheEntry<ConfiguredLoaderConfig>[],
			setCache: (draft: Im.Draft<PresenceStore>, cache: Lifecycle.LoaderCacheEntry<ConfiguredLoaderConfig>[]) => {
				draft.activityLoaderCache = cache
			},
			set: (updater: (state: PresenceStore) => PresenceStore) => set(updater),
			getCurrentState: () => get(),
		}

		store.subscribe((state, prev) => {
			if (prev.presence !== state.presence) {
				set({ userPresence: UP.resolveUserPresence(state.presence) })

				const config = ConfigClient.getConfig()
				if (config) {
					const wsClientId = config.wsClientId
					const prevClientActivityState = prev.presence.get(wsClientId)?.activityState ?? null
					const clientActivityState = state.presence.get(wsClientId)?.activityState ?? null
					if (prevClientActivityState !== clientActivityState) {
						Lifecycle.dispatchLoaderEvents(loaderCtx, clientActivityState, prevClientActivityState, false)
					}
				}
			}

			Lifecycle.checkAndUnloadStaleEntries(loaderCtx, state)
		})

		return {
			presence: new Map(),
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

			handlePresenceUpdate(update) {
				switch (update.code) {
					case 'init': {
						const config = ConfigClient.getConfig()
						const clientPresence = config ? get().presence.get(config.wsClientId) : null
						const merged = new Map([
							...update.presence,
							...(clientPresence && config ? [[config.wsClientId, clientPresence] as const] : []),
						])
						set({ presence: merged })
						get().pushPresenceAction(UPActions.editSessionChanged)
						break
					}
					case 'update': {
						set(state =>
							Im.produce(state, draft => {
								let currentPresence = draft.presence.get(update.wsClientId)
								if (!currentPresence) {
									currentPresence = UPActions.getClientPresenceDefaults(update.userId)
									draft.presence.set(update.wsClientId, currentPresence)
								}
								UP.updateClientPresence(currentPresence, update.changes)
							})
						)
						break
					}
				}
			},

			onSessionChanged(session) {
				set(state =>
					Im.produce(state, draft => {
						UPActions.applyToAll(draft.presence, session, UPActions.editSessionChanged)
					})
				)
				get().pushPresenceAction(UPActions.editSessionChanged)
			},

			async pushPresenceAction(action) {
				const config = ConfigClient.getConfig()
				if (!config) return
				const userId = UsersClient.loggedInUserId
				if (!userId) return
				const sllState = SLLClient.Store.getState()
				const hasEdits = SLL.hasMutations(sllState.session, userId)
				let update = action({ hasEdits, prev: get().presence.get(config.wsClientId) })
				update = Obj.trimUndefined(update)
				let presenceUpdated = false
				const beforeUpdates = get().presence.get(config.wsClientId)
				set(state =>
					Im.produce(state, draft => {
						let currentPresence = draft.presence.get(config.wsClientId)
						if (!currentPresence) {
							currentPresence = UPActions.getClientPresenceDefaults(userId)
							draft.presence.set(config.wsClientId, currentPresence)
						}
						presenceUpdated = UP.updateClientPresence(currentPresence, update)
					})
				)
				if (presenceUpdated) {
					const res = await RPC.orpc.userPresence.updatePresence.call({
						wsClientId: config.wsClientId,
						userId,
						changes: update,
					})
					if (res?.code === 'err:locked' && beforeUpdates) {
						get().pushPresenceAction(UPActions.failedToAcquireLocks(beforeUpdates))
					}
				}
			},

			updateActivity(update) {
				const config = ConfigClient.getConfig()
				if (!config) return
				const prev = get().presence.get(config.wsClientId)?.activityState ?? UP.DEFAULT_ACTIVITY
				const next = update(prev)
				get().pushPresenceAction(UPActions.updateActivity(next))
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
		PresenceStore,
		ZusUtils.useDeep(state => {
			const res = MapUtils.find(
				state.presence,
				(_, v) => {
					const activity = v.activityState?.child.EDITING_QUEUE?.chosen
					return !!activity && UP.isItemOwnedActivity(activity) && activity.opts.itemId === itemId
				},
			)
			if (!res) return [undefined, undefined] as const
			const root = res[1].activityState!
			const presence = {
				...res?.[1],
				itemActivity: root.child.EDITING_QUEUE!.chosen as UP.ItemOwnedActivity,
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

export function useClientPresence() {
	const config = ConfigClient.useConfig()
	const presence = Zus.useStore(PresenceStore, state => config ? state.presence.get(config?.wsClientId) : undefined)
	return presence
}

export function useIsEditing() {
	const user = UsersClient.useLoggedInUser()
	return Zus.useStore(SLLClient.Store, React.useMemo(() => (s: SLLClient.Store) => selectIsEditing(s, user), [user]))
}

export function selectIsEditing(store: SLLClient.Store, user?: USR.User) {
	if (!user) return false
	return user && store.session.editors.has(user.discordId) && !store.committing
}

// allows familiar useState binding to a presence activity
export function useActivityState<P>(
	opts: {
		createActivity: (prev: UP.RootActivity) => UP.RootActivity
		removeActivity: (prev: UP.RootActivity) => UP.RootActivity
		matchActivity: (prev: UP.RootActivity) => P
	},
) {
	const { matchActivity, createActivity, removeActivity } = opts

	const createActivityRef = React.useRef(createActivity)
	const removeActivityRef = React.useRef(removeActivity)
	createActivityRef.current = createActivity
	removeActivityRef.current = removeActivity

	const predicate = Zus.useStore(
		PresenceStore,
		ZusUtils.useDeep(React.useCallback(() => {
			const config = ConfigClient.getConfig()
			const state = (config ? PresenceStore.getState().presence.get(config?.wsClientId)?.activityState : undefined) ?? UP.DEFAULT_ACTIVITY
			return matchActivity(state)
		}, [matchActivity])),
	)
	const setActive: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		const config = ConfigClient.getConfig()
		if (!config) return
		const storeState = PresenceStore.getState()
		const state = PresenceStore.getState().presence.get(config?.wsClientId)?.activityState ?? UP.DEFAULT_ACTIVITY

		const alreadyActive = !!matchActivity(state)
		const newActive = typeof update === 'function' ? update(alreadyActive) : update

		if (newActive && !alreadyActive) {
			storeState.updateActivity(createActivityRef.current)
		}
		if (!newActive && alreadyActive) {
			storeState.updateActivity(removeActivityRef.current)
		}
	}, [matchActivity])
	return [predicate, setActive] as const
}

export function useHoveredActivityUser() {
	const [hovered, setHovered] = Zus.useStore(
		PresenceStore,
		useShallow((state) => [state.hoveredActivityUserId, state.setHoveredActivityUserId]),
	)
	return [hovered, setHovered] as const
}

export const selectActivityPresent = (targetActivity: UP.RootActivity) => (state: PresenceStore) => {
	for (const [activity] of UP.iterActivities(state.presence)) {
		if (Obj.deepEqual(activity, targetActivity)) {
			return true
		}
	}
	return false
}

export function useLoadedActivities() {
	return Zus.useStore(
		PresenceStore,
		ZusUtils.useShallow(state => {
			const loadedEntries = state.activityLoaderCache.filter(entry => !!entry.data)
			return loadedEntries as unknown as LoadedActivityState[]
		}),
	)
}

export function useActivityLoaded(_matchActivity: (state: UP.RootActivity) => boolean) {
	return Zus.useStore(
		PresenceStore,
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
		PresenceStore,
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
		PresenceStore.getState().handlePresenceUpdate(update)
	})

	// Hook into SLL session changes to re-apply presence actions
	SLLClient.Store.subscribe((state, prev) => {
		if (state.session !== prev.session) {
			// When session resets (new session object), notify presence store
			if (state.sessionSeqId !== prev.sessionSeqId) {
				PresenceStore.getState().onSessionChanged(state.session)
			}
		}
	})

	const settingsModified$ = toStream(ServerSettingsClient.Store).pipe(Rx.map(s => s.modified), Rx.distinctUntilChanged())
	const wsClientId$ = ConfigClient.fetchConfig().then(config => config.wsClientId)
	settingsModified$.pipe(
		Rx.withLatestFrom(wsClientId$),
	).subscribe(([modified, wsClientId]) => {
		try {
			const currentActivity = PresenceStore.getState().presence.get(wsClientId)?.activityState
			const dialogActivity = currentActivity?.child?.VIEWING_SETTINGS
			const inChangingSettingsActivity = dialogActivity?.id === 'VIEWING_SETTINGS' && dialogActivity?.child?.CHANGING_SETTINGS
			if (!modified && inChangingSettingsActivity) {
				PresenceStore.getState().updateActivity(Im.produce(draft => {
					const activity = draft.child?.VIEWING_SETTINGS
					if (!activity) return
					delete activity.child.CHANGING_SETTINGS
				}))
			}
			if (modified) {
				PresenceStore.getState().updateActivity(Im.produce(draft => {
					draft.child.VIEWING_SETTINGS = ST.Match.branch('VIEWING_SETTINGS', draft.child.VIEWING_SETTINGS?.opts ?? {}, {
						CHANGING_SETTINGS: ST.Match.leaf('CHANGING_SETTINGS', {}),
					})
				}))
			}
		} catch (error) {
			console.error('Error handling settings modification:', error)
		}
	})
}
