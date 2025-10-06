import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes'
import { AsyncResource, distinctDeepEquals, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Obj from '@/lib/object'
import Rcon, { DecodedPacket } from '@/lib/rcon/core-rcon'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import { SquadEventEmitter } from '@/lib/squad-log-parser/squad-event-emitter.ts'
import { Parts } from '@/lib/types'
import { HumanTime } from '@/lib/zod'
import * as Messages from '@/messages.ts'
import * as BAL from '@/models/balance-triggers.models'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as SME from '@/models/squad-models.events.ts'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as Commands from '@/server/systems/commands'
import * as LayerQueue from '@/server/systems/layer-queue.ts'
import * as MatchHistory from '@/server/systems/match-history.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as SquadRcon from '@/server/systems/squad-rcon'
import * as TrpcServer from '@/server/trpc.server'
import * as Otel from '@opentelemetry/api'
import { TRPCError } from '@trpc/server'
import { Mutex } from 'async-mutex'
import * as E from 'drizzle-orm/expressions'

import { assertNever } from '@/lib/type-guards'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { baseLogger } from '../logger'

const tracer = Otel.trace.getTracer('squad-server')

type State = {
	slices: Map<string, C.ServerSlice>
	// wsClientId => server id
	selectedServers: Map<string, string>
	selectedServerUpdate$: Rx.Subject<{ wsClientId: string; serverId: string }>
	debug__ticketOutcome?: SME.DebugTicketOutcome
	serverRolling: boolean
}

export let state!: State
export type SquadServer = {
	logEmitter: SquadEventEmitter

	layersStatusExt$: Rx.Observable<SM.LayersStatusResExt>

	adminList: AsyncResource<SM.AdminList, CS.Log & C.Rcon>

	postRollEventsSub: Rx.Subscription | null
} & SquadRcon.SquadRconContext

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<CS.Log>
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>

export async function setup() {
	const ctx = getBaseCtx()

	state = {
		slices: new Map(),
		serverRolling: false,
		selectedServers: new Map(),
		selectedServerUpdate$: new Rx.Subject(),
	}
	const ops: Promise<void>[] = []

	for (const serverConfig of CONFIG.servers) {
		ops.push((async () => {
			let settings: SS.ServerSettings | undefined
			await DB.runTransaction(ctx, async () => {
				const [serverRaw] = await ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, serverConfig.id)).for('update')
				const server: typeof serverRaw | undefined = serverRaw ? (unsuperjsonify(Schema.servers, serverRaw) as typeof serverRaw) : undefined
				const settingsParsedRes = server?.settings
					? SS.ServerSettingsSchema.safeParse(server.settings)
					: undefined
				settings = settingsParsedRes?.success ? settingsParsedRes.data : undefined
				if (!server) {
					settings = SS.ServerSettingsSchema.parse({ connections: serverConfig.connections })
					await ctx.db().insert(Schema.servers).values(superjsonify(Schema.servers, {
						id: serverConfig.id,
						settings,
						displayName: serverConfig.displayName,
						layerQueue: LL.LayerListSchema.parse([]),
					}))
				}

				if (server && server.displayName !== serverConfig.displayName) {
					await ctx.db().update(Schema.servers).set({ displayName: serverConfig.displayName }).where(
						E.eq(Schema.servers.id, serverConfig.id),
					)
				}

				if (server && !Obj.deepEqual(serverConfig.connections, settings?.connections)) {
					settings = SS.ServerSettingsSchema.parse({ ...(settings ?? {}), connections: serverConfig.connections })
					await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, { settings })).where(
						E.eq(Schema.servers.id, serverConfig.id),
					)
				}
			})

			if (!settings) throw new Error(`Server ${serverConfig.id} was unable to be configured`)
			const slice = await instantiateServer(ctx, serverConfig.id, settings)
			state.slices.set(serverConfig.id, slice)
		})())
	}

	await Promise.all(ops)
}

