import * as Schema from '$root/drizzle/schema.ts'
import { CleanupTasks, toAsyncGenerator, toCold, withAbortSignal } from '@/lib/async.ts'
import * as DH from '@/lib/display-helpers.ts'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards.ts'
import type { Parts } from '@/lib/types'
import { HumanTime } from '@/lib/zod.ts'
import * as Messages from '@/messages.ts'
import * as BAL from '@/models/balance-triggers.models.ts'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models.ts'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import orpcBase from '@/server/orpc-base'
import * as LayerQueriesServer from '@/server/systems/layer-queries'
import * as MatchHistory from '@/server/systems/match-history.ts'
import * as Rbac from '@/server/systems/rbac'
import * as SquadRcon from '@/server/systems/squad-rcon'
import * as SquadServer from '@/server/systems/squad-server'
import * as VoteSys from '@/server/systems/vote'
import * as LayerQueries from '@/systems.shared/layer-queries.shared.ts'
import * as Otel from '@opentelemetry/api'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { z } from 'zod'
import * as Users from './users'

export type LayerQueueContext = {
	unexpectedNextLayerSet$: Rx.BehaviorSubject<L.LayerId | null>

	// TODO we should fold this into the server events
	update$: Rx.ReplaySubject<[SS.LQStateUpdate, CS.Log & C.Db & C.ServerId]>
}

export function initLayerQueueContext(cleanup: CleanupTasks) {
	const ctx: LayerQueueContext = {
		unexpectedNextLayerSet$: new Rx.BehaviorSubject<L.LayerId | null>(null),
		update$: new Rx.ReplaySubject(1),
	}
	cleanup.push(
		ctx.unexpectedNextLayerSet$,
		ctx.update$,
	)
	return ctx
}

const tracer = Otel.trace.getTracer('layer-queue')
export const init = C.spanOp(
	'layer-queue:init',
	{ tracer, eventLogLevel: 'info', mutexes: (ctx) => ctx.vote.mtx },
	async (ctx: CS.Log & C.Db & C.ServerSlice) => {
		const serverId = ctx.serverId
		await DB.runTransaction(ctx, async (ctx) => {
			const s = ctx.layerQueue

			const initialServerState = await SquadServer.getFullServerState(ctx)

			// -------- initialize vote state --------
			await VoteSys.syncVoteStateWithQueueStateInPlace(ctx, [], initialServerState.layerQueue)

			addReleaseTask(() => s.update$.next([{ state: initialServerState, source: { type: 'system', event: 'app-startup' } }, ctx]))

			ctx.log.info('vote state initialized')
		})
		ctx.log.info('initial update complete')

		// -------- log vote state updates --------
		ctx.cleanup.push(ctx.vote.update$.subscribe((update) => {
			const ctx = getBaseCtx()
			ctx.log.info('Vote state updated : %s : %s : %s', update.source.type, update.source.event, update.state?.code ?? null)
		}))

		ctx.layerQueue.update$.subscribe(([state, ctx]) => {
			ctx.log.debug({ seqId: state.state.layerQueueSeqId }, 'pushing server state update')
		})

		// -------- schedule generic admin reminders --------
		if (CONFIG.servers.find(s => s.id === ctx.serverId)!.remindersAndAnnouncementsEnabled) {
			ctx.cleanup.push(
				Rx.interval(CONFIG.layerQueue.adminQueueReminderInterval).pipe(
					C.durableSub('layer-queue:queue-reminders', { ctx, tracer }, async () => {
						const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
						const serverState = await SquadServer.getServerState(ctx)
						const currentMatch = await MatchHistory.getCurrentMatch(ctx)
						const voteState = ctx.vote.state
						if (ctx.server.serverRolling$.value || currentMatch.status === 'post-game') return
						if (
							LL.isVoteItem(serverState.layerQueue[0])
							&& voteState?.code === 'ready'
							&& currentMatch.startTime !== undefined
							&& currentMatch.startTime.getTime() + CONFIG.vote.startVoteReminderThreshold < Date.now()
						) {
							await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.votePending)
						} else if (serverState.layerQueue.length === 0) {
							await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.empty)
						}
					}),
				).subscribe(),
			)
		}

		// -------- when SLM is not able to set a layer on the server, notify admins.
		ctx.cleanup.push(
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
					C.durableSub('layer-queue:notify-unexpected-next-layer', { tracer, ctx }, async (unexpectedNextlayer) => {
						const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
						const serverState = await SquadServer.getServerState(ctx)
						const expectedNextLayer = LL.getNextLayerId(serverState.layerQueue)!
						if (!expectedNextLayer) return
						const expectedLayerName = DH.toFullLayerNameFromId(expectedNextLayer)
						const actualLayerName = DH.toFullLayerNameFromId(unexpectedNextlayer)
						await SquadRcon.warnAllAdmins(
							ctx,
							`Current next layer on the server is out-of-sync with queue. Got ${actualLayerName}, but expected ${expectedLayerName}`,
						)
					}),
				).subscribe(),
		)

		// -------- make sure next layer set is synced with queue --------
		const nextSetLayer$ = ctx.server.layersStatus
			.observe(ctx)
			.pipe(
				Rx.concatMap((statusRes): Rx.Observable<L.UnvalidatedLayer | null> =>
					statusRes.code === 'ok' ? Rx.of(statusRes.data.nextLayer) : Rx.EMPTY
				),
				Rx.distinctUntilChanged((a, b) => a?.id === b?.id),
			)

		const nextQueuedLayer$ = ctx.layerQueue.update$.pipe(Rx.map(([update]) => LL.getNextLayerId(update.state.layerQueue)))

		Rx.combineLatest([
			nextSetLayer$,
			nextQueuedLayer$,
		]).pipe(
			C.durableSub('layer-queue:sync-next-layer-status', { tracer, ctx }, async ([nextSet, nextQueued]) => {
				if ((nextSet?.id ?? null) === nextQueued) return
				const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)

				// this case will be dealt with in handleNewGame, so can ignore it here
				if (ctx.server.serverRolling$.value) return

				await DB.runTransaction(ctx, async (ctx) => {
					const serverState = await SquadServer.getServerState(ctx)
					await syncNextLayerInPlace(ctx, serverState)
				})
			}),
		).subscribe()
	},
)

