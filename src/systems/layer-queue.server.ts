import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, toCold, withAbortSignal } from '@/lib/async.ts'
import * as Cleanup from '@/lib/cleanup'
import * as DH from '@/lib/display-helpers.ts'
import { IsolatedBehaviorSubject, IsolatedReplaySubject, IsolatedSubject } from '@/lib/isolated-subject'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards.ts'
import { DistributiveOmit } from '@/lib/types'
import { HumanTime } from '@/lib/zod.ts'
import * as Messages from '@/messages.ts'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as MH from '@/models/match-history.models'
import type * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list'
import type * as SM from '@/models/squad.models.ts'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as LayerQueriesServer from '@/systems/layer-queries.server'
import * as LayerQueries from '@/systems/layer-queries.shared.ts'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'
import * as VoteSys from '@/systems/vote.server'
import { Mutex, MutexInterface } from 'async-mutex'
import * as E from 'drizzle-orm'
import * as Rx from 'rxjs'
import { z } from 'zod'

export type LayerQueueSlice = {
	unexpectedNextLayerSet$: Rx.BehaviorSubject<L.LayerId | null>

	// TODO we should fold this into the server events
	update$: Rx.ReplaySubject<[SS.LQStateUpdate, C.Db & C.ServerId]>

	session: RbSyncState.Server.Session<SLL.Operation, SLL.State, SLL.SideEffect>
	op$: Rx.Subject<SLL.Operation>
	updateLayerMtx: MutexInterface
}

const module = initModule('layer-queue')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export function initLayerQueueSlice(ctx: C.ServerSliceCleanup & C.ServerId, serverState: SS.ServerState) {
	const sllState = SLL.createNewState(serverState.layerQueue)
	const sideEffect$ = new IsolatedSubject<SLL.SideEffect>()
	const slice: LayerQueueSlice = {
		unexpectedNextLayerSet$: new IsolatedBehaviorSubject<L.LayerId | null>(null),
		update$: new IsolatedReplaySubject(1),

		session: RbSyncState.Server.initSession<SLL.Operation, SLL.State, SLL.SideEffect>(sllState, {
			onSideEffect: (e) => sideEffect$.next(e),
		}),
		op$: new IsolatedSubject<SLL.Operation>(),
		updateLayerMtx: new Mutex(),
	}

	ctx.cleanup.push(
		slice.update$,
		slice.unexpectedNextLayerSet$,
		slice.op$,
		slice.updateLayerMtx,
	)

	return slice
}

