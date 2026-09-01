import * as E from 'drizzle-orm'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import { renderRow } from '@/components/feed/render'
import type * as RC from '@/components/feed/render-context'
import { createId } from '@/lib/id'
import { assertNever } from '@/lib/type-guards'
import * as I18n from '@/messages/i18n'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import * as HQ from '@/models/history.models'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as HistoryQuery from '@/systems/history-query.shared'
import type * as HistoryWorker from '@/systems/history-query.worker'
import * as HistoryResolve from '@/systems/history-resolve.server'
import * as HistoryRetention from '@/systems/history-retention.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'

// The history page's server half. A query request is: authorize and resolve on the main thread
// (history-resolve.server.ts), then dispatch the resolved tree to the query engine on a worker thread with
// its own read-only db connection, so a heavy scan never stalls the event loop the rcon and websockets live
// on. A query that arrives with no worker to run it fails: running it here instead would put the scan on
// exactly the loop the worker exists to protect, and one crashed worker would quietly degrade the whole app.

const module = initModule('history')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db })
let ENV!: ReturnType<typeof envBuilder>

// -------- the worker --------

let worker: Worker | undefined
let nextSeq = 1
let shuttingDown = false
let rebootAttempts = 0
let rebootTimer: ReturnType<typeof setTimeout> | undefined
const pending = new Map<
	number,
	{ resolve: (res: HistoryWorker.EngineResponse | HistoryQuery.QueryError) => void; reject: (err: unknown) => void }
>()

const REBOOT_DELAYS = [1_000, 5_000, 30_000]

function failPending(err: unknown) {
	for (const p of pending.values()) p.reject(err)
	pending.clear()
}

// A dead worker means no history queries at all, so it is brought back rather than left down until a restart.
// Backed off and capped: a worker that cannot open the db fails the same way every time.
function scheduleReboot() {
	if (shuttingDown || worker || rebootTimer) return
	const delay = REBOOT_DELAYS[Math.min(rebootAttempts, REBOOT_DELAYS.length - 1)]
	rebootAttempts++
	rebootTimer = setTimeout(() => {
		rebootTimer = undefined
		try {
			bootWorker()
		} catch (err) {
			log.error(err, 'history query worker failed to boot; retrying')
			scheduleReboot()
		}
	}, delay)
	rebootTimer.unref()
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
		// the first answer proves this worker works, so a later crash starts its backoff from the top
		rebootAttempts = 0
		const p = pending.get(msg.seq)
		if (!p) return
		pending.delete(msg.seq)
		if (msg.err) p.reject(Object.assign(new Error(msg.err.message), { stack: msg.err.stack }))
		else p.resolve(msg.res!)
	})
	w.on('error', (err) => {
		log.error(err, 'history query worker failed')
		if (worker === w) worker = undefined
		failPending(err)
		scheduleReboot()
	})
	w.on('exit', () => {
		if (worker === w) worker = undefined
		failPending(new Error('history query worker exited'))
		scheduleReboot()
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
		// not fatal: SLM managing live servers should not die because the history engine cannot start
		log.error(err, 'history query worker failed to boot; history queries are unavailable until it does')
		scheduleReboot()
	}
	CleanupSys.register(async () => {
		shuttingDown = true
		if (rebootTimer) clearTimeout(rebootTimer)
		await worker?.terminate()
	})
}

