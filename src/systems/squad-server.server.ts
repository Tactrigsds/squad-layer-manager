import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as AR from '@/app-routes'
import * as Arr from '@/lib/array'
import { acquireInBlock, anySignal, distinctDeepEquals, firstValueFrom, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { AsyncResource } from '@/lib/async-resource'
import * as Cleanup from '@/lib/cleanup'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { FileTail } from '@/lib/file-tail'
import * as Gen from '@/lib/generator'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object'
import Rcon from '@/lib/rcon/core-rcon'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import { SftpTail } from '@/lib/sftp-tail'
import * as Templating from '@/lib/templating'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import { HumanTime } from '@/lib/zod'
import * as Messages from '@/messages.ts'
import * as AAR from '@/models/admin-action-reasons.models'
import * as AppEvents from '@/models/app-events.models'
import type * as BAL from '@/models/balance-triggers.models'
import * as CHAT from '@/models/chat.models.ts'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as MH from '@/models/match-history.models'
import * as ATTRS from '@/models/otel-attrs'
import * as PendingEvents from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import * as SS from '@/models/server-state.models'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Otel from '@opentelemetry/api'

import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'

import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Commands from '@/systems/commands.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as TeamswapsSys from '@/systems/teamswaps.server'
import * as Timeouts from '@/systems/timeouts.server'
import * as Vote from '@/systems/vote.server'
import * as WsSessionSys from '@/systems/ws-session.server'
import * as Orpc from '@orpc/server'
import { Mutex, type MutexInterface } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import { z } from 'zod'

const module = initModule('squad-server')

const meter = Otel.metrics.getMeter('squad-server')

const logLineCounter = meter.createCounter(ATTRS.SquadLogs.LINES, {
	description: 'Squad log lines ingested, by server and log source',
})

const logIoCounter = meter.createCounter(ATTRS.SquadLogs.IO, {
	description: 'Bytes of squad log data ingested, by server and log source',
	unit: 'By',
})

const logEventCounter = meter.createCounter(ATTRS.SquadLogs.EVENTS, {
	description: 'Squad log events successfully parsed out of the log stream, by server and log source',
})

const serverEventCounter = meter.createCounter(ATTRS.ServerEvent.EMITTED, {
	description: 'Server events emitted on event$, by server and event type',
})
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

type State = {
	slices: Map<string, C.ServerSlice>
	// emits a serverId whenever that server's slice is added to or removed from `slices`
	sliceLifecycleUpdate$: Rx.Subject<string>
	serverEventIdCounter: Generator<number, never, unknown>
	squadIdCounter: Generator<number, never, unknown>

	debug__ticketOutcome?: { team1: number; team2: number }
}

export let globalState!: State

export type SquadServer = {
	layersStatusExt$: Rx.Observable<SM.LayersStatusResExt>

	postRollEventsSub: Rx.Subscription | null

	serverRolling$: Rx.BehaviorSubject<number | null>

	// latest "Server Tick Rate" reported in the game logs; null until the first sample is seen
	tickRate$: Rx.BehaviorSubject<number | null>

	// if null, we haven't saved yet in this instantiation of the server
	lastSavedEventId: number | null

	// ids saveEvents has already processed (saved or skipped); guards against double-persisting an event id.
	// Pruned alongside the emittedEvents rotation on match rollover.
	savedEventIds: Set<number>

	emittedEvents: SE.Event[]
	// TODO we should slim down the context we provide here so that we're just transmitting span & logging info, and leave the listener to construct everything else
	event$: Rx.Subject<[C.Db & C.ServerSlice, SE.Event]>
	eventState: PendingEvents.State

	// SLM app (audit) events for this server, and the live channel that feeds them into the activity panel
	emittedAppEvents: AppEvents.AppEvent[]
	appEvent$: Rx.Subject<[C.Db & C.ServerSlice, AppEvents.AppEvent]>

	chatState: CHAT.ChatState

	destroyed: boolean
	cleanupId: number | null

	processEventsMtx: MutexInterface
	savingEventsMtx: MutexInterface
} & SquadRcon.SquadRcon

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<C.OtelCtx>
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>

export const orpcRouter = {
	// which servers currently have a live slice. This is runtime state, not registry config: a server can be enabled and
	// non-broken yet have no slice (still booting, or torn down by a fatal resource error), and everything served per-server
	// needs one. The client gates the dashboard on this so it renders "unavailable" instead of hanging on silent streams.
	watchLoadedServers: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ signal }) {
		const obs = globalState.sliceLifecycleUpdate$.pipe(
			Rx.startWith(null),
			Rx.map(() => [...globalState.slices.keys()]),
			distinctDeepEquals(),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	watchLayersStatus: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = sliceStream$(context.wsClientId, input.serverId, (sliceCtx) =>
			new Rx.Observable<SM.LayersStatusResExt>((subscriber) => {
				const ac = new AbortController()
				;(async () => {
					const currentMatch = await MatchHistory.getCurrentMatch(sliceCtx)
					const nextLayerId = sliceCtx.server.eventState.nextLayerId
					subscriber.next({
						code: 'ok',
						data: {
							currentLayer: L.toLayer(currentMatch.layerId),
							nextLayer: nextLayerId ? L.toLayer(nextLayerId) : null,
							currentMatch,
						},
					})
					const event$ = sliceCtx.server.event$.pipe(withAbortSignal(ac.signal))
					for await (const [ctx, event] of toAsyncGenerator(event$)) {
						if (!['NEW_GAME', 'MAP_SET', 'RESET'].includes(event.type)) continue
						const currentMatch = await MatchHistory.getCurrentMatch(ctx)
						const nextLayerId = ctx.server.eventState.nextLayerId
						subscriber.next({
							code: 'ok',
							data: {
								currentLayer: L.toLayer(currentMatch.layerId),
								nextLayer: nextLayerId ? L.toLayer(nextLayerId) : null,
								currentMatch,
							},
						})
					}
					subscriber.complete()
				})().catch((err) => subscriber.error(err))
				return () => ac.abort()
			})).pipe(withAbortSignal(signal!))
		yield* toAsyncGenerator(obs)
	}),

	watchServerRolling: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = sliceStream$(context.wsClientId, input.serverId, (ctx) => ctx.server.serverRolling$).pipe(
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	watchTickRate: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = sliceStream$(context.wsClientId, input.serverId, (ctx) => ctx.server.tickRate$.pipe(distinctDeepEquals())).pipe(
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	watchServerInfo: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = sliceStream$(context.wsClientId, input.serverId, (ctx) => ctx.server.serverInfo.observe(ctx).pipe(distinctDeepEquals()))
			.pipe(withAbortSignal(signal!))
		yield* toAsyncGenerator(obs)
	}),

	endMatch: orpcBase.input(z.object({ serverId: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctxRes = trySliceCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		const deniedRes = await Rbac.tryDenyPermissionsForUser(
			ctx,
			RBAC.perm('squad-server:end-match'),
		)
		if (deniedRes) return deniedRes
		const matchEnded$ = ctx.server.event$.pipe(
			Rx.map(([_, e]) => e),
			Rx.filter((e) => e.type === 'ROUND_ENDED'),
			Rx.endWith(null),
		)
		const result$ = firstValueFrom(
			Rx.race(
				matchEnded$,
				Rx.timer(20_000).pipe(Rx.map(() => 'timeout' as const)),
			),
			ctx.signal,
		)

		await SquadRcon.endMatch(ctx)
		await emitAppEvent(
			ctx,
			AppEvents.create<AppEvents.MatchEnded>({
				type: 'MATCH_ENDED',
				actor: { type: 'slm-user', userId: ctx.user.discordId },
				serverId: ctx.serverId,
				matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
				causeId: null,
			}),
		)

		const result = await result$
		if (result === 'timeout') {
			return {
				code: 'err:timeout' as const,
				message: 'Failed to end match: operation timed out',
			}
		}
		if (result === null) {
			return {
				code: 'err:unknown' as const,
				message: 'Failed to end match: unknown error',
			}
		}
		if (result.type === 'ROUND_ENDED') {
			return { code: 'ok' as const, message: 'Match ended successfully' }
		}
		assertNever(result.type)
	}),

	watchChatEvents: orpcBase
		.meta({ logLevel: 'trace' })
		.input(
			z.object({ lastEventId: z.number().optional(), serverId: z.string() }),
		)
		.handler(async function*({ context, signal, input }) {
			const obs = sliceStream$(context.wsClientId, input.serverId, (ctx) => {
				async function getInitialEvents() {
					const sync: CHAT.SyncedEvent = {
						type: 'SYNCED' as const,
						time: Date.now(),
						matchId: (await MatchHistory.getCurrentMatch(ctx))
							.historyEntryId,
					}

					let allEvents: SE.Event[] = ctx.server.emittedEvents
					let events: (SE.Event | CHAT.AppFeedEvent | CHAT.LifecycleEvent)[] = []

					if (input.lastEventId === undefined) {
						events.push({
							type: 'INIT',
							time: Date.now(),
							serverId: ctx.serverId,
						})
						events.push(...mergeEventsByTime(allEvents, ctx.server.emittedAppEvents))
						events.push(sync)
					} else {
						let lastEventIndex = allEvents.findIndex(
							(e) => e.id === input!.lastEventId!,
						)

						// let the client know that we are reconnecting from their last known event id
						events.push({
							type: 'CHAT_RECONNECTED',
							resumedEventId: lastEventIndex === -1 ? null : input!.lastEventId!,
						})
						// if last event was not found it'll be -1, which works nicely here because we just need to resend all events
						events.push(
							...mergeEventsByTime(
								allEvents.slice(lastEventIndex + 1),
								ctx.server.emittedAppEvents.filter((a) => lastEventIndex === -1 || a.time >= allEvents[lastEventIndex].time),
							),
						)
						events.push(sync)
					}

					return Arr.paged(events, 512)
				}
				const initial$ = Rx.from(getInitialEvents()).pipe(Rx.concatAll())

				const upcoming$ = Rx.merge(
					ctx.server.event$.pipe(Rx.map(([_, e]): SE.Event | CHAT.AppFeedEvent => e)),
					ctx.server.appEvent$.pipe(Rx.map(([_, appEvent]): SE.Event | CHAT.AppFeedEvent => ({ type: 'APP_EVENT', appEvent }))),
				).pipe(
					Rx.map((event): (SE.Event | CHAT.AppFeedEvent)[] => [event]),
				)

				return Rx.concat(initial$, upcoming$).pipe(
					// orpc will break without this
					Rx.observeOn(Rx.asyncScheduler),
				)
			}).pipe(
				Rx.tap({
					error: (err) => {
						log.error(err, 'Error in watchChatEvents')
					},
				}),
				withAbortSignal(signal!),
			)
			yield* toAsyncGenerator(obs)
		}),

	toggleFogOfWar: orpcBase
		.input(z.object({ serverId: z.string(), disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(
				ctx,
				RBAC.perm('squad-server:turn-fog-off'),
			)
			if (denyRes) return denyRes
			const serverStatusRes = await ctx.server.layersStatus.get(ctx)
			if (serverStatusRes.code !== 'ok') return serverStatusRes
			await SquadRcon.setFogOfWar(ctx, input.disabled ? 'off' : 'on')
			await emitAppEvent(
				ctx,
				AppEvents.create<AppEvents.FogOfWarToggled>({
					type: 'FOG_OF_WAR_TOGGLED',
					actor: { type: 'slm-user', userId: ctx.user.discordId },
					serverId: ctx.serverId,
					matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
					causeId: null,
					enabled: !input.disabled,
				}),
			)
			if (input.disabled) {
				await SquadRcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
			}
			return { code: 'ok' as const }
		}),

	warnPlayers: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				playerIds: z.array(SM.PlayerIdSchema).min(1),
				reason: z.string().min(1).optional(),
				presetReasonLabel: z.string().min(1).optional(),
				// when a warn targets a whole squad the message gets a "@Squad<id>" (or "@cmdSquad") tag
				taggedSquad: z.object({
					squadId: z.number().int().positive(),
					squadName: z.string().min(1),
					teamId: SM.TeamIdSchema,
				}).optional(),
			}).refine(i => !!i.reason !== !!i.presetReasonLabel, { error: 'Exactly one of reason or presetReasonLabel must be provided' }),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:warn-players'))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('warn', input)
			if (reasonRes.code !== 'ok') return reasonRes
			// the input refine guarantees a reason was provided; narrow without asserting
			if (!reasonRes.applied) return { code: 'err:reason-required' as const, msg: 'A reason is required to warn.' }
			const message = AAR.renderAppliedReason(reasonRes.applied, {
				squadTag: input.taggedSquad ? SM.squadWarnTag(input.taggedSquad) : undefined,
			})
			// squad warns name the squad + faction (e.g. "warned Squad1 (PLA): ...") in the admin notification
			let adminNotifyDescription: string | undefined
			if (input.taggedSquad) {
				const currentMatch = await MatchHistory.getCurrentMatch(ctx)
				const squadLabel = SM.squadAdminLabel(input.taggedSquad, MH.getTeamFaction(currentMatch, input.taggedSquad.teamId))
				adminNotifyDescription = `warned ${squadLabel}: "${message}"`
			}
			await warnPlayers(ctx, input.playerIds, message, { type: 'slm-user', userId: ctx.user.discordId }, {
				reasonLabel: reasonRes.applied.label,
				adminNotifyDescription,
			})
			return { code: 'ok' as const }
		}),

	warnAdmins: orpcBase
		.input(z.object({ serverId: z.string(), message: z.string().min(1) }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:warn-players'))
			if (denyRes) return denyRes
			const [adminList, teamsRes] = await Promise.all([ctx.adminList.get(ctx), ctx.server.teams.get(ctx)])
			if (teamsRes.code !== 'ok') return teamsRes
			const admins = teamsRes.players
				.filter(p => p.ids.steam && adminList.admins.has(p.ids.steam))
				.map(p => SM.PlayerIds.getPlayerId(p.ids))
			if (admins.length === 0) return { code: 'err:no-admins-online' as const }
			await warnPlayers(ctx, admins, input.message, { type: 'slm-user', userId: ctx.user.discordId }, { suppressAdminNotify: true })
			return { code: 'ok' as const }
		}),

	broadcast: orpcBase
		.input(z.object({ serverId: z.string(), message: z.string().min(1) }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:broadcast'))
			if (denyRes) return denyRes
			await broadcastAction(ctx, input.message, { type: 'slm-user', userId: ctx.user.discordId })
			return { code: 'ok' as const }
		}),

	demoteCommander: orpcBase
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema, presetReasonLabel: z.string().min(1).optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('demote-commander', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await demoteCommanderAction(ctx, input.playerId, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	disbandSquad: orpcBase
		.input(z.object({
			serverId: z.string(),
			teamId: SM.TeamIdSchema,
			squadId: z.number().int().positive(),
			presetReasonLabel: z.string().min(1).optional(),
		}))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('disband-squad', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await disbandSquadAction(ctx, input.teamId, input.squadId, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	removeFromSquad: orpcBase
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema, presetReasonLabel: z.string().min(1).optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('remove-from-squad', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await removePlayersFromSquad(ctx, [input.playerId], { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	removePlayersFromSquad: orpcBase
		.input(
			z.object({ serverId: z.string(), playerIds: z.array(SM.PlayerIdSchema).min(1), presetReasonLabel: z.string().min(1).optional() }),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('remove-from-squad', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await removePlayersFromSquad(ctx, input.playerIds, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	kill: orpcBase
		.input(z.object({
			serverId: z.string(),
			playerIds: z.array(SM.PlayerIdSchema).min(1),
			reason: z.string().trim().min(1).optional(),
			presetReasonLabel: z.string().min(1).optional(),
		}))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('kill', input)
			if (reasonRes.code !== 'ok') return reasonRes
			// the kill notify delivers the rendered reason verbatim (see SquadRcon.killPlayers / WARNS.kill.notifyKilled)
			const reason = reasonRes.applied && AAR.renderAppliedReason(reasonRes.applied)
			await killPlayersAction(ctx, input.playerIds, { type: 'slm-user', userId: ctx.user.discordId }, reason, reasonRes.applied?.label)
			return { code: 'ok' as const }
		}),

	// a plain kick; timeouts (which bar the player from rejoining) go through timeouts.timeoutPlayer
	kickPlayers: orpcBase
		.input(z.object({
			serverId: z.string(),
			playerIds: z.array(SM.PlayerIdSchema).min(1),
			reason: z.string().trim().min(1).optional(),
			presetReasonLabel: z.string().min(1).optional(),
		}))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:kick-players'))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('kick', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await kickPlayersAction(ctx, input.playerIds, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	renameSquad: orpcBase
		.input(z.object({ serverId: z.string(), teamId: SM.TeamIdSchema, squadId: z.number().int().positive() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players'))
			if (denyRes) return denyRes
			await renameSquadAction(ctx, input.teamId, input.squadId, { type: 'slm-user', userId: ctx.user.discordId })
			return { code: 'ok' as const }
		}),
}

export async function setup() {
	log = module.getLogger()
	const ctx = getBaseCtx()

	globalState = {
		slices: new Map(),
		sliceLifecycleUpdate$: new IsolatedSubject(),
		serverEventIdCounter: undefined!,
		squadIdCounter: undefined!,
	}

	const lastEventRes = await ctx
		.db()
		.select({ id: Schema.serverEvents.id })
		.from(Schema.serverEvents)
		.orderBy(E.desc(Schema.serverEvents.id))
		.limit(1)
	// driver sometimes returns strings so just to be safe
	const nextEventId = lastEventRes.length > 0 ? lastEventRes[0].id + 1 : 0
	globalState.serverEventIdCounter = Gen.counter(nextEventId)

	const lastSquadRes = await ctx
		.db()
		.select({ id: Schema.squads.id })
		.from(Schema.squads)
		.orderBy(E.desc(Schema.squads.id))
		.limit(1)
	const nextSquadId = lastSquadRes.length > 0 ? lastSquadRes[0].id + 1 : 0
	globalState.squadIdCounter = Gen.counter(nextSquadId)

	// Settings.setup() has already loaded the registry by this point (see main.ts); boot a slice for every server that should have one
	await Promise.all(Settings.listServerEntries().map((entry) => ensureSliceRunning(entry.id)))
}

// boots a slice for the given server if it's enabled, not broken, and doesn't already have one running
export async function ensureSliceRunning(serverId: string) {
	if (globalState.slices.has(serverId)) return
	const entry = Settings.getServerEntry(serverId)
	if (!entry || !entry.enabled || entry.broken) return
	const ctx = getBaseCtx()
	const serverState = await getServerState({ ...ctx, serverId })
	await setupSlice(ctx, serverState)
	log.info(`Server ${serverId} setup complete`)
}

// tears down and re-creates the slice for a server, picking up the latest settings from the DB. If the server isn't currently
// running (disabled, broken, or not yet started), this just ensures it's running per the usual rules -- it never force-starts it.
export async function restartSliceIfRunning(serverId: string) {
	const ctx = getBaseCtx()
	const slice = globalState.slices.get(serverId)
	if (slice) {
		await destroyServer({ ...ctx, ...slice })
		log.info(`Server ${serverId} slice destroyed for restart`)
	}
	await ensureSliceRunning(serverId)
}

// forces the admin list resource to refetch (picking up the latest adminListSources/adminIdentifyingPermissions) without
// tearing down the rest of the slice. No-op if the server isn't currently running.
export function invalidateAdminList(serverId: string) {
	const slice = globalState.slices.get(serverId)
	if (!slice) return
	slice.adminList.invalidate(getBaseCtx())
}

// lets destroyServer cancel a slice's in-flight work before its cleanup tasks run
const sliceAbortControllers = new Map<string, AbortController>()

async function setupSlice(ctx: C.Db & CS.AbortSignal, serverState: SS.ServerState) {
	const serverId = serverState.id
	const settings = serverState.settings
	const cleanup: Cleanup.Tasks = []

	const sliceAbort = new AbortController()
	sliceAbortControllers.set(serverId, sliceAbort)
	// aborts when the slice is destroyed or the process shuts down
	const signal = anySignal(ctx.signal, sliceAbort.signal)!
	ctx = { ...ctx, signal }

	const rcon = new Rcon({ serverId, settings: settings.connections.rcon })
	rcon.ensureConnected()
	cleanup.push(() => rcon.disconnect())

	const layersStatusExt$: SquadServer['layersStatusExt$'] = getLayersStatusExt$(serverId)

	// a resource that keeps failing after retries means the slice can't do its job -- tear the slice down instead of
	// letting the error escalate to an unhandled rejection and crash the process
	const onResourceFatalError = async (err: unknown) => {
		log.error(err, `Server ${serverId}: async resource failed permanently, destroying slice`)
		const slice = globalState.slices.get(serverId)
		if (!slice) return
		try {
			await destroyServer({ ...getBaseCtx(), ...slice })
		} catch (destroyErr) {
			log.error(destroyErr, `Server ${serverId}: failed to destroy slice after fatal resource error`)
		}
	}

	const adminList = (() => {
		const adminListTTL = HumanTime.parse('1h')
		// read adminListSources/adminIdentifyingPermissions fresh on every fetch (rather than closing over the setup-time settings)
		// so that SquadServer.invalidateAdminList() picks up edits without needing a full slice restart
		return new AsyncResource<SM.AdminList, CS.Ctx & CS.AbortSignal>(
			`${serverId}/adminLists`,
			async (_ctx) => {
				const currentSettings = await Settings.getServerSettings(getBaseCtx(), serverId)
				// we are duplicating fetches here if two servers have the same source, but shouldn't matter
				return fetchAdminLists(currentSettings.adminListSources, currentSettings.adminIdentifyingPermissions, _ctx.signal)
			},
			module,
			{
				defaultTTL: adminListTTL,
				retries: 3,
				retryDelay: 1000,
				log,
				onFatalError: onResourceFatalError,
			},
		)
	})()
	cleanup.push(() => adminList.dispose())
	const eventState: PendingEvents.State = PendingEvents.init({
		counters: {
			eventId: globalState.serverEventIdCounter,
			squadId: globalState.squadIdCounter,
		},
		currentMatch: 'PENDING',
		log: log,
		hooks: {
			onNewGameDuringRoll: onNewGameDuringRoll(serverId),
			onNewGameDuringSync: onNewGameDuringSync(serverId),
			fetchLayersStatus: async () => {
				const ctx = resolveSliceCtx(getBaseCtx(), serverId)
				const data = await Rx.firstValueFrom(
					ctx.server.layersStatus.observe(ctx, { ttl: 2_000 }).pipe(
						Rx.concatMap((s): SM.LayersStatus[] => s.code === 'ok' ? [s.data] : []),
						Rx.takeUntil(Rx.timer(8_000)),
					),
					{ defaultValue: null },
				)

				if (data) return data
				return null
			},
		},
		// how far a non-log event may lead the log stream before we stop waiting for the log to catch up.
		// A polled source can be a whole poll behind; a pushed one is near-live.
		minSafeLogLeadTimeForOtherEvents: settings.connections.logs.type === 'sftp'
			? settings.connections.logs.pollInterval * 2
			: settings.connections.logs.type === 'local-file'
			? Settings.GLOBAL_SETTINGS.squadServer.logFilePollInterval * 2
			: settings.connections.logs.type === 'log-receiver'
			? 1000
			: assertNever(settings.connections.logs),
	})

	const server: SquadServer = {
		layersStatusExt$,

		postRollEventsSub: null,

		serverRolling$: new Rx.BehaviorSubject(null as number | null),
		tickRate$: new Rx.BehaviorSubject(null as number | null),

		event$: new IsolatedSubject(),
		appEvent$: new IsolatedSubject(),
		processEventsMtx: new Mutex(),

		eventState: eventState,

		chatState: CHAT.getInitialChatState(),
		emittedEvents: [],
		emittedAppEvents: [],
		lastSavedEventId: null,
		savedEventIds: new Set(),
		destroyed: false,
		cleanupId: null,

		savingEventsMtx: new Mutex(),

		...SquadRcon.initSquadRcon({ ...ctx, rcon, adminList, serverId }, cleanup, { onFatalError: onResourceFatalError }),
	}

	cleanup.push(
		() => server.postRollEventsSub,
		server.serverRolling$,
		server.tickRate$,
		server.event$,
		server.appEvent$,
		server.savingEventsMtx,
		server.processEventsMtx,
	)

	const slice: C.ServerSlice = {
		...CS.init(),
		serverId,
		signal,

		rcon,
		server,

		matchHistory: MatchHistory.initMatchHistoryContext(server.event$, cleanup),

		teamswaps: TeamswapsSys.initContext({
			...ctx,
			serverId,
			cleanup,
			server,
		}),
		layerQueue: LayerQueue.initLayerQueueSlice({ ...ctx, cleanup, serverId }, serverState),
		serverSettings: Settings.initServerSettingsSlice({ ...ctx, cleanup, serverId }, serverState),
		vote: Vote.initVoteContext(cleanup),

		adminList,
		cleanup: cleanup,
	}

	globalState.slices.set(serverId, slice)
	globalState.sliceLifecycleUpdate$.next(serverId)

	// -------- load saved events --------
	await loadSavedEvents({ ...ctx, server, serverId })

	// // -------- watch events --------
	server.event$.subscribe(([ctx, event]) => {
		try {
			CHAT.handleEvent(ctx.server.chatState, event)
		} catch (error) {
			log.error(error, 'Error handling event: %s %d', event.type, event.id)
		}
		log.info(
			'emitted event: %s %s',
			event.type,
			JSON.stringify(
				['NEW_GAME', 'RESET'].includes(event.type)
					? Obj.omit(event as any, ['state'])
					: event,
			),
		)
		ctx.server.emittedEvents.push(event)
	})

	server.event$
		.pipe(
			Rx.filter(
				([_, event]) => event.type === 'PLAYER_DETAILS_CHANGED' && !!event.newUsername,
			),
			C.durableSub('onPlayerNameChanged', { module }, async ([ctx, event]) => {
				if (event.type !== 'PLAYER_DETAILS_CHANGED' || !event.newUsername) {
					return
				}
				await ctx
					.db()
					.update(Schema.players)
					.set({ username: event.newUsername })
					.where(E.eq(Schema.players.eosId, event.player))
			}),
		)
		.subscribe()

	// kick-timeout enforcement: fresh connects and full roster reseeds. PLAYER_RECONCILED (roster backfill of an
	// already-present player) is deliberately excluded. RESET fires on every roll, doubling as a periodic sweep.
	server.event$
		.pipe(
			Rx.filter(([_, event]) => event.type === 'PLAYER_CONNECTED' || event.type === 'RESET'),
			C.durableSub('onPlayerConnectedEnforceTimeouts', { module }, async ([ctx, event], signal) => {
				const playerIds = event.type === 'PLAYER_CONNECTED'
					? [SM.PlayerIds.getPlayerId(event.player.ids)]
					: event.type === 'RESET'
					? SE.eventRoster(event)?.players.map(p => SM.PlayerIds.getPlayerId(p.ids)) ?? []
					: []
				if (playerIds.length === 0) return
				await Timeouts.enforceTimeouts(CS.addSignal(ctx, signal), playerIds)
			}),
		)
		.subscribe() // -------- process log events --------
	const logStreamAc = new AbortController()
	cleanup.push(logStreamAc)
	void C.spanOp('processLogEvents', { module }, async (_: unknown) => {
		let chunk$: Rx.Observable<string>
		if (settings.connections.logs.type === 'sftp') {
			const sftpReader = new SftpTail({
				filePath: settings.connections!.logs.logFile,
				host: settings.connections!.logs.host,
				port: settings.connections!.logs.port,
				username: settings.connections!.logs.username,
				password: settings.connections!.logs.password,
				pollInterval: settings.connections.logs.pollInterval,
				reconnectInterval: settings.connections.logs.reconnectInterval,
				maxReconnectAttempts: settings.connections.logs.maxReconnectAttempts,
				// reconnection attempts exhausted: tear the slice down rather than letting the error crash the process
				onFatalError: onResourceFatalError,
				parentModule: module,
			})
			cleanup.push(() => sftpReader.unwatch())
			sftpReader.watch()

			chunk$ = Rx.fromEvent(sftpReader, 'chunk').pipe(
				Rx.map((...args) => args[0] as string),
			)
		} else if (settings.connections.logs.type === 'local-file') {
			const fileReader = new FileTail({
				filePath: settings.connections.logs.logFile,
				pollInterval: Settings.GLOBAL_SETTINGS.squadServer.logFilePollInterval,
				onFatalError: onResourceFatalError,
				parentModule: module,
			})
			cleanup.push(() => fileReader.unwatch())
			fileReader.watch()

			chunk$ = Rx.fromEvent(fileReader, 'chunk').pipe(
				Rx.map((...args) => args[0] as string),
			)
		} else if (settings.connections.logs.type === 'log-receiver') {
			chunk$ = SquadLogsReceiver.streamFor(serverId)
		} else {
			assertNever(settings.connections.logs)
		}

		// Counted on the way in, at the one point every log source (sftp poll, local file tail,
		// log-receiver push) funnels through, so the numbers mean the same thing whichever a server uses. A
		// chunk is not line-aligned, so lines are counted by newline rather than by split length: a
		// chunk that splits a line in half would otherwise count it twice.
		const logSource = settings.connections.logs.type satisfies ATTRS.SquadLogs.Source
		const countedChunk$ = chunk$.pipe(
			Rx.tap((chunk) => {
				const attrs = { [ATTRS.SquadServer.ID]: serverId, [ATTRS.SquadLogs.SOURCE]: logSource }
				logIoCounter.add(Buffer.byteLength(chunk, 'utf8'), attrs)
				let lines = 0
				for (let i = 0; i < chunk.length; i++) {
					if (chunk[i] === '\n') lines++
				}
				if (lines > 0) logLineCounter.add(lines, attrs)
			}),
		)

		const errors: Error[] = []
		for await (
			const event of SM.LogEvents.parseLogStream(
				toAsyncGenerator(countedChunk$.pipe(withAbortSignal(logStreamAc.signal))),
				errors,
				(rate) => server.tickRate$.next(rate),
			)
		) {
			if (logStreamAc.signal.aborted) break
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			for (const error of errors) log.error(error)
			errors.splice(0, errors.length)

			if (!event) {
				log.warn('No log event to process')
				return
			}

			logEventCounter.add(1, { [ATTRS.SquadServer.ID]: serverId, [ATTRS.SquadLogs.SOURCE]: logSource })

			await collectEvents(ctx, () => {
				PendingEvents.onLogEvent(ctx.server.eventState, event)
			})
		}
	})({ ...ctx, server })

	cleanup.push(
		rcon.connected$
			.pipe(
				C.durableSub(
					'onRconConnectStatusChange',
					{ module },
					async (connected, signal) => {
						const ctx = resolveSliceCtx(CS.addSignal(getBaseCtx(), signal), serverId)
						const time = Date.now()
						let layerStatus: SM.LayersStatusResExt | undefined
						let layersData: SM.LayersStatusExt | undefined
						if (connected) {
							layerStatus = await ctx.server.layersStatus.get({ ...ctx, rcon })
							if (layerStatus.code !== 'ok') return layerStatus
							layersData = layerStatus.data
						}
						await collectEvents({ ...ctx, server }, () => {
							if (connected) {
								PendingEvents.onRconConnected(
									ctx.server.eventState,
									time,
									layersData!.nextLayer?.id ?? null,
									layersData!.currentLayer.id,
								)
							} else {
								PendingEvents.onRconDisconnected(ctx.server.eventState, time)
							}
						})
					},
				),
			)
			.subscribe(),
	)

	// -------- process rcon events --------
	cleanup.push(
		server.rconEvent$
			.pipe(
				C.durableSub(
					'onRconEvent',
					{ module, taskScheduling: 'parallel', levels: { event: 'trace' } },
					async ([_ctx, event], signal) => {
						const ctx = CS.initDeferred(DB.addPooledDb(resolveSliceCtx(CS.addSignal({ ..._ctx }, signal), serverId)))
						try {
							const opts: Promise<void>[] = []
							if (event.type === 'CHAT_MESSAGE') {
								if (Settings.GLOBAL_SETTINGS.allowedPrefixes.some((prefix) => event.message.startsWith(prefix))) {
									opts.push(
										Commands.handleCommand(ctx, event).then((res) => {
											if (res && res?.code !== 'ok') log.error(res)
										}),
									)
								} else if (
									event.message.trim().match(/^\d+$/)
									&& ctx.vote.state?.code === 'in-progress'
								) {
									opts.push(Vote.handleVote(ctx, event))
								}
							}
							await Promise.all(opts)
						} catch (err) {
							log.error(err)
						}

						await collectEvents(ctx, () => {
							PendingEvents.onRconEvent(ctx.server.eventState, event)
						})

						// drain best-effort side work (e.g. vote-cast warns) scheduled by the handlers above, so it
						// finishes inside this task's lifetime and signal instead of leaking as a floating promise
						for (const err of await CS.awaitDeferred(ctx)) log.error(err)
					},
				),
			)
			.subscribe(),
	)

	cleanup.push(
		server.teams
			.observe({ ...slice, ...ctx })
			.pipe(
				C.durableSub(
					'onTeamsPolled',
					{ module, numTaskRetries: 0, levels: { event: 'debug' } },
					async (teamsRes, signal) => {
						if (teamsRes.code !== 'ok') return teamsRes
						const receivedAt = Date.now()
						const ctx = resolveSliceCtx(CS.addSignal(getBaseCtx(), signal), serverId)
						await collectEvents(ctx, () => {
							PendingEvents.onTeamsPolled(
								server.eventState,
								{ players: teamsRes.players, squads: teamsRes.squads },
								receivedAt,
								teamsRes.polledAt,
							)
						})
					},
				),
			)
			.subscribe(),
	)

	{
		// -------- periodically save events  --------
		const saveEventSub = Rx.interval(10_000)
			.pipe(
				Rx.filter(() => {
					const ctx = resolveSliceCtx(getBaseCtx(), serverId)
					return ctx.server.emittedEvents.length > 0
						&& ctx.server.lastSavedEventId !== ctx.server.emittedEvents[ctx.server.emittedEvents.length - 1].id
				}),
				C.durableSub(
					'save-events-interval',
					{ module, root: true, taskScheduling: 'exhaust' },
					async () => {
						const ctx = resolveSliceCtx(getBaseCtx(), serverId)
						return saveEvents(ctx)
					},
				),
			)
			.subscribe()

		// -------- save remaining events on cleanup  --------
		cleanup.push(async () => {
			const ctx = resolveSliceCtx(getBaseCtx(), serverId)
			saveEventSub.unsubscribe()
			await saveEvents(ctx)
		})
	}

	void LayerQueue.setupInstance({ ...ctx, ...slice })
	Battlemetrics.setupSquadServerInstance({ ...ctx, ...slice })
	void adminList.get(slice)

	server.cleanupId = CleanupSys.register(async () => {
		const ctx = resolveSliceCtx(getBaseCtx(), serverId)
		await destroyServer(ctx)
	})
	log.info('Initialized server %s', serverId)
	if (Settings.GLOBAL_SETTINGS.warnOnSlmStart) {
		await SquadRcon.warnAllAdmins({ ...ctx, ...slice }, Messages.WARNS.slmStarted(AppEventsSys.restartInfo?.name))
	}
}

export async function pushAttribution(ctx: C.SquadServer & C.Db & CS.AbortSignal, attribution: Omit<PendingEvents.Attribution, 'time'>) {
	await collectEvents(ctx, () => {
		PendingEvents.pushAttribution(ctx.server.eventState, attribution)
	})
}

// persists an SLM app (audit) event and streams it into this server's activity feed. Persist happens before
// the push (and before any server event that links to it via appEventId is later saved), satisfying the FK.
export async function emitAppEvent(ctx: C.SquadServer & C.Db & CS.AbortSignal, appEvent: AppEvents.AppEvent) {
	await AppEventsSys.persistAppEvent(ctx, appEvent)
	ctx.server.emittedAppEvents.push(appEvent)
	ctx.server.appEvent$.next([resolveSliceCtx(ctx, ctx.serverId), appEvent])
}

// resolves a preset admin-action reason against the current global settings. handlers call this before executing
// anything so a stale preset (deleted/retargeted since the client loaded it) fails the whole action.
export function resolvePresetReason(action: AAR.AdminActionType, presetReasonLabel: string) {
	return AAR.resolveReason(Settings.GLOBAL_SETTINGS.adminActionReasons, action, presetReasonLabel)
}

// the variable context for reason/broadcast message templates: the admin-configured custom variables,
// overlaid with any per-call standard variables (e.g. duration)
export function messageVars(extra?: Record<string, string>): Record<string, string> {
	const custom = Object.fromEntries(Settings.GLOBAL_SETTINGS.messageVariables.map(v => [v.name, v.value]))
	return { ...custom, ...extra }
}

// enforces the per-action "require a reason" setting; returns an error result when the action needs a reason
// and none was provided, else null. A warn is nothing but its reason, so one is always required (which is why
// warn isn't configurable in requireReasonFor).
export function reasonRequirementError(
	action: AAR.AdminActionType,
	hasReason: boolean,
): { code: 'err:reason-required'; msg: string } | null {
	if (hasReason) return null
	const required = action === 'warn' || Settings.GLOBAL_SETTINGS.requireReasonFor.some((a) => a === action)
	if (required) return { code: 'err:reason-required', msg: `A reason is required for ${AAR.ADMIN_ACTIONS[action].displayName}.` }
	return null
}

// resolves a web action's reason input into an AppliedReason snapshot: enforces the require-reason setting,
// resolves preset labels against current settings (a stale preset fails the whole action), and snapshots the
// message variables so custom and preset text render identically everywhere. `applied` is undefined only when
// no reason was given and the action doesn't require one.
export function resolveReasonInput(
	action: AAR.AdminActionType,
	input: { reason?: string; presetReasonLabel?: string },
	extraVars?: Record<string, string>,
):
	| { code: 'ok'; applied?: AAR.AppliedReason }
	| { code: 'err:reason-required'; msg: string }
	| Exclude<AAR.ResolveReasonRes, { code: 'ok' }>
{
	const rr = reasonRequirementError(action, !!(input.reason || input.presetReasonLabel))
	if (rr) return rr
	if (input.presetReasonLabel) {
		const res = resolvePresetReason(action, input.presetReasonLabel)
		if (res.code !== 'ok') return res
		return { code: 'ok', applied: AAR.applyReason(action, res.reason, messageVars(extraVars)) }
	}
	if (input.reason) return { code: 'ok', applied: AAR.applyCustomReason(input.reason, messageVars(extraVars)) }
	return { code: 'ok' }
}

// warns every in-game admin of a web-initiated admin action so they see activity they'd otherwise only find in
// the web feed. In-game commands already echo to the invoking admin via reply() (and warn the target), so this
// fires only for slm-user (web) actors; ingame-user/system actions no-op.
export async function notifyAdminsOfWebAction(
	ctx: C.SquadRcon & C.AdminList & C.Db & CS.AbortSignal,
	appEvent: AppEvents.AppEvent,
	// override the default describeAppEvent phrasing (e.g. squad warns name the squad + faction)
	description?: string,
) {
	if (appEvent.actor.type !== 'slm-user') return
	const [user] = await ctx.db()
		.select({ nickname: Schema.users.nickname, username: Schema.users.username })
		.from(Schema.users)
		.where(E.eq(Schema.users.discordId, appEvent.actor.userId))
	const name = user?.nickname || user?.username || 'An admin'
	await SquadRcon.warnAllAdmins(ctx, `${name} ${description ?? AppEvents.describeAppEvent(appEvent)}`)
}

// delivers a preset reason's message to the affected players as an in-game warn, attributing the landing
// PLAYER_WARNED server events to the originating action's app event (so they collapse under it in the feed
// rather than emitting a separate PLAYER_WARNED app event).
async function sendReasonFollowUpWarn(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & CS.AbortSignal,
	appEventId: AppEvents.AppEventId,
	targets: SM.PlayerId[],
	message: string,
) {
	if (targets.length === 0) return
	const source = { type: 'event' as const, id: appEventId }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.expectWarn(ctx.server.eventState, { playerId: target, reason: message, source })
		}
	})
	await SquadRcon.warnAll(ctx, targets, message)
}

// kicks a single player, attributing the resulting PLAYER_KICKED server event to `source` (the app event that
// caused it: PLAYER_TIMED_OUT for timeout kicks and their later enforcement, PLAYER_KICKED for plain kicks).
// The primitive both kick paths bottom out in; it emits no app event of its own.
export async function kickPlayerAction(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & CS.AbortSignal,
	target: SM.PlayerId,
	source: PendingEvents.ArmedActionSource,
	reason?: string,
) {
	await collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_KICKED', playerId: target }, source)
	})
	await SquadRcon.kickPlayer(ctx, target, reason)
}

// the delivered kick message when no reason was given
const DEFAULT_KICK_TEXT = 'You have been kicked by an admin.'

// a plain kick (no timeout): the players are removed and may rejoin immediately. One app event covers the whole
// batch, and each kick's server event is attributed to it.
export async function kickPlayersAction(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerKicked>({
		type: 'PLAYER_KICKED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const message = reason ? AAR.renderAppliedReason(reason) : DEFAULT_KICK_TEXT
	for (const target of targets) {
		await kickPlayerAction(ctx, target, { type: 'event', id: appEvent.id }, message)
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}

export async function broadcastAction(
	ctx: C.SquadServer & C.Rcon & C.Db & CS.AbortSignal,
	message: string,
	actor: AppEvents.Actor,
	opts?: { presetLabel?: string },
) {
	// render {{var}} templating; the rendered text is what's broadcast and what the audit records
	const rendered = Templating.renderTemplate(message, messageVars({ label: opts?.presetLabel ?? '' }))
	const appEvent = AppEvents.create<AppEvents.BroadcastSent>({
		type: 'BROADCAST_SENT',
		actor,
		serverId: ctx.serverId,
		// audit-log only (matchId null): the ADMIN_BROADCAST server event already renders the broadcast in the
		// activity feed, and pending-events has no broadcast expectation to collapse the two, so a feed-visible
		// app event would duplicate every broadcast line
		matchId: null,
		causeId: null,
		message: rendered,
		presetLabel: opts?.presetLabel,
	})
	await emitAppEvent(ctx, appEvent)
	await SquadRcon.broadcast(ctx, rendered)
}

// warns players through an app event: creates the PLAYER_WARNED app event (so the feed can aggregate the
// resulting warns under one entry), arms the pending-events machine to attribute each landing PLAYER_WARNED server
// event to it, then issues the warns. Emit (persist) precedes arming and the warns so the app event exists before
// any server event referencing it is saved.
export async function warnPlayers(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	targets: SM.PlayerId[],
	reason: string,
	actor: AppEvents.Actor,
	// suppressAdminNotify: the "warn admins" feature already targets every admin, so skip the meta-notification there.
	// adminNotifyDescription: override the admin-notification phrasing (squad warns name the squad + faction)
	opts?: { reasonLabel?: string; suppressAdminNotify?: boolean; adminNotifyDescription?: string },
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerWarned>({
		type: 'PLAYER_WARNED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		message: reason,
		targets,
		reasonLabel: opts?.reasonLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.expectWarn(ctx.server.eventState, { playerId: target, reason, source })
		}
	})
	await SquadRcon.warnAll(ctx, targets, reason)
	if (!opts?.suppressAdminNotify) await notifyAdminsOfWebAction(ctx, appEvent, opts?.adminNotifyDescription)
}

// disbands a squad through an app event: records the squad + its members, arms the machine to attribute the
// resulting SQUAD_DISBANDED server event to the acting user, then issues the disband.
export async function disbandSquadAction(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	teamId: SM.TeamId,
	squadId: SM.SquadId,
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const teams = getCurrTeams(ctx)
	const squad = teams?.squads.find(s => s.teamId === teamId && s.squadId === squadId)
	const members = teams?.players
		.filter(p => p.teamId === teamId && p.squadId === squadId)
		.map(p => SM.PlayerIds.getPlayerId(p.ids)) ?? []
	const appEvent = AppEvents.create<AppEvents.SquadDisbanded>({
		type: 'SQUAD_DISBANDED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		teamId,
		squadId,
		squadName: squad?.squadName ?? `Squad ${squadId}`,
		members,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'SQUAD_DISBANDED', teamId, squadId }, source)
	})
	await SquadRcon.disbandSquad(ctx, teamId, squadId)
	if (reason) {
		await sendReasonFollowUpWarn(
			ctx,
			appEvent.id,
			members,
			AAR.renderAppliedReason(reason, { squadTag: squad ? SM.squadWarnTag(squad) : `@Squad${squadId}` }),
		)
	}
	// name the squad + faction consistently with squad warns (e.g. "disbanded Squad1 (PLA)")
	const squadLabel = squad ? SM.squadAdminLabel(squad, MH.getTeamFaction(currentMatch, teamId)) : `Squad${squadId}`
	await notifyAdminsOfWebAction(ctx, appEvent, `disbanded ${squadLabel}${reason?.label ? ` for ${reason.label}` : ''}`)
}

// removes players from their squads through an app event, attributing each resulting PLAYER_LEFT_SQUAD server event
export async function removePlayersFromSquad(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerRemovedFromSquad>({
		type: 'PLAYER_REMOVED_FROM_SQUAD',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_LEFT_SQUAD', playerId: target }, source)
		}
	})
	await Promise.all(targets.map(target => SquadRcon.removeFromSquad(ctx, target)))
	if (reason) {
		await sendReasonFollowUpWarn(ctx, appEvent.id, targets, AAR.renderAppliedReason(reason))
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}

// records a forced team change as an app event and arms attribution for the resulting PLAYER_CHANGED_TEAM server
// events (which arrive via the next teams poll). The caller (teamswaps) still issues the actual switch.
export async function forceTeamChangeAppEvent(
	ctx: C.SquadServer & C.Db & C.MatchHistory & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.TeamChangeForced>({
		type: 'TEAM_CHANGE_FORCED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_CHANGED_TEAM', playerId: target }, source)
		}
	})
}

