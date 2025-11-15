import { frameManager } from '@/frames/frame-manager'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import { globalToast$ } from '@/hooks/use-global-toast'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ST from '@/lib/state-tree'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SLL from '@/models/shared-layer-list'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems.client/config.client'
import * as RbacClient from '@/systems.client/rbac.client'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as UsersClient from '@/systems.client/users.client'
import * as VotesClient from '@/systems.client/votes.client'
import * as ReactRx from '@react-rxjs/core'
import * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'
import { useShallow } from 'zustand/react/shallow'

export type Store = {
	sessionSeqId: SLL.SessionSequenceId

	// state plus any in-flight operations applied
	session: SLL.EditSession

	// state that we're sure is syncronized between server and client
	syncedState: SLL.EditSession

	// operation ids which have not been synced from this client
	outgoingOpsPendingSync: string[]

	// operations that have come from the server that represent potential conflicts
	incomingOpsPendingSync: SLL.Operation[]

	hoveredActivityUserId: USR.UserId | null
	setHoveredActivityUserId(userId: USR.UserId, hovered: boolean): void

	presence: SLL.PresenceState
	itemLocks: SLL.ItemLocks

	handleServerUpdate(update: SLL.Update): void
	dispatch(op: SLL.NewOperation): Promise<void>
	pushPresenceAction(action: PresenceActions.Action): void

	saving: boolean
	save(): Promise<void>

	reset(): Promise<void>

	// if this layer is set as the next one on the server but is only a partial, then we want to "backfill" the details that the server fills in for us. If this property is defined that indicates that we should attempt to backfill
	// nextLayerBackfillId?: string
	// -------- derived properties --------
	layerList: LL.Item[]
	isModified: boolean
	userPresence: Map<bigint, SLL.ClientPresence>

	activityLoaderCache: LoaderCacheEntry<(typeof ACTIVITY_LOADER_CONFIGS)[number]>[]

	updateActivity: (update: (prev: SLL.RootActivity) => SLL.RootActivity) => void
	preloadActivity: (update: (prev: SLL.RootActivity) => SLL.RootActivity) => void
}

const [_useServerUpdate, serverUpdate$] = ReactRx.bind<SLL.Update>(
	RPC.observe(() => RPC.orpc.sharedLayerList.watchUpdates.call()),
)

export const Store = createStore()

type ActivityLoaderConfigOptions<Key, Data = never> =
	& {
		// the time before we unload an inactive action. default no unload
		staleTime?: number

		// don't mutate the store from the loader pretty please
		// load?: (opts: { activity: Predicate; preload: boolean; state: Store }) => Data
		// loadAsync?: (opts: { activity: Predicate; preload: boolean; state: Store }) => Promise<Data>

		// default false
		unloadOnLeave?: boolean

		onEnter?: (opts: { key: Key; data: Data; draft: Im.WritableDraft<Store> }) => Promise<void> | void
		onUnload?: (opts: { key: Key; data: Data | undefined; state: Im.WritableDraft<Store> }) => Promise<void> | void
		onLeave?: (opts: { key: Key; data: Data; draft: Im.WritableDraft<Store> }) => Promise<void> | void

		// use in cases where this loader has ephemeral external dependencies which (we use it to unload entries that reference a removed itemId)
		checkShouldUnload?: (opts: { key: Key; data: Data | undefined; state: Store }) => boolean
	}
	& ({
		load: (opts: { activity: Key; preload: boolean; state: Store }) => Data
	} | {
		loadAsync: (opts: { activity: Key; preload: boolean; state: Store; abortController: AbortController }) => Promise<Data>
	})

function hasSyncLoader<Config extends ActivityLoaderConfig>(config: Config): config is Extract<Config, { load: (...args: any[]) => any }> {
	return typeof (config as any).load === 'function'
}
function hasAsyncLoader<Config extends ActivityLoaderConfig>(
	config: Config,
): config is Extract<Config, { loadAsync: (...args: any[]) => any }> {
	return typeof (config as any).loadAsync === 'function'
}

type ActivityLoaderConfig<Name extends string = string, Key = any, Data = any> =
	& {
		match: (state: SLL.RootActivity) => Key | undefined
		name: Name
	}
	& ActivityLoaderConfigOptions<Key, Data>

