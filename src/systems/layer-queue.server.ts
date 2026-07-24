import * as Schema from '$root/drizzle/schema.ts'
import { isAbortError, toAsyncGenerator, toCold, withAbortSignal } from '@/lib/async.ts'
import * as ATTRS from '@/models/otel-attrs'
import * as UserPresenceSys from '@/systems/user-presence.server'

import * as DH from '@/lib/display-helpers.ts'
import { IsolatedBehaviorSubject, IsolatedReplaySubject, IsolatedSubject } from '@/lib/isolated-subject'

import * as ODSM from '@/lib/odsm'
import { assertNever } from '@/lib/type-guards.ts'

import { HumanTime } from '@/lib/zod.ts'
import * as Messages from '@/messages.ts'
import * as AppEvents from '@/models/app-events.models'
import * as BB from '@/models/backburner.models'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CS from '@/models/context-shared'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as MH from '@/models/match-history.models'
import * as SE from '@/models/server-events.models'
import type * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models.ts'
import type * as USR from '@/models/users.models'
import * as AppEventsSys from '@/systems/app-events.server'

import * as RBAC from '@/rbac.models.ts'

import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerQueriesServer from '@/systems/layer-queries.server'
import * as LayerQueries from '@/systems/layer-queries.shared.ts'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'
import * as VoteSys from '@/systems/vote.server'
import { Mutex } from 'async-mutex'
import type { MutexInterface } from 'async-mutex'
import * as E from 'drizzle-orm'
import * as Rx from 'rxjs'
import { z } from 'zod'

export type LayerQueueSlice = {
	unexpectedNextLayerSet$: Rx.BehaviorSubject<L.LayerId | null>

	// TODO we should fold this into the server events
	update$: Rx.ReplaySubject<[SS.LQStateUpdate, C.Db & C.ServerId]>

	session: ODSM.Server.Session<SLL.Operation, SLL.State>
	op$: Rx.Subject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>
	updateLayerMtx: MutexInterface
}

