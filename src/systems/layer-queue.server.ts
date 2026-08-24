import { Mutex } from 'async-mutex'
import * as E from 'drizzle-orm'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema.ts'
import * as DH from '@/lib/display-helpers.ts'
import { IsolatedBehaviorSubject, IsolatedReplaySubject, IsolatedSubject } from '@/lib/isolated-subject'
import * as ODSM from '@/lib/odsm'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards.ts'
import * as ZodUtils from '@/lib/zod-utils'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as AppEvents from '@/models/app-events.models'
import * as BB from '@/models/backburner.models'
import * as CS from '@/models/context-shared'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import * as LQY from '@/models/layer-queries.models.ts'
import type * as LQ from '@/models/layer-queue.models'
import type * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as ATTRS from '@/models/otel-attrs'
import * as SE from '@/models/server-events.models'
import type * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list'
import type * as SR from '@/models/squad-rcon.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models.ts'
import type * as USR from '@/models/users.models'
import type * as V from '@/models/vote.models'
import * as RBAC from '@/rbac.models.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerQueriesServer from '@/systems/layer-queries.server'
import * as LayerQueries from '@/systems/layer-queries.shared.ts'
import * as MatchHistory from '@/systems/match-history.server'
import * as Reminders from '@/systems/post-roll-reminders.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UserPresenceSys from '@/systems/user-presence.server'
import * as Users from '@/systems/users.server'
import * as VoteSys from '@/systems/vote.server'

// ctx for op dispatch and its side effects. `tx` is present when an op is dispatched inside a transaction (the map
// roll does this), which side effects use to defer work that must not run under the process-wide tx lock.
type SideEffectCtx = C.Db &
	LQ.Ctx &
	SQS.Ctx &
	V.Ctx &
	MH.Ctx &
	SR.Ctx.Rcon &
	SETTINGS.Ctx &
	CS.AbortSignal &
	Msgs.Ctx &
	Partial<Pick<C.Tx, 'tx'>>

const module = initModule('layer-queue')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export function initPayload(ctx: C.ManagedServerCleanup & CS.ServerId, serverState: SS.ServerState) {
	const sllState = SLL.createNewState(serverState.layerQueue, serverState.backburner)
	const payload: LQ.Ctx.Payload = {
		nextLayerSyncState$: new IsolatedBehaviorSubject<LQ.NextLayerSyncState>({ code: 'synced' }),
		ingameVote$: new IsolatedBehaviorSubject<LQ.IngameVote | null>(null),
		update$: new IsolatedReplaySubject(1),

		session: ODSM.Server.initSession<SLL.Operation, SLL.State>(sllState),
		op$: new IsolatedSubject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>(),
		updateLayerMtx: new Mutex(),
	}

	ctx.cleanup.push(payload.update$, payload.nextLayerSyncState$, payload.ingameVote$, payload.op$, payload.updateLayerMtx)

	return payload
}

