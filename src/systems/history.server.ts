import * as E from 'drizzle-orm'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import { createId } from '@/lib/id'
import { assertNever } from '@/lib/type-guards'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import * as HQ from '@/models/history.models'
import * as MH from '@/models/match-history.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as HistoryQuery from '@/systems/history-query.server'
import type * as HistoryWorker from '@/systems/history-query.worker'
import * as HistoryResolve from '@/systems/history-resolve.server'
import * as HistoryRetention from '@/systems/history-retention.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import * as Rbac from '@/systems/rbac.server'

// The history page's server half. A query request is: authorize and resolve on the main thread
// (history-resolve.server.ts), then dispatch the resolved tree to the query engine on a worker thread with
// its own read-only db connection, so a heavy scan never stalls the event loop the rcon and websockets live
// on. If the worker is unavailable the same engine call runs in-process instead.

const module = initModule('history')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db })
let ENV!: ReturnType<typeof envBuilder>

// -------- the worker --------

let worker: Worker | undefined
let nextSeq = 1
const pending = new Map<
	number,
	{ resolve: (res: HistoryQuery.EngineResponse | HistoryQuery.QueryError) => void; reject: (err: unknown) => void }
>()

function failPending(err: unknown) {
	for (const p of pending.values()) p.reject(err)
	pending.clear()
}

function bootWorker() {
	// under tsx this module's url is the .ts source and the worker needs the loader passed along; from the
	// prod bundle both are built .js chunks side by side in dist-server/
	const isTs = import.meta.url.endsWith('.ts')
	const url = new URL(isTs ? './history-query.worker.ts' : './history-query.worker.js', import.meta.url)
	const w = new Worker(url, {
		workerData: { dbPath: ENV.DB_PATH },
		execArgv: isTs ? ['--import', 'tsx'] : undefined,
	})
	w.on('message', (msg: HistoryWorker.Response) => {
		const p = pending.get(msg.seq)
		if (!p) return
		pending.delete(msg.seq)
		if (msg.err) p.reject(Object.assign(new Error(msg.err.message), { stack: msg.err.stack }))
		else p.resolve(msg.res!)
	})
	w.on('error', (err) => {
		log.error(err, 'history query worker failed; queries fall back in-process')
		if (worker === w) worker = undefined
		failPending(err)
	})
	w.on('exit', () => {
		if (worker === w) worker = undefined
		failPending(new Error('history query worker exited'))
	})
	// the worker must never hold the process open
	w.unref()
	worker = w
}

export function setup() {
	log = module.getLogger()
	ENV = envBuilder()
	try {
		bootWorker()
	} catch (err) {
		log.error(err, 'history query worker failed to boot; queries run in-process')
	}
	CleanupSys.register(async () => {
		await worker?.terminate()
	})
}

async function dispatch(
	ctx: C.Db & CS.AbortSignal,
	req: HistoryQuery.EngineRequest,
): Promise<HistoryQuery.EngineResponse | HistoryQuery.QueryError> {
	if (!worker) return await HistoryQuery.runEngineRequest(ctx, req)
	const seq = nextSeq++
	// an aborted caller just stops waiting: the scan itself is synchronous sqlite and cannot be interrupted
	const onAbort = () => {
		const p = pending.get(seq)
		if (!p) return
		pending.delete(seq)
		p.reject(ctx.signal.reason)
	}
	try {
		return await new Promise((resolve, reject) => {
			pending.set(seq, { resolve, reject })
			ctx.signal.addEventListener('abort', onAbort)
			worker!.postMessage({ seq, req } satisfies HistoryWorker.Request)
		})
	} finally {
		ctx.signal.removeEventListener('abort', onAbort)
	}
}

// -------- queries --------

const CursorSchema = z.object({ time: z.number().int(), serverEventId: z.number().int() })

async function resolveForQuery(ctx: C.OrpcBase, query: HQ.Query) {
	const node = HQ.queryFilterNode(query)
	const problems = HQ.validateQueryNode(node)
	if (problems.length > 0) {
		return {
			code: 'err:invalid-query' as const,
			message: problems.map((p) => ('column' in p ? `unknown column ${p.column}` : p.code)).join('; '),
		}
	}
	const visible = await HistoryResolve.visibleServerIds(ctx)
	const bounds = HistoryQuery.boundsOf(query, visible)
	const rewritten = await HistoryResolve.rewriteLayerNodes(ctx, node, bounds)
	if (rewritten.code !== 'ok') return rewritten
	return { code: 'ok' as const, node: rewritten.node, bounds, unrecognisedLayerMatches: rewritten.unrecognisedLayerMatches }
}