export type LoaderCacheEntry<Config extends ActivityLoaderConfig, Loaded extends boolean = boolean> = {
	name: Config['name']
	key: LoaderCacheKey<Config>
	data: Loaded extends true ? LoaderData<Config> : Loaded extends false ? undefined : LoaderData<Config> | undefined
	active: boolean
	// unsubscribe to unschedule staletime unload
	unloadSub?: Rx.Subscription

	// aborts loading if async
	loadAbortController?: AbortController
}
export type LoaderResult<Config extends ActivityLoaderConfig> = Config extends { loadAsync: () => infer Result } ? Result
	: LoaderData<Config>
export type LoaderData<Config extends ActivityLoaderConfig> = Config extends ActivityLoaderConfig<any, any, infer Data> ? Data
	: never
export type LoaderCacheKey<Config extends ActivityLoaderConfig> = Exclude<ReturnType<Config['match']>, undefined>
export type LoadedActivityState = LoaderCacheEntry<ConfiguredLoaderConfig, true>

// -------- configure loaders --------
export type ConfiguredLoaders = typeof ACTIVITY_LOADER_CONFIGS
export type ConfiguredLoaderConfig = ConfiguredLoaders[number]
const ACTIVITY_LOADER_CONFIGS = (function getActivityLoaderConfigs() {
	function newActivityLoaderConfig<Name extends string, Predicate extends ST.Match.Node>(
		name: Name,
		match: (state: SLL.RootActivity) => Predicate | undefined,
	) {
		return <Data>(config: ActivityLoaderConfigOptions<Predicate, Data>): ActivityLoaderConfig<Name, Predicate, Data> => ({
			name,
			match,
			...config,
		})
	}
	const eventConfigs = [
		newActivityLoaderConfig(
			'selectLayers',
			s => {
				const node = s.child.EDITING?.chosen
				if (node?.id === 'ADDING_ITEM' || node?.id === 'EDITING_ITEM') return node
				return undefined
			},
		)(
			{
				// this is what ensures that we reset the dialogs after they're closed
				unloadOnLeave: true,

				load(args) {
					let editedLayerId: L.LayerId | undefined
					if (args.activity.id === 'EDITING_ITEM') {
						const { item } = Obj.destrNullable(LL.findItemById(args.state.layerList, args.activity.opts.itemId))
						if (item) editedLayerId = item.layerId
					}
					const input = SelectLayersFrame.createInput({
						cursor: LQY.fromLayerListCursor(args.activity.opts.cursor),
						initialEditedLayerId: editedLayerId,
					})
					const frameKey = frameManager.ensureSetup(SelectLayersFrame.frame, input)
					return { selectLayersFrame: frameKey, activity: args.activity }
				},
				onEnter(_args) {},
				onUnload(args) {
					// crudely wait for unload to render as  .teardown will probably trigger a react rerender by itself. in future we could do this in a different lifecycle event
					if (args.data) void requestIdleCallback(() => frameManager.teardown(args.data!.selectLayersFrame))
				},
				checkShouldUnload(args) {
					if (args.key.opts.cursor.type !== 'item-relative') return false
					const itemId = args.key.opts.cursor.itemId
					return !LL.findItemById(args.state.layerList, itemId)
				},
			},
		),
	] as const

	return eventConfigs
})()