export const setupInstance = Instr.spanOp(
	'setupInstance',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.vote.mtx },
	async (ctx: C.Db & C.ManagedServer) => {
		const serverId = ctx.serverId

		// populates list with generated queue item if the list is empty
		await dispatchOp(ctx, { op: 'init', opId: SLL.createOpId() })

		ctx.layerQueue.update$.subscribe(() => {
			log.debug('pushing server state update')
		})

		// -------- schedule generic admin reminders --------
		{
			ctx.cleanup.push(
				Rx.interval(ctx.serverSettings.settings.queue.adminQueueReminderInterval)
					.pipe(
						Instr.durableSub('queue-reminders', { module, levels: { event: 'info' } }, async (_, signal) => {
							const baseCtx = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
							const serverState = await SquadServer.getServerState(baseCtx)
							if (!SETTINGS.remindersEnabled(serverState.settings)) return
							const currentMatch = await MatchHistory.getCurrentMatch(baseCtx)

							const voteState = baseCtx.vote.state
							if (baseCtx.server.serverRolling$.value || currentMatch.status === 'post-game') return
							if (
								LL.isVoteItem(serverState.layerQueue[0]) &&
								voteState?.code === 'ready' &&
								!serverState.layerQueue[0].endingVoteState &&
								currentMatch.startTime !== undefined &&
								currentMatch.startTime.getTime() + serverState.settings.vote.startVoteReminderThreshold < Date.now()
							) {
								await SquadRcon.warnAllAdmins(
									baseCtx,
									LL_Msgs.votePending(
										currentMatch.startTime,
										serverState.settings.vote.startVoteReminderThreshold,
										serverState.settings.vote.autoStartVoteDelay !== null,
										Settings.GLOBAL_SETTINGS.commands,
									),
								)
							} else if (serverState.layerQueue.length === 0) {
								await SquadRcon.warnAllAdmins(baseCtx, LL_Msgs.empty())
							}
						}),
					)
					.subscribe(),
			)
		}

		// -------- when SLM is not able to set a layer on the server, notify admins.
		ctx.layerQueue.nextLayerSyncState$
			.pipe(
				Rx.switchMap((syncState) => {
					if (syncState.code === 'err:refused') {
						return Rx.interval(ZodUtils.HumanTime.parse('2m')).pipe(
							Rx.startWith(0),
							Rx.map(() => syncState.actualLayerId),
						)
					}
					return Rx.EMPTY
				}),
				Instr.durableSub('notify-unexpected-next-layer', { module }, async (unexpectedNextlayer, signal) => {
					const ctx = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
					const expectedNextLayer = LL.getNextLayerId(getSavedQueue(ctx))!
					if (!expectedNextLayer) return
					const expectedLayerName = DH.toFullLayerNameFromId(expectedNextLayer)
					const actualLayerName = DH.toFullLayerNameFromId(unexpectedNextlayer)
					await SquadRcon.warnAllAdmins(
						ctx,
						`Current next layer on the server is out-of-sync with queue. Got ${actualLayerName}, but expected ${expectedLayerName}`,
					)
				}),
			)
			.subscribe()

		// -------- make sure next layer set is synced with queue --------
		{
			ctx.server.event$
				.pipe(
					Rx.filter(([ctx, event]) => event.type === 'MAP_SET'),
					Instr.durableSub(
						'sync-server-map-set',
						{ module, mutexes: ([evt]) => SquadServer.require(evt.serverId).layerQueue.updateLayerMtx },
						async ([evtCtx, event], signal) => {
							const ctx = SquadServer.eventCtx(evtCtx, signal)
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
							const external = externalActor(event.source)
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
				)
				.subscribe()
		}

		// -------- stand down while the Squad server runs its own vote --------
		// A next-layer vote resolves after SLM has already set the next layer and overwrites it, so anything SLM
		// writes from here until the roll is discarded. Rather than fight it, stop writing and say so. The flag is
		// left on across the roll deliberately: whoever turned voting on owns the rotation until an admin says
		// otherwise. Faction votes don't touch the layer, so they only get recorded and shown.
		{
			ctx.server.event$
				.pipe(
					Rx.filter(([, event]) => event.type === 'INGAME_VOTE_STARTED' || event.type === 'NEW_GAME'),
					Instr.durableSub('handle-ingame-vote', { module }, async ([evtCtx, event], signal) => {
						const ctx = SquadServer.eventCtx(evtCtx, signal)
						if (event.type === 'NEW_GAME') {
							ctx.layerQueue.ingameVote$.next(null)
							return
						}
						if (event.type !== 'INGAME_VOTE_STARTED') return

						const serverState = await SquadServer.getServerState(ctx)
						// A vote takes over the reason even when an admin had already turned updates off: whoever stopped
						// SLM writing the rotation, the vote is what decides the next layer now, and the alert has to say
						// so. Only the first stage acts, though -- each team's faction round arrives as its own container,
						// and re-claiming on those would override an admin who re-enabled updates mid-vote.
						const existing = ctx.layerQueue.ingameVote$.getValue()
						const from = serverState.settings.updatesToSquadServerDisabled
						if (!existing && from?.type !== 'ingame-vote') {
							await toggleUpdatesToSquadServer({ ctx, input: { disabled: { type: 'ingame-vote', inferred: false } } })
							// SLM turning itself off is an action in its own right, and the settings write alone leaves no
							// trace of who did it or why
							await AppEventsSys.persistAppEvent(
								ctx,
								AppEvents.create<AppEvents.SettingsUpdated>({
									type: 'SETTINGS_UPDATED',
									actor: { type: 'system' },
									serverId: ctx.serverId,
									matchId: event.matchId,
									causeId: null,
									changes: [{ path: 'updatesToSquadServerDisabled', from, to: { type: 'ingame-vote', inferred: false } }],
								}),
							)
						}
						ctx.layerQueue.ingameVote$.next({
							choices: event.choices,
							startedAt: existing?.startedAt ?? event.time,
						})
					}),
				)
				.subscribe()
		}

		// -------- infer a vote from the server losing its next layer --------
		// Enabling voting clears the server's next layer, and nothing is logged when an admin enables it, so the
		// cleared next layer is the only thing SLM can see. This reads the status the existing poll already produces
		// and issues no rcon of its own: an extra round trip on the shared connection delays the roster poll across
		// a roll, which is enough to change what the roll looks like to everything downstream.
		{
			// a roll clears the next layer too, and SLM's write lands just after, so one sighting proves nothing --
			// every roll produces one. Only a gap that outlasts the grace period is somebody else's doing.
			let missingSince: number | null = null
			ctx.cleanup.push(
				ctx.squadRcon.layersStatus
					.observe(ctx)
					.pipe(
						Instr.durableSub('infer-ingame-vote', { module, levels: { event: 'trace' } }, async (status, signal) => {
							const rolling = !!ctx.server.serverRolling$.value
							if (status.code !== 'ok' || status.data.nextLayer || rolling) {
								missingSince = null
								return
							}
							if (missingSince === null) {
								missingSince = Date.now()
								return
							}
							if (Date.now() - missingSince < INFER_INGAME_VOTE_GRACE_MS) return

							// only now is it worth reading anything: until here this has cost one comparison per poll
							const ctxWithSignal = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
							if (!(await nextLayerMissingWithNothingToBlame(ctxWithSignal))) {
								missingSince = null
								return
							}
							missingSince = null

							const from = (await SquadServer.getServerState(ctxWithSignal)).settings.updatesToSquadServerDisabled
							await toggleUpdatesToSquadServer({
								ctx: ctxWithSignal,
								input: { disabled: { type: 'ingame-vote', inferred: true } },
							})
							await AppEventsSys.persistAppEvent(
								ctxWithSignal,
								AppEvents.create<AppEvents.SettingsUpdated>({
									type: 'SETTINGS_UPDATED',
									actor: { type: 'system' },
									serverId: ctxWithSignal.serverId,
									matchId: (await MatchHistory.getCurrentMatch(ctxWithSignal))?.historyEntryId ?? null,
									causeId: null,
									changes: [{ path: 'updatesToSquadServerDisabled', from, to: { type: 'ingame-vote', inferred: true } }],
								}),
							)
						}),
					)
					.subscribe(),
			)
		}

		// -------- handle AdminChangeLayer --------
		{
			ctx.server.event$
				.pipe(
					Rx.filter(([ctx, event]) => event.type === 'ROUND_ENDED' && event.action?.type === 'AdminChangeLayer'),
					Instr.durableSub('syncAdminChangeLayer', { module }, async ([evtCtx, event], signal) => {
						const ctx = SquadServer.eventCtx(evtCtx, signal)
						if (event.type !== 'ROUND_ENDED' || event.action?.type !== 'AdminChangeLayer') return
						const external = externalActor(event.action.source)
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
				)
				.subscribe()
		}

		// -------- discard drafts whose last editor left without saving --------
		ctx.cleanup.push(
			UserPresenceSys.editingAbandoned$(serverId)
				.pipe(
					Instr.durableSub('discard-abandoned-edits', { module, levels: { event: 'info' } }, async (scope, signal) => {
						const ctx = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
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
				)
				.subscribe(),
		)
	},
)

// how long to leave between one post-roll announcement and the next
const ANNOUNCEMENT_GAP_MS = 2000

export function schedulePostRollTasks(ctx: SQS.Ctx & LQ.Ctx & SETTINGS.Ctx, newLayerId: L.LayerId) {
	const serverId = ctx.serverId

	// -------- schedule post-roll events --------
	ctx.server.postRollEventsSub?.unsubscribe()
	ctx.server.postRollEventsSub = new Rx.Subscription()

	// -------- schedule FRAAS auto fog-off --------
	const currentLayer = L.toLayer(newLayerId)
	if (currentLayer.Gamemode === 'FRAAS') {
		ctx.server.postRollEventsSub.add(
			Rx.timer(ctx.serverSettings.settings.fogOffDelay).subscribe(async () => {
				const ctx = SquadServer.resolveCtx(getBaseCtx(), serverId)
				await SquadRcon.setFogOfWar(ctx, 'off')
				await SquadRcon.broadcast(ctx, ctx.tr.broadcast(SS_Msgs.fogOff()))
			}),
		)
	}

	// -------- schedule post-roll announcements --------
	if (SETTINGS.remindersEnabled(ctx.serverSettings.settings)) {
		// what the registered providers have to say right now, then the standing announcements
		const announcements: (() => Promise<void>)[] = []

		announcements.push(async () => {
			const ctx = SquadServer.resolveCtx(getBaseCtx(), serverId)
			const messages = await Reminders.collect(ctx, log)
			for (const [i, message] of messages.entries()) {
				if (i > 0) await Prom.sleep(ANNOUNCEMENT_GAP_MS)
				await SquadRcon.warnAllAdmins(ctx, message)
			}
		})

		announcements.push(async () => {
			await warnShowNext(SquadServer.resolveCtx(getBaseCtx(), serverId), 'all-admins')
		})

		announcements.push(async () => {
			const ctx = SquadServer.resolveCtx(getBaseCtx(), serverId)
			const queue = getSavedQueue(ctx)
			const threshold = ctx.serverSettings.settings.queue.lowQueueWarningThreshold
			if (threshold !== null && queue && queue.length <= threshold) {
				await SquadRcon.warnAllAdmins(ctx, LL_Msgs.lowQueueItemCount(queue.length))
			}
		})

		// concat over the observables themselves, not over an observable *of* them: Rx.from(paced)
		// emits each task as a value and never subscribes to it, so every post-roll announcement was
		// silently skipped. A failing announcement must not take the rest of the chain with it.
		const paced: Rx.Observable<unknown>[] = [Rx.timer(ctx.serverSettings.settings.postRollAnnouncementsTimeout)]
		for (const [i, announce] of announcements.entries()) {
			if (i > 0) paced.push(Rx.timer(ANNOUNCEMENT_GAP_MS))
			paced.push(Rx.Ext.toCold(announce).pipe(Rx.catchError(() => Rx.EMPTY)))
		}
		ctx.server.postRollEventsSub.add(Rx.concat(...paced).subscribe())
	}
}

// Who made a layer change SLM is reconciling against. `unknown` is the honest answer for a change SLM found rather
// than watched happen -- notably the layer already set when SLM connects, which used to be reported as another RCON
// tool's doing on every startup.
export function externalActor(source: SE.MapSet['source']): { type: 'player'; playerId: string } | { type: 'rcon' } | { type: 'unknown' } {
	if (source?.type === 'player') return { type: 'player', playerId: SM.PlayerIds.getPlayerId(source.playerIds) }
	if (source?.type === 'rcon') return { type: 'rcon' }
	return { type: 'unknown' }
}

// get the queue which is synced to the squad server
/** The committed queue. Edits a user has open but not saved are not in it. */
export function getSavedQueue(ctx: LQ.Ctx) {
	return ctx.layerQueue.session.state.savedList
}

export async function saveQueueAndUpdateServer(
	ctx: C.Db & LQ.Ctx & SQS.Ctx & V.Ctx & MH.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
	list: LL.List,
	// the list this save replaces. Every next-layer change reaches the server through here -- an SLM edit, a roll, or
	// adopting a layer someone set outside SLM -- so comparing the two heads is what tells admins the layer moved.
	prevList: LL.List,
	// the QUEUE_UPDATED for this save; the resulting MAP_SET app event (if the next layer changed) links back to it
	queueUpdatedId?: string,
) {
	await VoteSys.syncVoteStateWithQueueState(ctx, list)
	return await DB.runTransaction(ctx, { redactParams: true }, async (txCtx) => {
		const serverState = await SquadServer.getServerState(txCtx)
		const nextItemId = list[0]?.itemId || null
		const nextLayerId = LL.getNextLayerId(list)
		const prevNextLayerId = LL.getNextLayerId(prevList)
		const nextLayerChanged = !!nextLayerId && (!prevNextLayerId || !L.areLayersCompatible(prevNextLayerId, nextLayerId))

		await SquadServer.updateServerState(
			txCtx,
			{ layerQueue: list },
			{
				type: 'system',
				event: 'admin-change-layer',
			},
		)

		// These reach the game server over rcon, so they're deferred rather than awaited under the (global) tx lock.
		// unlockTasks are the outermost transaction's, so this also keeps them out of the map-roll tx that
		// onNewGameDuringRoll wraps around this. The mutex context is ambient, so it still covers them; `tx` is dropped
		// because it's spent by then, and a nested runTransaction would otherwise join a committed transaction and run
		// in autocommit with a rollback() that does nothing.
		const deferredCtx = { ...ctx, tx: undefined }
		txCtx.tx.unlockTasks.push(async () => {
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
			// after the sync, so the warn names the layer now set rather than the one it replaced. A change SLM overrides
			// never gets here: the override sets the layer back directly instead of saving, so it announces nothing.
			// gated on the same settings the sync read, so the warn fires only when the layer it names really was set.
			if (
				deferredCtx.serverSettings.settings.warnOnNextLayerChange &&
				nextLayerChanged &&
				!serverState.settings.updatesToSquadServerDisabled
			) {
				await warnShowNext(deferredCtx, 'all-admins', { updated: true })
			}
		})

		return {
			code: 'ok' as const,
		}
	})
}

// Draws the next queue item and applies it. Split out of handleSideEffect because a map roll defers it past that
// transaction's commit, where it would otherwise run untraced.
const generateAndDispatchQueueItem = Instr.spanOp(
	'generateAndDispatchQueueItem',
	{ module, levels: { event: 'info' } },
	async (ctx: SideEffectCtx) => {
		const serverState = await SquadServer.getServerState(ctx)
		const allConstraints = SETTINGS.getSettingsConstraints(serverState.settings, { generatingLayers: true })
		const layerCtx = await LayerQueriesServer.resolveLayerQueryCtx(ctx)
		const layerItemsState = await LayerQueriesServer.resolveLayerItemsState(ctx)
		const templates = ctx.layerQueue.session.state.savedBackburner.map((item) => ({ itemId: item.itemId, filter: item.filter }))

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
				const noDnrConstraints = constraints.filter((c) => c.type !== 'do-not-repeat')
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
	},
)

// What the queue head breaks, as the layer table's own warning indicators would show it: the repeat rules it
// violates and the pool filters it misses. Undefined when there is nothing to report, so a caller can drop the
// whole section rather than render an empty one.
async function nextLayerViolations(ctx: C.Db & SQS.Ctx & LQ.Ctx & MH.Ctx & SETTINGS.Ctx & CS.AbortSignal) {
	const head = getSavedQueue(ctx)[0]
	if (!head) return undefined
	const serverState = await SquadServer.getServerState(ctx)
	const allConstraints = SETTINGS.getSettingsConstraints(serverState.settings, { generatingLayers: false })
	// statuses need the engine, so the query ctx is only resolved once there is a head to report on
	const queryCtx = await LayerQueriesServer.resolveLayerQueryCtx(ctx)
	const statusRes = await LayerQueries.getLayerItemStatuses({
		ctx: queryCtx,
		input: {
			constraints: allConstraints,
			skipWarningsForTags: serverState.settings.queue.mainPool.skipWarningsForTags,
			list: await LayerQueriesServer.resolveLayerItemsState(ctx),
		},
	})
	if (statusRes.code !== 'ok') return undefined
	const warns = statusRes.statuses.warns.filter((w) => w.itemId === head.itemId)
	if (warns.length === 0) return undefined
	const repeatViolations = warns.filter((w) => w.type === 'repeat-rule-violation-warning').flatMap((w) => w.descriptors)
	const poolViolations = warns
		.filter((w) => w.type === 'filter-entity-warning')
		.map((w) => {
			const constraint = allConstraints.find((c) => c.id === w.constraintId)! as Extract<LQY.Constraint, { type: 'filter-entity' }>
			const entity = queryCtx.filters.get(constraint.filterId)
			// warn 'inverted' fires when the layer does NOT match, so use the miss indicator's message
			const missed = constraint.warn === 'inverted'
			return (
				(missed ? entity?.invertedAlertMessage : entity?.alertMessage) ?? `${missed ? '!' : ''}${entity?.name ?? constraint.filterId}`
			)
		})
	return { repeatViolations, poolViolations }
}

export async function warnShowNext(
	ctx: C.Db & SQS.Ctx & LQ.Ctx & MH.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
	playerIds: 'all-admins' | SM.PlayerIds.Type,
	opts?: { updated?: boolean; isAdmin?: boolean },
) {
	const layerQueue = getSavedQueue(ctx)
	const firstItem = layerQueue[0]
	let setByUser: USR.User | undefined
	if (firstItem?.source.type === 'manual') {
		const userId = firstItem.source.userId
		const [user] = await Users.selectUsers(ctx).where(E.eq(Schema.users.discordId, userId))
		setByUser = await Users.buildUser(user)
	}
	const isAdmin = playerIds === 'all-admins' || !!opts?.isAdmin

	const nextLayerRes = await ctx.squadRcon.layersStatus.get(ctx)
	const nextLayer = nextLayerRes.code === 'ok' ? nextLayerRes.data.nextLayer : null
	const commands = Settings.GLOBAL_SETTINGS.commands
	// what is wrong with the layer is an admin's business, and the reader has to be one to act on it anyway
	const violations = isAdmin ? await nextLayerViolations(ctx) : undefined
	const showNextMsg = ctx.tr.warn(
		LL_Msgs.showNext(layerQueue, nextLayer, setByUser, commands, { updated: opts?.updated, isAdmin, violations }),
	)
	if (playerIds === 'all-admins') {
		await SquadRcon.warnAllAdmins(ctx, showNextMsg)
	} else {
		await SquadRcon.warn(ctx, playerIds, showNextMsg)
	}
}

/**
 * sets next layer on server according to the current queue, generating a new queue item if needed. modifies serverState in place.
 */
// matchHistory.mtx is declared here (rather than acquired lazily by the nested getCurrentMatch call
// below) so that every op taking both locks takes them as one ordered set. Acquiring updateLayerMtx
// first and matchHistory.mtx later deadlocks against onNewGameDuringRoll, which takes them together.
export const syncNextLayerToServer = Instr.spanOp(
	'syncNextLayerToServer',
	{ module, mutexes: (ctx) => [ctx.layerQueue.updateLayerMtx, ctx.matchHistory.mtx] },
	async (
		ctx: SQS.Ctx & SR.Ctx.Rcon & LQ.Ctx & C.Db & MH.Ctx & CS.AbortSignal,
		settings: SETTINGS.ServerSettings,
		nextQueuedLayerId: L.LayerId,
		itemId: string,
		// why SLM is setting the layer. queue-driven sets fold into their QUEUE_UPDATED (audit-only MAP_SET); override sets
		// react to a non-SLM set and get a feed entry. absent -> no MAP_SET app event (still attributes the server event).
		mapSetCause?: { reason: 'queue-updated'; causeId: string } | { reason: 'override'; overrode?: AppEvents.MapSet['overrode'] },
	) => {
		const syncState$ = ctx.layerQueue.nextLayerSyncState$
		if (settings.updatesToSquadServerDisabled) {
			syncState$.next({ code: 'disabled' })
			return
		}
		const currentStatusRes = await ctx.squadRcon.layersStatus.get(ctx)
		if (currentStatusRes.code !== 'ok') {
			syncState$.next({ code: 'err:rcon' })
			return currentStatusRes
		}
		if (currentStatusRes.data.nextLayer && L.areLayersCompatible(currentStatusRes.data.nextLayer.id, nextQueuedLayerId)) {
			syncState$.next({ code: 'synced' })
			return
		}
		// the write and the read-back that verifies it are a round trip each, so the queue head and the server
		// legitimately disagree until setNextLayer returns. Clients spin on this rather than calling it out of sync.
		syncState$.next({ code: 'syncing' })
		const res = await SquadRcon.setNextLayer(ctx, nextQueuedLayerId)
		// we do this so we can stay in this async context so we hold on to the mutex that we acquired
		switch (res.code) {
			case 'err:unable-to-set-next-layer':
				syncState$.next({ code: 'err:refused', actualLayerId: res.unexpectedLayerId })
				break
			case 'err:rcon':
				syncState$.next({ code: 'err:rcon' })
				// deliberately detached (see below): observe the rejection instead of awaiting
				SquadServer.pushAttribution(ctx, { type: 'MAP_SET_ATTRIBUTION', itemId, layerId: nextQueuedLayerId }).catch((err) => {
					if (!Prom.isAbortError(err)) log.error(err)
				})
				break
			case 'ok': {
				syncState$.next({ code: 'synced' })
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
					if (!Prom.isAbortError(err)) log.error(err)
				})
				break
			}
			default:
				assertNever(res)
		}
	},
)

// How long the server is allowed to have no next layer before SLM reads it as voting having been enabled. A roll
// clears it and SLM's own write lands shortly after -- a second or two -- so anything near that gap reads every roll
// as a vote. The gap must also be seen on more than one poll, so this is a floor on the wait, not the whole of it.
const INFER_INGAME_VOTE_GRACE_MS = 10_000

// The conditions under which an empty next layer is somebody else's doing rather than SLM's own: SLM is writing the
// rotation, it has a head it would have written, and no roll is in flight to explain the gap.
async function nextLayerMissingWithNothingToBlame(ctx: C.Db & SQS.Ctx & LQ.Ctx & SETTINGS.Ctx & CS.AbortSignal) {
	if (ctx.server.serverRolling$.value) return false
	const serverState = await SquadServer.getServerState(ctx)
	if (serverState.settings.updatesToSquadServerDisabled) return false
	return !!getSavedQueue(ctx)[0]?.layerId
}

export async function toggleUpdatesToSquadServer({
	ctx,
	input,
}: {
	ctx: C.Db & SQS.Ctx & SM.Ctx.UserOrPlayer & LQ.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx
	// null re-enables. The reason is the state, so a caller cannot disable updates without saying why.
	input: { disabled: SETTINGS.SlmUpdatesDisabled | null }
}) {
	const byVote = input.disabled?.type === 'ingame-vote'
	let turnedIngameVotingOff = false
	await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
		const serverState = await SquadServer.getServerState(ctx)
		// Re-enabling while a vote is the reason has to turn the vote off too, or SLM goes straight back to setting a
		// next layer the vote will overwrite -- the fight that standing down avoided in the first place.
		turnedIngameVotingOff = !input.disabled && serverState.settings.updatesToSquadServerDisabled?.type === 'ingame-vote'
		serverState.settings.updatesToSquadServerDisabled = input.disabled
		await Settings.updateServerSettings(ctx, serverState.settings, {
			type: 'system',
			event: byVote ? 'ingame-vote-detected' : 'updates-to-squad-server-toggled',
		})
	})

	if (turnedIngameVotingOff) await SquadRcon.setIngameVotingEnabled(ctx, false)

	// only syncNextLayerToServer moves this off err:refused, and it returns before reaching that point while
	// disabled, so a next layer already flagged would otherwise keep warning admins every 2 minutes forever.
	if (input.disabled) ctx.layerQueue.nextLayerSyncState$.next({ code: 'disabled' })

	const notification = byVote
		? SS_Msgs.ingameVoteDisabledUpdates(input.disabled?.type === 'ingame-vote' && input.disabled.inferred)
		: SS_Msgs.slmUpdatesSet(!input.disabled, turnedIngameVotingOff)
	// a chat command is read by every admin as it is typed, so only the admin who ran it needs telling. SLM standing
	// down on its own is nobody's command and still goes to all of them.
	if (ctx.player && !byVote) await SquadRcon.warn(ctx, ctx.player.ids, notification)
	else await SquadRcon.warnAllAdmins(ctx, notification)
	return { code: 'ok' as const }
}

/** Whether SLM is currently allowed to push layer changes to the game server, and if not, whether an in-game vote is why. */
export async function getSlmUpdatesEnabled(ctx: C.Db & SM.Ctx.UserOrPlayer & SQS.Ctx & LQ.Ctx) {
	const serverState = await SquadServer.getServerState(ctx)
	const disabled = serverState.settings.updatesToSquadServerDisabled
	return { code: 'ok' as const, enabled: !disabled, disabledByIngameVote: disabled?.type === 'ingame-vote' }
}

export async function requestFeedback(
	ctx: C.Db & SQS.Ctx & LQ.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
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
	await SquadRcon.warnAllAdmins(ctx, LL_Msgs.requestFeedback(index, playerName, item))
	return { code: 'ok' as const }
}

function getBaseCtx() {
	return C.initMutexStore(DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }))
}