export const router = {
	query: orpcBase
		.input(
			z.object({
				query: HQ.QuerySchema,
				// events page backwards from newest by compound cursor; players/matches page by offset
				cursor: CursorSchema.optional(),
				page: z.number().int().nonnegative().prefault(0),
			}),
		)
		.handler(async ({ input, context: ctx }) => {
			const resolved = await resolveForQuery(ctx, input.query)
			if (resolved.code !== 'ok') return resolved
			const { node, bounds, unrecognisedLayerMatches } = resolved

			switch (input.query.type) {
				case 'events': {
					const res = await dispatch(ctx, {
						kind: 'events',
						node,
						bounds,
						cursor: input.cursor,
						pageSize: HQ.PAGE_SIZES.events,
						withTotal: !input.cursor,
					})
					if (res.code !== 'ok') return res
					if (res.kind !== 'events') throw new Error('engine returned a mismatched response kind')
					const page = await assembleEventPage(ctx, res.hits)
					const last = res.hits.at(-1)
					const nextCursor =
						res.hits.length === HQ.PAGE_SIZES.events && last
							? { time: last.time.getTime(), serverEventId: last.serverEventId }
							: undefined
					return { code: 'ok' as const, type: 'events' as const, ...page, nextCursor, total: res.total, unrecognisedLayerMatches }
				}
				case 'players': {
					const res = await dispatch(ctx, {
						kind: 'players',
						node,
						bounds,
						group: HQ.groupPlayerRefs(input.query),
						minMatches: input.query.minMatches,
						sort: input.query.sort ?? { column: 'matches', dir: 'desc' },
						limit: HQ.PAGE_SIZES.players,
						offset: input.page * HQ.PAGE_SIZES.players,
					})
					if (res.code !== 'ok') return res
					if (res.kind !== 'players') throw new Error('engine returned a mismatched response kind')
					return { code: 'ok' as const, type: 'players' as const, rows: res.rows, total: res.total, unrecognisedLayerMatches }
				}
				case 'matches': {
					const res = await dispatch(ctx, {
						kind: 'matches',
						node,
						bounds,
						limit: HQ.PAGE_SIZES.matches,
						offset: input.page * HQ.PAGE_SIZES.matches,
					})
					if (res.code !== 'ok') return res
					if (res.kind !== 'matches') throw new Error('engine returned a mismatched response kind')
					return {
						code: 'ok' as const,
						type: 'matches' as const,
						matches: res.rows.flatMap((row) => toMatchDetails(row) ?? []),
						total: res.total,
						unrecognisedLayerMatches,
					}
				}
				default:
					assertNever(input.query.type)
			}
		}),

	// -------- saved queries --------

	listSaved: orpcBase.handler(async ({ context: ctx }) => {
		const rows = await ctx
			.db()
			.select({ row: Schema.savedQueries, ownerName: Schema.discordAccounts.username })
			.from(Schema.savedQueries)
			.leftJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.savedQueries.ownerId))
			.where(E.or(E.eq(Schema.savedQueries.ownerId, ctx.user.discordId), E.eq(Schema.savedQueries.visibility, 'shared')))
			.orderBy(E.desc(Schema.savedQueries.updatedAt))
		const out: (HQ.SavedQuery & { ownerName: string | null })[] = []
		for (const { row, ownerName } of rows) {
			const query = HQ.QuerySchema.safeParse(row.query)
			if (!query.success) {
				log.warn('saved query %s does not parse; skipping', row.id)
				continue
			}
			out.push({
				id: row.id,
				name: row.name,
				ownerId: row.ownerId,
				ownerName,
				visibility: row.visibility,
				retain: row.retain,
				query: query.data,
				updatedAt: row.updatedAt.getTime(),
			})
		}
		return { code: 'ok' as const, queries: out }
	}),

	save: orpcBase
		.input(z.object({ id: HQ.SAVED_QUERY_ID.optional() }).extend(HQ.SavedQueryUpdateSchema.shape))
		.handler(async ({ input, context: ctx }) => {
			if (input.id) {
				const [existing] = await ctx.db().select().from(Schema.savedQueries).where(E.eq(Schema.savedQueries.id, input.id))
				if (!existing) return { code: 'err:not-found' as const }
				if (existing.ownerId !== ctx.user.discordId) return { code: 'err:not-owner' as const }
				// editing a retention rule's query changes what gets kept, so it takes the same permission as
				// flipping the flag
				if (existing.retain) {
					const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RETAIN_PERM_REQ)
					if (denyRes) return denyRes
				}
				await ctx
					.db()
					.update(Schema.savedQueries)
					.set({ name: input.name, visibility: input.visibility, query: input.query, updatedAt: new Date() })
					.where(E.eq(Schema.savedQueries.id, input.id))
				return { code: 'ok' as const, id: input.id }
			}
			const id = createId(12)
			await ctx.db().insert(Schema.savedQueries).values({
				id,
				name: input.name,
				ownerId: ctx.user.discordId,
				visibility: input.visibility,
				query: input.query,
			})
			return { code: 'ok' as const, id }
		}),

	deleteSaved: orpcBase.input(z.object({ id: HQ.SAVED_QUERY_ID })).handler(async ({ input, context: ctx }) => {
		const [existing] = await ctx.db().select().from(Schema.savedQueries).where(E.eq(Schema.savedQueries.id, input.id))
		if (!existing) return { code: 'err:not-found' as const }
		if (existing.ownerId !== ctx.user.discordId) return { code: 'err:not-owner' as const }
		await ctx.db().delete(Schema.savedQueries).where(E.eq(Schema.savedQueries.id, input.id))
		// the delete cascaded this rule's claims; events kept only by it can go too
		if (existing.retain) await HistoryRetention.gcOrphanRetainedEvents(ctx)
		return { code: 'ok' as const }
	}),

	setRetain: orpcBase.input(z.object({ id: HQ.SAVED_QUERY_ID, retain: z.boolean() })).handler(async ({ input, context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RETAIN_PERM_REQ)
		if (denyRes) return denyRes
		const [existing] = await ctx.db().select().from(Schema.savedQueries).where(E.eq(Schema.savedQueries.id, input.id))
		if (!existing) return { code: 'err:not-found' as const }
		if (existing.ownerId !== ctx.user.discordId && existing.visibility !== 'shared') return { code: 'err:not-found' as const }
		const query = HQ.QuerySchema.safeParse(existing.query)
		if (!query.success || query.data.type !== 'events') {
			return { code: 'err:invalid-query' as const, message: 'only queries with the events result type can retain their results' }
		}
		if (existing.retain === input.retain) return { code: 'ok' as const }
		await ctx.db().update(Schema.savedQueries).set({ retain: input.retain }).where(E.eq(Schema.savedQueries.id, input.id))
		if (!input.retain) {
			await ctx.db().delete(Schema.retainedEventClaims).where(E.eq(Schema.retainedEventClaims.savedQueryId, input.id))
			await HistoryRetention.gcOrphanRetainedEvents(ctx)
		}
		await AppEventsSys.persistAppEvent(
			ctx,
			AppEvents.create<AppEvents.HistoryRetentionChanged>({
				type: 'HISTORY_RETENTION_CHANGED',
				savedQueryId: input.id,
				savedQueryName: existing.name,
				retain: input.retain,
				actor: { type: 'slm-user', userId: ctx.user.discordId },
				serverId: null,
				matchId: null,
				causeId: null,
			}),
		)
		return { code: 'ok' as const }
	}),
}