export function schedulePostRollTasks(ctx: C.SquadServer & CS.Log, newLayerId: L.LayerId) {
	const serverId = ctx.serverId

	// -------- schedule post-roll events --------
	ctx.server.postRollEventsSub?.unsubscribe()
	ctx.server.postRollEventsSub = new Rx.Subscription()

	// -------- schedule FRAAS auto fog-off --------
	const currentLayer = L.toLayer(newLayerId)
	if (currentLayer.Gamemode === 'FRAAS') {
		ctx.server.postRollEventsSub.add(
			Rx.timer(CONFIG.fogOffDelay).subscribe(async () => {
				const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
				await SquadRcon.setFogOfWar(ctx, 'off')
				void SquadRcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
			}),
		)
	}

	// -------- schedule post-roll announcements --------
	if (CONFIG.servers.find(s => s.id === ctx.serverId)?.remindersAndAnnouncementsEnabled) {
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
			const serverState = await SquadServer.getServerState(ctx)
			if (serverState.layerQueue.length <= CONFIG.layerQueue.lowQueueWarningThreshold) {
				await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.lowQueueItemCount(serverState.layerQueue.length))
			}
		}))

		const withWaits: Rx.Observable<unknown>[] = []
		withWaits.push(Rx.timer(CONFIG.postRollAnnouncementsTimeout))

		for (let i = 0; i < announcementTasks.length; i++) {
			withWaits.push(announcementTasks[i].pipe(Rx.catchError(() => Rx.EMPTY)))
			if (i !== announcementTasks.length - 1) {
				withWaits.push(Rx.timer(2000))
			}
		}

		ctx.server.postRollEventsSub.add(Rx.concat(Rx.from(withWaits)).subscribe())
	}
}