// -------- setup router --------
export const router = {
	watchNextLayerSyncState: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) => ctx.layerQueue.nextLayerSyncState$).pipe(
				// every sync ends by re-announcing its outcome, so without this a save that changed nothing still
				// pushes a fresh object to every client
				Rx.Ext.distinctDeepEquals(),
				Rx.Ext.withAbortSignal(signal!),
			)
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchIngameVote: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) => ctx.layerQueue.ingameVote$).pipe(
				Rx.Ext.withAbortSignal(signal!),
			)
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	toggleUpdatesToSquadServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(
				ctx,
				RBAC.perm('squad-server:disable-slm-updates', { serverId: ctx.serverId }),
			)
			if (denyRes) return denyRes
			// a user can only ever disable updates as themselves: the vote reason is SLM's alone
			const disabled = input.disabled ? ({ type: 'manual', by: { type: 'slm-user', userId: ctx.user.discordId } } as const) : null
			return await toggleUpdatesToSquadServer({ ctx, input: { disabled } })
		}),

	// Turning voting on hands the rotation to the players, so SLM has to stand down with it -- doing one without the
	// other just puts the two back to overwriting each other. Gated on disable-slm-updates because that is what it
	// does to SLM, and there is no narrower permission for handing the rotation away.
	enableIngameVoting: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(
				ctx,
				RBAC.perm('squad-server:disable-slm-updates', { serverId: ctx.serverId }),
			)
			if (denyRes) return denyRes
			await SquadRcon.setIngameVotingEnabled(ctx, true)
			return await toggleUpdatesToSquadServer({ ctx, input: { disabled: { type: 'ingame-vote', inferred: false } } })
		}),

	watchOps: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, input, signal }) {
			const updateForServer$ = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) => {
				const initial: SLL.Update = {
					code: 'init',
					state: ctx.layerQueue.session.state,
					ops: ctx.layerQueue.session.ops,
				}
				const updateForClient$: Rx.Observable<SLL.Update> = ctx.layerQueue.op$.pipe(
					Rx.map((dispatched) => ODSM.Server.toClientUpdate(dispatched, context.wsClientId)),
					Rx.filter((update): update is NonNullable<typeof update> => update !== null),
					Rx.startWith(initial),
					// if we don't do this then the orpcWs breaks
					Rx.observeOn(Rx.asyncScheduler),
				)
				return updateForClient$
			}).pipe(Rx.Ext.withAbortSignal(signal!))

			yield* Rx.Ext.toAsyncGenerator(updateForServer$)
		}),

	dispatchOp: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), op: SLL.OperationSchema }))
		.handler(async ({ context: _ctx, input: { serverId, op } }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, serverId)
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
				op.op === 'backburner-write-saved' ||
				op.op === 'discard-abandoned-request-edits' ||
				op.op === 'discard-abandoned-queue-edits'
			) {
				return { code: 'err:invalid-op' as const, msg: `${op.op} is server-only` }
			}

			if (SLL.isBackburnerOp(op)) {
				const backburnerRes = await tryDenyBackburnerDraftOp(ctx, op)
				if (backburnerRes) return backburnerRes
			} else {
				const authRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write', { serverId: ctx.serverId }))
				if (authRes) return authRes
				const noteRes = await tryDenyNoteOp(ctx, op)
				if (noteRes) return noteRes
			}

			// adding or setting a layer that isn't in the configured pool additionally requires queue:force-write.
			// only checked when the op introduces layers and the user lacks force-write, to keep the common path cheap.
			const forceWriteCandidates = getForceWriteCandidateLayerIds(ctx.layerQueue.session.state, op)
			if (forceWriteCandidates.length > 0) {
				const forceWriteDenied = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:force-write', { serverId: ctx.serverId }))
				if (forceWriteDenied) {
					const serverState = await SquadServer.getServerState(ctx)
					const poolConstraints = SETTINGS.getPoolMembershipConstraints(serverState.settings)
					const layerCtx = await LayerQueriesServer.resolveLayerQueryCtx(ctx)
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
export async function isTemplateSatisfiable(ctx: C.Db & MH.Ctx & LQ.Ctx & CS.AbortSignal, filter: F.FilterNode): Promise<boolean> {
	const layerCtx = await LayerQueriesServer.resolveLayerQueryCtx(ctx)
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

// writing a note only needs queue:write, which the caller has already established. Rewording or dropping someone
// else's is what the manage-all grant is for.
async function tryDenyNoteOp(ctx: C.Db & C.ManagedServer & USR.Ctx.Id & CS.AbortSignal, op: SLL.Operation) {
	if (op.op !== 'edit-note' && op.op !== 'delete-note') return
	const note = LL.findNote(ctx.layerQueue.session.state.list, op.itemId, op.noteId)
	// a note that isn't there is left to the reducer, which no-ops on it
	if (!note || LNote.isAuthor(note, ctx.user.discordId)) return
	return await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:manage-all-notes', { serverId: ctx.serverId }))
}

type BackburnerDraftOp = Exclude<Extract<SLL.Operation, { op: `backburner-${string}` }>, { op: 'backburner-write-saved' }>

// per-op authorization + validation for backburner draft ops arriving over the RPC. Own items need any
// queue:request-layers grant; touching someone else's item needs queue:write. Adds/updates/combines are
// probed for satisfiability so an impossible template can't enter the backburner.
async function tryDenyBackburnerDraftOp(ctx: C.Db & C.ManagedServer & USR.Ctx.Id & CS.AbortSignal, op: BackburnerDraftOp) {
	const state = ctx.layerQueue.session.state
	const owner: USR.GuiOrChatUserId = { discordId: ctx.user.discordId }
	const targets: BB.BackburnerItem[] = []
	switch (op.op) {
		case 'backburner-add':
			break
		case 'backburner-update':
		case 'backburner-reorder': {
			const item = state.backburner.find((item) => item.itemId === op.itemId)
			if (item) targets.push(item)
			break
		}
		case 'backburner-remove':
			targets.push(...state.backburner.filter((item) => op.itemIds.includes(item.itemId)))
			break
		case 'backburner-combine':
			targets.push(...state.backburner.filter((item) => item.itemId === op.targetItemId || item.itemId === op.sourceItemId))
			break
		// save/reset commit or discard the shared draft as a whole; any requester may do so
		case 'backburner-save':
		case 'backburner-reset':
			break
		default:
			assertNever(op)
	}

	// own items qualify with any queue:request-layers grant; touching someone else's item needs queue:write
	const touchesOthers = targets.some((item) => !BB.sameOwner(item.source, owner))
	const authReq = touchesOthers
		? RBAC.perm('queue:write', { serverId: ctx.serverId })
		: RBAC.permReq('any', [RBAC.perm('queue:write', { serverId: ctx.serverId }), RBAC.anyLayerRequestGrant(ctx.serverId)])
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
			const target = state.backburner.find((item) => item.itemId === op.targetItemId)
			const source = state.backburner.find((item) => item.itemId === op.sourceItemId)
			if (!target || !source) break
			const merged = BB.mergeTemplateFilters(target.filter, source.filter)
			if (merged.code !== 'ok') {
				const names = merged.filterIds.map((id) => backburnerFilterName(id) ?? id)
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
	ctx: C.Db & C.ManagedServer & USR.Ctx.Id & CS.AbortSignal,
	owner: USR.GuiOrChatUserId,
	opts?: { list?: BB.BackburnerItem[] },
) {
	const state = ctx.layerQueue.session.state
	const list = opts?.list ?? state.backburner
	const serverState = await SquadServer.getServerState(ctx)
	const maxTotal = serverState.settings.queue.layerRequests.maxTotal
	if (list.length >= maxTotal) return { code: 'err:backburner-full' as const, max: maxTotal }
	const hasQueueWrite = !(await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write', { serverId: ctx.serverId })))
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
// when they are at their cap. Authorization resolves off the player, so an unlinked sender can still request;
// `source` carries their steam id plus their linked account when they have one, so ownership checks work from
// either surface.
export async function addBackburnerRequestFromChat(
	ctx: C.Db & C.ManagedServer & CS.AbortSignal & SM.Ctx.Ids,
	args: { source: USR.GuiOrChatUserId; filter: F.FilterNode },
): Promise<AddRequestResult> {
	const denied = await Rbac.tryDenyPermissionsForPlayer(ctx, RBAC.anyLayerRequestGrant(ctx.serverId))
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
		write: { kind: 'add', item, evictItemIds: evicted.map((i) => i.itemId) },
		source: args.source,
	})
	return { code: 'ok', item, evicted }
}

export async function removeBackburnerRequestsFromChat(
	ctx: C.Db & C.ManagedServer & CS.AbortSignal,
	args: { itemIds: string[]; source: USR.GuiOrChatUserId },
) {
	await dispatchOp(ctx, {
		op: 'backburner-write-saved',
		opId: SLL.createOpId(),
		write: { kind: 'remove', itemIds: args.itemIds },
		source: args.source,
	})
}

/** The committed backburner: layers set aside rather than queued. Same saved-only rule as getSavedQueue. */
export function getSavedBackburner(ctx: LQ.Ctx): BB.BackburnerItem[] {
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

/**
 * Applies a queue operation: the same path the web client's edits go through, so a plugin's edit is an
 * ordinary edit and produces the same side effects, app events and client updates. Rejected ops are
 * logged and dropped rather than thrown.
 */
export const dispatchOp = Instr.spanOp(
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
		ctx: SideEffectCtx,
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

const handleSideEffect = Instr.spanOp(
	'handleSideEffect',
	{
		module,
		extraText: (ctx, op, se) => `${op.op} -> Side Effect ${se.code}`,
		attrs: (ctx, op, se) => ({ [ATTRS.LayerQueue.OP]: op.op, [ATTRS.LayerQueue.SIDE_EFFECT]: se.code }),
	},
	async (ctx: SideEffectCtx, op: SLL.Operation, se: SLL.SideEffect) => {
		switch (se.code) {
			case 'complete':
			case 'op-outcome':
				break
			case 'edit-window-closed': {
				UserPresenceSys.dispatchEndAllLayerQueueEditing(ctx.serverId)
				break
			}
			case 'request-queue-item-generation': {
				// Generation queries the layer engine (loading its artifact if nothing has for a while) and ends in a
				// dispatchOp that opens its own transaction. Neither belongs under the process-wide tx lock, so when a
				// map roll wraps this it runs once that transaction has committed. `tx` is dropped for the reason
				// saveList drops it: it is spent by then, and a nested runTransaction would join a committed
				// transaction and run in autocommit with a rollback() that does nothing.
				if (ctx.tx) {
					const deferredCtx = { ...ctx, tx: undefined }
					ctx.tx.unlockTasks.push(() => generateAndDispatchQueueItem(deferredCtx))
				} else {
					await generateAndDispatchQueueItem(ctx)
				}
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
				const prevIds = new Set(se.prevItems.map((item) => item.itemId))
				const nextIds = new Set(se.items.map((item) => item.itemId))
				const added = se.items.filter((item) => !prevIds.has(item.itemId))
				const removed = se.prevItems.filter((item) => !nextIds.has(item.itemId))
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
								itemIds: removed.map((item) => item.itemId),
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
							itemIds: removed.map((item) => item.itemId),
							descriptions: removed.map(describe),
						}),
					)
				}
				break
			}
			case 'request-list-save': {
				// the ops that make up this save: the span (lastSaveOpId, opId] from the session's op log
				const allOps = ctx.layerQueue.session.ops
				const startIdx = se.lastSaveOpId == null ? 0 : allOps.findIndex((o) => o.opId === se.lastSaveOpId) + 1
				const endIdx = allOps.findIndex((o) => o.opId === se.opId)
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
					return {
						trigger: 'user-edit',
						actor: triggerOp?.userId ? { type: 'slm-user', userId: triggerOp.userId } : { type: 'system' },
					}
				})()
				// who the saver overrode: the users still mid-edit when the save landed. the saver's own editing presence is
				// cleared alongside the save, so exclude them rather than race the two ops.
				const save =
					triggerOp?.op === 'save'
						? {
								force: triggerOp.force ?? false,
								overrodeEditors: UserPresenceSys.getQueueEditors(ctx.serverId, triggerOp.userId),
							}
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
				await saveQueueAndUpdateServer(ctx, se.list, se.prevList, queueUpdated.id)
				await dispatchOp(ctx, { op: 'save-completed', opId: SLL.createOpId() })
				UserPresenceSys.dispatchEndAllLayerQueueEditing(ctx.serverId)
				break
			}
			default:
				assertNever(se)
		}
	},
)