const RETAIN_PERM_REQ = RBAC.permReq('any', ['global-settings:write'])

function toMatchDetails(row: (typeof Schema.matchHistory)['$inferSelect']): MH.MatchDetails | undefined {
	try {
		return MH.matchHistoryEntryToMatchDetails(row, false)
	} catch (err) {
		log.warn(err, 'match %d does not map to details; dropping it from the page', row.id)
		return undefined
	}
}

// Event bodies come last and only for the page, read per server because enrichment replays per-server app
// events. Enriched rather than raw: a filtered slice carries no roster to replay against, so the client
// cannot enrich it itself.
async function assembleEventPage(ctx: C.OrpcBase, hits: HistoryQuery.EventHit[]) {
	if (hits.length === 0) return { events: CHAT.Wire.encode([]), matches: [] as MH.MatchDetails[] }
	const matchIds = [...new Set(hits.map((h) => h.matchId))]
	const matchRows = await ctx.db().select().from(Schema.matchHistory).where(E.inArray(Schema.matchHistory.id, matchIds))

	const byServer = new Map<string, number[]>()
	for (const row of matchRows) {
		let ids = byServer.get(row.serverId)
		if (!ids) byServer.set(row.serverId, (ids = []))
		ids.push(row.id)
	}

	const wanted = new Set<number>(hits.map((h) => h.serverEventId))
	const events: CHAT.EventEnriched[] = []
	for (const [serverId, ids] of byServer) {
		const serverCtx = { ...ctx, serverId, matchEventsCache: MatchEventsCache.initMatchEventsCacheContext() }
		const enriched = await MatchEventsCache.getEnrichedEventsForMatches(serverCtx, ...ids)
		// app events replay into the same buffer and carry string ids; the index covers server events only
		events.push(...enriched.filter((e) => typeof e.id === 'number' && wanted.has(e.id)))
	}
	events.sort((a, b) => a.time - b.time)
	return { events: CHAT.Wire.encode(events), matches: matchRows.flatMap((row) => toMatchDetails(row) ?? []) }
}