async function instantiateServer(ctx: CS.Log & C.Db & C.Locks, serverId: string, settings: SS.ServerSettings): Promise<C.ServerSlice> {
	const layersStatus: SquadServer['layersStatus'] = new AsyncResource('serverStatus', (ctx) => SquadRcon.getLayerStatus(ctx), {
		defaultTTL: 5000,
	})

	const rcon = new Rcon({ serverId: serverId, settings: settings.connections!.rcon })
	rcon.ensureConnected(ctx)

	const layersStatusExt$: SquadServer['layersStatusExt$'] = getLayersStatusExt$(serverId)

	const adminListTTL = HumanTime.parse('1h')
	const adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })

	const sub = new Rx.Subscription()

	const rconEvent$: Rx.Observable<SM.SquadRconEvent> = Rx.fromEvent(rcon, 'server').pipe(
		Rx.concatMap((pkt): Rx.Observable<SM.SquadRconEvent> => {
			const ctx = getBaseCtx()
			const message = SquadRcon.processChatPacket(ctx, pkt as DecodedPacket)
			if (message === null) return Rx.EMPTY
			ctx.log.debug(`Chat : %s : %s`, message.name, message.message)
			return Rx.of({ type: 'chat-message', message })
		}),
		Rx.share(),
	)

	const logEmitter = new SquadEventEmitter(getBaseCtx(), {
		sftp: {
			filePath: settings.connections!.sftp.logFile,
			host: settings.connections!.sftp.host,
			port: settings.connections!.sftp.port,
			username: settings.connections!.sftp.username,
			password: settings.connections!.sftp.password,
			pollInterval: CONFIG.squadServer.sftpPollInterval,
			reconnectInterval: CONFIG.squadServer.sftpReconnectInterval,
		},
	})
	logEmitter.connect()

	const server: SquadServer = {
		layersStatusExt$,
		...SquadRcon.initSquadRcon(ctx, serverId, settings.connections!.rcon, sub),

		adminList,
		logEmitter,
		postRollEventsSub: null,
	}

	const slice: C.ServerSlice = {
		serverId,

		server,
		rcon,

		matchHistory: MatchHistory.initMatchHistoryContext(),

		layerQueue: LayerQueue.initLayerQueueContext(),

		userPresence: {
			state: {},
			update$: new Rx.Subject<USR.UserPresenceStateUpdate & Parts<USR.UserPart>>(),
		},

		vote: {
			autostartVoteSub: null,
			voteEndTask: null,
			state: null,
			mtx: new Mutex(),

			update$: new Rx.Subject<V.VoteStateUpdate>(),
		},
		serverSliceSub: sub,
	}

	const sync$ = rcon.connected$.pipe(
		Rx.concatMap(async (connected) => {
			if (!connected) return Rx.EMPTY
			const ctx = { ...getBaseCtx(), ...slice }

			const { value: statusRes } = await layersStatus.get(ctx)
			if (statusRes.code === 'err:rcon') return Rx.EMPTY
			await MatchHistory.resolvePotentialCurrentLayerConflict(ctx, statusRes.data.currentLayer)
			return Rx.of(1)
		}),
		Rx.concatAll(),
		Rx.share(),
	)

	sub.add(sync$.subscribe())
	await Rx.firstValueFrom(sync$)

	sub.add(
		slice.matchHistory.update$.pipe(Rx.startWith(0)).subscribe(() => {
			const ctx = { ...getBaseCtx(), ...slice }
			ctx.log.info(
				'active match id: %s, status: %s',
				MatchHistory.getCurrentMatch(ctx)?.historyEntryId,
				MatchHistory.getCurrentMatch(ctx)?.status,
			)
		}),
	)

	sub.add(
		rconEvent$.pipe(
			C.durableSub(
				'squad-server:handle-rcon-event',
				{ tracer, ctx, eventLogLevel: 'trace', taskScheduling: 'parallel', root: true },
				async (event) => {
					const ctx = C.initLocks(resolveSliceCtx(getBaseCtx(), serverId))
					if (event.type === 'chat-message' && event.message.message.startsWith(CONFIG.commandPrefix)) {
						await Commands.handleCommand(ctx, event.message)
					} else if (event.type === 'chat-message' && event.message.message.trim().match(/^\d+$/)) {
						LayerQueue.handleVote(ctx, event.message)
					}
				},
			),
		).subscribe(),
	)

	sub.add(
		slice.server.logEmitter.event$.pipe(
			C.durableSub(
				'squad-server:handle-squad-log-event',
				{ tracer, ctx, eventLogLevel: 'info' },
				([_ctx, event]) => handleSquadEvent(resolveSliceCtx(getBaseCtx(), serverId), event),
			),
		).subscribe(),
	)

	await MatchHistory.loadState({ ...ctx, ...slice })
	await LayerQueue.initLayerQueue({ ...ctx, ...slice })

	return slice
}