function createStore() {
	const store = Zus.createStore<Store>((set, get, store) => {
		const session = SLL.createNewSession()
		store.subscribe((state, prev) => {
			if (state.session.list !== state.layerList) {
				set({ layerList: state.session.list })
			}

			const isModified = state.session.ops.length > 0
			const prevIsModified = prev.session.ops.length > 0
			if (isModified !== prevIsModified) {
				set({ isModified })
			}

			;(() => {
				if (prev.presence !== state.presence) {
					set({ userPresence: SLL.resolveUserPresence(state.presence) })

					const config = ConfigClient.getConfig()
					if (!config) return
					const wsClientId = config.wsClientId
					const prevClientActivityState = prev.presence.get(wsClientId)?.activityState ?? null
					const clientActivityState = state.presence.get(wsClientId)?.activityState ?? null
					if (prevClientActivityState !== clientActivityState) {
						dispatchClientActivityEvents(clientActivityState, prevClientActivityState, false)
					}
				}
			})()
			for (const entry of state.activityLoaderCache) {
				const config = ACTIVITY_LOADER_CONFIGS.find(e => e.name === entry.name)
				if (!config?.checkShouldUnload) continue

				const shouldUnload = config.checkShouldUnload({ key: entry.key, data: entry.data, state })
				if (shouldUnload) {
					set(Im.produce<Store>(draft => {
						unloadLoaderEntry(config, entry.key, draft)
					}))
				}
			}
		})

		function dispatchClientActivityEvents(
			updated: SLL.RootActivity | null,
			prev: SLL.RootActivity | null,
			preloading: boolean,
		) {
			set(Im.produce<Store>(draft => {
				const loaderCache = draft.activityLoaderCache
				if (updated == prev) return
				for (const config of ACTIVITY_LOADER_CONFIGS) {
					const cacheKey = updated ? config.match(updated) : undefined
					const prevCacheKey = prev ? config.match(prev) : undefined
					if (Obj.deepEqual(cacheKey, prevCacheKey)) continue
					if (!cacheKey) {
						if (!prevCacheKey || preloading) continue
						for (const entry of loaderCache) {
							if (!entry.active || !Obj.deepEqual(prevCacheKey, entry.key)) continue
							if (!loaderCache.includes(entry)) return
							if (config.unloadOnLeave) {
								unloadLoaderEntry(config, prevCacheKey, draft)
							} else {
								entry.unloadSub = scheduleUnloadLoaderEntry(config, prevCacheKey)
							}
							if (config.onLeave) {
								entry.active = false
								void config.onLeave({ key: prevCacheKey, data: Im.current(entry.data!) as LoaderData<typeof config>, draft })
							}
						}
						continue
					}
					const existingEntry = loaderCache.find(e => Obj.deepEqual(e.key, cacheKey))
					let cacheEntry: LoaderCacheEntry<typeof config>
					let load$: Rx.Observable<LoaderData<typeof config> | undefined> | undefined
					if (!existingEntry) {
						cacheEntry = { name: config.name, key: cacheKey, active: undefined!, data: undefined }
						const args = { activity: cacheKey, preload: preloading, state: Im.current(draft) as Store }
						if (hasSyncLoader(config)) {
							const data = config.load(args)
							cacheEntry.data = data
						} else if (hasAsyncLoader(config)) {
							const controller = new AbortController()
							cacheEntry.loadAbortController = controller
							const directLoad$ = Rx.from(
								config.loadAsync({ ...args, abortController: cacheEntry.loadAbortController }).catch(() => undefined),
							)
							load$ = Rx.race(
								directLoad$,
								Rx.fromEvent(controller.signal, 'abort', { once: true }).pipe(Rx.map(() => undefined)),
							)
							load$.subscribe((data: LoaderData<typeof config> | undefined) => {
								if (data === undefined) return
								set(Im.produce<Store>(draft => {
									const cacheEntry = draft.activityLoaderCache.find(entry => entry.key === cacheKey)
									if (cacheEntry) {
										cacheEntry.data = data
									}
								}))
							})
						}

						loaderCache.push(cacheEntry)
					} else {
						cacheEntry = existingEntry as LoaderCacheEntry<typeof config>
					}
					if (preloading) {
						if (cacheEntry.active) continue
						cacheEntry.active = false
						cacheEntry.unloadSub?.unsubscribe()
						cacheEntry.unloadSub = scheduleUnloadLoaderEntry(config as any, cacheKey as any)
					} else {
						if (cacheEntry.data) {
							cacheEntry.active = true
							cacheEntry.unloadSub?.unsubscribe()
							delete cacheEntry.unloadSub
							void config.onEnter?.({ key: cacheKey, data: cacheEntry.data, draft: draft })
						} else if (load$) {
							load$.subscribe((data: LoaderData<typeof config> | undefined) => {
								if (!data) return
								set(Im.produce<Store>(draft => {
									const cacheEntry = draft.activityLoaderCache.find(entry => entry.key === cacheKey)
									if (cacheEntry) {
										cacheEntry.data = data
									}
								}))
							})
						}
					}
				}
			}))
		}

		function unloadLoaderEntry<Config extends ActivityLoaderConfig>(
			config: Config,
			key: LoaderCacheKey<Config>,
			draft: Im.WritableDraft<Store>,
		) {
			const loaderCache = draft.activityLoaderCache
			const cacheEntry = loaderCache.find(e => Obj.deepEqual(e.key, key))
			if (!cacheEntry) return
			draft.activityLoaderCache = loaderCache.filter(e => !Obj.deepEqual(e.key, key))
			if (config.onUnload) {
				const args = { key, data: Im.current(cacheEntry.data), state: draft }
				void config.onUnload(args)
			}
			cacheEntry?.loadAbortController?.abort('unloaded')
		}

		function scheduleUnloadLoaderEntry<Config extends ActivityLoaderConfig>(
			config: Config,
			predicate: LoaderCacheKey<Config>,
		) {
			if (config.staleTime === undefined) return

			return Rx.of(1).pipe(Rx.delay(config.staleTime)).subscribe(() => {
				set(Im.produce<Store>(draft => {
					unloadLoaderEntry(config, predicate, draft)
				}))
			})
		}

		return {
			session,

			sessionSeqId: 0,
			syncedState: SLL.createNewSession(),
			itemLocks: new Map(),

			outgoingOpsPendingSync: [],
			incomingOpsPendingSync: [],

			hoveredActivityUserId: null,
			setHoveredActivityUserId(userId, hovered) {
				if (!hovered) {
					if (userId !== get().hoveredActivityUserId) return
					else set({ hoveredActivityUserId: null })
				} else {
					set({ hoveredActivityUserId: userId })
				}
			},

			presence: new Map(),
			userPresence: new Map(),

			// shorthands
			layerList: session.list,
			isModified: false,

			_activityState: null,

			async handleServerUpdate(update) {
				switch (update.code) {
					case 'init': {
						this.pushPresenceAction(PresenceActions.editSessionChanged)
						set({
							session: update.session,
							syncedState: update.session,
							outgoingOpsPendingSync: [],
							presence: MapUtils.union(update.presence, get().presence),
							sessionSeqId: update.sessionSeqId,
							itemLocks: new Map(),
						})
						break
					}
					case 'op': {
						const state = get()
						const nextPendingOpId = state.outgoingOpsPendingSync[0]

						if (nextPendingOpId && nextPendingOpId === update.op.opId) {
							const serverDivergedOps = state.incomingOpsPendingSync
							const serverSession = Obj.deepClone(state.syncedState)
							SLL.applyOperations(serverSession, [...serverDivergedOps, update.op])

							set({
								session: serverSession,
								syncedState: serverSession,
								incomingOpsPendingSync: [],
								outgoingOpsPendingSync: this.outgoingOpsPendingSync.slice(1),
							})
						} else if (nextPendingOpId) {
							set({ incomingOpsPendingSync: [...state.incomingOpsPendingSync, update.op] })
						} else {
							set(state =>
								Im.produce(state, draft => {
									SLL.applyOperations(draft.syncedState, [update.op])
									SLL.applyOperations(draft.session, [update.op])
								})
							)
						}

						break
					}
					case 'update-presence': {
						set(state =>
							Im.produce(state, draft => {
								let currentPresence = draft.presence.get(update.wsClientId)
								if (!currentPresence) {
									currentPresence = SLL.getClientPresenceDefaults(update.userId)
									draft.presence.set(update.wsClientId, currentPresence)
								}

								SLL.updateClientPresence(currentPresence, { ...update.changes })
							})
						)
						break
					}

					case 'reset-completed':
					case 'list-updated':
					case 'commit-completed': {
						if (update.code === 'list-updated') {
							globalToast$.next({ title: 'Queue Updated' })
						} else {
							const msg = `Queue ${update.code === 'commit-completed' ? 'updated' : 'reset'} by ${update.initiator}`
							globalToast$.next({ title: msg })
						}
						// we always re-push our own state because we may have edited our presence since the server sent this update
						this.pushPresenceAction(PresenceActions.editSessionChanged)
						set(state =>
							Im.produce(state, draft => {
								draft.sessionSeqId = update.newSessionSeqId
								draft.session = draft.syncedState = SLL.createNewSession(update.list)
								draft.itemLocks = new Map()
								PresenceActions.applyToAll(draft.presence, draft.session, PresenceActions.editSessionChanged)
							})
						)
						break
					}

					case 'commit-rejected': {
						globalToast$.next({ variant: 'destructive', title: update.msg })
						break
					}

					case 'locks-modified': {
						set(state =>
							Im.produce(state, draft => {
								for (const [itemId, wsClientId] of update.mutations) {
									if (wsClientId === null) draft.itemLocks.delete(itemId)
									else draft.itemLocks.set(itemId, wsClientId)
								}
							})
						)
						break
					}

					case 'commit':
					case 'reset':
						break

					default:
						assertNever(update)
				}
			},

			// try to call this such that react will batch the rerenders
			async dispatch(newOp) {
				const userId = UsersClient.loggedInUserId!
				const baseProps = { opId: createId(6), userId }

				let op: SLL.Operation
				const source: LL.Source = { type: 'manual', userId }
				switch (newOp.op) {
					case 'add': {
						const items = newOp.items.map(item => LL.createLayerListItem(item, source))
						op = {
							op: 'add',
							index: newOp.index,
							items,
							...baseProps,
						}
						break
					}
					default: {
						op = {
							...newOp,
							...baseProps,
						}
						break
					}
				}

				set(state =>
					Im.produce(state, draft => {
						draft.outgoingOpsPendingSync.push(op.opId)
						SLL.applyOperations(draft.session, [op])
					})
				)
				this.updateActivity(SLL.TOGGLE_EDITING_TRANSITIONS.createActivity)

				await processUpdate({
					code: 'op',
					op,
					expectedIndex: get().session!.ops.length - 1,
					sessionSeqId: get().sessionSeqId,
				})
			},

			async pushPresenceAction(action) {
				const config = ConfigClient.getConfig()
				if (!config) return
				const state = get()
				const userId = UsersClient.loggedInUserId
				if (!userId) return
				const hasEdits = SLL.checkUserHasEdits(state.session, userId!)
				let update = action({ hasEdits, prev: state.presence.get(config.wsClientId) })
				update = Obj.trimUndefined(update)
				let presenceUpdated = false
				const beforeUpdates = get().presence.get(config.wsClientId)
				set(state =>
					Im.produce(state, draft => {
						let currentPresence = draft.presence.get(config.wsClientId)
						if (!currentPresence) {
							currentPresence = SLL.getClientPresenceDefaults(userId)
							draft.presence.set(config.wsClientId, currentPresence)
						}

						presenceUpdated = SLL.updateClientPresence(
							currentPresence,
							update,
						)
					})
				)
				if (presenceUpdated) {
					const res = await processUpdate({
						code: 'update-presence',
						wsClientId: config.wsClientId,
						userId,
						changes: update,
					})
					if (res?.code === 'err:locked' && beforeUpdates) {
						this.pushPresenceAction(PresenceActions.failedToAcquireLocks(beforeUpdates))
					}
				}
			},

			activityLoaderCache: [],

			updateActivity(update) {
				const config = ConfigClient.getConfig()
				if (!config) return
				let prev: SLL.RootActivity | null = get().presence.get(config.wsClientId)?.activityState ?? null
				if (!prev) {
					prev = SLL.DEFAULT_ACTIVITY
				}
				const next = update(prev)
				get().pushPresenceAction(PresenceActions.updateActivity(next))
			},

			preloadActivity(update) {
				requestIdleCallback(() => {
					const config = ConfigClient.getConfig()
					if (!config) return
					let prev: SLL.RootActivity | null = get().presence.get(config.wsClientId)?.activityState ?? null
					if (!prev) {
						prev = {
							_tag: 'branch',
							id: 'ON_QUEUE_PAGE',
							opts: {},
							child: {},
						}
					}
					const next = update(prev)
					dispatchClientActivityEvents(next, prev, true)
				})
			},

			saving: false,
			async save() {
				set({ saving: true })
				try {
					const commitResponse = Rx.firstValueFrom(
						serverUpdate$.pipe(Rx.filter(update => update.code === 'commit-completed' || update.code === 'commit-rejected')),
					)
					await processUpdate({
						code: 'commit',
						sessionSeqId: get().sessionSeqId,
					})
					await commitResponse
				} finally {
					set({ saving: false })
				}
			},

			async reset() {
				await processUpdate({
					code: 'reset',
					sessionSeqId: get().sessionSeqId,
				})
			},
		}
	})

	return store
}

