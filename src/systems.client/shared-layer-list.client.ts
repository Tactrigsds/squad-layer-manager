import * as AR from '@/app-routes'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { frameManager, getFrameState } from '@/frames/frame-manager'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as Browser from '@/lib/browser'
import * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ST from '@/lib/state-tree'
import { assertNever } from '@/lib/type-guards'
import { destrNullable, NumericKeys } from '@/lib/types'
import * as ZusUtils from '@/lib/zustand'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SLL from '@/models/shared-layer-list'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import * as ConfigClient from '@/systems.client/config.client'
import * as LQYClient from '@/systems.client/layer-queries.client'
import * as RbacClient from '@/systems.client/rbac.client'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as UsersClient from '@/systems.client/users.client'
import * as VotesClient from '@/systems.client/votes.client'
import * as ReactRx from '@react-rxjs/core'
import * as TQ from '@tanstack/react-query'
import * as Im from 'immer'
import React, { cache } from 'react'
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

	activityLoaderCache: ActivityLoaderCacheEntry<(typeof activityLoaderConfigs)[number]>[]

	updateActivity: (update: (prev: SLL.Activity) => SLL.Activity) => void
	preloadActivity: (update: (prev: SLL.Activity) => SLL.Activity) => void
}

export type ActivityLoaderCacheEntry<Config extends ActivityLoaderConfig<any, any, any>> = {
	name: Config['name']
	key: Config extends ActivityLoaderConfig<any, infer Predicate, any> ? Predicate : never
	data?: Config extends ActivityLoaderConfig<any, any, infer Data> ? Data : never
	active: boolean
	unloadSub?: Rx.Subscription
}

type ActivityLoaderCacheEntryLoaded<Config extends ActivityLoaderConfig<any, any, any>> = ActivityLoaderCacheEntry<Config> & {
	data: Config extends ActivityLoaderConfig<any, any, infer Data> ? Data : never
}

const [_useServerUpdate, serverUpdate$] = ReactRx.bind<SLL.Update>(
	RPC.observe(() => RPC.orpc.sharedLayerList.watchUpdates.call()),
)

export const Store = createStore()

type MatchFn<Predicate> = (state: SLL.Activity) => Predicate | undefined

type ActivityLoaderConfigOptions<Predicate, Data = never> = {
	// the time before we unload an inactive action
	staleTime?: number

	// don't mutate the store from the loader pretty please
	load?: (opts: { activity: Predicate; preload: boolean; state: Store }) => Awaited<Data>

	onEnter?: (opts: { activity: Predicate; data: Data; state: Im.WritableDraft<Store> }) => Promise<void> | void
	onUnload?: (opts: { activity: Predicate; data: Data; state: Im.WritableDraft<Store> }) => Promise<void> | void
	onLeave?: (opts: { activity: Predicate; data: Data; state: Im.WritableDraft<Store> }) => Promise<void> | void
}

type ActivityLoaderConfig<Name extends string = string, Predicate = any, O = never> =
	& ActivityLoaderConfigOptions<Predicate, O>
	& {
		match: MatchFn<Predicate>
		name: Name
	}
export type LoadedActivityState = ActivityLoaderCacheEntryLoaded<(typeof activityLoaderConfigs)[number]>