async function dispatch(
	ctx: CS.AbortSignal,
	req: HistoryWorker.EngineRequest,
): Promise<HistoryWorker.EngineResponse | HistoryQuery.QueryError> {
	if (!worker) return { code: 'err:engine-unavailable', message: 'the history query engine is not running' }
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

// what server-side rendering needs to know about the viewer, since row markup depends on both
const RenderSchema = z.object({
	displayTeamsNormalized: z.boolean().prefault(true),
	locale: z.string().max(35).prefault('en'),
})
type RenderOpts = z.infer<typeof RenderSchema>

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
				render: RenderSchema.prefault({}),
				// events only. 'html' is the default because a results feed only displays what it gets; 'wire'
				// is for a caller that has to do something with the events themselves, like interleave them
				// with live ones (the player details window).
				format: z.enum(['html', 'wire']).prefault('html'),
				// keep the match-boundary events of the matches on the page, even though no filter selected
				// them. A slice of one player's history reads as a flat run of events without them.
				includeMatchBoundaries: z.boolean().prefault(false),
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
					const page = await assembleEventPage(ctx, res.hits, input.render, input.format, input.includeMatchBoundaries)
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

	// who a player is, independent of any server: what the frameless player-details window opens with
	playerInfo: orpcBase.input(z.object({ playerId: z.string() })).handler(async ({ input, context: ctx }) => {
		const [row] = await ctx
			.db()
			.select({ username: Schema.players.username, steamId: Schema.players.steamId })
			.from(Schema.players)
			.where(E.eq(Schema.players.eosId, input.playerId))
		if (!row) return { code: 'err:not-found' as const }
		return { code: 'ok' as const, username: row.username, steamId: row.steamId?.toString() ?? null }
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
// events. The rows go out as rendered html rather than event data: the same builders the live feed uses run
// here against a shadow dom, the client inserts the strings and holds them behind content-visibility, and
// interactivity is all attributes resolved against the client's scope (see feed/render-context.ts).
async function assembleEventPage(
	ctx: C.OrpcBase,
	hits: HistoryWorker.EventHit[],
	render: RenderOpts,
	format: 'html' | 'wire',
	includeMatchBoundaries = false,
) {
	if (hits.length === 0) return { rowsHtml: [] as string[], events: null as CHAT.Wire.Batch | null, matches: [] as MH.MatchDetails[] }
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
		const enriched = await MatchEventsCache.getEnrichedEventsForMatches(serverCtx, Settings.GLOBAL_SETTINGS.chat, ...ids)
		// app events replay into the same buffer and carry string ids; the index covers server events only
		events.push(
			...enriched.filter((e) => (typeof e.id === 'number' && wanted.has(e.id)) || (includeMatchBoundaries && e.type === 'NEW_GAME')),
		)
	}
	// newest first, matching the page order: each further page stacks downward into the past
	events.sort((a, b) => b.time - a.time)
	const matches = matchRows.flatMap((row) => toMatchDetails(row) ?? [])
	const revived = await reviveNoops(ctx, events)
	if (format === 'wire') return { rowsHtml: [] as string[], events: CHAT.Wire.encode(revived), matches }
	return { rowsHtml: renderEventRows(revived, matches, render), events: null, matches }
}

// Interpolation NOOPs an event whose players are missing from the replayed roster, which is every event of a
// match that only survives as retained rows. The hit is still a result, so it is revived: the raw event with
// minimal players (name from the players table, no team or squad) put back on the fields interpolation reads.
//
// A suppressed event is not revived. It is still a hit -- the index has no idea a pattern matches it -- so it
// goes through as the NOOP it is and the renderer stands a placeholder in for it, rather than being dropped
// (which would leave the page short of its own result count) or revived (which would undo the suppression).
async function reviveNoops(ctx: C.OrpcBase, events: CHAT.EventEnriched[]): Promise<CHAT.EventEnriched[]> {
	const playerFieldsOf = (type: string) =>
		(CHAT.Wire.FIELDS as Record<string, { players?: readonly string[]; playerLists?: readonly string[] }>)[type]
	const revivable = (e: CHAT.EventEnriched): e is CHAT.NoopEvent => e.type === 'NOOP' && e.cause === 'unresolved'

	const missing = new Set<string>()
	for (const event of events) {
		if (!revivable(event)) continue
		const original = event.originalEvent as unknown as Record<string, unknown>
		const fields = playerFieldsOf(event.originalEvent.type)
		for (const key of fields?.players ?? []) {
			if (typeof original[key] === 'string') missing.add(original[key])
		}
		for (const key of fields?.playerLists ?? []) {
			for (const id of Array.isArray(original[key]) ? (original[key] as unknown[]) : []) {
				if (typeof id === 'string') missing.add(id)
			}
		}
	}
	if (missing.size === 0) return events.filter((e) => !revivable(e))

	const nameRows = await ctx
		.db()
		.select({ eosId: Schema.players.eosId, username: Schema.players.username, steamId: Schema.players.steamId })
		.from(Schema.players)
		.where(E.inArray(Schema.players.eosId, [...missing]))
	const names = new Map(nameRows.map((r) => [r.eosId, r]))
	const synth = (value: unknown) => {
		if (typeof value !== 'string') return value
		const row = names.get(value)
		return {
			ids: { eos: value, username: row?.username ?? value, steam: row?.steamId?.toString() },
			teamId: null,
			squadId: null,
			isLeader: false,
			isAdmin: false,
			role: '',
		} satisfies SM.Player
	}

	const out: CHAT.EventEnriched[] = []
	for (const event of events) {
		if (!revivable(event)) {
			out.push(event)
			continue
		}
		const fields = playerFieldsOf(event.originalEvent.type)
		if (!fields) continue
		const revived = { ...(event.originalEvent as unknown as Record<string, unknown>) }
		for (const key of fields.players ?? []) {
			if (revived[key] !== undefined && revived[key] !== null) revived[key] = synth(revived[key])
		}
		for (const key of fields.playerLists ?? []) {
			if (Array.isArray(revived[key])) revived[key] = (revived[key] as unknown[]).map(synth)
		}
		out.push(revived as unknown as CHAT.EventEnriched)
	}
	return out
}

function renderEventRows(events: CHAT.EventEnriched[], matches: MH.MatchDetails[], render: RenderOpts): string[] {
	const byId = new Map(matches.map((m) => [m.historyEntryId, m]))
	const rctx: RC.RenderCtx = {
		scopeId: '',
		stores: {} as never,
		outletKey: 'default',
		zIndexBase: 0,
		displayTeamsNormalized: render.displayTeamsNormalized,
		showTeamlessChat: true,
		placeholderUndrawn: true,
		matchById: (matchId) => (matchId === null || matchId === undefined ? undefined : byId.get(matchId)),
		latestMatch: undefined,
		currentMatch: undefined,
		groupColor: () => null,
	}
	// safe to set-and-restore without a scope: the render loop below is synchronous, so nothing else can
	// read the ambient locale while it is ours
	const prevLocale = I18n.getAmbientLocale()
	I18n.setAmbientLocale(render.locale)
	try {
		const out: string[] = []
		for (const event of events) {
			if (event.type === 'APP_EVENT') continue
			const html = renderRow(rctx, event)
			if (html !== '') out.push(html)
		}
		return out
	} finally {
		I18n.setAmbientLocale(prevLocale)
	}
}
