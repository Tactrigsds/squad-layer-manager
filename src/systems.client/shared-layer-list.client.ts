import { globalToast$ } from '@/hooks/use-global-toast'
import * as Browser from '@/lib/browser'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as TrpcHelpers from '@/lib/trpc-helpers'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as LL from '@/models/layer-list.models'
import * as SLL from '@/models/shared-layer-list'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as USR from '@/models/users.models'
import * as AppRoutesClient from '@/systems.client/app-routes.client.ts'
import * as ConfigClient from '@/systems.client/config.client'
import * as RbacClient from '@/systems.client/rbac.client'
import * as UsersClient from '@/systems.client/users.client'
import * as VotesClient from '@/systems.client/votes.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
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
	handleClientPresenceUpdate(update: PresenceActions.ActionOutput): Promise<void>
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
}

const [useUpdate, update$] = ReactRx.bind<SLL.Update>(
	TrpcHelpers.fromTrpcSub(undefined, trpc.sharedLayerList.watchUpdates.subscribe),
)

export const [Store, storeSubHandle] = createStore()

function createStore() {
	const store = Zus.createStore<Store>((set, get) => {
		const session = SLL.createNewSession()

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

			async handleServerUpdate(update) {
				console.log('handling server update', update)
				switch (update.code) {
					case 'init':
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
								SLL.updateClientPresence(update.wsClientId, update.userId, draft.presence, update.changes)
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
				const baseProps = { opId: createId(6), userId: UsersClient.loggedInUserId! }

				let op: SLL.Operation
				const source: LL.Source = { type: 'manual', userId: UsersClient.loggedInUserId! }
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

				void this.pushPresenceAction(PresenceActions.madeEditAction)

				await processUpdate({
					code: 'op',
					op,
					expectedIndex: get().session!.ops.length - 1,
					sessionSeqId: get().sessionSeqId,
				})
			},

			async pushPresenceAction(action) {
				const config = await ConfigClient.fetchConfig()
				const state = get()
				const hasEdits = SLL.checkUserHasEdits(state.session, UsersClient.loggedInUserId!)
				const update = action({ hasEdits, prev: state.presence.get(config.wsClientId) })
				await this.handleClientPresenceUpdate(update)
			},

			async handleClientPresenceUpdate(update) {
				console.log('handleClientPresenceUpdate', update)
				update = Obj.trimUndefined(update)
				const config = await ConfigClient.fetchConfig()
				let presenceUpdated = false
				delete (update as any).userId
				set(state =>
					Im.produce(state, draft => {
						presenceUpdated = SLL.updateClientPresence(
							config.wsClientId,
							UsersClient.loggedInUserId!,
							draft.presence,
							update,
						)
					})
				)
				if (presenceUpdated) {
					const res = await processUpdate({
						code: 'update-presence',
						userId: UsersClient.loggedInUserId!,
						wsClientId: config.wsClientId,
						changes: update,
					})
					if (res?.code === 'err:locked') {
						set(state =>
							Im.produce(state, draft => {
								const presence = draft.presence.get(config.wsClientId)
								if (!presence) return
								presence.currentActivity = null
							})
						)
					}
				}
			},

			saving: false,
			async save() {
				set({ saving: true })
				try {
					const commitResponse = Rx.firstValueFrom(
						update$.pipe(Rx.filter(update => update.code === 'commit-completed' || update.code === 'commit-rejected')),
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

	const subHandle = ZusUtils.createSubHandle((subs) => {
		subs.push(store.subscribe((state, prev) => {
			if (state.session.list !== state.layerList) {
				store.setState({ layerList: state.session.list })
			}

			const isModified = state.session.ops.length > 0
			const prevIsModified = prev.session.ops.length > 0
			if (isModified !== prevIsModified) {
				store.setState({ isModified })
			}

			if (prev.presence !== state.presence) {
				store.setState({ userPresence: SLL.resolveUserPresence(state.presence) })
			}
		}))
		subs.push(store.subscribe(async (state, prev) => {
			if (state.presence === prev.presence) return
			const config = await ConfigClient.fetchConfig()
			const clientPresence = state.presence.get(config.wsClientId)
			const prevClientPresence = prev.presence.get(config.wsClientId)
			if (!Obj.deepEqual(clientPresence, prevClientPresence)) {
				console.log('client presence changed', clientPresence)
			}
		}))
	})

	return [store, subHandle] as const
}

async function processUpdate(update: SLL.ClientUpdate) {
	const res = await trpc.sharedLayerList.processUpdate.mutate(update)

	if (res && res.code === 'err:permission-denied') {
		RbacClient.handlePermissionDenied(res)
	} else if (res) {
		globalToast$.next({ variant: 'destructive', title: res.msg })
	}
	return res
}

export function useItemPresence(itemId: LL.ItemId) {
	const [presence, activityHovered] = Zus.useStore(
		Store,
		useShallow(state => {
			const res = MapUtils.find(
				state.presence,
				(_, v) => !!v.currentActivity && SLL.isItemOwnedActivity(v.currentActivity) && v.currentActivity.itemId === itemId,
			)

			const presence = res?.[1] as (SLL.ClientPresence & { currentActivity: SLL.ItemOwnedActivity }) | undefined
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
	storeSubHandle.subscribe()
	update$.subscribe(update => {
		Store.getState().handleServerUpdate(update)
	})

	const onQueuePage$ = AppRoutesClient.route$
		.pipe(Rx.map(route => route?.id === '/servers/:id'))

	const pageInteration$ = onQueuePage$.pipe(
		Rx.switchMap((visiting) => {
			if (!visiting) return Rx.EMPTY
			return Browser.interaction$.pipe(Rx.startWith(true))
		}),
		Rx.debounceTime(1000),
	)

	const interactTimeout$ = pageInteration$.pipe(
		Rx.switchMap(() => {
			return Rx.of(true).pipe(Rx.delay(PresenceActions.INTERACT_TIMEOUT))
		}),
	)

	const onNavigateAway$ = onQueuePage$.pipe(
		// satisfy pairwise so we emit immediately
		Rx.startWith(false),
		Rx.pairwise(),
		Rx.switchMap(([visitingPrev, visiting]) => {
			if (!visitingPrev) return Rx.EMPTY
			if (!visiting) return Rx.of(true)
			// handle non-spa navigation while we're on a queue page
			return Rx.fromEvent(window, 'beforeunload')
		}),
	)

	pageInteration$
		.subscribe(() => {
			const storeState = Store.getState()
			storeState.pushPresenceAction(PresenceActions.pageInteraction)
		})

	interactTimeout$
		.subscribe(() => {
			const storeState = Store.getState()
			storeState.pushPresenceAction(PresenceActions.interactionTimeout)
		})

	onNavigateAway$.subscribe(() => {
		const storeState = Store.getState()
		storeState.pushPresenceAction(PresenceActions.navigatedAway)
	})
}

export function useIsEditing() {
	const config = ConfigClient.useConfig()
	const isEditing = Zus.useStore(Store, (s) => config ? s.presence.get(config.wsClientId)?.editing : undefined) ?? false

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
export function useActivityState(activity: SLL.ClientPresenceActivity, defaultState = false) {
	const activityRef = React.useRef(activity)
	const config = ConfigClient.useConfig()
	const [active, _setActive] = React.useState(defaultState)
	const activeRef = React.useRef(active)

	const setActive: React.Dispatch<React.SetStateAction<boolean>> = React.useCallback((update) => {
		const newActive = typeof update === 'function' ? update(active) : update
		const action = newActive ? PresenceActions.startActivity(activityRef.current) : PresenceActions.endActivity
		Store.getState().pushPresenceAction(action)
		_setActive(newActive)
		activeRef.current = newActive
	}, [_setActive, active])

	React.useEffect(() => {
		if (!config) return
		const unsub = Store.subscribe((state) => {
			const currentActivity = state.presence.get(config.wsClientId)?.currentActivity
			if (activeRef.current && (!currentActivity || !Obj.deepEqual(currentActivity, activityRef.current))) _setActive(false)
		})
		return () => unsub()
	}, [config])
	return [active, setActive] as const
}

// allows familiar useState binding to multiple presence activities. it's expected that multiple dialogs can bind to the same presence so activating a presence will not flip the state
export function useActivityKeyState<K extends string>(mapping: Record<K, SLL.ClientPresenceActivity>, defaultState: K | null = null) {
	const mappingRef = React.useRef(mapping)
	const config = ConfigClient.useConfig()
	const [active, _setActive] = React.useState<K | null>(defaultState)
	const activeRef = React.useRef(active)

	const setActive: React.Dispatch<React.SetStateAction<K | null>> = React.useCallback((update) => {
		const newActive = typeof update === 'function' ? update(active) : update
		const mapping = mappingRef.current
		const action = newActive ? PresenceActions.startActivity(mapping[newActive]) : PresenceActions.endActivity
		Store.getState().pushPresenceAction(action)
		_setActive(newActive)
		activeRef.current = newActive
	}, [_setActive, active])

	React.useEffect(() => {
		if (!config) return
		const unsub = Store.subscribe((state) => {
			const currentActivity = state.presence.get(config.wsClientId)?.currentActivity
			if (activeRef.current && (!currentActivity || !Obj.deepEqual(currentActivity, mappingRef.current[activeRef.current]))) {
				_setActive(null)
			}
		})
		return () => unsub()
	}, [config])
	return [active, setActive] as const
}

export function useHoveredActivityUser() {
	const [hovered, setHovered] = Zus.useStore(Store, useShallow((state) => [state.hoveredActivityUserId, state.setHoveredActivityUserId]))
	return [hovered, setHovered] as const
}
