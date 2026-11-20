import { Mutex } from 'async-mutex'

import { IsolatedBehaviorSubject, IsolatedReplaySubject, IsolatedSubject } from '@/lib/isolated-subject'
import * as ODSM from '@/lib/odsm'
import * as OrderedLanes from '@/lib/ordered-lanes'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards.ts'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as BB_Msgs from '@/messages/backburner.messages'
import * as I18n from '@/messages/i18n'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as AppEvents from '@/models/app-events.models'
import * as BB from '@/models/backburner.models'
import * as CB from '@/models/constraint-builders.models'
import * as CS from '@/models/context-shared.models'
import type * as DH from '@/models/display-helpers.models'
import * as FPM from '@/models/filter-problems.models'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns.models'
import * as LE from '@/models/layer-engine.models'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import * as LQY from '@/models/layer-queries.models.ts'
import type * as LQ from '@/models/layer-queue.models'
import * as L from '@/models/layer.models'
import type * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as ATTRS from '@/models/otel-attrs.models'
import * as SE from '@/models/server-events.models'
import type * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list.models'
import type * as SR from '@/models/squad-rcon.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models.ts'
import type * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import * as RBAC from '@/rbac.models.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerEngine from '@/systems/layer-engine.server'
import * as LayerQueries from '@/systems/layer-queries.server'
import * as LayerQueriesShared from '@/systems/layer-queries.shared.ts'
import * as MatchHistory from '@/systems/match-history.server'
import * as Reminders from '@/systems/post-roll-reminders.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServerActions from '@/systems/squad-server-actions.server'
import * as SquadServerIngest from '@/systems/squad-server-ingest.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UserPresence from '@/systems/user-presence.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'

// ctx for op dispatch and its side effects, which await rcon and so never run inside a transaction
type SideEffectCtx = C.Db & LQ.Ctx & SQS.Ctx & V.Ctx & MH.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx

// The server MAP_SET an outside-set sync is reacting to, by the queue item the sync puts in the queue, for the length of
// that one dispatch. Carried beside the op rather than on it: the op type is part of the plugin API.
const externalSetEventIds = new Map<LL.ItemId, number>()