export const setupInstance = C.spanOp(
	'setupInstance',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.vote.mtx },
	async (ctx: C.Db & C.ServerSlice) => {
		const serverId = ctx.serverId

		// populates list with generated queue item if the list is empty
		await dispatchOp(ctx, { op: 'init', opId: SLL.createOpId() })

		ctx.layerQueue.update$.subscribe(([state, ctx]) => {
			log.debug('pushing server state update')
		})

		// -------- schedule generic admin reminders --------
		if (ctx.serverSettings.settings.remindersAndAnnouncementsEnabled) {
			const GS = Settings.GLOBAL_SETTINGS
			ctx.cleanup.push(
				Rx.interval(GS.layerQueue.adminQueueReminderInterval).pipe(
					C.durableSub('queue-reminders', { module, levels: { event: 'info' } }, async () => {
						const baseCtx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
						const serverState = await SquadServer.getServerState(baseCtx)
						const ctx = LayerQueriesServer.resolveLayerQueryCtx(baseCtx)
						const currentMatch = await MatchHistory.getCurrentMatch(ctx)
						const allConstraints = SETTINGS.getSettingsConstraints(serverState.settings, { generatingLayers: false })
						const statusRes = await LayerQueries.getLayerItemStatuses({
							ctx,
							input: { constraints: allConstraints, list: await LayerQueriesServer.resolveLayerItemsState(baseCtx) },
						})

						warnCondition: if (statusRes.code === 'ok') {
							const nextLayer = getSavedQueue(ctx)[0] ?? null
							if (!nextLayer) break warnCondition
							const warns = statusRes.statuses.warns.filter(w => w.itemId === nextLayer.itemId)
							if (warns.length === 0) break warnCondition
							const repeatViolations = warns.filter(w => w.type === 'repeat-rule-violation-warning').flatMap(w => w.descriptors)
							const poolViolations = warns.filter(w => w.type === 'filter-entity-warning').map(w => {
								const constraint = allConstraints.find(c => c.id === w.constraintId)! as Extract<LQY.Constraint, { type: 'filter-entity' }>
								return constraint.warn === 'inverted' ? `!${constraint.filterId}` : constraint.filterId
							})
							await SquadRcon.warnAllAdmins(
								ctx,
								Messages.WARNS.queue.nextLayerWarning(nextLayer.layerId, { repeatViolations, poolViolations }),
							)
							return
						}

						const voteState = ctx.vote.state
						if (ctx.server.serverRolling$.value || currentMatch.status === 'post-game') return
						if (
							LL.isVoteItem(serverState.layerQueue[0])
							&& voteState?.code === 'ready'
							&& !serverState.layerQueue[0].endingVoteState
							&& currentMatch.startTime !== undefined
							&& currentMatch.startTime.getTime() + GS.vote.startVoteReminderThreshold < Date.now()
						) {
							await SquadRcon.warnAllAdmins(
								ctx,
								Messages.WARNS.queue.votePending(
									currentMatch.startTime,
									GS.vote.startVoteReminderThreshold,
									GS.vote.autoStartVoteDelay !== null,
									Settings.GLOBAL_SETTINGS.commands,
									Settings.GLOBAL_SETTINGS.commandPrefix,
								),
							)
						} else if (serverState.layerQueue.length === 0) {
							await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.empty)
						}
					}),
				).subscribe(),
			)
		}

		// -------- when SLM is not able to set a layer on the server, notify admins.
		ctx.layerQueue.unexpectedNextLayerSet$
			.pipe(
				Rx.switchMap((unexpectedNextLayer) => {
					if (unexpectedNextLayer) {
						return Rx.interval(HumanTime.parse('2m')).pipe(
							Rx.startWith(0),
							Rx.map(() => unexpectedNextLayer),
						)
					}
					return Rx.EMPTY
				}),
				C.durableSub('notify-unexpected-next-layer', { module }, async (unexpectedNextlayer) => {
					const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
					const serverState = await SquadServer.getServerState(ctx)
					const expectedNextLayer = LL.getNextLayerId(getSavedQueue(ctx))!
					if (!expectedNextLayer) return
					const expectedLayerName = DH.toFullLayerNameFromId(expectedNextLayer)
					const actualLayerName = DH.toFullLayerNameFromId(unexpectedNextlayer)
					await SquadRcon.warnAllAdmins(
						ctx,
						`Current next layer on the server is out-of-sync with queue. Got ${actualLayerName}, but expected ${expectedLayerName}`,
					)
				}),
			).subscribe()

		// -------- make sure next layer set is synced with queue --------
		{
			ctx.server.event$.pipe(
				Rx.filter(([ctx, event]) => event.type === 'MAP_SET'),
				C.durableSub('sync-server-map-set', { module, mutexes: ([ctx]) => ctx.layerQueue.updateLayerMtx }, async ([ctx, event]) => {
					if (event.type !== 'MAP_SET' || event.source?.type === 'layer-queue') return
					const queue = getSavedQueue(ctx)
					// this case will be dealt with in handleNewGame, so can ignore it here
					if (ctx.server.serverRolling$.value) return
					const savedNextLayerId = LL.getNextLayerId(queue)
					const savedNextItemId = queue[0]?.itemId || null
					if (savedNextLayerId && L.areLayersCompatible(event.layerId, savedNextLayerId)) return
					if (ctx.serverSettings.settings.overrideAdminSetNextLayer) {
						const serverState = await SquadServer.getServerState(ctx)
						if (savedNextLayerId === null) {
							log.warn('no next layer to sync after map set')
							return
						}
						await syncNextLayerToServer(ctx, serverState.settings, savedNextLayerId, savedNextItemId!)
					} else {
						const op: SLL.Operation = {
							opId: SLL.createOpId(),
							op: 'unshift-first-saved-layer',
							itemId: LL.createItemId(),
							itemSource: { type: event.source?.type === 'player' ? 'gameserver' : 'unknown' },
							layerId: event.layerId,
						}
						await dispatchOp(ctx, op)
					}
				}),
			).subscribe()
		}

		// -------- handle AdminChangeLayer --------
		{
			ctx.server.event$.pipe(
				Rx.filter(([ctx, event]) => event.type === 'ROUND_ENDED' && event.action?.type === 'AdminChangeLayer'),
				C.durableSub('syncAdminChangeLayer', { module }, async ([ctx, event]) => {
					if (event.type !== 'ROUND_ENDED' || event.action?.type !== 'AdminChangeLayer') return
					const op: SLL.Operation = {
						opId: SLL.createOpId(),
						op: 'unshift-first-saved-layer',
						itemId: LL.createItemId(),
						itemSource: {
							type: event.action?.type === 'AdminChangeLayer' && event.action.source.type === 'player' ? 'gameserver' : 'unknown',
						},
						layerId: event.action.layerId,
					}

					await dispatchOp(ctx, op)
				}),
			).subscribe()
		}
	},
)

