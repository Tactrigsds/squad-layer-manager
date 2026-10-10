// The state every managed server shares: the registry of running managed servers, context resolution for a
// server id, and reads and writes of a server's persisted state. Booting and tearing down a managed server is in
// squad-server-lifecycle.server.ts.

import * as Orpc from '@orpc/server'
import type { Mutex, MutexInterface } from 'async-mutex'
import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as AR from '@/app-routes'
import { superjsonify } from '@/lib/drizzle'
import * as Gen from '@/lib/generator-utils'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import type { Parts } from '@/lib/types'
import type * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared.models'
import type * as LQ from '@/models/layer-queue.models'
import type * as MH from '@/models/match-history.models'
import type * as SS from '@/models/server-state.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Settings from '@/systems/settings.server'
import * as WsSessionSys from '@/systems/ws-session.server'

const module = initModule('squad-server')

export let log!: CS.Logger

type State = {
	managedServers: Map<string, C.ManagedServer>
	// guards every transition of a managed server between running and not, not just setup. See withLifecycleLock.
	lifecycleMtxs: Map<string, MutexInterface>
	// emits a serverId whenever a managed server is added to or removed from `managedServers`
	lifecycleUpdate$: Rx.Subject<string>
	squadIdCounter: Generator<number, never, unknown>

	debug__ticketOutcome?: { team1: number; team2: number }
}

export let globalState!: State

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<CS.Otel>
	recentMatches: MH.MatchDetails[]
} & Parts<USR.UserPart>

// state every squad-server module reads; runs before any managed server boots
export async function init() {
	log = module.getLogger()
	const ctx = getBaseCtx()

	globalState = {
		managedServers: new Map(),
		lifecycleUpdate$: new IsolatedSubject(),
		squadIdCounter: undefined!,
		lifecycleMtxs: new Map(),
	}

	const lastSquadRes = await ctx.db().select({ id: Schema.squads.id }).from(Schema.squads).orderBy(E.desc(Schema.squads.id)).limit(1)
	const nextSquadId = lastSquadRes.length > 0 ? lastSquadRes[0].id + 1 : 0
	globalState.squadIdCounter = Gen.counter(nextSquadId)
}

export async function getFullServerState(ctx: C.Db & LQ.Ctx) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	return Settings.parseServerStateRow(serverRaw)
}

/** The current teams on the server, as tracked by the server event state */
export function getCurrTeams(ctx: SQS.Ctx) {
	return ctx.server.eventState.currTeams
}

/**
 * The current match as the event state knows it, without taking matchHistory.mtx. Null until the first
 * sync establishes one. Prefer this over MatchHistory.getCurrentMatch anywhere a stall is worse than a
 * stale read: while rcon is down that mutex is held for the whole reconnect ladder.
 */
export function peekCurrentMatch(ctx: SQS.Ctx) {
	const current = ctx.server.eventState.currentMatch
	return current === 'PENDING' ? null : current
}

// maps a GUI/chat user id (or an automated marker) to an app-event actor, resolving in-game (steam) senders against
// the current teams. Shared by the vote/teamswap attribution paths.
export function actorFromUser(ctx: SQS.Ctx, source: USR.GuiOrChatUserId | 'autostart' | undefined | null): AppEvents.Actor {
	if (!source || source === 'autostart') return { type: 'system' }
	if (source.discordId) return { type: 'slm-user', userId: source.discordId }
	if (source.steamId) {
		// by steam id, which the roster is not keyed on -- one of the few lookups that still has to scan
		const player = SM.PlayerIds.find([...(getCurrTeams(ctx)?.players.values() ?? [])], (p) => p.ids, { steam: source.steamId })
		if (player) return { type: 'ingame-user', playerId: SM.PlayerIds.getPlayerId(player.ids) }
	}
	return { type: 'system' }
}