const module = initModule('layer-queue')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export function initPayload(ctx: C.ManagedServerCleanup & CS.ServerId, serverState: SS.ServerState) {
	const sllState = SLL.createNewState(serverState.layerQueue, serverState.backburner, {
		generateWhenEmpty: serverState.settings.queue.mainPool.generateLayers,
	})
	const payload: LQ.Ctx.Payload = {
		nextLayerSyncState$: new IsolatedBehaviorSubject<LQ.NextLayerSyncState>({ code: 'synced' }),
		ingameVote$: new IsolatedBehaviorSubject<LQ.IngameVote | null>(null),
		update$: new IsolatedReplaySubject(1),

		session: ODSM.Server.initSession<SLL.Operation, SLL.State>(sllState),
		op$: new IsolatedSubject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>(),
		updateLayerMtx: new Mutex(),
		deferredServerSyncs: null,
		mapSetsAwaitingSync: 0,
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
							const serverState = SquadServer.getServerState(baseCtx)
							if (!SETTINGS.remindersEnabled(serverState.settings)) return
							const currentMatch = await MatchHistory.getCurrentMatch(baseCtx)

							const voteState = baseCtx.vote.state
							// no match recorded means rcon has never synced, so there is no one in game to warn anyway
							if (baseCtx.server.serverRolling$.value || !currentMatch || currentMatch.status === 'post-game') return
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
				// a retry passes through syncing on its way back to the same refusal, which would otherwise restart the
				// interval and warn again on every retry
				Rx.filter((syncState) => syncState.code !== 'syncing'),
				Rx.distinctUntilChanged(
					(a, b) => a.code === 'err:refused' && b.code === 'err:refused' && L.areLayersCompatible(a.actualLayerId, b.actualLayerId),
				),
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
					const expectedNextLayer = LL.getNextLayerId(getSavedQueue(ctx))
					if (!expectedNextLayer) return
					await SquadRcon.warnAllAdmins(ctx, LL_Msgs.nextLayerRefused(expectedNextLayer, unexpectedNextlayer))
				}),
			)
			.subscribe()

		// -------- retry a set-next the dropped connection lost --------
		// nothing else retries it: the queue has not changed, and the reconnect reports the layer the server still had.
		// Keyed off the processed reconnect rather than the socket, so the server's next layer the reconnect records
		// predates this write and can't be read back as somebody else setting it. A reconnect mid-roll is folded into
		// the roll, whose server-roll RESET is then the first event processed with RCON back.
		ctx.server.event$
			.pipe(
				Rx.filter(([, event]) => event.type === 'RCON_CONNECTED' || (event.type === 'RESET' && event.source === 'server-roll')),
				// the roll writes the head itself, and holds the rolling flag until that write has finished
				Rx.concatMap((value) =>
					ctx.server.serverRolling$.pipe(
						Rx.filter((rolling) => rolling === null),
						Rx.take(1),
						Rx.map(() => value),
					),
				),
				Rx.filter(() => ctx.layerQueue.nextLayerSyncState$.value.code === 'err:rcon'),
				Instr.durableSub('resync-next-layer-on-reconnect', { module }, async ([evtCtx], signal) => {
					const ctx = SquadServer.eventCtx(evtCtx, signal)
					const queue = getSavedQueue(ctx)
					const nextLayerId = LL.getNextLayerId(queue)
					if (!nextLayerId) return
					const serverState = SquadServer.getServerState(ctx)
					await syncNextLayerToServer(ctx, serverState.settings, nextLayerId, queue[0].itemId)
				}),
			)
			.subscribe()

		// -------- make sure next layer set is synced with queue --------
		{
			ctx.server.event$
				.pipe(
					Rx.filter(([ctx, event]) => event.type === 'MAP_SET'),
					Rx.tap(() => ctx.layerQueue.mapSetsAwaitingSync++),
					// a roll writes the new queue head after it has recorded the match, and holds the rolling flag until then.
					// Comparing against the head before that write lands would fight it.
					Rx.concatMap((value) =>
						ctx.server.serverRolling$.pipe(
							Rx.filter((rolling) => rolling === null),
							Rx.take(1),
							Rx.map(() => value),
						),
					),
					Instr.durableSub(
						'sync-server-map-set',
						{ module, mutexes: ([evt]) => SquadServer.require(evt.serverId).layerQueue.updateLayerMtx },
						async ([evtCtx, event], signal) => {
							try {
								const ctx = SquadServer.eventCtx(evtCtx, signal)
								// skip map sets SLM itself caused (queue save, app-event set-next, or other internal
								// set-next) -- the saved queue is already in sync, so unshifting would duplicate the layer.
								// only organic sets (in-game admin, external RCON tool, unattributed) should unshift.
								if (event.type !== 'MAP_SET' || SE.mapSetIsSlmOriginated(event.source)) return
								const queue = getSavedQueue(ctx)
								const savedNextLayerId = LL.getNextLayerId(queue)
								const savedNextItemId = queue[0]?.itemId || null
								if (savedNextLayerId && L.areLayersCompatible(event.layerId, savedNextLayerId)) return
								const external = externalActor(event.source)
								if (ctx.serverSettings.settings.overrideAdminSetNextLayer) {
									const serverState = SquadServer.getServerState(ctx)
									if (savedNextLayerId === null) {
										log.warn('no next layer to sync after map set')
										return
									}
									await syncNextLayerToServer(ctx, serverState.settings, savedNextLayerId, savedNextItemId!, {
										reason: 'override',
										overrode: external,
										overrodeEventId: event.id,
									})
									await warnOverridden(
										ctx,
										event.source?.type === 'player' ? event.source.playerIds.username : undefined,
										event.layerId,
										savedNextLayerId,
									)
								} else {
									const op: SLL.Operation = {
										opId: SLL.createOpId(),
										op: 'unshift-first-saved-layer',
										itemId: LL.createItemId(),
										itemSource: { type: external.type === 'player' ? 'gameserver' : 'unknown' },
										layerId: event.layerId,
										externalSource: external,
									}
									externalSetEventIds.set(op.itemId, event.id)
									try {
										await dispatchOp(ctx, op)
									} finally {
										externalSetEventIds.delete(op.itemId)
									}
								}
							} finally {
								ctx.layerQueue.mapSetsAwaitingSync--
							}
						},
					),
				)
				.subscribe()
		}

		// -------- put the server back on the queue head when nothing else does --------
		// Every other write reacts to something: a save, a roll, a logged MAP_SET, a reconnect. This catches what they
		// miss, such as a set-next the log never reports, one dropped during a transition map, or a refused write.
		// It reads the status the existing poll produces, so it costs no rcon until it acts.
		{
			let offHeadSince: number | null = null
			let attempts = 0
			ctx.cleanup.push(
				ctx.squadRcon.layersStatus
					.observe(ctx)
					.pipe(
						Rx.filter((status) => {
							if (status.code !== 'ok') {
								offHeadSince = null
								return false
							}
							const serverNext = status.data.nextLayer
							const head = LL.getNextLayerId(getSavedQueue(ctx))
							// no next layer at all is left to the in-game vote inference below
							if (!serverNext || !head || L.areLayersCompatible(serverNext.id, head)) {
								offHeadSince = null
								attempts = 0
								// the server can come back to the head without SLM's write, as when the head is adopted from an
								// outside set, and a stale error would keep warning admins about a mismatch that is gone
								const syncState$ = ctx.layerQueue.nextLayerSyncState$
								const errored = syncState$.value.code === 'err:refused' || syncState$.value.code === 'err:rcon'
								if (serverNext && head && errored) syncState$.next({ code: 'synced' })
								return false
							}
							if (!headResyncAllowed(ctx)) {
								offHeadSince = null
								return false
							}
							const now = Date.now()
							offHeadSince ??= now
							if (now - offHeadSince < RESYNC_HEAD_GRACE_MS * 2 ** Math.min(attempts, RESYNC_HEAD_MAX_BACKOFF_EXP)) return false
							offHeadSince = null
							attempts++
							return true
						}),
						Instr.durableSub(
							'resync-next-layer-off-head',
							{ module, levels: { event: 'info' }, taskScheduling: 'exhaust', mutexes: () => ctx.layerQueue.updateLayerMtx },
							async (_, signal) => {
								const ctxWithSignal = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
								await resyncHeadIfOff(ctxWithSignal)
							},
						),
					)
					.subscribe(),
			)
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

						const serverState = SquadServer.getServerState(ctx)
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
							AppEventsSys.persistAppEvent(
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

							const from = SquadServer.getServerState(ctxWithSignal).settings.updatesToSquadServerDisabled
							await toggleUpdatesToSquadServer({
								ctx: ctxWithSignal,
								input: { disabled: { type: 'ingame-vote', inferred: true } },
							})
							AppEventsSys.persistAppEvent(
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
			UserPresence.editingAbandoned$(serverId)
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

		// -------- follow the layer generation setting --------
		// an op rather than a direct write, so every replica's reducer sees the same flag
		ctx.cleanup.push(
			Settings.settings$
				.pipe(
					Rx.filter((e): e is Extract<Settings.SettingsEvent, { scope: 'server' }> => e.scope === 'server' && e.serverId === serverId),
					Rx.map((e) => e.settings.queue.mainPool.generateLayers),
					Rx.distinctUntilChanged(),
					Instr.durableSub('sync-generate-when-empty', { module, levels: { event: 'info' } }, async (enabled, signal) => {
						const ctx = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
						if (ctx.layerQueue.session.state.generateWhenEmpty === enabled) return
						await dispatchOp(ctx, { op: 'set-generate-when-empty', enabled, opId: SLL.createOpId() })
					}),
				)
				.subscribe(),
		)
	},
)

// how long to leave between one post-roll announcement and the next
const ANNOUNCEMENT_GAP_MS = 2000

export function schedulePostRollTasks(
	ctx: SQS.Ctx & LQ.Ctx & SETTINGS.Ctx,
	newLayerId: L.LayerId,
	// set when the server loaded a layer other than the next layer it last reported
	startedOffQueue?: { expectedLayerId: L.LayerId },
) {
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
	const announcements: (() => Promise<void>)[] = []
	if (startedOffQueue) {
		announcements.push(async () => {
			const ctx = SquadServer.resolveCtx(getBaseCtx(), serverId)
			await SquadRcon.warnAllAdmins(ctx, LL_Msgs.matchStartedOffQueue(newLayerId, startedOffQueue.expectedLayerId))
		})
	}
	if (SETTINGS.remindersEnabled(ctx.serverSettings.settings)) {
		// what the registered providers have to say right now, then the standing announcements
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
	}

	if (announcements.length > 0) {
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

// Who made a layer change SLM is reconciling against. `unknown` covers a change SLM found rather than watched
// happen, such as the layer already set when SLM connects.
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

/** One entry of the saved queue, as `editSaved` presents it. */
export type QueueEntry = {
	itemId: string
	layerId: L.LayerId
	isVote: boolean
	/** the item came from layer generation rather than a person or the game server */
	generated: boolean
}

/**
 * Rewrites the saved queue. `mutate` gets the current entries and returns the ones it wants, in order: an
 * entry passed through keeps its original item, so its vote config, tags and notes survive, and a bare layer
 * id becomes a new item attributed to `userId`.
 *
 * Refuses when anyone has unsaved edits open rather than resetting over them. A caller that finds
 * `err:unsaved-edits` should say so and try again later; discarding an admin's draft is not its call.
 * While the queue waits on a generated layer, the edit waits for it to land and then applies.
 *
 * `source` is where the new items come from, and who the edit is attributed to. A manual source also names
 * the person on the ops themselves, which is what drives presence and the QUEUE_UPDATED actor; anything else
 * issues them with no user, since there is no person to name.
 */
export async function editSaved(
	ctx: SideEffectCtx,
	opts: { source: LL.Source },
	mutate: (entries: QueueEntry[]) => (QueueEntry | L.LayerId)[],
): Promise<{ code: 'ok' } | { code: 'err:unsaved-edits' } | { code: 'err:unknown-item'; itemId: string }> {
	return await retryAfterGeneration(ctx, () => editSavedNow(ctx, opts, mutate))
}

// Adds items to the saved queue at `placement` in one add op, and saves. Items `clear` accepts are removed by the same
// op, and `placement` is read against what remains. Refuses with `err:unsaved-edits` as editSaved does.
export async function addToSaved(
	ctx: SideEffectCtx,
	opts: { source: LL.Source; clear?: (item: LL.Item) => boolean },
	items: LL.NewItem[],
	placement: LL.Placement,
): Promise<{ code: 'ok' } | { code: 'err:unsaved-edits' }> {
	return await retryAfterGeneration(ctx, () => addToSavedNow(ctx, opts, items, placement))
}

// Resolves once nobody has unsaved queue edits open, straight away when nobody has. Rejects when ctx.signal aborts.
export async function editsSettled(ctx: LQ.Ctx & CS.AbortSignal): Promise<void> {
	await Rx.Ext.firstValueFrom(
		ctx.layerQueue.op$.pipe(
			Rx.startWith(null),
			Rx.filter(() => !SLL.hasMutations(ctx.layerQueue.session.state)),
		),
		ctx.signal,
	)
}

// a generation in flight would skip an edit, so the edit waits for it. Generation always ends in a
// queue-item-generated op, falling back to a default layer when it fails.
async function retryAfterGeneration<R extends { code: string }>(
	ctx: SideEffectCtx,
	attempt: () => Promise<R | { code: 'generating-queue-item' }>,
): Promise<Exclude<R, { code: 'generating-queue-item' }>> {
	while (true) {
		const res = await attempt()
		if (res.code !== 'generating-queue-item') return res as Exclude<R, { code: 'generating-queue-item' }>
		await Rx.Ext.firstValueFrom(
			ctx.layerQueue.op$.pipe(
				Rx.startWith(null),
				Rx.filter(() => !ctx.layerQueue.session.state.requestingGeneratedQueueItem),
			),
			ctx.signal,
		)
	}
}

const addToSavedNow = Instr.spanOp(
	'addToSavedNow',
	{ module, mutexes: (ctx) => [ctx.layerQueue.updateLayerMtx, ctx.matchHistory.mtx] },
	async (
		ctx: SideEffectCtx,
		opts: { source: LL.Source; clear?: (item: LL.Item) => boolean },
		items: LL.NewItem[],
		placement: LL.Placement,
	): Promise<{ code: 'ok' } | { code: 'err:unsaved-edits' } | { code: 'generating-queue-item' }> => {
		const state = () => ctx.layerQueue.session.state
		if (SLL.hasMutations(state())) return { code: 'err:unsaved-edits' }
		if (state().requestingGeneratedQueueItem) return { code: 'generating-queue-item' }
		const userId = opts.source.type === 'manual' ? opts.source.userId : undefined
		const opBase = () => ({ opId: SLL.createOpId(), userId, source: opts.source, editWindowSeqId: state().editWindowSeqId })
		const cleared = opts.clear
			? state()
					.list.filter(opts.clear)
					.map((item) => item.itemId)
			: []
		const remaining = cleared.length > 0 ? state().list.filter((item) => !cleared.includes(item.itemId)) : state().list
		const target = LL.placementTarget(remaining, placement)
		await dispatchOp(ctx, {
			op: 'add',
			items: items.map((item) => LL.createItem(item, opts.source)),
			index: target.index,
			clearItemIds: [...cleared, ...(target.clearItemIds ?? [])],
			...opBase(),
		})
		await dispatchOp(ctx, { op: 'save', ...opBase() })
		return { code: 'ok' }
	},
)

// Holds dispatchOp's locks across the read and all three ops, so nothing lands between them. Another op could move
// the edit window, or a generation could start, and either would silently skip the rest of the edit. A generation
// already in flight skips it too, so that is reported rather than attempted.
const editSavedNow = Instr.spanOp(
	'editSavedNow',
	{ module, mutexes: (ctx) => [ctx.layerQueue.updateLayerMtx, ctx.matchHistory.mtx] },
	async (
		ctx: SideEffectCtx,
		opts: { source: LL.Source },
		mutate: (entries: QueueEntry[]) => (QueueEntry | L.LayerId)[],
	): Promise<
		{ code: 'ok' } | { code: 'err:unsaved-edits' } | { code: 'err:unknown-item'; itemId: string } | { code: 'generating-queue-item' }
	> => {
		const state = () => ctx.layerQueue.session.state
		if (SLL.hasMutations(state())) return { code: 'err:unsaved-edits' }
		if (state().requestingGeneratedQueueItem) return { code: 'generating-queue-item' }

		const byItemId = new Map(state().savedList.map((item) => [item.itemId, item]))
		const entries: QueueEntry[] = state().savedList.map((item) => ({
			itemId: item.itemId,
			layerId: item.layerId,
			isVote: item.type === 'vote-list-item',
			generated: LL.isGeneratedSource(item.source),
		}))

		const next: LL.Item[] = []
		for (const entry of mutate(entries)) {
			if (typeof entry !== 'object') {
				next.push(LL.createItem({ type: 'single-list-item', layerId: entry }, opts.source))
				continue
			}
			const existing = byItemId.get(entry.itemId)
			if (!existing) return { code: 'err:unknown-item', itemId: entry.itemId }
			next.push(existing)
		}

		// save/reset bump editWindowSeqId, so every op reads it fresh; a stale value silently skips the op. The
		// ops carry no userId: a manual source names the person, and nothing else here is a person.
		const userId = opts.source.type === 'manual' ? opts.source.userId : undefined
		const opBase = () => ({ opId: SLL.createOpId(), userId, source: opts.source, editWindowSeqId: state().editWindowSeqId })
		const itemIds = state().list.map((item) => item.itemId)
		if (itemIds.length > 0) await dispatchOp(ctx, { op: 'clear', itemIds, ...opBase() })
		if (next.length > 0) {
			await dispatchOp(ctx, { op: 'add', items: next, index: { outerIndex: 0, innerIndex: null }, ...opBase() })
		}
		await dispatchOp(ctx, { op: 'save', ...opBase() })
		return { code: 'ok' }
	},
)

export async function saveQueueAndUpdateServer(
	ctx: C.Db & LQ.Ctx & SQS.Ctx & V.Ctx & MH.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
	list: LL.List,
	// the list this save replaces. Every next-layer change reaches the server through here -- an SLM edit, a roll, or
	// adopting a layer someone set outside SLM -- so comparing the two heads is what tells admins the layer moved.
	prevList: LL.List,
	// the QUEUE_UPDATED for this save; the resulting MAP_SET app event (if the next layer changed) links back to it
	queueUpdatedId?: string,
) {
	await Vote.syncVoteStateWithQueueState(ctx, list)
	const nextItemId = list[0]?.itemId || null
	const nextLayerId = LL.getNextLayerId(list)
	const prevNextLayerId = LL.getNextLayerId(prevList)
	const nextLayerChanged = !!nextLayerId && (!prevNextLayerId || !L.areLayersCompatible(prevNextLayerId, nextLayerId))
	const serverState = DB.transaction(ctx, {}, (txCtx) => {
		const { settings } = SquadServer.getServerState(txCtx)
		SquadServer.updateServerState(txCtx, { layerQueue: list }, { type: 'system', event: 'admin-change-layer' })
		return { code: 'ok' as const, settings }
	})

	const syncToServer = async () => {
		if (nextLayerId && nextItemId) {
			await syncNextLayerToServer(
				ctx,
				serverState.settings,
				nextLayerId,
				nextItemId,
				queueUpdatedId ? { reason: 'queue-updated', causeId: queueUpdatedId } : undefined,
			)
		} else {
			log.error('No next layer to sync to server')
		}
		// after the sync, so the warn names the layer now set rather than the one it replaced. A change SLM overrides
		// never gets here: the override sets the layer back directly instead of saving, and warns through warnOverridden.
		// gated on the same settings the sync read, so the warn fires only when the layer it names really was set.
		if (ctx.serverSettings.settings.warnOnNextLayerChange && nextLayerChanged && !serverState.settings.updatesToSquadServerDisabled) {
			await warnShowNext(ctx, 'all-admins', { updated: true })
		}
	}
	// while a roll is being recorded, the roll runs the sync once it has released its locks
	const deferredServerSyncs = ctx.layerQueue.deferredServerSyncs
	if (deferredServerSyncs) deferredServerSyncs.push(syncToServer)
	else await syncToServer()

	return { code: 'ok' as const }
}

// Draws the next queue item and applies it. Split out of handleSideEffect because a map roll defers it past that
// transaction's commit, where it would otherwise run untraced.
const generateAndDispatchQueueItem = Instr.spanOp(
	'generateAndDispatchQueueItem',
	{ module, levels: { event: 'info' } },
	async (ctx: SideEffectCtx) => {
		const serverState = SquadServer.getServerState(ctx)
		const constraints = SETTINGS.getSettingsConstraints(serverState.settings, Settings.repeatRulesFor(serverState.settings), {
			generatingLayers: true,
		})
		const layerCtx = await LayerQueries.resolveLayerQueryCtx(ctx)
		const list = await LayerQueries.resolveLayerItemsState(ctx)
		const templates = ctx.layerQueue.session.state.savedBackburner.map((item) => ({ itemId: item.itemId, filter: item.filter }))
		const generateVotes = serverState.settings.queue.mainPool.generateVotes

		// a layer request outranks a vote: the requested layer is queued on its own
		let generated = templates.length > 0 || !generateVotes.enabled ? await generateLayer(layerCtx, constraints, templates, list) : null
		let nextQueueItem: LL.Item | null = null
		let problems: LQY.ConstraintProblem[] = []
		if (generateVotes.enabled && !generated?.consumedItemIds.length) {
			const vote = await generateVoteChoices(layerCtx, constraints, list)
			if (vote.layerIds.length >= 2) {
				// the map is the one thing the choices are certain to differ by, so it is always shown
				const displayProps = Array.from(new Set<DH.LayerDisplayProp>(['map', ...generateVotes.displayProps]))
				nextQueueItem = LL.createVoteItem(vote.layerIds, { type: 'generated' }, { displayProps })
				problems = vote.problems
			} else {
				log.warn('only %d map(s) available for a generated vote, generating a single layer instead', vote.layerIds.length)
			}
		}

		let consumedBackburnerItemIds: string[] | undefined
		if (!nextQueueItem) {
			generated ??= await generateLayer(layerCtx, constraints, templates, list)
			const requesters: USR.GuiOrChatUserId[] = []
			for (const item of ctx.layerQueue.session.state.savedBackburner) {
				if (!generated.consumedItemIds.includes(item.itemId)) continue
				if (requesters.some((r) => BB.sameOwner(r, item.source))) continue
				requesters.push(item.source)
			}
			const source: LL.Source = requesters.length > 0 ? { type: 'layer-request', requesters } : { type: 'generated' }
			nextQueueItem = LL.createItem({ type: 'single-list-item', layerId: generated.layerId }, source)
			if (generated.consumedItemIds.length > 0) consumedBackburnerItemIds = generated.consumedItemIds
			problems = generated.problems
		}
		await dispatchOp(ctx, {
			op: 'queue-item-generated',
			item: nextQueueItem,
			consumedBackburnerItemIds,
			opId: SLL.createOpId(),
		})
		// a constraint that only marks layers, or a miss exemption that exempts nothing, left the draw as it was
		const skipped = FPM.appliedProblems(problems, constraints)
		if (skipped.length > 0) await reportGeneratedWithoutFilters(ctx, nextQueueItem, skipped)
	},
)

// Records a generation that left out configured filters because they cannot be applied: a log line, an entry in the
// server's activity feed, and one warn to the admins in game.
async function reportGeneratedWithoutFilters(ctx: SideEffectCtx, item: LL.Item, problems: LQY.ConstraintProblem[]) {
	const vote = LL.isVoteItem(item)
	const layerIds = vote ? item.choices.map((choice) => choice.layerId) : [item.layerId]
	const skipped = skippedFilters(problems)
	log.warn(
		{ [ATTRS.SquadServer.ID]: ctx.serverId },
		'generated %s without filters that cannot be applied:\n%s',
		layerIds.join(', '),
		describeProblems(problems),
	)
	await SquadServerActions.emitAppEvent(
		ctx,
		AppEvents.create<AppEvents.LayerGeneratedWithoutFilters>({
			type: 'LAYER_GENERATED_WITHOUT_FILTERS',
			actor: { type: 'system' },
			serverId: ctx.serverId,
			matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
			causeId: null,
			layerIds,
			vote,
			queueItemId: item.itemId,
			skipped,
		}),
	)
	// detached: a roll can generate while it holds the queue's locks, and the warn is a round trip per admin. The
	// generation may have been started by a request, so the warn lives as long as the server rather than the request.
	SquadRcon.warnAllAdmins(
		{ ...ctx, signal: SquadServer.require(ctx.serverId).signal },
		LL_Msgs.generatedWithoutFilters(vote, skippedFilterNames(problems)),
	).catch((err: unknown) => {
		if (!Prom.isAbortError(err)) log.error(err)
	})
}

// the configured filters a query left out, one entry per constraint
function skippedFilters(problems: LQY.ConstraintProblem[]): AppEvents.LayerGeneratedWithoutFilters['skipped'] {
	const byConstraint = new Map<string, AppEvents.LayerGeneratedWithoutFilters['skipped'][number]>()
	for (const problem of problems) {
		let entry = byConstraint.get(problem.constraintId)
		if (!entry) {
			entry = {
				constraintId: problem.constraintId,
				constraintType: problem.constraintType,
				filterId: problem.filterId,
				filterName: problem.filterId ? backburnerFilterName(problem.filterId) : undefined,
				errors: [],
			}
			byConstraint.set(problem.constraintId, entry)
		}
		entry.errors.push(...problem.errors.map(AppEvents.toFilterNodeProblem))
	}
	return [...byConstraint.values()]
}

function skippedFilterNames(problems: LQY.ConstraintProblem[]): string[] {
	return [...new Set(skippedFilters(problems).map((s) => s.filterName ?? s.filterId ?? s.constraintId))]
}

function describeProblems(problems: LQY.ConstraintProblem[]): string {
	return problems
		.flatMap((problem) => problem.errors.map((error) => `${problem.constraintId}: ${F.describeNodeValidationError(error)}`))
		.join('\n')
}

// Draws a single layer, folding in whatever backburner templates fit. A configured filter that cannot be applied is
// left out of the draw and reported in `problems`. Falls back to dropping the repeat rules, and then to
// L.defaultLayerId(), rather than leave the queue empty.
async function generateLayer(
	layerCtx: LQY.Ctx,
	constraints: LQY.Constraint[],
	templates: LayerQueriesShared.BackburnerTemplate[],
	list: LQY.LayerItemsState,
): Promise<{ layerId: L.LayerId; consumedItemIds: string[]; problems: LQY.ConstraintProblem[] }> {
	const fallback = { layerId: L.defaultLayerId(), consumedItemIds: [] as string[], problems: [] }
	try {
		const res = await LayerQueriesShared.generateWithBackburner({
			ctx: layerCtx,
			input: { constraints, templates, list, cursor: { type: 'start' }, action: 'add', seed: LQY.getSeed() },
		})
		for (const [itemId, errors] of Object.entries(res.templateErrors)) {
			log.warn(
				'layer request %s cannot be applied and was skipped:\n%s',
				itemId,
				errors.map((error) => F.describeNodeValidationError(error)).join('\n'),
			)
		}
		if (res.layer) return { layerId: res.layer.id, consumedItemIds: res.consumedItemIds, problems: res.problems }
		const noDnrConstraints = constraints.filter((c) => c.type !== 'do-not-repeat')
		if (noDnrConstraints.length < constraints.length) {
			log.info('no layers found with do-not-repeat constraints applied, retrying without')
			return await generateLayer(layerCtx, noDnrConstraints, templates, list)
		}
		log.warn(`No layers found for constraints: %o`, { constraints })
		return fallback
	} catch (e) {
		log.error(e, 'Error generating layer')
		return fallback
	}
}

// Draws up to V.DEFAULT_NUM_CHOICES layers, each on a different map. Unlike generateLayer it never drops the repeat
// rules, so it can return fewer choices than asked for.
async function generateVoteChoices(
	layerCtx: LQY.Ctx,
	constraints: LQY.Constraint[],
	list: LQY.LayerItemsState,
): Promise<{ layerIds: L.LayerId[]; problems: LQY.ConstraintProblem[] }> {
	try {
		const res = await LayerQueriesShared.genVote({
			ctx: layerCtx,
			input: {
				constraints,
				list,
				cursor: { type: 'start' },
				action: 'add',
				choices: Array.from({ length: V.DEFAULT_NUM_CHOICES }, () => V.GenVote.initChoice()),
				uniqueConstraints: ['Map'],
				seed: LQY.getSeed(),
			},
		})
		if (res.code !== 'ok') {
			log.error(`Invalid choices when generating vote: %o`, { cause: res.choices })
			return { layerIds: [], problems: [] }
		}
		return { layerIds: res.chosenLayers.flatMap((layer) => (layer ? [layer.id] : [])), problems: res.problems }
	} catch (e) {
		log.error(e, 'Error generating vote')
		return { layerIds: [], problems: [] }
	}
}

// What the queue head breaks, as the layer table's own warning indicators would show it: the repeat rules it
// violates, the pool filters it misses, and the configured filters it could not be checked against because they
// cannot be applied. Undefined when there is nothing to report, so a caller can drop the whole section rather than
// render an empty one.
async function nextLayerViolations(ctx: C.Db & SQS.Ctx & LQ.Ctx & MH.Ctx & SETTINGS.Ctx & CS.AbortSignal) {
	const head = getSavedQueue(ctx)[0]
	if (!head) return undefined
	const serverState = SquadServer.getServerState(ctx)
	const allConstraints = SETTINGS.getSettingsConstraints(serverState.settings, Settings.repeatRulesFor(serverState.settings), {
		generatingLayers: false,
	})
	// statuses need the engine, so the query ctx is only resolved once there is a head to report on
	const queryCtx = await LayerQueries.resolveLayerQueryCtx(ctx)
	const statusRes = await LayerQueriesShared.getLayerItemStatuses({
		ctx: queryCtx,
		input: {
			constraints: allConstraints,
			skipWarningsForTags: serverState.settings.queue.mainPool.skipWarningsForTags,
			list: await LayerQueries.resolveLayerItemsState(ctx),
		},
	})
	// a vote warns through its choices, so report the choice the vote currently resolves to
	const headItemId = LL.isVoteItem(head) ? head.choices.find((c) => c.layerId === head.layerId)?.itemId : head.itemId
	const warns = statusRes.statuses.warns.filter((w) => w.itemId === headItemId)
	// the filters whose warnings could not be raised. One that only marks layers raises none to miss.
	const unchecked = statusRes.statuses.problems.filter((problem) => {
		if (problem.part !== 'filter') return false
		const constraint = allConstraints.find((c) => c.id === problem.constraintId)
		return constraint?.type === 'filter-entity' && constraint.warn !== 'disabled'
	})
	const uncheckedFilters = skippedFilterNames(unchecked)
	if (warns.length === 0 && uncheckedFilters.length === 0) return undefined
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
	const unsupportedMods = [...new Set(warns.filter((w) => w.type === 'unsupported-mod-warning').map((w) => w.collection))]
	return { repeatViolations, poolViolations, unsupportedMods, uncheckedFilters }
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
		const user = Users.getDbUser(ctx, userId)
		if (user) setByUser = await Users.buildUser(user)
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
// Holds updateLayerMtx alone across its round trips. It must not take matchHistory.mtx, even nested: that mutex
// gates every getCurrentMatch caller, and acquiring it under updateLayerMtx deadlocks against onNewGameDuringRoll,
// which takes the two together.
export const syncNextLayerToServer = Instr.spanOp(
	'syncNextLayerToServer',
	{ module, mutexes: (ctx) => [ctx.layerQueue.updateLayerMtx] },
	async (
		ctx: SQS.Ctx & SR.Ctx.Rcon & LQ.Ctx & C.Db & MH.Ctx & CS.AbortSignal,
		settings: SETTINGS.ServerSettings,
		nextQueuedLayerId: L.LayerId,
		itemId: string,
		// why SLM is setting the layer. queue-driven sets fold into their QUEUE_UPDATED (audit-only MAP_SET); override sets
		// react to a non-SLM set and get a feed entry. absent -> no MAP_SET app event (still attributes the server event).
		mapSetCause?:
			| { reason: 'queue-updated'; causeId: string }
			| { reason: 'override'; overrode?: AppEvents.MapSet['overrode']; overrodeEventId?: number },
	) => {
		const syncState$ = ctx.layerQueue.nextLayerSyncState$
		if (settings.updatesToSquadServerDisabled) {
			syncState$.next({ code: 'disabled' })
			return
		}
		// an override reacts to a set-next the cached status can predate, which would read as already synced. Only the
		// override pays for the fresh read: an extra round trip on every sync delays the roster poll across a roll.
		if (mapSetCause?.reason === 'override') ctx.squadRcon.layersStatus.invalidate(ctx)
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
		// Queued ahead of the command, so it is in place before the MAP_SET the command logs is processed. Only an
		// attribution whose app event is already written can go first: an override's MAP_SET app event is written
		// once the set has succeeded, and the server event that links to it must not land before it.
		const attributeAhead = mapSetCause?.reason !== 'override'
		const logAttributionError = (err: unknown) => {
			if (!Prom.isAbortError(err)) log.error(err)
		}
		if (attributeAhead) {
			// detached: awaiting it under updateLayerMtx deadlocks against a roll waiting on that mutex
			SquadServerIngest.pushAttribution(ctx, {
				type: 'MAP_SET_ATTRIBUTION',
				itemId,
				layerId: nextQueuedLayerId,
				appEventId: mapSetCause?.reason === 'queue-updated' ? mapSetCause.causeId : undefined,
			}).catch(logAttributionError)
		}
		let res: Awaited<ReturnType<typeof SquadRcon.setNextLayer>>
		try {
			res = await SquadRcon.setNextLayer(ctx, nextQueuedLayerId)
		} catch (err) {
			if (attributeAhead) SquadServerIngest.withdrawAttribution(ctx, itemId, nextQueuedLayerId).catch(logAttributionError)
			throw err
		}
		// we do this so we can stay in this async context so we hold on to the mutex that we acquired
		switch (res.code) {
			case 'err:unable-to-set-next-layer':
				syncState$.next({ code: 'err:refused', actualLayerId: res.unexpectedLayerId })
				if (attributeAhead) SquadServerIngest.withdrawAttribution(ctx, itemId, nextQueuedLayerId).catch(logAttributionError)
				break
			case 'err:rcon':
				syncState$.next({ code: 'err:rcon' })
				// the command may still have landed
				if (!attributeAhead) {
					SquadServerIngest.pushAttribution(ctx, { type: 'MAP_SET_ATTRIBUTION', itemId, layerId: nextQueuedLayerId }).catch(
						logAttributionError,
					)
				}
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
						overrodeEventId: mapSetCause.reason === 'override' ? mapSetCause.overrodeEventId : undefined,
						itemId,
						actor: { type: 'system' },
						serverId: ctx.serverId,
						// no current match yet on a freshly-registered server (first sync hasn't run)
						matchId: MatchHistory.peekCurrentMatch(ctx)?.historyEntryId ?? null,
						causeId: mapSetCause.reason === 'queue-updated' ? mapSetCause.causeId : null,
					})
					if (AppEvents.isFeedVisible(mapSet)) await SquadServerActions.emitAppEvent(ctx, mapSet)
					else AppEventsSys.persistAppEvent(ctx, mapSet)
					// attribute to whichever app event reaches the feed, since that's what the server event collapses into:
					// the QUEUE_UPDATED for a queue-driven set (its MAP_SET is audit-only), the MAP_SET itself for an override.
					// the audit-only MAP_SET stays reachable from the QUEUE_UPDATED via its causeId.
					mapSetAppEventId = mapSetCause.reason === 'queue-updated' ? mapSetCause.causeId : mapSet.id
				}
				if (!attributeAhead) {
					SquadServerIngest.pushAttribution(ctx, {
						type: 'MAP_SET_ATTRIBUTION',
						itemId,
						layerId: nextQueuedLayerId,
						appEventId: mapSetAppEventId,
					}).catch(logAttributionError)
				}
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
	const serverState = SquadServer.getServerState(ctx)
	if (serverState.settings.updatesToSquadServerDisabled) return false
	return !!getSavedQueue(ctx)[0]?.layerId
}

// How long the server's next layer may stay off the queue head before SLM puts it back. A logged set-next reaches the
// MAP_SET handler within a few seconds, so this only fires for changes that path missed. Doubles after each attempt
// that does not stick, up to 2^RESYNC_HEAD_MAX_BACKOFF_EXP times, so SLM does not fight something in a tight loop.
const RESYNC_HEAD_GRACE_MS = 20_000
const RESYNC_HEAD_MAX_BACKOFF_EXP = 5

function headResyncAllowed(ctx: SQS.Ctx & LQ.Ctx & SETTINGS.Ctx) {
	return (
		!ctx.server.serverRolling$.value &&
		!ctx.serverSettings.settings.updatesToSquadServerDisabled &&
		!ctx.layerQueue.ingameVote$.getValue() &&
		ctx.layerQueue.mapSetsAwaitingSync === 0 &&
		ctx.layerQueue.nextLayerSyncState$.value.code !== 'syncing'
	)
}

// Called under updateLayerMtx, so a write queued behind it has landed and the fresh read below sees it.
async function resyncHeadIfOff(ctx: SideEffectCtx) {
	if (!headResyncAllowed(ctx)) return
	ctx.squadRcon.layersStatus.invalidate(ctx)
	const status = await ctx.squadRcon.layersStatus.get(ctx)
	if (status.code !== 'ok' || !status.data.nextLayer) return
	const serverLayerId = status.data.nextLayer.id
	const queue = getSavedQueue(ctx)
	const head = LL.getNextLayerId(queue)
	if (!head || L.areLayersCompatible(serverLayerId, head)) return

	const settings = SquadServer.getServerState(ctx).settings
	// a refused write left the server on a layer SLM failed to replace, not one somebody chose, so it is retried
	// rather than adopted
	const refused = ctx.layerQueue.nextLayerSyncState$.value.code === 'err:refused'
	if (refused) {
		log.info('retrying the refused write of %s as the next layer', head)
		await syncNextLayerToServer(ctx, settings, head, queue[0].itemId)
		return
	}
	if (settings.overrideAdminSetNextLayer) {
		log.info('server next layer %s is off the queue head %s, setting it back', serverLayerId, head)
		await syncNextLayerToServer(ctx, settings, head, queue[0].itemId, { reason: 'override', overrode: { type: 'unknown' } })
		await warnOverridden(ctx, undefined, serverLayerId, head)
		return
	}
	log.info('server next layer %s is off the queue head %s, adopting it into the queue', serverLayerId, head)
	await dispatchOp(ctx, {
		opId: SLL.createOpId(),
		op: 'unshift-first-saved-layer',
		itemId: LL.createItemId(),
		itemSource: { type: 'unknown' },
		layerId: serverLayerId,
		externalSource: { type: 'unknown' },
	})
}

// Every admin is told, not only the one who set the layer: a console or RCON set-next is invisible to the others, who
// otherwise see the next layer change twice with no explanation. Sent only once the override has landed, so the warn
// never names a layer the server does not have.
async function warnOverridden(
	ctx: SQS.Ctx & SR.Ctx.Rcon & LQ.Ctx & CS.AbortSignal & Msgs.Ctx,
	setBy: string | undefined,
	setLayerId: L.LayerId,
	queueLayerId: L.LayerId,
) {
	if (ctx.layerQueue.nextLayerSyncState$.value.code !== 'synced') return
	await SquadRcon.warnAllAdmins(ctx, LL_Msgs.nextLayerOverridden(setLayerId, queueLayerId, setBy))
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
	const { turnedIngameVotingOff } = DB.transaction(ctx, {}, (ctx) => {
		const serverState = SquadServer.getServerState(ctx)
		// Re-enabling while a vote is the reason has to turn the vote off too, or SLM goes straight back to setting a
		// next layer the vote will overwrite -- the fight that standing down avoided in the first place.
		const turnedIngameVotingOff = !input.disabled && serverState.settings.updatesToSquadServerDisabled?.type === 'ingame-vote'
		serverState.settings.updatesToSquadServerDisabled = input.disabled
		Settings.updateServerSettings(ctx, serverState.settings, {
			type: 'system',
			event: byVote ? 'ingame-vote-detected' : 'updates-to-squad-server-toggled',
		})
		return { code: 'ok' as const, turnedIngameVotingOff }
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
	const serverState = SquadServer.getServerState(ctx)
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
	return C.initMutexStore(DB.withDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }))
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
		// a client's ops apply in the order it sent them, however long each one's checks below take
		.handler(({ context: _ctx, input: { serverId, op } }) =>
			clientOpLanes(`${serverId}:${_ctx.wsClientId}`, async () => {
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

				if (!SLL.isClientOp(op)) return { code: 'err:invalid-op' as const, msg: `${op.op} is server-only` }

				let skippedRequestFilters: string[] = []
				// the client applied the op as it sent it, so a corrected op is echoed back for it to replay instead
				let opCorrected = false
				if (SLL.isBackburnerOp(op)) {
					const backburnerRes = await checkBackburnerDraftOp(ctx, op)
					if (backburnerRes.code !== 'ok') return backburnerRes
					opCorrected = backburnerRes.op !== op
					op = backburnerRes.op
					skippedRequestFilters = backburnerRes.skippedRequestFilters
				} else {
					const authRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write', { serverId: ctx.serverId }))
					if (authRes) return authRes
					const noteRes = await tryDenyNoteOp(ctx, op)
					if (noteRes) return noteRes
				}

				// Two checks on the layers an op introduces, in order of severity. A layer whose mod the server does not
				// have cannot load at all, so it is refused outright, no permission involved. Being out of the configured
				// pool is a policy call, and additionally requires queue:force-write -- checked only when the user lacks
				// it, to keep the common path cheap.
				const forceWriteCandidates = getForceWriteCandidateLayerIds(ctx.layerQueue.session.state, op)
				if (forceWriteCandidates.length > 0) {
					const serverState = SquadServer.getServerState(ctx)
					const { installedMods } = serverState.settings
					const unsupported = forceWriteCandidates.filter((layerId) => {
						const collection = L.toLayer(layerId).Collection
						return !!collection && !installedMods.includes(collection)
					})
					if (unsupported.length > 0) {
						return {
							code: 'err:mods-not-installed' as const,
							layerIds: unsupported,
							msg: `This server does not have the mods these layers need: ${unsupported.join(', ')}`,
						}
					}

					const forceWriteDenied = await Rbac.tryDenyPermissionsForUser(
						ctx,
						RBAC.perm('queue:force-write', { serverId: ctx.serverId }),
					)
					if (forceWriteDenied) {
						const poolConstraints = SETTINGS.getPoolMembershipConstraints(serverState.settings)
						const layerCtx = await LayerQueries.resolveLayerQueryCtx(ctx)
						const poolRes = await LayerQueriesShared.getLayersOutOfPool({
							ctx: layerCtx,
							input: { layerIds: forceWriteCandidates, constraints: poolConstraints },
						})
						// a pool filter that cannot be applied admits every layer, so it never blocks a queue edit
						if (poolRes.problems.length > 0) {
							log.warn(
								{ [ATTRS.SquadServer.ID]: ctx.serverId },
								'force-write pool check skipped filters that cannot be applied:\n%s',
								describeProblems(poolRes.problems),
							)
						}
						if (poolRes.outOfPool.length > 0) return forceWriteDenied
					}
				}

				// The op joins the shared session here, so what it sets off runs for the life of the server rather than of
				// this request. A save that its client left mid-way would otherwise never send save-completed, and the queue
				// would stay saving for every admin.
				const serverCtx = SquadServer.resolveCtx({ ...ctx, signal: CleanupSys.shutdownSignal }, serverId)
				await dispatchOp(serverCtx, op, { sourceWsClientId: _ctx.wsClientId, echoToSource: opCorrected })

				if (skippedRequestFilters.length === 0) return { code: 'ok' as const }
				return {
					code: 'ok' as const,
					skippedRequestFilters,
					msg: ctx.tr.text(BB_Msgs.requestFiltersSkipped(skippedRequestFilters)),
				}
			}),
		),
}

const clientOpLanes = OrderedLanes.create()

type TemplateCheck = { code: 'ok' } | { code: 'err:no-solutions' } | { code: 'err:invalid-filter'; errors: F.NodeValidationError[] }

// Whether a layer request template has any solutions, or cannot be applied at all. Filters ride in the template
// itself (see BB.withFilters), and do-not-repeat constraints are deliberately excluded: they are transient, and a
// request that is only blocked until the next match shouldn't be rejected outright.
async function checkTemplate(ctx: C.Db & MH.Ctx & LQ.Ctx & SETTINGS.Ctx & CS.AbortSignal, filter: F.FilterNode): Promise<TemplateCheck> {
	const layerCtx = await LayerQueries.resolveLayerQueryCtx(ctx)
	const res = await LayerQueriesShared.checkBackburnerTemplates({
		ctx: layerCtx,
		input: {
			// a request only this server's missing mods could satisfy has no solutions here either
			constraints: [SETTINGS.getInstalledModsConstraint(ctx.serverSettings.settings)],
			templates: [{ itemId: 'probe', filter }],
		},
	})
	if (res.problems.length > 0) {
		log.warn(
			{ [ATTRS.SquadServer.ID]: ctx.serverId },
			'layer request check skipped constraints that cannot be applied:\n%s',
			describeProblems(res.problems),
		)
	}
	const errors = res.invalid['probe']
	if (errors) return { code: 'err:invalid-filter', errors }
	return res.satisfiable['probe'] ? { code: 'ok' } : { code: 'err:no-solutions' }
}

// The template without the server's layer request filters that cannot be applied, so a broken setting does not
// block requests. `skipped` names the filters taken out.
function dropUnappliableRequestFilters(ctx: C.Db & C.ManagedServer, filter: F.FilterNode): { filter: F.FilterNode; skipped: string[] } {
	const requestFilterIds = SquadServer.getServerState(ctx).settings.queue.mainPool.layerRequestFilters.map((f) => f.filterId)
	if (requestFilterIds.length === 0) return { filter, skipped: [] }
	const parts = BB.parseTemplateParts(filter)
	const applied = requestFilterIds.filter((id) => parts.filterIds.includes(id) || parts.excludedFilterIds.includes(id))
	if (applied.length === 0) return { filter, skipped: [] }
	const lower = LayerQueriesShared.lowerCtx({
		...CS.init(),
		engine: LayerEngine.requireEngine(),
		filters: FilterEntity.state.filters,
		effectiveColsConfig: LC.getEffectiveColumnConfig(),
	})
	const broken = applied.filter((id) => LE.lowerFilterEntity(lower, id).code !== 'ok')
	if (broken.length === 0) return { filter, skipped: [] }
	log.warn(
		{ [ATTRS.SquadServer.ID]: ctx.serverId },
		'layer request filters %s cannot be applied and were left out of a request',
		broken.join(', '),
	)
	parts.filterIds = parts.filterIds.filter((id) => !broken.includes(id))
	parts.excludedFilterIds = parts.excludedFilterIds.filter((id) => !broken.includes(id))
	return { filter: BB.buildTemplateFilter(parts), skipped: broken.map((id) => backburnerFilterName(id) ?? id) }
}

// the stored filters that make a template impossible to apply, named. Empty when the problem is in the template's own
// conditions
function unappliableFilterNames(errors: F.NodeValidationError[]): string[] {
	const ids = new Set<string>()
	for (const error of errors) {
		const id = error.via[0] ?? error.ownerFilterId ?? (error.type === 'unknown-filter' ? error.filterId : null)
		if (id) ids.add(id)
	}
	return [...ids].map((id) => backburnerFilterName(id) ?? id)
}

function invalidRequestResult(ctx: Msgs.Ctx, errors: F.NodeValidationError[]) {
	return {
		code: 'err:invalid-filter' as const,
		msg: ctx.tr.text(BB_Msgs.requestCannotBeApplied(unappliableFilterNames(errors))),
		errors,
	}
}

// writing a note only needs queue:write, which the caller has already established. Rewording or dropping someone
// else's is what the manage-all grant is for.
async function tryDenyNoteOp(ctx: C.Db & C.ManagedServer & USR.Ctx.Id & CS.AbortSignal, op: SLL.Operation) {
	if (op.op === 'add') {
		// a note may arrive with a new item only as an anonymous copy of a rotation's note, so nobody can file one in
		// someone else's name
		const notes = op.items
			.flatMap((item) => (item.type === 'single-list-item' ? [item] : item.choices))
			.flatMap((item) => item.notes ?? [])
		if (notes.some((note) => !LNote.isRotationNote(note)))
			return { code: 'err:invalid-op' as const, msg: 'New items can only carry notes copied from a rotation' }
		return
	}
	if (op.op !== 'edit-note' && op.op !== 'delete-note') return
	const note = LL.findNote(ctx.layerQueue.session.state.list, op.itemId, op.noteId)
	// a note that isn't there is left to the reducer, which no-ops on it
	if (!note || LNote.isAuthor(note, ctx.user.discordId)) return
	return await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:manage-all-notes', { serverId: ctx.serverId }))
}

type BackburnerDraftOp = Exclude<Extract<SLL.Operation, { op: `backburner-${string}` }>, { op: 'backburner-write-saved' }>

// per-op authorization + validation for backburner draft ops arriving over the RPC. Own items need any
// queue:request-layers grant; touching someone else's item needs queue:write. Adds/updates/combines are
// probed for satisfiability so an impossible template can't enter the backburner. An add or update loses the layer
// request filters that cannot be applied, so `op` is the op to dispatch, which may differ from the one sent.
async function checkBackburnerDraftOp(ctx: C.Db & C.ManagedServer & USR.Ctx.Id & CS.AbortSignal & Msgs.Ctx, op: BackburnerDraftOp) {
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
		: RBAC.Req.any(RBAC.perm('queue:write', { serverId: ctx.serverId }), RBAC.Req.layerRequest(ctx.serverId))
	const authRes = await Rbac.tryDenyPermissionsForUser(ctx, authReq)
	if (authRes) return authRes

	const noSolutions = { code: 'err:no-solutions' as const, msg: 'No layers in the current pool match this request' }
	switch (op.op) {
		case 'backburner-add': {
			if (!BB.sameOwner(op.item.source, owner)) {
				return { code: 'err:invalid-source' as const, msg: 'Layer requests must be added under your own account' }
			}
			const capRes = await checkBackburnerCaps(ctx, owner)
			if (capRes) return capRes
			const dropped = dropUnappliableRequestFilters(ctx, op.item.filter)
			const check = await checkTemplate(ctx, dropped.filter)
			if (check.code === 'err:invalid-filter') return invalidRequestResult(ctx, check.errors)
			if (check.code === 'err:no-solutions') return noSolutions
			if (dropped.skipped.length === 0) break
			return { code: 'ok' as const, op: { ...op, item: { ...op.item, filter: dropped.filter } }, skippedRequestFilters: dropped.skipped }
		}
		case 'backburner-update': {
			const dropped = dropUnappliableRequestFilters(ctx, op.filter)
			const check = await checkTemplate(ctx, dropped.filter)
			if (check.code === 'err:invalid-filter') return invalidRequestResult(ctx, check.errors)
			if (check.code === 'err:no-solutions') return noSolutions
			if (dropped.skipped.length === 0) break
			return { code: 'ok' as const, op: { ...op, filter: dropped.filter }, skippedRequestFilters: dropped.skipped }
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
			// the reducer merges the stored templates as they are, so a filter that cannot be applied stays in the result
			const check = await checkTemplate(ctx, merged.filter)
			if (check.code === 'err:invalid-filter') return invalidRequestResult(ctx, check.errors)
			if (check.code === 'err:no-solutions') return { code: 'err:not-combinable' as const, msg: 'No layers match the combined request' }
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
	return { code: 'ok' as const, op, skippedRequestFilters: [] as string[] }
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
	const serverState = SquadServer.getServerState(ctx)
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
	// skippedRequestFilters names the layer request filters left out because they cannot be applied
	| { code: 'ok'; item: BB.BackburnerItem; evicted: BB.BackburnerItem[]; skippedRequestFilters: string[] }
	| { code: 'err:no-solutions'; msg: string }
	| { code: 'err:invalid-filter'; msg: string; errors: F.NodeValidationError[] }
	| { code: 'err:backburner-full'; max: number }
	| RBAC.PermissionDeniedResponse

// the chat path (/reqlayer): commits straight to the saved backburner, evicting the owner's oldest request(s)
// when they are at their cap. Authorization resolves off the player, so an unlinked sender can still request;
// `source` carries their steam id plus their linked account when they have one, so ownership checks work from
// either surface.
export async function addBackburnerRequestFromChat(
	ctx: C.Db & C.ManagedServer & CS.AbortSignal & SM.Ctx.Ids,
	// requestFilters replace the server's layer request filters. The caller checks the sender may replace them.
	args: { source: USR.GuiOrChatUserId; filter: F.FilterNode; requestFilters?: BB.AppliedFilter[] },
): Promise<AddRequestResult> {
	const denied = await Rbac.tryDenyPermissionsForPlayer(ctx, RBAC.Req.layerRequest(ctx.serverId))
	if (denied) return denied
	const serverState = SquadServer.getServerState(ctx)
	const { filter, skipped } = args.requestFilters
		? { filter: BB.withFilters(args.filter, args.requestFilters), skipped: [] }
		: dropUnappliableRequestFilters(ctx, BB.withFilters(args.filter, serverState.settings.queue.mainPool.layerRequestFilters))
	const check = await checkTemplate(ctx, filter)
	if (check.code === 'err:invalid-filter') return invalidRequestResult(ctx, check.errors)
	if (check.code === 'err:no-solutions') return { code: 'err:no-solutions', msg: 'No layers in the current pool match this request' }
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
	return { code: 'ok', item, evicted, skippedRequestFilters: skipped }
}

export type AddVoteResult =
	// labels are the choices as players see them
	| { code: 'ok'; labels: string[] }
	// the choices no layer in the pool could be drawn for, by the value each was asked for
	| { code: 'err:unfilled-choices'; values: string[] }
	// filterNames are the typed filters that cannot be applied
	| { code: 'err:invalid-filter'; filterNames: string[] }
	| { code: 'err:vote-in-progress' }
	| { code: 'err:unsaved-edits' }

const VOTE_FIELD_DISPLAY_PROP: Record<BB.VoteChoiceField, DH.LayerDisplayProp | null> = {
	Map: 'map',
	Layer: 'layer',
	Gamemode: 'gamemode',
	Size: null,
}

// The chat path (/vote): draws one layer per value from the main pool, with the typed filters applied to every choice,
// and puts the vote at the head of the queue. Nothing is queued unless every choice is drawn. poolFilters, when given,
// replace the pool filter.
export async function addVoteFromChat(
	ctx: SideEffectCtx,
	args: {
		field: BB.VoteChoiceField
		choices: BB.VoteChoiceToken[]
		filterIds: string[]
		poolFilters?: BB.AppliedFilter[]
		source: LL.Source
	},
): Promise<AddVoteResult> {
	if (ctx.vote.state?.code === 'in-progress') return { code: 'err:vote-in-progress' }
	const serverState = SquadServer.getServerState(ctx)
	const typedFilterConstraintId = (filterId: string) => `vote-filter:${filterId}`
	const poolFilterConstraintId = (filterId: string) => `vote-pool-filter:${filterId}`
	const constraints = [
		...SETTINGS.getMainPoolConstraints(serverState.settings, Settings.repeatRulesFor(serverState.settings), {
			poolFilter: !args.poolFilters,
		}),
		...(args.poolFilters ?? []).map(({ filterId, applyAs }) =>
			CB.filterEntity(poolFilterConstraintId(filterId), filterId, { filterApplState: applyAs }),
		),
		...args.filterIds.map((filterId) => CB.filterEntity(typedFilterConstraintId(filterId), filterId)),
	]
	const res = await LayerQueriesShared.genVote({
		ctx: await LayerQueries.resolveLayerQueryCtx(ctx),
		input: {
			constraints,
			list: await LayerQueries.resolveLayerItemsState(ctx),
			// the vote goes in first, so the repeat rules look back from the head of the queue
			cursor: { type: 'start' },
			action: 'add',
			choices: args.choices.map((choice) => ({ choiceConstraints: { [args.field]: choice.value } })),
			uniqueConstraints: [args.field],
			seed: LQY.getSeed(),
		},
	})
	if (res.code !== 'ok') {
		log.warn({ [ATTRS.SquadServer.ID]: ctx.serverId }, 'vote choices from chat cannot be applied: %o', res.choices)
		return { code: 'err:unfilled-choices', values: res.choices.map((c) => args.choices[c.index].value) }
	}
	const brokenTypedFilters = [
		...(args.poolFilters ?? [])
			.map((f) => f.filterId)
			.filter((filterId) => res.problems.some((problem) => problem.constraintId === poolFilterConstraintId(filterId))),
		...args.filterIds.filter((filterId) => res.problems.some((problem) => problem.constraintId === typedFilterConstraintId(filterId))),
	]
	if (brokenTypedFilters.length > 0) {
		return { code: 'err:invalid-filter', filterNames: brokenTypedFilters.map((id) => backburnerFilterName(id) ?? id) }
	}
	if (res.problems.length > 0) {
		log.warn(
			{ [ATTRS.SquadServer.ID]: ctx.serverId },
			'vote from chat drawn without constraints that cannot be applied:\n%s',
			describeProblems(res.problems),
		)
	}
	const unfilled = args.choices.filter((_, i) => !res.chosenLayers[i]).map((c) => c.value)
	if (unfilled.length > 0) return { code: 'err:unfilled-choices', values: unfilled }

	const fieldProp = VOTE_FIELD_DISPLAY_PROP[args.field]
	const displayProps = Array.from(
		new Set<DH.LayerDisplayProp>([...(fieldProp ? [fieldProp] : []), ...serverState.settings.vote.voteDisplayProps]),
	)
	const layerIds = res.chosenLayers.map((layer) => layer!.id)
	const choiceTexts = args.choices.flatMap((choice, i) => (choice.text ? [{ layerId: layerIds[i], text: choice.text }] : []))
	const voteConfig = { displayProps, ...(choiceTexts.length > 0 ? { choiceTexts } : {}) }
	const added = await addToSaved(ctx, { source: args.source }, [LL.createVoteItem(layerIds, args.source, voteConfig)], 'start')
	if (added.code !== 'ok') return added
	return { code: 'ok', labels: layerIds.map((layerId) => V.choiceLabel(layerId, voteConfig, displayProps)) }
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
		// set for ops arriving via the dispatchOp rpc; the originating client gets an ack instead of the full op, unless
		// echoToSource says the server corrected it
		opts?: { sourceWsClientId?: string; echoToSource?: boolean },
	) => {
		if ((ctx as Partial<C.Tx>).tx) throw new Error('dispatchOp awaits rcon, so it cannot run inside a transaction')
		const applied = ODSM.Server.applyOps(ctx.layerQueue.session, [op], SLL.reducer)
		ctx.layerQueue.session = applied.session
		if (applied.rejected) {
			const rejection = applied.error.data as SLL.Rejection
			ctx.layerQueue.op$.next({ ops: [op], sourceWsClientId: opts?.sourceWsClientId, rejection })
			if (rejection.code === 'op-skipped') log.debug('layer queue op skipped: %s', op.op)
			else log.error(new Error('layer queue op produced invalid state', { cause: applied.error }))
			return
		}
		ctx.layerQueue.op$.next({ ops: [op], sourceWsClientId: opts?.sourceWsClientId, echoToSource: opts?.echoToSource })
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
				await UserPresence.dispatchEndAllLayerQueueEditing(ctx.serverId)
				break
			}
			case 'request-queue-item-generation': {
				await generateAndDispatchQueueItem(ctx)
				break
			}
			case 'request-backburner-save': {
				DB.transaction(ctx, {}, (ctx) => {
					SquadServer.updateServerState(ctx, { backburner: se.items }, { type: 'system', event: 'backburner-updated' })
				})
				if (se.trigger === 'user-save') {
					UserPresence.dispatchEndAllLayerRequestEditing(ctx.serverId)
				}
				const matchId = (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null
				const describe = (item: BB.BackburnerItem) =>
					BB.describeTemplate(I18n.translatorFor(I18n.DEFAULT_LOCALE), item.filter, backburnerFilterName)
				const prevIds = new Set(se.prevItems.map((item) => item.itemId))
				const nextIds = new Set(se.items.map((item) => item.itemId))
				const added = se.items.filter((item) => !prevIds.has(item.itemId))
				const removed = se.prevItems.filter((item) => !nextIds.has(item.itemId))
				if (se.trigger === 'consumed') {
					if (removed.length > 0) {
						await SquadServerActions.emitAppEvent(
							ctx,
							AppEvents.create<AppEvents.LayerRequestConsumed>({
								type: 'LAYER_REQUEST_CONSUMED',
								actor: { type: 'system' },
								serverId: ctx.serverId,
								matchId,
								causeId: null,
								itemIds: removed.map((item) => item.itemId),
								descriptions: removed.map(describe),
								layerId: se.layerId ?? L.defaultLayerId(),
								queueItemId: se.queueItemId,
								requests: removed.map((item) => {
									const requester = SquadServer.actorFromUser(ctx, item.source)
									return {
										requester: item.source,
										playerId: requester.type === 'ingame-user' ? requester.playerId : undefined,
										requestedAt: item.createdAt,
									}
								}),
							}),
						)
					}
					break
				}
				// each added item is attributed to whoever created it; the removal batch to whoever performed the write
				for (const item of added) {
					await SquadServerActions.emitAppEvent(
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
					await SquadServerActions.emitAppEvent(
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
						actor: triggerOp ? AppEvents.opActor(triggerOp) : { type: 'system' },
					}
				})()
				// who the saver overrode: the users still mid-edit when the save landed. the saver's own editing presence is
				// cleared alongside the save, so exclude them rather than race the two ops.
				const save =
					triggerOp?.op === 'save'
						? {
								force: triggerOp.force ?? false,
								overrodeEditors: UserPresence.getQueueEditors(ctx.serverId, triggerOp.userId),
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
					externalEventId: triggerOp?.op === 'unshift-first-saved-layer' ? externalSetEventIds.get(triggerOp.itemId) : undefined,
				})
				await SquadServerActions.emitAppEvent(ctx, queueUpdated)
				await saveQueueAndUpdateServer(ctx, se.list, se.prevList, queueUpdated.id)
				await dispatchOp(ctx, { op: 'save-completed', opId: SLL.createOpId() })
				await UserPresence.dispatchEndAllLayerQueueEditing(ctx.serverId)
				break
			}
			default:
				assertNever(se)
		}
	},
)