const module = initModule('layer-queue')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export function initLayerQueueSlice(ctx: C.ServerSliceCleanup & C.ServerId, serverState: SS.ServerState) {
	const sllState = SLL.createNewState(serverState.layerQueue, serverState.backburner)
	const slice: LayerQueueSlice = {
		unexpectedNextLayerSet$: new IsolatedBehaviorSubject<L.LayerId | null>(null),
		update$: new IsolatedReplaySubject(1),

		session: ODSM.Server.initSession<SLL.Operation, SLL.State>(sllState),
		op$: new IsolatedSubject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>(),
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
					C.durableSub('queue-reminders', { module, levels: { event: 'info' } }, async (_, signal) => {
						const baseCtx = SquadServer.resolveSliceCtx({ ...getBaseCtx(), signal }, serverId)
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
								const entity = ctx.filters.get(constraint.filterId)
								// warn 'inverted' fires when the layer does NOT match, so use the miss indicator's message
								const missed = constraint.warn === 'inverted'
								return (missed ? entity?.invertedAlertMessage : entity?.alertMessage)
									?? `${missed ? '!' : ''}${entity?.name ?? constraint.filterId}`
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
				C.durableSub('notify-unexpected-next-layer', { module }, async (unexpectedNextlayer, signal) => {
					const ctx = SquadServer.resolveSliceCtx({ ...getBaseCtx(), signal }, serverId)
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
				C.durableSub(
					'sync-server-map-set',
					{ module, mutexes: ([ctx]) => ctx.layerQueue.updateLayerMtx },
					async ([_ctx, event], signal) => {
						const ctx = { ..._ctx, signal }
						// skip map sets SLM itself caused (queue save, app-event set-next, or other internal
						// set-next) -- the saved queue is already in sync, so unshifting would duplicate the layer.
						// only organic sets (in-game admin, external RCON tool, unattributed) should unshift.
						if (event.type !== 'MAP_SET' || SE.mapSetIsSlmOriginated(event.source)) return
						const queue = getSavedQueue(ctx)
						// this case will be dealt with in handleNewGame, so can ignore it here
						if (ctx.server.serverRolling$.value) return
						const savedNextLayerId = LL.getNextLayerId(queue)
						const savedNextItemId = queue[0]?.itemId || null
						if (savedNextLayerId && L.areLayersCompatible(event.layerId, savedNextLayerId)) return
						// the external actor whose set we're reacting to (post-guard, source is player / rcon / unattributed)
						const external: { type: 'player'; playerId: string } | { type: 'rcon' } = event.source?.type === 'player'
							? { type: 'player', playerId: SM.PlayerIds.getPlayerId(event.source.playerIds) }
							: { type: 'rcon' }
						if (ctx.serverSettings.settings.overrideAdminSetNextLayer) {
							const serverState = await SquadServer.getServerState(ctx)
							if (savedNextLayerId === null) {
								log.warn('no next layer to sync after map set')
								return
							}
							await syncNextLayerToServer(ctx, serverState.settings, savedNextLayerId, savedNextItemId!, {
								reason: 'override',
								overrode: external,
							})
						} else {
							const op: SLL.Operation = {
								opId: SLL.createOpId(),
								op: 'unshift-first-saved-layer',
								itemId: LL.createItemId(),
								itemSource: { type: external.type === 'player' ? 'gameserver' : 'unknown' },
								layerId: event.layerId,
								externalSource: external,
							}
							await dispatchOp(ctx, op)
						}
					},
				),
			).subscribe()
		}

		// -------- handle AdminChangeLayer --------
		{
			ctx.server.event$.pipe(
				Rx.filter(([ctx, event]) => event.type === 'ROUND_ENDED' && event.action?.type === 'AdminChangeLayer'),
				C.durableSub('syncAdminChangeLayer', { module }, async ([_ctx, event], signal) => {
					const ctx = { ..._ctx, signal }
					if (event.type !== 'ROUND_ENDED' || event.action?.type !== 'AdminChangeLayer') return
					const external: { type: 'player'; playerId: string } | { type: 'rcon' } = event.action.source.type === 'player'
						? { type: 'player', playerId: SM.PlayerIds.getPlayerId(event.action.source.playerIds) }
						: { type: 'rcon' }
					const op: SLL.Operation = {
						opId: SLL.createOpId(),
						op: 'unshift-first-saved-layer',
						itemId: LL.createItemId(),
						itemSource: { type: external.type === 'player' ? 'gameserver' : 'unknown' },
						layerId: event.action.layerId,
						externalSource: external,
					}

					await dispatchOp(ctx, op)
				}),
			).subscribe()
		}

		// -------- discard drafts whose last editor left without saving --------
		ctx.cleanup.push(
			UserPresenceSys.editingAbandoned$(serverId).pipe(
				C.durableSub('discard-abandoned-edits', { module, levels: { event: 'info' } }, async (scope, signal) => {
					const ctx = SquadServer.resolveSliceCtx({ ...getBaseCtx(), signal }, serverId)
					const state = ctx.layerQueue.session.state
					if (scope === 'queue') {
						if (!SLL.hasMutations(state)) return
						await dispatchOp(ctx, { op: 'discard-abandoned-queue-edits', opId: SLL.createOpId() })
					} else {
						if (!SLL.hasBackburnerMutations(state)) return
						await dispatchOp(ctx, { op: 'discard-abandoned-request-edits', opId: SLL.createOpId() })
					}
					log.info('discarded abandoned %s edits', scope)
				}),
			).subscribe(),
		)
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
				await SquadRcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
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
			await warnShowNext(ctx, 'all-admins')
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

		// concat over the observables themselves, not over an observable *of* them: Rx.from(withWaits)
		// emits each task as a value and never subscribes to it, so every post-roll announcement was
		// silently skipped
		ctx.server.postRollEventsSub.add(Rx.concat(...withWaits).subscribe())
	}
}

// get the queue which is synced to the squad server
export function getSavedQueue(ctx: C.LayerQueue) {
	return ctx.layerQueue.session.state.savedList
}

export async function saveQueueAndUpdateServer(
	ctx: C.Db & C.LayerQueue & C.SquadServer & C.Vote & C.MatchHistory & C.Rcon & C.ServerSettings & CS.AbortSignal,
	list: LL.List,
	// the QUEUE_UPDATED for this save; the resulting MAP_SET app event (if the next layer changed) links back to it
	queueUpdatedId?: string,
) {
	await VoteSys.syncVoteStateWithQueueState(ctx, list)
	return await DB.runTransaction(ctx, { redactParams: true }, async (txCtx) => {
		const serverState = await SquadServer.getServerState(txCtx)
		const nextItemId = list[0]?.itemId || null
		const nextLayerId = LL.getNextLayerId(list)

		await SquadServer.updateServerState(txCtx, { layerQueue: list }, {
			type: 'system',
			event: 'admin-change-layer',
		})

		// These reach the game server over rcon, so they're deferred rather than awaited under the (global) tx lock.
		// unlockTasks are the outermost transaction's, so this also keeps them out of the map-roll tx that
		// onNewGameDuringRoll wraps around this. The mutex context is ambient, so it still covers them; `tx` is dropped
		// because it's spent by then, and a nested runTransaction would otherwise join a committed transaction and run
		// in autocommit with a rollback() that does nothing.
		const deferredCtx = { ...ctx, tx: undefined }
		txCtx.tx.unlockTasks.push(async () => {
			if (deferredCtx.serverSettings.settings.warnOnChangeLayer && nextLayerId) {
				const statusRes = await deferredCtx.server.layersStatus.get(deferredCtx)
				if (statusRes.code === 'ok' && statusRes.data.nextLayer) {
					if (!L.areLayersCompatible(statusRes.data.nextLayer.id, nextLayerId)) {
						await warnShowNext(deferredCtx, 'all-admins', { updated: true })
					}
				}
			}
			if (nextLayerId && nextItemId) {
				await syncNextLayerToServer(
					deferredCtx,
					serverState.settings,
					nextLayerId,
					nextItemId,
					queueUpdatedId ? { reason: 'queue-updated', causeId: queueUpdatedId } : undefined,
				)
			} else {
				log.error('No next layer to sync to server')
			}
		})

		return {
			code: 'ok' as const,
		}
	})
}

export async function warnShowNext(
	ctx: C.Db & C.SquadServer & C.LayerQueue & C.Rcon & CS.AbortSignal,
	playerIds: 'all-admins' | SM.PlayerIds.Type,
	opts?: { updated?: boolean },
) {
	const layerQueue = getSavedQueue(ctx)
	const firstItem = layerQueue[0]
	let setByUser: USR.User | undefined
	if (firstItem?.source.type === 'manual') {
		const userId = firstItem.source.userId
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, userId))
		setByUser = await Users.buildUser(user)
	}
	let isAdmin: boolean = false
	if (playerIds === 'all-admins') {
		isAdmin = true
	} else if (playerIds.steam !== undefined) {
		// isAdmin = (await ctx.adminList.get(ctx)).admins.has(playerIds.steam)
	}

	const nextLayerRes = await ctx.server.layersStatus.get(ctx)
	const nextLayer = nextLayerRes.code === 'ok' ? nextLayerRes.data.nextLayer : null
	const commands = Settings.GLOBAL_SETTINGS.commands
	const showNextMsg = Messages.WARNS.queue.showNext(layerQueue, nextLayer, setByUser, commands, { updated: opts?.updated, isAdmin })
	if (playerIds === 'all-admins') {
		await SquadRcon.warnAllAdmins(
			ctx,
			showNextMsg,
		)
	} else {
		await SquadRcon.warn(
			ctx,
			playerIds,
			showNextMsg,
		)
	}
}