export function schedulePostRollTasks(ctx: C.SquadServer & C.LayerQueue & C.ServerSettings, newLayerId: L.LayerId) {
	const serverId = ctx.serverId

	// -------- schedule post-roll events --------
	ctx.server.postRollEventsSub?.unsubscribe()
	ctx.server.postRollEventsSub = new Rx.Subscription()

	// -------- schedule FRAAS auto fog-off --------
	const currentLayer = L.toLayer(newLayerId)
	if (currentLayer.Gamemode === 'FRAAS') {
		ctx.server.postRollEventsSub.add(
			Rx.timer(Settings.GLOBAL_SETTINGS.fogOffDelay).subscribe(async () => {
				const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
				await SquadRcon.setFogOfWar(ctx, 'off')
				void SquadRcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
			}),
		)
	}

	// -------- schedule post-roll announcements --------
	if (ctx.serverSettings.settings.remindersAndAnnouncementsEnabled) {
		const announcementTasks: (Rx.Observable<void>)[] = []
		announcementTasks.push(toCold(async () => {
			const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
			const historyState = MatchHistory.getPublicMatchHistoryState(ctx)
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			if (!currentMatch) return
			const mostRelevantEvent = BAL.getHighestPriorityTriggerEvent(MH.getActiveTriggerEvents(historyState))
			if (!mostRelevantEvent) return
			await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.balanceTrigger.showEvent(mostRelevantEvent, currentMatch, { isCurrent: true }))
		}))

		announcementTasks.push(toCold(async () => {
			const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
			void warnShowNext(ctx, 'all-admins')
		}))

		announcementTasks.push(toCold(async () => {
			const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
			const queue = getSavedQueue(ctx)
			if (queue && queue.length <= Settings.GLOBAL_SETTINGS.layerQueue.lowQueueWarningThreshold) {
				await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.lowQueueItemCount(queue.length))
			}
		}))

		const withWaits: Rx.Observable<unknown>[] = []
		withWaits.push(Rx.timer(Settings.GLOBAL_SETTINGS.postRollAnnouncementsTimeout))

		for (let i = 0; i < announcementTasks.length; i++) {
			withWaits.push(announcementTasks[i].pipe(Rx.catchError(() => Rx.EMPTY)))
			if (i !== announcementTasks.length - 1) {
				withWaits.push(Rx.timer(2000))
			}
		}

		ctx.server.postRollEventsSub.add(Rx.concat(Rx.from(withWaits)).subscribe())
	}
}