async function handleSquadEvent(ctx: C.Db & C.Locks & C.SquadServer & C.MatchHistory & C.LayerQueue & C.Vote, event: SME.Event) {
	switch (event.type) {
		case 'NEW_GAME': {
			try {
				return await LayerQueue.handleNewGame(ctx, event.time)
			} finally {
				state.serverRolling = false
			}
		}
		case 'ROUND_ENDED': {
			const { value: statusRes } = await ctx.server.layersStatus.get(ctx, { ttl: 0 })
			if (statusRes.code !== 'ok') return statusRes
			// -------- use debug ticketOutcome if one was set --------
			if (state.debug__ticketOutcome) {
				let winner: SM.TeamId | null
				let loser: SM.TeamId | null
				if (state.debug__ticketOutcome.team1 === state.debug__ticketOutcome.team2) {
					winner = null
					loser = null
				} else {
					winner = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 > 0 ? 1 : 2
					loser = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 < 0 ? 1 : 2
				}
				const partial = L.toLayer(statusRes.data.currentLayer)
				const teams: SM.SquadOutcomeTeam[] = [
					{
						faction: partial.Faction_1!,
						unit: partial.Unit_1!,
						team: 1,
						tickets: state.debug__ticketOutcome.team1,
					},
					{
						faction: partial.Faction_2!,
						unit: partial.Unit_2!,
						team: 2,
						tickets: state.debug__ticketOutcome.team2,
					},
				]
				const winnerTeam = teams.find(t => t?.team && t.team === winner) ?? null
				const loserTeam = teams.find(t => t?.team && t.team === loser) ?? null
				event = {
					...event,
					loser: loserTeam,
					winner: winnerTeam,
				}
				delete state.debug__ticketOutcome
			}
			const res = await MatchHistory.finalizeCurrentMatch(ctx, statusRes.data.currentLayer.id, event)
			return res
		}
		default:
			assertNever(event)
	}
}

export function destroyServer(ctx: C.ServerSlice & CS.Log) {
	ctx.serverSliceSub.unsubscribe()
	ctx.server.logEmitter.disconnect()
	ctx.rcon.disconnect(ctx)
	ctx.matchHistory.update$.complete()

	state.slices.delete(ctx.serverId)
	for (const [wsClientId, serverId] of Array.from(state.selectedServers.entries())) {
		if (ctx.serverId === serverId) state.selectedServers.delete(wsClientId)
	}
}

export async function getFullServerState(ctx: C.Db & CS.Log & C.LayerQueue) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
	let serverRaw: any
	if (ctx.tx) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

function getLayersStatusExt$(
	serverId: string,
) {
	return new Rx.Observable<SM.LayersStatusResExt>(s => {
		const ctx = { ...getBaseCtx(), ...state.slices.get(serverId)! }
		const sub = new Rx.Subscription()
		sub.add(
			ctx.server.layersStatus.observe(ctx).subscribe({
				next: async () => {
					s.next(await fetchLayersStatusExt(ctx))
				},
				error: (err) => s.error(err),
				complete: () => s.complete(),
			}),
		)
		sub.add(ctx.matchHistory.update$.subscribe({
			next: async () => {
				s.next(await fetchLayersStatusExt(ctx))
			},
			error: (err) => s.error(err),
			complete: () => s.complete(),
		}))
		return () => sub.unsubscribe()
	}).pipe(distinctDeepEquals(), Rx.share())
}

async function fetchLayersStatusExt(ctx: CS.Log & C.SquadServer & C.MatchHistory) {
	const { value: statusRes } = await ctx.server.layersStatus.get(ctx)
	if (statusRes.code !== 'ok') return statusRes
	return buildServerStatusRes(statusRes.data, MatchHistory.getCurrentMatch(ctx))
}

function buildServerStatusRes(rconStatus: SM.LayersStatus, currentMatch: MH.MatchDetails) {
	const res: SM.LayersStatusResExt = { code: 'ok' as const, data: { ...rconStatus } }
	if (currentMatch && L.areLayersCompatible(currentMatch.layerId, rconStatus.currentLayer)) {
		res.data.currentMatch = currentMatch
	}
	return res
}