/**
 * sets next layer on server according to the current queue, generating a new queue item if needed. modifies serverState in place.
 */
// matchHistory.mtx is declared here (rather than acquired lazily by the nested getCurrentMatch call
// below) so that every op taking both locks takes them as one ordered set. Acquiring updateLayerMtx
// first and matchHistory.mtx later deadlocks against onNewGameDuringRoll, which takes them together.
export const syncNextLayerToServer = C.spanOp(
	'syncNextLayerToServer',
	{ module, mutexes: (ctx) => [ctx.layerQueue.updateLayerMtx, ctx.matchHistory.mtx] },
	async (
		ctx: C.SquadServer & C.Rcon & C.LayerQueue & C.Db & C.MatchHistory & CS.AbortSignal,
		settings: SETTINGS.ServerSettings,
		nextQueuedLayerId: L.LayerId,
		itemId: string,
		// why SLM is setting the layer. queue-driven sets fold into their QUEUE_UPDATED (audit-only MAP_SET); override sets
		// react to a non-SLM set and get a feed entry. absent -> no MAP_SET app event (still attributes the server event).
		mapSetCause?:
			| { reason: 'queue-updated'; causeId: string }
			| { reason: 'override'; overrode?: { type: 'player'; playerId: string } | { type: 'rcon' } },
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
				ctx.layerQueue.unexpectedNextLayerSet$.next(null)
				// deliberately detached (see below): observe the rejection instead of awaiting
				SquadServer.pushAttribution(ctx, { type: 'MAP_SET_ATTRIBUTION', itemId, layerId: nextQueuedLayerId }).catch((err) => {
					if (!isAbortError(err)) log.error(err)
				})
				break
			case 'ok': {
				ctx.layerQueue.unexpectedNextLayerSet$.next(null)
				// SLM actually set the layer -> record a MAP_SET app event (SLM-originated only), and link the resulting
				// MAP_SET server event to it via the attribution
				let mapSetAppEventId: string | undefined
				if (mapSetCause) {
					const mapSet = AppEvents.create<AppEvents.MapSet>({
						type: 'MAP_SET',
						layerId: nextQueuedLayerId,
						reason: mapSetCause.reason,
						overrode: mapSetCause.reason === 'override' ? mapSetCause.overrode : undefined,
						actor: { type: 'system' },
						serverId: ctx.serverId,
						// no current match yet on a freshly-registered server (first sync hasn't run)
						matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
						causeId: mapSetCause.reason === 'queue-updated' ? mapSetCause.causeId : null,
					})
					if (AppEvents.isFeedVisible(mapSet)) await SquadServer.emitAppEvent(ctx, mapSet)
					else await AppEventsSys.persistAppEvent(ctx, mapSet)
					// attribute to whichever app event reaches the feed, since that's what the server event collapses into:
					// the QUEUE_UPDATED for a queue-driven set (its MAP_SET is audit-only), the MAP_SET itself for an override.
					// the audit-only MAP_SET stays reachable from the QUEUE_UPDATED via its causeId.
					mapSetAppEventId = mapSetCause.reason === 'queue-updated' ? mapSetCause.causeId : mapSet.id
				}
				// awaiting this will cause a deadlock on map roll, so it stays detached; observe its rejection
				SquadServer.pushAttribution(ctx, {
					type: 'MAP_SET_ATTRIBUTION',
					itemId,
					layerId: nextQueuedLayerId,
					appEventId: mapSetAppEventId,
				}).catch((err) => {
					if (!isAbortError(err)) log.error(err)
				})
				break
			}
			default:
				assertNever(res)
		}
	},
)