// get the queue which is synced to the squad server
export function getSavedQueue(ctx: C.LayerQueue) {
	return ctx.layerQueue.session.state.savedList
}

async function onSideEffect(
	ctx: C.Db & C.LayerQueue & C.SquadServer & C.Vote & C.MatchHistory & C.Rcon,
	e: SLL.SideEffect,
) {
	// TODO implement
}

export async function saveQueueAndUpdateServer(
	ctx: C.Db & C.LayerQueue & C.SquadServer & C.Vote & C.MatchHistory & C.Rcon & C.AdminList & C.ServerSettings,
	list: LL.List,
) {
	await VoteSys.syncVoteStateWithQueueState(ctx, list)
	return await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
		const serverState = await SquadServer.getServerState(ctx)
		const nextItemId = list[0]?.itemId || null
		const nextLayerId = LL.getNextLayerId(list)
		if (ctx.serverSettings.settings.warnOnChangeLayer && nextLayerId) {
			const statusRes = await ctx.server.layersStatus.get(ctx)
			if (statusRes.code === 'ok' && statusRes.data.nextLayer) {
				if (!L.areLayersCompatible(statusRes.data.nextLayer.id, nextLayerId)) {
					await warnShowNext(ctx, 'all-admins', { updated: true })
				}
			}
		}
		if (nextLayerId && nextItemId) {
			await syncNextLayerToServer(ctx, serverState.settings, nextLayerId, nextItemId)
		} else {
			log.error('No next layer to sync to server')
		}

		await SquadServer.updateServerState(ctx, { layerQueue: list }, {
			type: 'system',
			event: 'admin-change-layer',
		})

		return {
			code: 'ok' as const,
		}
	})
}

export async function warnShowNext(
	ctx: C.Db & C.SquadServer & C.LayerQueue & C.Rcon & C.AdminList,
	playerIds: 'all-admins' | SM.PlayerIds.Type,
	opts?: { repeat?: number; updated?: boolean },
) {
	const layerQueue = getSavedQueue(ctx)
	const parts: USR.UserPart = { users: [] }
	const firstItem = layerQueue[0]
	if (firstItem?.source.type === 'manual') {
		const userId = firstItem.source.userId
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, userId))
		parts.users.push(await Users.buildUser(user))
	}
	if (playerIds === 'all-admins') {
		await SquadRcon.warnAllAdmins(
			ctx,
			Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1, updated: opts?.updated }),
		)
	} else {
		await SquadRcon.warn(
			ctx,
			playerIds,
			Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1, updated: opts?.updated }),
		)
	}
}

/**
 * sets next layer on server according to the current queue, generating a new queue item if needed. modifies serverState in place.
 */
export const syncNextLayerToServer = C.spanOp('syncNextLayerToServer', { module, mutexes: (ctx) => ctx.layerQueue.updateLayerMtx }, async (
	ctx: C.SquadServer & C.Rcon & C.LayerQueue & C.Db,
	settings: SETTINGS.ServerSettings,
	nextQueuedLayerId: L.LayerId,
	itemId: string,
) => {
	if (settings.updatesToSquadServerDisabled) return
	const currentStatusRes = await ctx.server.layersStatus.get(ctx)
	if (currentStatusRes.code !== 'ok') return currentStatusRes
	if (currentStatusRes.data.nextLayer && L.areLayersCompatible(currentStatusRes.data.nextLayer.id, nextQueuedLayerId)) return
	const res = await SquadRcon.setNextLayer(ctx, nextQueuedLayerId)
	// we do this so we can stay in this async context so we hold on to the mutex that we acquired
	switch (res.code) {
		case 'err:unable-to-set-next-layer':
			ctx.layerQueue.unexpectedNextLayerSet$.next(res.unexpectedLayerId)
			break
		case 'err:rcon':
		case 'ok':
			ctx.layerQueue.unexpectedNextLayerSet$.next(null)
			// awaiting this will cause a deadlock on map roll
			void SquadServer.pushAttribution(ctx, { type: 'MAP_SET_ATTRIBUTION', itemId: itemId, layerId: nextQueuedLayerId })
			break
		default:
			assertNever(res)
	}
})