// resolves a default server id for a request given the route and a previously stored default server id
export function manageDefaultServerIdForRequest<Ctx extends C.HttpRequest>(ctx: Ctx) {
	const defaultServerId = ctx.cookies['default-server-id']

	let serverId: string | undefined
	if (C.isRoutedHttpRequestContext(ctx) && ctx.route === AR.route('/servers/:id')) {
		serverId = ctx.route.params.id
	} else if (defaultServerId) {
		serverId = defaultServerId
	} else {
		serverId = (state.slices.keys().next().value)!
	}

	if (defaultServerId && serverId === defaultServerId) return ctx
	const res = ctx.res.setCookie(AR.COOKIE_KEY.Values['default-server-id'], serverId)
	return {
		...ctx,
		res,
	}
}

export function resolveWsClientSliceCtx(ctx: C.TrpcRequest) {
	let serverId = state.selectedServers.get(ctx.wsClientId)
	serverId ??= CONFIG.servers[0].id
	if (!serverId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'No server selected' })
	const slice = state.slices.get(serverId)
	if (!slice) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Server slice not found' })
	return {
		...ctx,
		...slice,
	}
}

export function resolveSliceCtx<T extends object>(ctx: T, serverId: string) {
	const slice = state.slices.get(serverId)
	if (!slice) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Server slice not found' })
	return {
		...ctx,
		...slice,
	}
}

function getBaseCtx() {
	return C.initLocks(DB.addPooledDb({ log: baseLogger }))
}

export function selectedServerCtx$<Ctx extends C.WSSession>(ctx: Ctx) {
	return state.selectedServerUpdate$.pipe(
		Rx.concatMap(s => s.wsClientId === ctx.wsClientId ? Rx.of(s.serverId) : Rx.EMPTY),
		Rx.startWith(state.selectedServers.get(ctx.wsClientId)!),
		Rx.map(serverId => resolveSliceCtx(ctx, serverId)),
	)
}

export const router = TrpcServer.router({
	setSelectedServer: TrpcServer.procedure.input(z.string()).mutation(async ({ ctx, input: serverId }) => {
		const slice = state.slices.get(serverId)
		if (!slice) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Server not found' })
		state.selectedServers.set(ctx.wsClientId, serverId)
		state.selectedServerUpdate$.next({ wsClientId: ctx.wsClientId, serverId })
		return { code: 'ok' as const }
	}),

	watchLayersStatus: TrpcServer.procedure.subscription(async function*({ ctx, signal }) {
		const obs = selectedServerCtx$(ctx)
			.pipe(
				Rx.switchMap(ctx => {
					ctx.log.info('subbing to layers status %s %s', ctx.serverId, ctx.wsClientId)
					return Rx.concat(fetchLayersStatusExt(ctx), ctx.server.layersStatusExt$)
				}),
				withAbortSignal(signal!),
			)
		yield* toAsyncGenerator(obs)
	}),

	watchServerInfo: TrpcServer.procedure.subscription(async function*({ ctx, signal }) {
		const obs = selectedServerCtx$(ctx)
			.pipe(
				Rx.switchMap(ctx => {
					return ctx.server.serverInfo.observe(ctx).pipe(
						distinctDeepEquals(),
					)
				}),
				withAbortSignal(signal!),
			)
		yield* toAsyncGenerator(obs)
	}),

	endMatch: TrpcServer.procedure.mutation(async ({ ctx: _ctx }) => {
		const ctx = resolveWsClientSliceCtx(_ctx)
		const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
			check: 'all',
			permits: [RBAC.perm('squad-server:end-match')],
		})
		if (deniedRes) return deniedRes
		SquadRcon.endMatch(ctx)
		await SquadRcon.warnAllAdmins(ctx, Messages.BROADCASTS.matchEnded(ctx.user))
		return { code: 'ok' as const }
	}),

	toggleFogOfWar: TrpcServer.procedure.input(z.object({ disabled: z.boolean() })).mutation(async ({ ctx: _ctx, input }) => {
		const ctx = resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('squad-server:turn-fog-off'))
		if (denyRes) return denyRes
		const { value: serverStatusRes } = await ctx.server.layersStatus.get(ctx)
		if (serverStatusRes.code !== 'ok') return serverStatusRes
		await SquadRcon.setFogOfWar(ctx, input.disabled ? 'off' : 'on')
		if (input.disabled) {
			await SquadRcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
		}
		return { code: 'ok' as const }
	}),
})