export async function toggleUpdatesToSquadServer(
	{ ctx, input }: {
		ctx: C.Db & C.SquadServer & C.UserOrPlayer & C.LayerQueue & C.Rcon & C.ServerSettings & CS.AbortSignal
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
	ctx: C.Db & C.SquadServer & C.LayerQueue & C.Rcon & CS.AbortSignal,
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
	return C.initMutexStore(DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }))
}

// -------- setup router --------
export const router = {
	watchUnexpectedNextLayer: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = SquadServer.sliceStream$(context.wsClientId, input.serverId, (ctx) => ctx.layerQueue.unexpectedNextLayerSet$).pipe(
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	toggleUpdatesToSquadServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = SquadServer.trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			return await toggleUpdatesToSquadServer({ ctx, input })
		}),

	watchOps: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function*({ context, input, signal }) {
			const updateForServer$ = SquadServer.sliceStream$(context.wsClientId, input.serverId, (ctx) => {
				const initial: SLL.Update = {
					code: 'init',
					state: ctx.layerQueue.session.state,
					ops: ctx.layerQueue.session.ops,
				}
				const updateForClient$: Rx.Observable<SLL.Update> = ctx.layerQueue.op$.pipe(
					Rx.map(dispatched => ODSM.Server.toClientUpdate(dispatched, context.wsClientId)),
					Rx.filter((update): update is NonNullable<typeof update> => update !== null),
					Rx.startWith(initial),
					// if we don't do this then the orpcWs breaks
					Rx.observeOn(Rx.asyncScheduler),
				)
				return updateForClient$
			}).pipe(withAbortSignal(signal!))

			yield* toAsyncGenerator(updateForServer$)
		}),

	dispatchOp: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), op: SLL.OperationSchema }))
		.handler(async ({ context: _ctx, input: { serverId, op } }) => {
			const ctxRes = SquadServer.trySliceCtx(_ctx, serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx

			const userId = (op as { userId?: USR.UserId })?.userId
			if (userId && ctx.user.discordId !== userId) {
				return {
					code: 'err:invalid-user' as const,
					msg: `Invalid user ${userId} for operation ${op.op} (${op.opId})`,
				}
			}

			if (
				op.op === 'backburner-write-saved' || op.op === 'discard-abandoned-request-edits'
				|| op.op === 'discard-abandoned-queue-edits'
			) {
				return { code: 'err:invalid-op' as const, msg: `${op.op} is server-only` }
			}

			if (SLL.isBackburnerOp(op)) {
				const backburnerRes = await tryDenyBackburnerDraftOp(ctx, op)
				if (backburnerRes) return backburnerRes
			} else {
				const authRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write'))
				if (authRes) return authRes
			}

			// adding or setting a layer that isn't in the configured pool additionally requires queue:force-write.
			// only checked when the op introduces layers and the user lacks force-write, to keep the common path cheap.
			const forceWriteCandidates = getForceWriteCandidateLayerIds(ctx.layerQueue.session.state, op)
			if (forceWriteCandidates.length > 0) {
				const forceWriteDenied = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:force-write'))
				if (forceWriteDenied) {
					const serverState = await SquadServer.getServerState(ctx)
					const poolConstraints = SETTINGS.getPoolMembershipConstraints(serverState.settings)
					const layerCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx)
					const poolRes = await LayerQueries.getLayersOutOfPool({
						ctx: layerCtx,
						input: { layerIds: forceWriteCandidates, constraints: poolConstraints },
					})
					if (poolRes.code !== 'ok') {
						// a broken pool filter shouldn't block all queue edits, so fail open and surface the misconfiguration
						log.error('force-write pool check failed to build pool constraints: %o', poolRes)
					} else if (poolRes.outOfPool.length > 0) {
						return forceWriteDenied
					}
				}
			}

			await dispatchOp(ctx, op, { sourceWsClientId: _ctx.wsClientId })

			return { code: 'ok' as const }
		}),
}