export async function toggleUpdatesToSquadServer(
	{ ctx, input }: {
		ctx: C.Db & C.SquadServer & C.UserOrPlayer & C.LayerQueue & C.AdminList & C.Rcon & C.ServerSettings
		input: { disabled: boolean }
	},
) {
	// if player we assume authorization has already been established
	if (ctx.user) {
		const denyRes = await Rbac.tryDenyPermissionsForUser({ ...ctx, user: ctx.user! }, RBAC.perm('squad-server:disable-slm-updates'))
		if (denyRes) return denyRes
	}

	await DB.runTransaction(ctx, { redactParams: true }, async ctx => {
		const serverState = await SquadServer.getServerState(ctx)
		serverState.settings.updatesToSquadServerDisabled = input.disabled
		await Settings.updateServerSettings(ctx, serverState.settings, {
			type: 'system',
			event: 'updates-to-squad-server-toggled',
		})
	})

	await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.slmUpdatesSet(!input.disabled))
	return { code: 'ok' as const }
}

export async function getSlmUpdatesEnabled(ctx: C.Db & C.UserOrPlayer & C.SquadServer & C.LayerQueue) {
	const serverState = await SquadServer.getServerState(ctx)
	return { code: 'ok' as const, enabled: !serverState.settings.updatesToSquadServerDisabled }
}

export async function requestFeedback(
	ctx: C.Db & C.SquadServer & C.LayerQueue & C.AdminList & C.Rcon,
	playerName: string,
	layerQueueNumber: string | undefined,
) {
	const layerQueue = getSavedQueue(ctx)
	let index: LL.ItemIndex | undefined
	if (layerQueue.length === 0) return { code: 'err:empty' as const }
	if (layerQueueNumber === undefined) index = LL.iterItems(...layerQueue).next().value
	else index = LL.resolveLayerQueueItemIndexForNumber(layerQueueNumber) ?? undefined
	if (!index) return { code: 'err:not-found' as const }
	const item = LL.resolveItemForIndex(layerQueue, index)!
	await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.requestFeedback(index, playerName, item))
	return { code: 'ok' as const }
}

function getBaseCtx() {
	return C.initMutexStore(DB.addPooledDb(CS.init()))
}

// -------- setup router --------
export const router = {
	watchUnexpectedNextLayer: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = SquadServer.sliceCtx$(context.wsClientId, input.serverId).pipe(
			Rx.switchMap(ctx => {
				if (!ctx) return Rx.EMPTY
				return ctx.layerQueue.unexpectedNextLayerSet$
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	toggleUpdatesToSquadServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = SquadServer.resolveSliceCtx(_ctx, input.serverId)
			return await toggleUpdatesToSquadServer({ ctx, input })
		}),

	watchOps: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function*({ context, input, signal }) {
			const updateForServer$ = SquadServer.sliceCtx$(context.wsClientId, input.serverId).pipe(
				Rx.switchMap(ctx => {
					if (!ctx) return Rx.EMPTY
					const initial: SLL.Update = {
						code: 'init',
						state: ctx.layerQueue.session.state,
						ops: ctx.layerQueue.session.ops,
					}
					const updateForClient$: Rx.Observable<SLL.Update> = ctx.layerQueue.op$.pipe(
						Rx.map(op => ({ code: 'op' as const, op })),
						Rx.startWith(initial),
						// if we don't do this then the orpcWs breaks
						Rx.observeOn(Rx.asyncScheduler),
					)
					return updateForClient$
				}),
				withAbortSignal(signal!),
			)

			yield* toAsyncGenerator(updateForServer$)
		}),

	dispatchOp: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), op: SLL.OperationSchema }))
		.handler(async ({ context: _ctx, input: { serverId, op } }) => {
			const ctx = SquadServer.resolveSliceCtx(_ctx, serverId)
			const authRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write'))
			if (authRes) return authRes

			const userId = (op as { userId?: USR.UserId })?.userId
			if (userId && ctx.user.discordId !== userId) {
				return {
					code: 'err:invalid-user' as const,
					msg: `Invalid user ${userId} for operation ${op.op} (${op.opId})`,
				}
			}

			await dispatchOp(ctx, op)

			return { code: 'ok' as const }
		}),
}