// resolves a default server id for a request given the route and a previously stored default server id
export function manageDefaultServerIdForRequest<Ctx extends C.HttpRequest>(ctx: Ctx) {
	const servers = Settings.listServerEntries()
		// scoped servers are entered explicitly (a tutorial), never resolved as somebody's default server, so they must
		// not be picked here or persisted into the default-server cookie via the /servers/:id sync below.
		.filter((s) => s.enabled && globalState.managedServers.has(s.id) && s.visibility !== 'scoped')
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

function withSignal<T extends object>(ctx: T, managedServer: C.ManagedServer) {
	// cancel when either the caller (e.g. the originating request) or the managed server is done. the managed server signal
	// already covers process shutdown, so don't allocate a composite for base ctxs on the hot event path
	const callerSignal = (ctx as Partial<CS.AbortSignal>).signal
	const signal = callerSignal === CleanupSys.shutdownSignal ? managedServer.signal : Prom.anySignal(callerSignal, managedServer.signal)!
	return {
		...ctx,
		...managedServer,
		signal,
	}
}

// throws when the managed server is missing. Only for callers running inside the managed server's own lifecycle (setup loops, timers,
// event handlers), where a missing managed server is a bug rather than a state the caller has to render. oRPC handlers should
// use tryCtx / stream$ instead, so the client gets a code it can act on.
/** the live managed server, for the rare caller that needs one field off it rather than a ctx */
export function require(serverId: string): C.ManagedServer {
	const managedServer = globalState.managedServers.get(serverId)
	if (!managedServer) throw new Error('Managed server not found: ' + serverId)
	return managedServer
}

/**
 * The managed server ctx for an event handler, rebuilt at handle time from the serverId the event carries.
 * The emitter used to ship its whole ctx on the stream, which made the SQS.Ctx.Payload payload reference
 * C.ManagedServer and so pinned it to the server layer.
 */
export function eventCtx(evtCtx: CS.Otel & CS.ServerId, signal: AbortSignal) {
	return { ...resolveCtx({ ...getBaseCtx(), ...evtCtx }, evtCtx.serverId), signal }
}

export function resolveCtx<T extends object>(ctx: T, serverId: string) {
	const managedServer = globalState.managedServers.get(serverId)
	if (!managedServer) {
		throw new Orpc.ORPCError('BAD_REQUEST', {
			message: 'Managed server not found: ' + serverId,
		})
	}
	return withSignal(ctx, managedServer)
}

export async function tryCtx<T extends C.Db & USR.Ctx.Id & CS.AbortSignal>(
	ctx: T,
	serverId: string,
): Promise<{ code: 'ok'; ctx: ReturnType<typeof withSignal<T>> } | SM.ServerNotLoaded> {
	const managedServer = globalState.managedServers.get(serverId)
	if (!managedServer) return SM.serverNotLoaded(serverId)
	return { code: 'ok', ctx: withSignal(ctx, managedServer) }
}

// like selectedServerCtx$, but keyed by an explicit serverId instead of a wsClientId's session selection
export function ctx$(wsClientId: string, serverId: string) {
	return globalState.lifecycleUpdate$.pipe(
		Rx.filter((id) => id === serverId),
		Rx.startWith(serverId),
		Rx.map(() => {
			const managedServer = globalState.managedServers.get(serverId)
			if (!managedServer) return null
			const session = WsSessionSys.wsSessions.get(wsClientId)!
			return { ...getBaseCtx(), ...session, ...managedServer }
		}),
	)
}

export type ManagedServerCtx = NonNullable<Rx.ObservedValueOf<ReturnType<typeof ctx$>>>

// the only way an oRPC stream should resolve a managed server. While the managed server is absent the stream emits err:server-not-loaded
// rather than going silent (a silent stream leaves the client suspended forever), and it switches over to the real
// source as soon as the managed server appears -- so a server being enabled, or coming back after a crash, self-heals.
export function stream$<T>(
	wsClientId: string,
	serverId: string,
	project: (ctx: ManagedServerCtx) => Rx.Observable<T>,
): Rx.Observable<T | SM.ServerNotLoaded> {
	return ctx$(wsClientId, serverId).pipe(
		Rx.switchMap((ctx): Rx.Observable<T | SM.ServerNotLoaded> => {
			if (!ctx) return Rx.of(SM.serverNotLoaded(serverId))
			return project(ctx)
		}),
	)
}

export function getBaseCtx() {
	return DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
}

export async function getServerState(ctx: C.Db & CS.ServerId) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	return Settings.parseServerStateRow(serverRaw)
}

// settings changes go through Settings.updateServerSettings instead — that's the one source of truth for reading/writing/broadcasting settings
export async function updateServerState(
	ctx: C.Db & C.Tx & LQ.Ctx,
	changes: Partial<Omit<SS.ServerState, 'settings'>>,
	source: SS.LQStateUpdate['source'],
) {
	const serverState = await getServerState(ctx)
	const newServerState = { ...serverState, ...changes }
	await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, changes)).where(E.eq(Schema.servers.id, ctx.serverId))
	const update: SS.LQStateUpdate = { state: newServerState, source }

	ctx.tx.unlockTasks.push(() => ctx.layerQueue.update$.next(update))
	return newServerState
}

export async function waitForSynced(ctx: SQS.Ctx & CS.AbortSignal) {
	if (ctx.server.eventState.syncState.type === 'synced') return
	await Rx.Ext.firstValueFrom(
		ctx.server.event$.pipe(Rx.filter(([ctx, event]) => event.type === 'NEW_GAME' || event.type === 'RESET')),
		ctx.signal,
	)
}