// whether a template has any solutions. Pool membership rides in the template itself (see BB.withPoolFilter),
// and do-not-repeat constraints are deliberately excluded: they are transient, and a request that is only
// blocked until the next match shouldn't be rejected outright.
export async function isTemplateSatisfiable(
	ctx: C.Db & C.MatchHistory & C.LayerQueue & CS.AbortSignal,
	filter: F.FilterNode,
): Promise<boolean> {
	const layerCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx)
	const res = await LayerQueries.checkBackburnerTemplates({
		ctx: layerCtx,
		input: { constraints: [], templates: [{ itemId: 'probe', filter }] },
	})
	if (res.code !== 'ok') {
		log.error('backburner satisfiability probe failed to build constraints, failing open: %o', res)
		return true
	}
	return res.satisfiable['probe']
}

type BackburnerDraftOp = Exclude<Extract<SLL.Operation, { op: `backburner-${string}` }>, { op: 'backburner-write-saved' }>

// per-op authorization + validation for backburner draft ops arriving over the RPC. Own items need any
// queue:request-layers grant; touching someone else's item needs queue:write. Adds/updates/combines are
// probed for satisfiability so an impossible template can't enter the backburner.
async function tryDenyBackburnerDraftOp(
	ctx: C.Db & C.ServerSlice & C.UserId & CS.AbortSignal,
	op: BackburnerDraftOp,
) {
	const state = ctx.layerQueue.session.state
	const owner: USR.GuiOrChatUserId = { discordId: ctx.user.discordId }
	const targets: BB.BackburnerItem[] = []
	switch (op.op) {
		case 'backburner-add':
			break
		case 'backburner-update':
		case 'backburner-reorder': {
			const item = state.backburner.find(item => item.itemId === op.itemId)
			if (item) targets.push(item)
			break
		}
		case 'backburner-remove':
			targets.push(...state.backburner.filter(item => op.itemIds.includes(item.itemId)))
			break
		case 'backburner-combine':
			targets.push(...state.backburner.filter(item => item.itemId === op.targetItemId || item.itemId === op.sourceItemId))
			break
		// save/reset commit or discard the shared draft as a whole; any requester may do so
		case 'backburner-save':
		case 'backburner-reset':
			break
		default:
			assertNever(op)
	}

	// own items qualify with any queue:request-layers grant; touching someone else's item needs queue:write
	const touchesOthers = targets.some(item => !BB.sameOwner(item.source, owner))
	const authReq = touchesOthers
		? RBAC.perm('queue:write')
		: RBAC.permReq('any', [RBAC.perm('queue:write'), 'queue:request-layers'])
	const authRes = await Rbac.tryDenyPermissionsForUser(ctx, authReq)
	if (authRes) return authRes

	switch (op.op) {
		case 'backburner-add': {
			if (!BB.sameOwner(op.item.source, owner)) {
				return { code: 'err:invalid-source' as const, msg: 'Layer requests must be added under your own account' }
			}
			const capRes = await checkBackburnerCaps(ctx, owner)
			if (capRes) return capRes
			if (!(await isTemplateSatisfiable(ctx, op.item.filter))) {
				return { code: 'err:no-solutions' as const, msg: 'No layers in the current pool match this request' }
			}
			break
		}
		case 'backburner-update': {
			if (!(await isTemplateSatisfiable(ctx, op.filter))) {
				return { code: 'err:no-solutions' as const, msg: 'No layers in the current pool match this request' }
			}
			break
		}
		case 'backburner-combine': {
			const target = state.backburner.find(item => item.itemId === op.targetItemId)
			const source = state.backburner.find(item => item.itemId === op.sourceItemId)
			if (!target || !source) break
			const merged = BB.mergeTemplateFilters(target.filter, source.filter)
			if (merged.code !== 'ok') {
				const names = merged.filterIds.map(id => backburnerFilterName(id) ?? id)
				return {
					code: 'err:not-combinable' as const,
					msg: `Cannot combine: ${names.join(', ')} is applied normally on one request and inverted on the other`,
				}
			}
			if (!(await isTemplateSatisfiable(ctx, merged.filter))) {
				return { code: 'err:not-combinable' as const, msg: 'No layers match the combined request' }
			}
			break
		}
		case 'backburner-remove':
		case 'backburner-reorder':
		case 'backburner-save':
		case 'backburner-reset':
			break
		default:
			assertNever(op)
	}
	return null
}