const activityLoaderConfigs = (function getActivityLoaderConfigs() {
	function newActivityLoaderConfig<Name extends string, Predicate extends ST.Match.Node>(
		name: Name,
		match: (state: SLL.Activity) => Predicate | undefined,
	) {
		return <O>(config: ActivityLoaderConfigOptions<Predicate, O>): ActivityLoaderConfig<Name, Predicate, O> => ({
			name,
			match,
			...config,
		})
	}
	const eventConfigs = [
		newActivityLoaderConfig(
			'selectLayers',
			s => {
				const node = s.child.EDITING?.child
				if (node?.id === 'ADDING_ITEM' || node?.id === 'EDITING_ITEM') return node
				return undefined
			},
		)(
			{
				load(args) {
					let editedLayerId: L.LayerId | undefined
					if (args.activity.id === 'EDITING_ITEM') {
						const { item } = destrNullable(LL.findItemById(args.state.layerList, args.activity.opts.itemId))
						if (item) editedLayerId = item.layerId
					}
					const input = SelectLayersFrame.createInput(
						args.activity.id === 'EDITING_ITEM'
							? { initialEditedLayerId: editedLayerId }
							: { cursor: args.activity.opts.cursor },
					)
					const frameKey = frameManager.ensureSetup(SelectLayersFrame.frame, input)
					const frameState = getFrameState(frameKey)
					const queryInput = LayerTablePrt.selectQueryInput(frameState)
					RPC.queryClient.prefetchQuery(LQYClient.getQueryLayersOptions(queryInput))
					return { selectLayersFrame: frameKey, activity: args.activity }
				},
				onEnter(args) {},
				onLeave(args) {
					const frameState = getFrameState(args.data.selectLayersFrame)
					if (frameState.layerTable.sort?.type === 'random') {
						frameState.layerTable.randomize()
					}
				},
				staleTime: 30_000,
				onUnload(args) {
					frameManager.teardown(args.data.selectLayersFrame)
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

			if (prev.presence !== state.presence) {
				set({ userPresence: SLL.resolveUserPresence(state.presence) })

				const wsClientId = ConfigClient.getConfig().wsClientId
				const prevClientActivityState = prev.presence.get(wsClientId)?.activityState ?? null
				const clientActivityState = state.presence.get(wsClientId)?.activityState ?? null
				if (prevClientActivityState !== clientActivityState) {
					dispatchClientActivityEvents(clientActivityState, prevClientActivityState, false)
				}
			}
		})

		function dispatchClientActivityEvents(
			updated: SLL.Activity | null,
			prev: SLL.Activity | null,
			preload: boolean,
		) {
			set(Im.produce<Store>(draft => {
				const loaderCache = draft.activityLoaderCache
				if (updated == prev) return
				if (!preload) draft._activityState = updated
				for (const config of activityLoaderConfigs) {
					const predicate = updated ? config.match(updated) : undefined
					const prevPredicate = prev ? config.match(prev) : undefined
					if (Obj.deepEqual(predicate, prevPredicate)) continue
					if (!predicate) {
						if (!prevPredicate) continue
						for (const entry of loaderCache) {
							if (!entry.active || !Obj.deepEqual(prevPredicate, entry.key)) continue
							if (!loaderCache.includes(entry)) return
							const args = { activity: prevPredicate, data: Im.current(entry.data), state: draft } as any
							entry.active = false
							config.onLeave?.(args)
							entry.unloadSub = scheduleUnload(config as any, prevPredicate as any)
						}
						continue
					}
					const existingEntry = loaderCache.find(e => Obj.deepEqual(e.key, predicate))
					let cacheEntry: ActivityLoaderCacheEntry<typeof config>
					if (!existingEntry) {
						cacheEntry = { name: config.name, key: predicate, active: undefined! }
						const maybePromise = config.load?.({ activity: predicate, preload, state: draft }) as any

						if (maybePromise && 'then' in maybePromise) {
							;(maybePromise as Promise<any>).then((data) => (
								set(Im.produce<Store>(draft => {
									const cacheEntry = draft.activityLoaderCache.find(entry => entry.key === predicate)
									if (cacheEntry) {
										cacheEntry.data = data
									}
								}))
							))
						} else {
							cacheEntry.data = maybePromise as any
						}
						loaderCache.push(cacheEntry)
					} else {
						cacheEntry = existingEntry as ActivityLoaderCacheEntry<typeof config>
					}
					if (preload) {
						if (cacheEntry.active) continue
						cacheEntry.active = false
						cacheEntry.unloadSub?.unsubscribe()
						cacheEntry.unloadSub = scheduleUnload(config as any, predicate as any)
					} else {
						cacheEntry.active = true
						cacheEntry.unloadSub?.unsubscribe()
						if (!loaderCache.includes(cacheEntry)) return
						config.onEnter?.({ activity: predicate, data: cacheEntry.data as any, state: draft })
						delete cacheEntry.unloadSub
					}
				}
			}))

			function scheduleUnload<Predicate extends ST.Match.Node>(config: ActivityLoaderConfig<string, Predicate>, predicate: Predicate) {
				return Rx.of(1).pipe(Rx.delay(config.staleTime ?? 1000)).subscribe(async () => {
					const data = get().activityLoaderCache.find(e => Obj.deepEqual(e.key, predicate))?.data
					set(Im.produce<Store>(draft => {
						const loaderCache = draft.activityLoaderCache
						const cacheEntry = loaderCache.find(e => Obj.deepEqual(e.key, predicate))
						if (!cacheEntry) return
						draft.activityLoaderCache = loaderCache.filter(e => !Obj.deepEqual(e.key, predicate))
						const args = { activity: predicate, data, state: draft as any } as any
						config.onUnload?.(args)
					}))
				})
			}
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

			async dispatch(newOp) {
				const userId = (await UsersClient.fetchLoggedInUser()).discordId
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

				await processUpdate({
					code: 'op',
					op,
					expectedIndex: get().session!.ops.length - 1,
					sessionSeqId: get().sessionSeqId,
				})
			},

			async pushPresenceAction(action) {
				const config = ConfigClient.getConfig()
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
				let prev: SLL.Activity | null = get().presence.get(ConfigClient.getConfig().wsClientId)?.activityState ?? null
				if (!prev) {
					prev = {
						_tag: 'branch',
						id: 'ON_QUEUE_PAGE',
						opts: {},
						child: {},
					}
				}
				const next = update(prev)
				get().pushPresenceAction(PresenceActions.updateActivity(next))
			},

			preloadActivity(update) {
				let prev: SLL.Activity | null = get().presence.get(ConfigClient.getConfig().wsClientId)?.activityState ?? null
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
					const activity = v.activityState?.child.EDITING?.child
					return !!activity && SLL.isItemOwnedActivity(activity) && activity.opts.itemId === itemId
				},
			)
			if (!res) return [undefined, undefined] as const
			const root = res[1].activityState!
			const presence = {
				...res?.[1],
				itemActivity: root.child.EDITING!.child as SLL.ItemOwnedActivity,
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
export function useActivityState(
	opts: {
		createActivity: (prev: SLL.Activity) => SLL.Activity
		removeActivity: (prev: SLL.Activity) => SLL.Activity
		matchActivity: (prev: SLL.Activity) => boolean
	},
) {
	const createActivityRef = React.useRef(opts.createActivity)
	const matchActivityRef = React.useRef(opts.matchActivity)
	const removeActivityRef = React.useRef(opts.removeActivity)

	const config = ConfigClient.useConfig()
	const [active, _setActive] = React.useState(() => {
		const state = Store.getState().presence.get(ConfigClient.getConfig().wsClientId)?.activityState
		return !!state && !!matchActivityRef.current(state)
	})
	const activeRef = React.useRef(active)

	const setActive: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		const newActive = typeof update === 'function' ? update(active) : update

		_setActive(newActive)
		activeRef.current = newActive

		const storeState = Store.getState()
		const state = storeState.presence.get(ConfigClient.getConfig().wsClientId)?.activityState
		if (!state) return
		const alreadyActive = !!state && !matchActivityRef.current(state)

		if (newActive && !alreadyActive) {
			storeState.updateActivity(createActivityRef.current)
		}
		if (!newActive && alreadyActive) {
			storeState.updateActivity(removeActivityRef.current)
		}
	}, [_setActive, active])

	React.useEffect(() => {
		if (!config) return
		const unsub = Store.subscribe((state) => {
			const currentActivity = state.presence.get(ConfigClient.getConfig().wsClientId)?.activityState
			if (!currentActivity || !matchActivityRef.current(currentActivity)) {
				_setActive(false)
				activeRef.current = false
			}
		})
		return () => unsub()
	}, [config, _setActive])

	React.useEffect(() => {
		if (!active) return

		// end activity if this component unmounts
		const removeActivity = removeActivityRef.current
		return () => Store.getState().updateActivity(removeActivity)
	}, [active])

	return [active, setActive] as const
}

export function useHoveredActivityUser() {
	const [hovered, setHovered] = Zus.useStore(Store, useShallow((state) => [state.hoveredActivityUserId, state.setHoveredActivityUserId]))
	return [hovered, setHovered] as const
}

export const selectActivityPresent = (targetActivity: SLL.Activity) => (state: Store) => {
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