export async function updateQueue(
	{ input, ctx }: {
		input: { layerQueue: LL.List; layerQueueSeqId: number }
		ctx: C.OrpcBase & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory
	},
) {
	input = Obj.deepClone(input)
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const serverStatePrev = await SquadServer.getServerState(ctx)
		const serverState = Obj.deepClone(serverStatePrev)
		if (input.layerQueueSeqId !== serverState.layerQueueSeqId) {
			return {
				code: 'err:out-of-sync' as const,
				msg: 'Update is out of sync',
			}
		}

		for (const item of input.layerQueue) {
			if (LL.isVoteItem(item) && item.choices.length > CONFIG.vote.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.vote.maxNumVoteChoices}`,
				}
			}
		}

		if (input.layerQueue.length > CONFIG.layerQueue.maxQueueSize) {
			return {
				code: 'err:queue-too-large' as const,
				msg: ` Queue size exceeds maximum limit (${input.layerQueue.length}/${CONFIG.layerQueue.maxQueueSize})`,
			}
		}

		for (const item of input.layerQueue) {
			if (LL.isVoteItem(item) && item.choices.length > CONFIG.vote.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.vote.maxNumVoteChoices}`,
				}
			}
			if (
				LL.isVoteItem(item)
				&& !V.validateChoicesWithDisplayProps(item.choices.map(c => c.layerId), item.displayProps ?? CONFIG.vote.voteDisplayProps)
			) {
				return {
					code: 'err:not-enough-visible-info' as const,
					msg: "Can't distinguish between vote choices.",
				}
			}
		}

		serverState.layerQueue = input.layerQueue

		await syncNextLayerInPlace(ctx, serverState, { skipDbWrite: true })
		await VoteSys.syncVoteStateWithQueueStateInPlace(ctx, serverStatePrev.layerQueue, serverState.layerQueue)

		const update = await SquadServer.updateServerState(ctx, serverState, {
			type: 'manual',
			user: USR.toMiniUser(ctx.user),
			event: 'edit-queue',
		})

		return { code: 'ok' as const, update }
	})

	return res
}

export async function warnShowNext(
	ctx: C.Db & CS.Log & C.SquadServer & C.LayerQueue & C.AdminList,
	playerIds: 'all-admins' | SM.PlayerIds.Type,
	opts?: { repeat?: number },
) {
	const serverState = await SquadServer.getServerState(ctx)
	const layerQueue = serverState.layerQueue
	const parts: USR.UserPart = { users: [] }
	const firstItem = layerQueue[0]
	if (firstItem?.source.type === 'manual') {
		const userId = firstItem.source.userId
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, userId))
		parts.users.push(await Users.buildUser(ctx, user))
	}
	if (playerIds === 'all-admins') {
		await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	} else {
		await SquadRcon.warn(ctx, playerIds, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	}
}

/**
 * sets next layer on server according to the current queue, generating a new queue item if needed. modifies serverState in place.
 */