// records a kill as an app event and arms attribution for any resulting PLAYER_CHANGED_TEAM server events. The
// double switch nets zero, so a settled teams poll usually emits none; arming keeps parity with the forced-switch
// path in case a poll observes an intermediate state.
export async function killPlayersAppEvent(
	ctx: C.SquadServer & C.Db & C.MatchHistory & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: string,
	reasonLabel?: string,
): Promise<AppEvents.PlayerKilled | undefined> {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerKilled>({
		type: 'PLAYER_KILLED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
		reason,
		reasonLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_CHANGED_TEAM', playerId: target }, source)
		}
	})
	return appEvent
}

export async function killPlayersAction(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: string,
	reasonLabel?: string,
) {
	if (targets.length === 0) return
	const appEvent = await killPlayersAppEvent(ctx, targets, actor, reason, reasonLabel)
	await SquadRcon.killPlayers(ctx, targets, reason)
	if (appEvent) await notifyAdminsOfWebAction(ctx, appEvent)
}

export async function renameSquadAction(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	teamId: SM.TeamId,
	squadId: SM.SquadId,
	actor: AppEvents.Actor,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const squad = getCurrTeams(ctx)?.squads.find(s => s.teamId === teamId && s.squadId === squadId)
	const appEvent = AppEvents.create<AppEvents.SquadRenamed>({
		type: 'SQUAD_RENAMED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		teamId,
		squadId,
		squadName: squad?.squadName ?? `Squad ${squadId}`,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'SQUAD_RENAMED', teamId, squadId }, source)
	})
	await SquadRcon.adminRenameSquad(ctx, teamId, squadId)
}