// the GUI add path rejects at the caps rather than evicting (the panel offers an explicit "evict my oldest"
// confirm); the per-user cap doesn't apply to queue:write holders, who curate the whole backburner anyway
export async function checkBackburnerCaps(
	ctx: C.Db & C.ServerSlice & C.UserId & CS.AbortSignal,
	owner: USR.GuiOrChatUserId,
	opts?: { list?: BB.BackburnerItem[] },
) {
	const state = ctx.layerQueue.session.state
	const list = opts?.list ?? state.backburner
	const serverState = await SquadServer.getServerState(ctx)
	const maxTotal = serverState.settings.queue.layerRequests.maxTotal
	if (list.length >= maxTotal) return { code: 'err:backburner-full' as const, max: maxTotal }
	const hasQueueWrite = !(await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write')))
	if (hasQueueWrite) return null
	const max = await Rbac.getMaxLayerRequestsForUser(ctx)
	if (max === null || max === undefined) return null
	const own = BB.ownedItems(list, owner).length
	if (own >= max) return { code: 'err:limit-reached' as const, max }
	return null
}

export type AddRequestResult =
	| { code: 'ok'; item: BB.BackburnerItem; evicted: BB.BackburnerItem[] }
	| { code: 'err:no-solutions'; msg: string }
	| { code: 'err:backburner-full'; max: number }
	| RBAC.PermissionDeniedResponse

// the chat path (/reqlayer): commits straight to the saved backburner, evicting the owner's oldest request(s)
// when they are at their cap. `user` is the sender's linked SLM account (RBAC identity); `source` carries both
// ids so ownership checks work from either surface.
export async function addBackburnerRequestFromChat(
	ctx: C.Db & C.ServerSlice & CS.AbortSignal & C.PlayerIds,
	args: { user: { discordId: bigint }; source: USR.GuiOrChatUserId; filter: F.FilterNode },
): Promise<AddRequestResult> {
	const denied = await Rbac.tryDenyPermissionsForPlayer(ctx, 'queue:request-layers')
	if (denied) return denied
	const serverState = await SquadServer.getServerState(ctx)
	// in-game requests always carry the main pool filter; only the GUI can deliberately drop it
	const filter = BB.withPoolFilter(args.filter, serverState.settings.queue.mainPool.poolFilter)
	if (!(await isTemplateSatisfiable(ctx, filter))) {
		return { code: 'err:no-solutions', msg: 'No layers in the current pool match this request' }
	}
	const saved = ctx.layerQueue.session.state.savedBackburner
	const maxTotal = serverState.settings.queue.layerRequests.maxTotal
	const max = await Rbac.getMaxLayerRequestsForPlayer(ctx)
	const own = BB.ownedItems(saved, args.source)
	const evicted: BB.BackburnerItem[] = []
	if (max !== null && max !== undefined && own.length >= max) {
		evicted.push(...own.slice(0, own.length - max + 1))
	}
	if (saved.length - evicted.length >= maxTotal) return { code: 'err:backburner-full', max: maxTotal }
	const item: BB.BackburnerItem = {
		itemId: BB.createItemId(),
		filter,
		source: args.source,
		createdAt: Date.now(),
	}
	await dispatchOp(ctx, {
		op: 'backburner-write-saved',
		opId: SLL.createOpId(),
		write: { kind: 'add', item, evictItemIds: evicted.map(i => i.itemId) },
		source: args.source,
	})
	return { code: 'ok', item, evicted }
}

export async function removeBackburnerRequestsFromChat(
	ctx: C.Db & C.ServerSlice & CS.AbortSignal,
	args: { itemIds: string[]; source: USR.GuiOrChatUserId },
) {
	await dispatchOp(ctx, {
		op: 'backburner-write-saved',
		opId: SLL.createOpId(),
		write: { kind: 'remove', itemIds: args.itemIds },
		source: args.source,
	})
}

export function getSavedBackburner(ctx: C.LayerQueue): BB.BackburnerItem[] {
	return ctx.layerQueue.session.state.savedBackburner
}

// resolves filter-entity names for template descriptions (chat listings, app events)
export function backburnerFilterName(id: string): string | undefined {
	return FilterEntity.state.filters.get(id)?.name
}

// layer ids an op would introduce into the queue that are subject to the pool/force-write gate. move, delete, clone
// and server-sourced ops (generation, vote results) preserve or source-validate their layers, so they aren't checked.
function getForceWriteCandidateLayerIds(state: SLL.State, op: SLL.Operation): L.LayerId[] {
	switch (op.op) {
		case 'add':
			return op.items.flatMap((item) => Array.from(LL.getAllItemLayerIds(item)))
		case 'edit-layer':
			return [op.newLayerId]
		case 'swap-factions': {
			const found = LL.findItemById(state.list, op.itemId)
			if (!found) return []
			return Array.from(LL.getAllItemLayerIds(found.item)).map((id) => L.swapFactionsInId(id))
		}
		default:
			return []
	}
}

export const dispatchOp = C.spanOp(
	'dispatchOp',
	{
		module,
		// see syncNextLayerToServer: side effects reach getCurrentMatch, so matchHistory.mtx is taken
		// as part of this op's ordered lock set rather than nested underneath updateLayerMtx
		mutexes: (ctx) => [ctx.layerQueue.updateLayerMtx, ctx.matchHistory.mtx],
		levels: { event: 'info' },
		attrs: (ctx, op) => ({ [ATTRS.LayerQueue.OP]: op.op, [ATTRS.LayerQueue.OP_ID]: op.opId }),
		extraText: (ctx, op) => `Dispatch op ${op.op} (${op.opId})`,
	},
	async (
		ctx: C.Db & C.LayerQueue & C.SquadServer & C.Vote & C.MatchHistory & C.Rcon & C.ServerSettings & CS.AbortSignal,
		op: SLL.Operation,
		// set for ops arriving via the dispatchOp rpc; the originating client gets an ack instead of the full op
		opts?: { sourceWsClientId?: string },
	) => {
		const applied = ODSM.Server.applyOps(ctx.layerQueue.session, [op], SLL.reducer)
		ctx.layerQueue.session = applied.session
		if (applied.rejected) {
			const rejection = applied.error.data as SLL.Rejection
			ctx.layerQueue.op$.next({ ops: [op], sourceWsClientId: opts?.sourceWsClientId, rejection })
			if (rejection.code === 'op-skipped') log.debug('layer queue op skipped: %s', op.op)
			else log.error(new Error('layer queue op produced invalid state', { cause: applied.error }))
			return
		}
		ctx.layerQueue.op$.next({ ops: [op], sourceWsClientId: opts?.sourceWsClientId })
		// all side effect processing happens here in an uninterrupted async context
		for (const se of applied.sideEffects) {
			await handleSideEffect(ctx, op, se)
		}
	},
)

const handleSideEffect = C.spanOp(
	'handleSideEffect',
	{
		module,
		extraText: (ctx, op, se) => `${op.op} -> Side Effect ${se.code}`,
		attrs: (ctx, op, se) => ({ [ATTRS.LayerQueue.OP]: op.op, [ATTRS.LayerQueue.SIDE_EFFECT]: se.code }),
	},
	async (
		ctx: C.Db & C.LayerQueue & C.SquadServer & C.Vote & C.MatchHistory & C.Rcon & C.ServerSettings & CS.AbortSignal,
		op: SLL.Operation,
		se: SLL.SideEffect,
	) => {
		switch (se.code) {
			case 'complete':
			case 'op-outcome':
				break
			case 'edit-window-closed': {
				UserPresenceSys.dispatchEndAllLayerQueueEditing(ctx.serverId)
				break
			}
			case 'request-queue-item-generation': {
				const serverState = await SquadServer.getServerState(ctx)
				const allConstraints = SETTINGS.getSettingsConstraints(serverState.settings, { generatingLayers: true })
				const layerCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx)
				const layerItemsState = await LayerQueriesServer.resolveLayerItemsState(ctx)
				const templates = ctx.layerQueue.session.state.savedBackburner.map(item => ({ itemId: item.itemId, filter: item.filter }))

				const fallback = { layerId: L.DEFAULT_LAYER_ID, consumedItemIds: [] as string[] }
				const generated = await (async function generate(
					constraints: LQY.Constraint[] = allConstraints,
				): Promise<{ layerId: L.LayerId; consumedItemIds: string[] }> {
					try {
						const res = await LayerQueries.generateWithBackburner({
							ctx: layerCtx,
							input: {
								constraints,
								templates,
								list: layerItemsState,
								cursor: { type: 'start' },
								action: 'add',
								seed: LQY.getSeed(),
							},
						})
						if (res.code !== 'ok') {
							log.error(`Invalid node error when generating layer: %o`, { cause: res.errors })
							return fallback
						}
						if (res.invalidItemIds.length > 0) {
							log.warn('backburner templates failed to lower and were skipped: %o', res.invalidItemIds)
						}
						if (res.layer) return { layerId: res.layer.id, consumedItemIds: res.consumedItemIds }
						const noDnrConstraints = constraints.filter(c => c.type !== 'do-not-repeat')
						if (noDnrConstraints.length < constraints.length) {
							log.info('no layers found with do-not-repeat constraints applied, retrying without')
							return await generate(noDnrConstraints)
						}
						log.warn(`No layers found for constraints: %o`, { constraints })
						return fallback
					} catch (e) {
						log.error(e, 'Error generating layer')
						return fallback
					}
				})()

				const nextQueueItem = LL.createItem({ type: 'single-list-item', layerId: generated.layerId }, { type: 'generated' })
				await dispatchOp(ctx, {
					op: 'queue-item-generated',
					item: nextQueueItem,
					consumedBackburnerItemIds: generated.consumedItemIds.length > 0 ? generated.consumedItemIds : undefined,
					opId: SLL.createOpId(),
				})
				break
			}
			case 'request-backburner-save': {
				await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
					await SquadServer.updateServerState(ctx, { backburner: se.items }, { type: 'system', event: 'backburner-updated' })
				})
				if (se.trigger === 'user-save') {
					UserPresenceSys.dispatchEndAllLayerRequestEditing(ctx.serverId)
				}
				const matchId = (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null
				const describe = (item: BB.BackburnerItem) => BB.describeTemplate(item.filter, backburnerFilterName)
				const prevIds = new Set(se.prevItems.map(item => item.itemId))
				const nextIds = new Set(se.items.map(item => item.itemId))
				const added = se.items.filter(item => !prevIds.has(item.itemId))
				const removed = se.prevItems.filter(item => !nextIds.has(item.itemId))
				if (se.trigger === 'consumed') {
					if (removed.length > 0) {
						await SquadServer.emitAppEvent(
							ctx,
							AppEvents.create<AppEvents.LayerRequestConsumed>({
								type: 'LAYER_REQUEST_CONSUMED',
								actor: { type: 'system' },
								serverId: ctx.serverId,
								matchId,
								causeId: null,
								itemIds: removed.map(item => item.itemId),
								descriptions: removed.map(describe),
								layerId: se.layerId ?? L.DEFAULT_LAYER_ID,
							}),
						)
					}
					break
				}
				// each added item is attributed to whoever created it; the removal batch to whoever performed the write
				for (const item of added) {
					await SquadServer.emitAppEvent(
						ctx,
						AppEvents.create<AppEvents.LayerRequestAdded>({
							type: 'LAYER_REQUEST_ADDED',
							actor: SquadServer.actorFromUser(ctx, item.source),
							serverId: ctx.serverId,
							matchId,
							causeId: null,
							itemId: item.itemId,
							description: describe(item),
						}),
					)
				}
				if (removed.length > 0) {
					await SquadServer.emitAppEvent(
						ctx,
						AppEvents.create<AppEvents.LayerRequestRemoved>({
							type: 'LAYER_REQUEST_REMOVED',
							actor: SquadServer.actorFromUser(ctx, se.source),
							serverId: ctx.serverId,
							matchId,
							causeId: null,
							itemIds: removed.map(item => item.itemId),
							descriptions: removed.map(describe),
						}),
					)
				}
				break
			}
			case 'request-list-save': {
				// the ops that make up this save: the span (lastSaveOpId, opId] from the session's op log
				const allOps = ctx.layerQueue.session.ops
				const startIdx = se.lastSaveOpId == null ? 0 : allOps.findIndex(o => o.opId === se.lastSaveOpId) + 1
				const endIdx = allOps.findIndex(o => o.opId === se.opId)
				const ops = endIdx === -1 ? [] : allOps.slice(startIdx, endIdx + 1)
				// classify the save by the op that triggered it, so we don't credit SLM for reacting to outside changes:
				//  - shift-first-saved-layer  -> the map rolled
				//  - unshift-first-saved-layer -> reconciling to a layer set outside SLM (attribute to that actor)
				//  - otherwise                 -> an SLM user edit (or an internal op like a vote result)
				const triggerOp = allOps[endIdx] as (SLL.Operation & { userId?: USR.UserId }) | undefined
				const { trigger, actor } = ((): { trigger: AppEvents.QueueUpdated['trigger']; actor: AppEvents.Actor } => {
					if (triggerOp?.op === 'shift-first-saved-layer') return { trigger: 'roll', actor: { type: 'system' } }
					if (triggerOp?.op === 'unshift-first-saved-layer') {
						const ext = triggerOp.externalSource
						return {
							trigger: 'external-layer-change',
							actor: ext?.type === 'player' ? { type: 'ingame-user', playerId: ext.playerId } : { type: 'system' },
						}
					}
					return { trigger: 'user-edit', actor: triggerOp?.userId ? { type: 'slm-user', userId: triggerOp.userId } : { type: 'system' } }
				})()
				// who the saver overrode: the users still mid-edit when the save landed. the saver's own editing presence is
				// cleared alongside the save, so exclude them rather than race the two ops.
				const save = triggerOp?.op === 'save'
					? { force: triggerOp.force ?? false, overrodeEditors: UserPresenceSys.getQueueEditors(ctx.serverId, triggerOp.userId) }
					: undefined
				const queueUpdated = AppEvents.create<AppEvents.QueueUpdated>({
					type: 'QUEUE_UPDATED',
					actor,
					serverId: ctx.serverId,
					// no current match yet on a freshly-registered server (first sync hasn't run)
					matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
					causeId: null,
					trigger,
					ops,
					prevList: se.prevList,
					list: se.list,
					save,
				})
				await SquadServer.emitAppEvent(ctx, queueUpdated)
				await saveQueueAndUpdateServer(ctx, se.list, queueUpdated.id)
				await dispatchOp(ctx, { op: 'save-completed', opId: SLL.createOpId() })
				UserPresenceSys.dispatchEndAllLayerQueueEditing(ctx.serverId)
				break
			}
			default:
				assertNever(se)
		}
	},
)