export const dispatchOp = C.spanOp(
	'dispatchOp',
	{
		module,
		mutexes: (ctx) => ctx.layerQueue.updateLayerMtx,
		levels: { event: 'info' },
		attrs: (ctx, op) => ({ op: op.op, opId: op.opId }),
	},
	async (
		ctx: C.Db & C.LayerQueue & C.SquadServer & C.Vote & C.MatchHistory & C.Rcon & C.AdminList & C.ServerSettings,
		op: SLL.Operation,
	) => {
		log.info(`Dispatching op ${op.op} (${op.opId}) %o`, op)

		// we're doing this in a slightly weird way so it's clear that all side effect processing happens in an uninterrupted async context
		const sideEffects: SLL.SideEffect[] = []
		function onSideEffect(se: SLL.SideEffect) {
			sideEffects.push(se)
		}

		ctx.layerQueue.session = RbSyncState.Server.applyOps(ctx.layerQueue.session, [op], SLL.reducer, { onSideEffect })
		ctx.layerQueue.op$.next(op)
		for (const se of sideEffects) {
			log.info(`Side effect: ${se.code} %o`, se)
			switch (se.code) {
				case 'complete':
					break
				case 'error':
					log.error(new Error('Error in side effect', { cause: se.error }))
					break
				case 'request-queue-item-generation': {
					const serverState = await SquadServer.getServerState(ctx)
					const allConstraints = SETTINGS.getSettingsConstraints(serverState.settings, { generatingLayers: true })
					const layerCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx)
					const layerItemsState = await LayerQueriesServer.resolveLayerItemsState(ctx)

					const nextQueuedLayerId = await (async function getNextQueuedLayerId(constraints: LQY.Constraint[] = allConstraints) {
						try {
							const gen = LayerQueries.queryLayersStreamed({
								ctx: layerCtx,
								input: {
									constraints,
									list: layerItemsState,
									cursor: { type: 'start' },
									action: 'add',
									pageSize: 1,
									sort: { type: 'random', seed: LQY.getSeed() },
								},
							})
							let ids: string[] = []

							for await (const packet of gen) {
								if (packet.code === 'menu-item-possible-values') continue
								if (packet.code === 'err:invalid-node') {
									log.error(`Invalid node error when generating layer: %o`, { cause: packet.errors })
									return L.DEFAULT_LAYER_ID
								}
								ids = packet.layers.map(l => l.id)
							}

							if (ids.length > 0) return ids[0]
							const noDnrConstraints = constraints.filter(c => c.type !== 'do-not-repeat')
							if (noDnrConstraints.length < constraints.length) {
								log.info('no layers found with do-not-repeat constraints applied, retrying without')
								return await getNextQueuedLayerId(noDnrConstraints)
							}
							log.warn(`No layers found for constraints: %o`, { constraints })
							return L.DEFAULT_LAYER_ID
						} catch (e) {
							log.error(`Error generating layer: %o`, e)
							return L.DEFAULT_LAYER_ID
						}
					})()

					const nextQueueItem = LL.createItem({ type: 'single-list-item', layerId: nextQueuedLayerId }, { type: 'generated' })
					await dispatchOp(ctx, { op: 'queue-item-generated', item: nextQueueItem, opId: SLL.createOpId() })
					break
				}
				case 'request-list-save': {
					await saveQueueAndUpdateServer(ctx, se.list)
					await dispatchOp(ctx, { op: 'save-completed', opId: SLL.createOpId() })
					break
				}
				default:
					assertNever(se)
			}
		}
	},
)