// demoting a commander has no attributable server event, so this is a pure audit-feed entry
export async function demoteCommanderAction(
	ctx: C.SquadServer & C.Rcon & C.AdminList & C.Db & C.MatchHistory & CS.AbortSignal,
	playerId: SM.PlayerId,
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.CommanderDemoted>({
		type: 'COMMANDER_DEMOTED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		target: playerId,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	await SquadRcon.demoteCommander(ctx, playerId)
	if (reason) {
		await sendReasonFollowUpWarn(ctx, appEvent.id, [playerId], AAR.renderAppliedReason(reason))
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}

// interleaves server events and app events by time for the activity feed. app events sort before server events on
// ties (placed first + stable sort) so a warn's aggregating app event is already in the client buffer when its
// collapsed server events arrive. app events are wrapped for the wire (see CHAT.AppFeedEvent).
function mergeEventsByTime(serverEvents: SE.Event[], appEvents: AppEvents.AppEvent[]): (SE.Event | CHAT.AppFeedEvent)[] {
	const wrapped: CHAT.AppFeedEvent[] = appEvents.map((appEvent) => ({ type: 'APP_EVENT', appEvent }))
	const timeOf = (e: SE.Event | CHAT.AppFeedEvent) => e.type === 'APP_EVENT' ? e.appEvent.time : e.time
	return [...wrapped, ...serverEvents].sort((a, b) => timeOf(a) - timeOf(b))
}

const destroyServer = C.spanOp('destroyServer', { module, levels: { event: 'info' } }, async (ctx: C.ServerSlice) => {
	if (ctx.server.destroyed) return
	log.info(`destroying server slice ${ctx.serverId}`)
	ctx.server.destroyed = true
	sliceAbortControllers.get(ctx.serverId)?.abort(new DOMException('server slice destroyed', 'AbortError'))
	sliceAbortControllers.delete(ctx.serverId)
	const cleanupId = ctx.server.cleanupId
	if (cleanupId !== null) CleanupSys.unregister(cleanupId)
	await Cleanup.runCleanup({ ...CS.init(), ...ctx, log }, ctx.cleanup)
	// we're not dealing with mutexes yet Sadge
	globalState.slices.delete(ctx.serverId)
	globalState.sliceLifecycleUpdate$.next(ctx.serverId)
})

export async function getFullServerState(ctx: C.Db & C.LayerQueue) {
	const query = ctx
		.db()
		.select()
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	const state = SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
	return { ...state, settings: Settings.openConnections(state.settings) }
}

export function getCurrTeams(ctx: C.SquadServer) {
	return ctx.server.eventState.currTeams
}

// maps a GUI/chat user id (or an automated marker) to an app-event actor, resolving in-game (steam) senders against
// the current teams. Shared by the vote/teamswap attribution paths.
export function actorFromUser(ctx: C.SquadServer, source: USR.GuiOrChatUserId | 'autostart' | undefined | null): AppEvents.Actor {
	if (!source || source === 'autostart') return { type: 'system' }
	if (source.discordId) return { type: 'slm-user', userId: source.discordId }
	if (source.steamId) {
		const player = SM.PlayerIds.find(getCurrTeams(ctx)?.players ?? [], p => p.ids, { steam: source.steamId })
		if (player) return { type: 'ingame-user', playerId: SM.PlayerIds.getPlayerId(player.ids) }
	}
	return { type: 'system' }
}

async function collectEvents(
	ctx: C.SquadServer & C.Db & CS.AbortSignal,
	addEventsCb: () => void,
) {
	using _lock = await acquireInBlock(ctx.server.processEventsMtx, { signal: ctx.signal })
	addEventsCb()
	for await (
		const event of PendingEvents.process(
			ctx.server.eventState,
			Date.now(),
		)
	) {
		// the single funnel for every server event, whatever produced it
		serverEventCounter.add(1, {
			[ATTRS.SquadServer.ID]: ctx.serverId,
			[ATTRS.ServerEvent.TYPE]: event.type,
		})
		ctx.server.event$.next([resolveSliceCtx(ctx, ctx.serverId), event])
	}
}

function getLayersStatusExt$(serverId: string) {
	return new Rx.Observable<SM.LayersStatusResExt>((s) => {
		const ctx = { ...getBaseCtx(), ...globalState.slices.get(serverId)! }
		const sub = new Rx.Subscription()
		sub.add(
			ctx.server.layersStatus.observe(ctx).subscribe({
				next: async () => {
					s.next(await fetchLayersStatusExt(ctx))
				},
				error: (err) => s.error(err),

				// this is what causes the observable to be completed when a server is destroyed
				complete: () => s.complete(),
			}),
		)
		sub.add(
			ctx.matchHistory.update$.subscribe({
				next: async () => {
					s.next(await fetchLayersStatusExt(ctx))
				},
				error: (err) => s.error(err),
				complete: () => s.complete(),
			}),
		)
		return () => sub.unsubscribe()
	}).pipe(distinctDeepEquals(), Rx.share())
}

async function fetchLayersStatusExt(
	ctx: C.SquadServer & C.Rcon & C.MatchHistory & CS.AbortSignal,
) {
	const statusRes = await ctx.server.layersStatus.get(ctx)
	if (statusRes.code !== 'ok') return statusRes
	return buildServerStatusRes(
		statusRes.data,
		await MatchHistory.getCurrentMatch(ctx),
	)
}

function buildServerStatusRes(
	rconStatus: SM.LayersStatus,
	currentMatch: MH.MatchDetails,
) {
	const res: SM.LayersStatusResExt = {
		code: 'ok' as const,
		data: { ...rconStatus },
	}
	if (
		currentMatch
		&& L.areLayersCompatible(currentMatch.layerId, rconStatus.currentLayer)
	) {
		res.data.currentMatch = currentMatch
	}
	return res
}

// resolves a default server id for a request given the route and a previously stored default server id
export function manageDefaultServerIdForRequest<Ctx extends C.HttpRequest>(
	ctx: Ctx,
) {
	const servers = Settings.listServerEntries()
		.filter((s) => s.enabled && globalState.slices.has(s.id))
		.toSorted((a, b) => {
			if (a.defaultServer !== b.defaultServer) return a.defaultServer ? -1 : 1
			return 0
		})

	const res = ctx.res

	if (servers.length === 0) {
		// Clear any stale server cookie so the client doesn't try to connect to a disabled server
		if (ctx.cookies['default-server-id']) {
			res.clearCookie(AR.COOKIE_KEY.enum['default-server-id'], AR.COOKIE_DEFAULTS)
		}
		return { ...ctx, res }
	}

	const defaultServerId = ctx.cookies['default-server-id']
	let serverId: string
	if (ctx.route?.id === AR.route('/servers/:id') && servers.some((s) => s.id === ctx.route!.params.id)) {
		// keep the default in sync with the server being viewed -- but only when it's a real server. An invalid id (e.g.
		// /servers/undefined) still renders a client-side 404, we just must not persist it as the default server.
		serverId = ctx.route.params.id
	} else if (defaultServerId && servers.some((s) => s.id === defaultServerId)) {
		serverId = defaultServerId
	} else {
		serverId = servers[0].id
	}

	if (serverId !== defaultServerId) {
		res.cookie(AR.COOKIE_KEY.enum['default-server-id'], serverId, {
			...AR.COOKIE_DEFAULTS,
			httpOnly: false,
		})
	}

	return {
		...ctx,
		res,
	}
}

function withSliceSignal<T extends object>(ctx: T, slice: C.ServerSlice) {
	// cancel when either the caller (e.g. the originating request) or the slice is done. the slice signal
	// already covers process shutdown, so don't allocate a composite for base ctxs on the hot event path
	const callerSignal = (ctx as Partial<CS.AbortSignal>).signal
	const signal = callerSignal === CleanupSys.shutdownSignal ? slice.signal : anySignal(callerSignal, slice.signal)!
	return {
		...ctx,
		...slice,
		signal,
	}
}

// throws when the slice is missing. Only for callers running inside the slice's own lifecycle (setup loops, timers,
// event handlers), where a missing slice is a bug rather than a state the caller has to render. oRPC handlers should
// use trySliceCtx / sliceStream$ instead, so the client gets a code it can act on.
export function resolveSliceCtx<T extends object>(ctx: T, serverId: string) {
	const slice = globalState.slices.get(serverId)
	if (!slice) {
		throw new Orpc.ORPCError('BAD_REQUEST', {
			message: 'Server slice not found: ' + serverId,
		})
	}
	return withSliceSignal(ctx, slice)
}

export function trySliceCtx<T extends object>(
	ctx: T,
	serverId: string,
): { code: 'ok'; ctx: ReturnType<typeof withSliceSignal<T>> } | SM.ServerNotLoaded {
	const slice = globalState.slices.get(serverId)
	if (!slice) return SM.serverNotLoaded(serverId)
	return { code: 'ok', ctx: withSliceSignal(ctx, slice) }
}

// like selectedServerCtx$, but keyed by an explicit serverId instead of a wsClientId's session selection
export function sliceCtx$(wsClientId: string, serverId: string) {
	return globalState.sliceLifecycleUpdate$.pipe(
		Rx.filter((id) => id === serverId),
		Rx.startWith(serverId),
		Rx.map(() => {
			const slice = globalState.slices.get(serverId)
			if (!slice) return null
			return { ...getBaseCtx(), ...WsSessionSys.wsSessions.get(wsClientId)!, ...slice }
		}),
	)
}

export type SliceCtx = NonNullable<Rx.ObservedValueOf<ReturnType<typeof sliceCtx$>>>

// the only way an oRPC stream should resolve a slice. While the slice is absent the stream emits err:server-not-loaded
// rather than going silent (a silent stream leaves the client suspended forever), and it switches over to the real
// source as soon as the slice appears -- so a server being enabled, or coming back after a crash, self-heals.
export function sliceStream$<T>(
	wsClientId: string,
	serverId: string,
	project: (ctx: SliceCtx) => Rx.Observable<T>,
): Rx.Observable<T | SM.ServerNotLoaded> {
	return sliceCtx$(wsClientId, serverId).pipe(
		Rx.switchMap((ctx): Rx.Observable<T | SM.ServerNotLoaded> => {
			if (!ctx) return Rx.of(SM.serverNotLoaded(serverId))
			return project(ctx)
		}),
	)
}

function getBaseCtx() {
	return DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
}

// registry data (identity/enabled/default/broken) lives in settings.server.ts; this only orchestrates the live slice around it
export async function enableServer(serverId: string) {
	const ctx = getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, true)
	if (res.code !== 'ok') return res
	await ensureSliceRunning(serverId)
	log.info('Server %s enabled', serverId)
	return { code: 'ok' as const }
}

export async function disableServer(serverId: string) {
	const ctx = getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, false)
	if (res.code !== 'ok') return res

	const slice = globalState.slices.get(serverId)
	if (slice) {
		await destroyServer({ ...ctx, ...slice })
	}
	log.info('Server %s disabled', serverId)
	return { code: 'ok' as const }
}

export async function deleteServer(serverId: string) {
	const ctx = getBaseCtx()
	const slice = globalState.slices.get(serverId)
	if (slice) {
		await destroyServer({ ...ctx, ...slice })
	}
	return await Settings.deleteServerEntry(ctx, serverId)
}

export async function getServerState(ctx: C.Db & C.ServerId) {
	const query = ctx
		.db()
		.select()
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	const state = SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
	return { ...state, settings: Settings.openConnections(state.settings) }
}

// settings changes go through Settings.updateServerSettings instead — that's the one source of truth for reading/writing/broadcasting settings
export async function updateServerState(
	ctx: C.Db & C.Tx & C.LayerQueue,
	changes: Partial<Omit<SS.ServerState, 'settings'>>,
	source: SS.LQStateUpdate['source'],
) {
	const serverState = await getServerState(ctx)
	const newServerState = { ...serverState, ...changes }
	await ctx
		.db()
		.update(Schema.servers)
		.set(
			superjsonify(Schema.servers, changes),
		)
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const update: SS.LQStateUpdate = { state: newServerState, source }

	ctx.tx.unlockTasks.push(() =>
		ctx.layerQueue.update$.next([
			update,
			{ ...getBaseCtx(), serverId: ctx.serverId },
		])
	)
	return newServerState
}

const loadSavedEvents = C.spanOp(
	'loadSavedEvents',
	{ module },
	async (ctx: C.SquadServer & C.Db) => {
		const server = ctx.server
		const [lastMatch] = await ctx
			.db()
			.select({ id: Schema.matchHistory.id })
			.from(Schema.matchHistory)
			.where(E.eq(Schema.matchHistory.serverId, ctx.serverId))
			.orderBy(E.desc(Schema.matchHistory.ordinal))
			.limit(1)

		const rowsRaw = lastMatch
			? await ctx
				.db()
				.select({ event: Schema.serverEvents })
				.from(Schema.serverEvents)
				.where(E.eq(Schema.serverEvents.matchId, lastMatch.id))
				.orderBy(E.asc(Schema.serverEvents.id))
			: []
		const events = rowsRaw.map((r) => SE.fromEventRow(r.event))
		server.lastSavedEventId = events[events.length - 1]?.id ?? null
		server.emittedEvents = events
		server.savedEventIds = new Set(events.map((e) => e.id))

		const appEventRows = lastMatch
			? await ctx
				.db()
				.select()
				.from(Schema.appEvents)
				.where(E.eq(Schema.appEvents.matchId, lastMatch.id))
				.orderBy(E.asc(Schema.appEvents.time))
			: []
		server.emittedAppEvents = appEventRows.map((r) => AppEvents.fromRow(r)).filter((e): e is AppEvents.AppEvent => e !== null)
	},
)

type EventInsertRows = {
	eventRow: SchemaModels.NewServerEvent
	playerRows: SchemaModels.NewPlayer[]
	playerAssociationRows: SchemaModels.NewPlayerEventAssociation[]
	squadRows: SchemaModels.NewSquad[]
	squadAssociationRows: SchemaModels.NewSquadEventAssociation[]
}

function buildEventRows(ctx: CS.Log, event: SE.Event): EventInsertRows {
	const persisted = Obj.omit(event, ['id', 'type', 'time', 'matchId'])
	// queryable projection of source when it links to an app event
	const source = (event as { source?: { type: string; id?: string } }).source
	const eventRow: SchemaModels.NewServerEvent = {
		id: event.id,
		type: event.type,
		time: new Date(event.time),
		matchId: event.matchId,
		appEventId: source?.type === 'event' ? source.id! : null,
		data: superjson.serialize(persisted),
	}

	const playerRows: SchemaModels.NewPlayer[] = []
	const playerAssociationRows: SchemaModels.NewPlayerEventAssociation[] = []
	for (const [player, assocType] of SE.iterAssocPlayers(event)) {
		let playerId: SM.PlayerId
		if (typeof player === 'object') {
			playerRows.push({
				steamId: player.ids.steam ? BigInt(player.ids.steam) : null,
				eosId: player.ids.eos,
				username: player.ids.username,
				epicId: player.ids.epic,
			})
			playerId = SM.PlayerIds.getPlayerId(player.ids)
		} else {
			playerId = player
		}
		playerAssociationRows.push({ assocType, playerId, serverEventId: event.id })
	}

	const squadRows: SchemaModels.NewSquad[] = []
	const squadAssociationRows: SchemaModels.NewSquadEventAssociation[] = []
	for (const squad of SE.iterAssocUniqueSquads(ctx, event)) {
		let uniqueSquadId: number
		if (typeof squad === 'object') {
			squadRows.push({
				id: squad.uniqueId,
				ingameSquadId: squad.squadId,
				name: squad.squadName,
				creatorId: squad.creator,
				teamId: squad.teamId,
			})
			uniqueSquadId = squad.uniqueId
		} else {
			uniqueSquadId = squad
		}
		squadAssociationRows.push({ squadId: uniqueSquadId, serverEventId: event.id })
	}

	return { eventRow, playerRows, playerAssociationRows, squadRows, squadAssociationRows }
}

// Persists the rows for a single event. Kept as one unit so a caller can wrap it in a per-event transaction:
// any statement here that throws (a constraint violation, a bad steamId, an unknown-player FK) aborts only this
// event, letting the caller log it and move on rather than rolling back an entire batch.
async function insertEventRows(ctx: C.Db, rows: EventInsertRows) {
	await ctx
		.db()
		.insert(Schema.serverEvents)
		.values([rows.eventRow])

	if (rows.playerRows.length > 0) {
		await ctx
			.db()
			.insert(Schema.players)
			.values(rows.playerRows)
			.onConflictDoUpdate({
				target: Schema.players.eosId,
				set: {
					steamId: sql`excluded.steamId`,
					username: sql`excluded.username`,
					modifiedAt: new Date(),
				},
			})
	}

	if (rows.playerAssociationRows.length > 0) {
		const insertedEosIds = new Set(rows.playerRows.map((p) => p.eosId))
		const playersToLookup = [
			...new Set(rows.playerAssociationRows.map((r) => r.playerId).filter((id) => !insertedEosIds.has(id))),
		]
		let existingIds = new Set<SM.PlayerId>()
		if (playersToLookup.length > 0) {
			const existingPlayers = await ctx
				.db()
				.select({ eosId: Schema.players.eosId })
				.from(Schema.players)
				.where(E.inArray(Schema.players.eosId, playersToLookup))
			existingIds = new Set(existingPlayers.map((p) => p.eosId))
		}
		const validRows = rows.playerAssociationRows.filter((r) => {
			if (insertedEosIds.has(r.playerId)) return true
			if (existingIds.has(r.playerId)) return true
			log.error(
				'skipping playerEventAssociation for unknown player %s (event %d)',
				r.playerId,
				r.serverEventId,
			)
			return false
		})
		if (validRows.length > 0) {
			await ctx
				.db()
				.insert(Schema.playerEventAssociations)
				.values(validRows)
				.onConflictDoNothing({
					target: [
						Schema.playerEventAssociations.serverEventId,
						Schema.playerEventAssociations.playerId,
						Schema.playerEventAssociations.assocType,
					],
				})
		}
	}

	if (rows.squadRows.length > 0) {
		// creatorId references players.eosId, but the creator may have left before we ever persisted them (e.g. a
		// squad snapshotted or synthesized from a poll). Null the reference out rather than failing the whole event.
		const insertedEosIds = new Set(rows.playerRows.map((p) => p.eosId))
		const creatorsToLookup = [
			...new Set(rows.squadRows.map((s) => s.creatorId).filter((id): id is string => !!id && !insertedEosIds.has(id))),
		]
		let knownCreatorIds = new Set<string>()
		if (creatorsToLookup.length > 0) {
			const existingPlayers = await ctx
				.db()
				.select({ eosId: Schema.players.eosId })
				.from(Schema.players)
				.where(E.inArray(Schema.players.eosId, creatorsToLookup))
			knownCreatorIds = new Set(existingPlayers.map((p) => p.eosId))
		}
		const squadRows = rows.squadRows.map((s) => {
			if (!s.creatorId || insertedEosIds.has(s.creatorId) || knownCreatorIds.has(s.creatorId)) return s
			log.warn('squad %d creator %s not in players table; inserting with null creatorId', s.id, s.creatorId)
			return { ...s, creatorId: null }
		})
		await ctx
			.db()
			.insert(Schema.squads)
			.values(squadRows)
			.onConflictDoUpdate({
				target: Schema.squads.id,
				set: {
					ingameSquadId: sql`excluded.ingameSquadId`,
					teamId: sql`excluded.teamId`,
					name: sql`excluded.name`,
					creatorId: sql`excluded.creatorId`,
				},
			})
	}

	if (rows.squadAssociationRows.length > 0) {
		await ctx
			.db()
			.insert(Schema.squadEventAssociations)
			.values(rows.squadAssociationRows)
			.onConflictDoNothing({
				target: [Schema.squadEventAssociations.serverEventId, Schema.squadEventAssociations.squadId],
			})
	}
}

// Persists buffered events one at a time, each in its own transaction. If any row insert for an event throws
// (a constraint violation, a malformed steamId, etc.) the event is logged in full and skipped, so a single bad
// event can neither roll back the rest of the batch nor silently drop it. The in-memory cursor advances only
// after each event is dealt with, keeping it in step with the DB even across a crash mid-batch.
//
// NOTE: a failing event is skipped (its cursor advances) after being logged, so its data is dropped on purpose
// rather than becoming a poison pill that blocks every later event. The error log is the record of what was lost.
export const saveEvents = C.spanOp(
	'saveEvents',
	{ module, mutexes: (ctx) => ctx.server.savingEventsMtx },
	async (ctx: C.SquadServer & C.Db) => {
		const server = ctx.server

		let events: SE.Event[] = []
		if (server.lastSavedEventId === null) {
			events = server.emittedEvents.slice()
		} else {
			const lastSavedIndex = server.emittedEvents.findIndex((e) => e.id === server.lastSavedEventId)
			if (lastSavedIndex === -1) {
				throw new Error(`CRITICAL: Unable to resolve last saved event ${server.lastSavedEventId}`)
			}
			events = server.emittedEvents.slice(lastSavedIndex + 1)
		}

		if (events.length === 0) {
			log.debug('No events to save')
			return
		}

		let savedCount = 0
		let failedCount = 0
		for (const event of events) {
			if (server.savedEventIds.has(event.id)) {
				log.error('saveEvents: duplicate event id %d (%s), skipping', event.id, event.type)
				server.lastSavedEventId = event.id
				continue
			}

			const rows = buildEventRows({ ...CS.init(), log }, event)
			try {
				await DB.runTransaction(ctx, { redactParams: true }, (txCtx) => insertEventRows(txCtx, rows))
				savedCount++
			} catch (err) {
				failedCount++
				// err in the merge object so pino's error serializer includes message/stack (a %o format drops
				// non-enumerable Error props, leaving just the code)
				log.error(
					{ err, event, playerRows: rows.playerRows, squadRows: rows.squadRows },
					'saveEvents: failed to persist event %d (%s); skipping it so the rest of the batch is not lost',
					event.id,
					event.type,
				)
			}
			// Advance past the event whether it committed or failed. Leaving the cursor behind a failed event would
			// re-fail it on every flush and block every later event from ever being saved.
			server.savedEventIds.add(event.id)
			server.lastSavedEventId = event.id
		}

		if (failedCount > 0) {
			log.warn('saveEvents: persisted %d event(s), %d failed and were skipped', savedCount, failedCount)
		}

		// Everything before the current match is persisted and no longer served from memory; rotate it out so
		// emittedEvents (and the duplicate-id set) don't grow for the life of the process. Mirrors what
		// loadEventState keeps on slice boot. The cut is bounded by the save cursor: events can land for a NEW
		// match while this flush's inserts are in flight, and cutting past the cursor would strand it (the next
		// flush resolves lastSavedEventId by index).
		const currentMatchId = server.emittedEvents[server.emittedEvents.length - 1]?.matchId
		if (currentMatchId !== undefined && server.lastSavedEventId !== null) {
			const firstCurrentIdx = server.emittedEvents.findIndex((e) => e.matchId === currentMatchId)
			const cursorIdx = server.emittedEvents.findIndex((e) => e.id === server.lastSavedEventId)
			const cutoff = Math.min(firstCurrentIdx, cursorIdx)
			if (cutoff > 0) {
				const dropped = server.emittedEvents.splice(0, cutoff)
				for (const e of dropped) server.savedEventIds.delete(e.id)
			}
		}
	},
)

const onNewGameDuringSync = (serverId: string): PendingEvents.State['hooks']['onNewGameDuringSync'] => async (currentLayerId, _time) => {
	const ctx = resolveSliceCtx(getBaseCtx(), serverId)
	return C.spanOp(
		'onNewGameDuringSync',
		{
			module,
			mutexes: () => [ctx.matchHistory.mtx, ctx.server.savingEventsMtx],
			levels: { event: 'info' },
		},
		async () => {
			const { currentMatch, pushedNewMatch } = await MatchHistory.syncWithCurrentLayer(ctx, currentLayerId)
			return { match: currentMatch, isNewMatch: pushedNewMatch }
		},
	)()
}

const onNewGameDuringRoll = (serverId: string): PendingEvents.State['hooks']['onNewGameDuringRoll'] => async (newLayerId, time) => {
	const ctx = resolveSliceCtx(getBaseCtx(), serverId)
	return C.spanOp(
		'onNewGameDuringRoll',
		{
			module,
			mutexes: () => [ctx.matchHistory.mtx, ctx.server.savingEventsMtx, ctx.layerQueue.updateLayerMtx],
			levels: { event: 'info' },
		},
		async () =>
			await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
				ctx.server.serverRolling$.next(Date.now())
				try {
					const nextLqItem = LayerQueue.getSavedQueue(ctx)[0]

					let currentMatchLqItem: LL.Item | undefined
					if (
						nextLqItem
						&& L.areLayersCompatible(nextLqItem.layerId, newLayerId)
					) {
						await LayerQueue.dispatchOp(ctx, { op: 'shift-first-saved-layer', opId: SLL.createOpId() })
						currentMatchLqItem = nextLqItem
					}
					const { match } = await MatchHistory.addNewCurrentMatch(
						ctx,
						MH.getNewMatchHistoryEntry({
							layerId: newLayerId,
							serverId: ctx.serverId,
							startTime: new Date(time),
							lqItem: currentMatchLqItem,
						}),
					)
					LayerQueue.schedulePostRollTasks(ctx, match.layerId)
					const nextLayerId = LL.getNextLayerId(LayerQueue.getSavedQueue(ctx))
					return { match, nextLayerId }
				} finally {
					ctx.server.serverRolling$.next(null)
				}
			}),
	)()
}

export async function waitForSynced(ctx: C.SquadServer & CS.AbortSignal) {
	if (ctx.server.eventState.syncState.type === 'synced') return
	await firstValueFrom(
		ctx.server.event$.pipe(
			Rx.filter(
				([ctx, event]) => event.type === 'NEW_GAME' || event.type === 'RESET',
			),
		),
		ctx.signal,
	)
}