export async function syncNextLayerInPlace<NoDbWrite extends boolean>(
	ctx: CS.Log & C.Db & (NoDbWrite extends true ? object : C.Tx) & C.SquadServer & C.LayerQueue & C.MatchHistory,
	serverState: SS.ServerState,
	opts?: { skipDbWrite: NoDbWrite },
) {
	let nextLayerId = LL.getNextLayerId(serverState.layerQueue)
	let wroteServerState = false
	if (!nextLayerId) {
		const constraints = SS.getSettingsConstraints(serverState.settings, { generatingLayers: true })
		const layerCtx = await LayerQueriesServer.resolveLayerQueryCtx(ctx, serverState)
		const gen = LayerQueries.queryLayersStreamed({
			ctx: layerCtx,
			input: {
				constraints,
				cursor: { type: 'item-relative', itemId: LQY.SpecialItemId.FIRST_LIST_ITEM, position: 'before' },
				action: 'add',
				pageSize: 1,
				sort: { type: 'random', seed: LQY.getSeed() },
			},
		})
		let ids: string[] = []

		for await (const packet of gen) {
			if (packet.code === 'menu-item-possible-values') continue
			if (packet.code === 'err:invalid-node') {
				throw new Error(`Invalid node error when generating layer`, { cause: packet.errors })
			}

			ids = packet.layers.map(l => l.id)
		}

		;[nextLayerId] = ids
		if (!nextLayerId) return false
		const nextQueueItem = LL.createLayerListItem({ layerId: nextLayerId }, { type: 'generated' })
		serverState.layerQueue.push(nextQueueItem)
		if (!opts?.skipDbWrite) {
			await SquadServer.updateServerState(ctx as C.Db & C.SquadServer & C.LayerQueue & C.Tx, serverState, {
				type: 'system',
				event: 'next-layer-generated',
			})
		}
		wroteServerState = true
	}
	const currentStatusRes = await ctx.server.layersStatus.get(ctx)
	if (currentStatusRes.code !== 'ok') return currentStatusRes
	if (!serverState.settings.updatesToSquadServerDisabled) {
		const res = await SquadRcon.setNextLayer(ctx, nextLayerId)
		switch (res.code) {
			case 'err:unable-to-set-next-layer':
				ctx.layerQueue.unexpectedNextLayerSet$.next(res.unexpectedLayerId)
				break
			case 'err:rcon':
			case 'ok':
				ctx.layerQueue.unexpectedNextLayerSet$.next(null)
				break
			default:
				assertNever(res)
		}
	}
	return wroteServerState
}

export async function toggleUpdatesToSquadServer(
	{ ctx, input }: { ctx: CS.Log & C.Db & C.SquadServer & C.UserOrPlayer & C.LayerQueue & C.AdminList; input: { disabled: boolean } },
) {
	// if player we assume authorization has already been established
	if (ctx.user) {
		const denyRes = await Rbac.tryDenyPermissionsForUser({ ...ctx, user: ctx.user! }, RBAC.perm('squad-server:disable-slm-updates'))
		if (denyRes) return denyRes
	}

	await DB.runTransaction(ctx, async ctx => {
		const serverState = await SquadServer.getServerState(ctx)
		serverState.settings.updatesToSquadServerDisabled = input.disabled
		await SquadServer.updateServerState(ctx, { settings: serverState.settings }, {
			type: 'system',
			event: 'updates-to-squad-server-toggled',
		})
	})

	await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.slmUpdatesSet(!input.disabled))
	return { code: 'ok' as const }
}

export async function getSlmUpdatesEnabled(ctx: CS.Log & C.Db & C.UserOrPlayer & C.SquadServer & C.LayerQueue) {
	const serverState = await SquadServer.getServerState(ctx)
	return { code: 'ok' as const, enabled: !serverState.settings.updatesToSquadServerDisabled }
}

export async function requestFeedback(
	ctx: CS.Log & C.Db & C.SquadServer & C.LayerQueue & C.AdminList,
	playerName: string,
	layerQueueNumber: string | undefined,
) {
	const serverState = await SquadServer.getServerState(ctx)
	let index: LL.ItemIndex | undefined
	if (serverState.layerQueue.length === 0) return { code: 'err:empty' as const }
	if (layerQueueNumber === undefined) index = LL.iterItems(...serverState.layerQueue).next().value
	else index = LL.resolveLayerQueueItemIndexForNumber(layerQueueNumber) ?? undefined
	if (!index) return { code: 'err:not-found' as const }
	const item = LL.resolveItemForIndex(serverState.layerQueue, index)!
	await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.requestFeedback(index, playerName, item))
	return { code: 'ok' as const }
}

function getBaseCtx() {
	return C.initMutexStore(DB.addPooledDb({ log: baseLogger }))
}

// -------- setup router --------
export const router = {
	watchUnexpectedNextLayer: orpcBase.handler(async function*({ context, signal }) {
		const obs = SquadServer.selectedServerCtx$(context).pipe(
			Rx.switchMap(ctx => {
				return ctx.layerQueue.unexpectedNextLayerSet$
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	toggleUpdatesToSquadServer: orpcBase
		.input(z.object({ disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
			return await toggleUpdatesToSquadServer({ ctx, input })
		}),
}