async function processUpdate(update: SLL.ClientUpdate) {
	const res = await RPC.orpc.sharedLayerList.processUpdate.call(update)

	if (res && res.code === 'err:permission-denied') {
		RbacClient.handlePermissionDenied(res)
		return
	} else if (res) {
		globalToast$.next({ variant: 'destructive', title: res.msg })
	}
	return res
}

export function useItemPresence(itemId: LL.ItemId) {
	const [presence, activityHovered] = Zus.useStore(
		Store,
		ZusUtils.useDeep(state => {
			const res = MapUtils.find(
				state.presence,
				(_, v) => {
					const activity = v.activityState?.child.EDITING?.chosen
					return !!activity && SLL.isItemOwnedActivity(activity) && activity.opts.itemId === itemId
				},
			)
			if (!res) return [undefined, undefined] as const
			const root = res[1].activityState!
			const presence = {
				...res?.[1],
				itemActivity: root.child.EDITING!.chosen as SLL.ItemOwnedActivity,
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
	const presence = Zus.useStore(Store, state => config ? state.presence.get(config?.wsClientId) : undefined)
	return presence
}

export async function setup() {
	serverUpdate$.subscribe(update => {
		Store.getState().handleServerUpdate(update)
	})

	const settingsModified$ = toStream(ServerSettingsClient.Store).pipe(Rx.map(s => s.modified), Rx.distinctUntilChanged())

	const wsClientId$ = ConfigClient.fetchConfig().then(config => config.wsClientId)
	settingsModified$.pipe(
		Rx.withLatestFrom(wsClientId$),
	).subscribe(([modified, wsClientId]) => {
		try {
			const currentActivity = Store.getState().presence.get(wsClientId)?.activityState
			const dialogActivity = currentActivity?.child?.VIEWING_SETTINGS
			const inChangingSettingsActivity = dialogActivity?.id === 'VIEWING_SETTINGS' && dialogActivity?.child?.CHANGING_SETTINGS
			if (!modified && inChangingSettingsActivity) {
				Store.getState().updateActivity(Im.produce(draft => {
					const activity = draft.child?.VIEWING_SETTINGS
					if (!activity) return
					delete activity.child.CHANGING_SETTINGS
				}))
			}
			if (modified) {
				Store.getState().updateActivity(Im.produce(draft => {
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

export function useIsEditing() {
	const config = ConfigClient.useConfig()
	const isEditing = Zus.useStore(Store, (s) => config ? !!s.presence.get(config.wsClientId)?.activityState?.child?.EDITING : undefined)
		?? false

	return isEditing
}

export function useIsItemLocked(itemId: LL.ItemId) {
	const globalVoteState = VotesClient.useVoteState()
	const config = UsersClient.useLoggedInUser()
	const locked = Zus.useStore(Store, (s) => {
		const lockedClientId = s.itemLocks.get(itemId)
		if (!lockedClientId) return false
		return config && config.wsClientId !== lockedClientId
	})
	const voteState = globalVoteState?.itemId === itemId ? globalVoteState : undefined
	return locked || voteState?.code === 'in-progress'
}

// allows familiar useState binding to a presence activity. it's expected that multiple dialogs can bind to the same presence so activating a presence will not flip the state
export function useActivityState<P>(
	opts: {
		createActivity: (prev: SLL.RootActivity) => SLL.RootActivity
		removeActivity: (prev: SLL.RootActivity) => SLL.RootActivity

		// the callback passed here should probably be memoized
		matchActivity: (prev: SLL.RootActivity) => P
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
			const state = (config ? Store.getState().presence.get(config?.wsClientId)?.activityState : undefined) ?? SLL.DEFAULT_ACTIVITY
			return matchActivity(state)
		}, [matchActivity])),
	)
	const setActive: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		const config = ConfigClient.getConfig()
		if (!config) return
		const storeState = Store.getState()
		const state = Store.getState().presence.get(config?.wsClientId)?.activityState ?? SLL.DEFAULT_ACTIVITY

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
	const [hovered, setHovered] = Zus.useStore(Store, useShallow((state) => [state.hoveredActivityUserId, state.setHoveredActivityUserId]))
	return [hovered, setHovered] as const
}

export const selectActivityPresent = (targetActivity: SLL.RootActivity) => (state: Store) => {
	for (const [activity] of SLL.iterActivities(state.presence)) {
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

export function useActivityLoaded(_matchActivity: (state: SLL.RootActivity) => boolean) {
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
