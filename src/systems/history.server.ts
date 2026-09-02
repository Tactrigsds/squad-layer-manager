import * as E from 'drizzle-orm'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import { renderRow } from '@/components/feed/render'
import * as RC from '@/components/feed/render-context'
import { createId } from '@/lib/id'
import { assertNever } from '@/lib/type-guards'
import * as I18n from '@/messages/i18n'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import * as HQ from '@/models/history.models'
import * as MH from '@/models/match-history.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as HistoryQuery from '@/systems/history-query.shared'
import type * as HistoryWorker from '@/systems/history-query.worker'
import * as HistoryResolve from '@/systems/history-resolve.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import * as PluginsSys from '@/systems/plugins.server'
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

// a position in the merged event order; exactly one id is set, per the family the cursor sits in
const CursorSchema = z.object({
	time: z.number().int(),
	serverEventId: z.number().int().optional(),
	appEventId: z.string().optional(),
})

// what server-side rendering needs to know about the viewer, since row markup depends on both
const RenderSchema = z.object({
	displayTeamsNormalized: z.boolean().prefault(true),
	locale: z.string().max(35).prefault('en'),
})
type RenderOpts = z.infer<typeof RenderSchema>

// a name picker only has to show enough to pick from; a needle matching thousands is a needle to keep typing
const PLAYER_SEARCH_LIMIT = 25

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
					const order = input.query.order ?? 'newest'
					const res = await dispatch(ctx, {
						kind: 'events',
						node,
						bounds,
						cursor: input.cursor,
						pageSize: HQ.PAGE_SIZES.events,
						withTotal: !input.cursor,
						order,
					})
					if (res.code !== 'ok') return res
					if (res.kind !== 'events') throw new Error('engine returned a mismatched response kind')
					const page = await assembleEventPage(ctx, res.hits, input.render, input.format, input.includeMatchBoundaries, order)
					const last = res.hits.at(-1)
					const nextCursor =
						res.hits.length === HQ.PAGE_SIZES.events && last
							? { time: last.time.getTime(), serverEventId: last.serverEventId, appEventId: last.appEventId }
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
						// keyed by match id, since a row toMatchDetails drops has no details to hang a count on
						eventCounts: res.events,
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

	// what the player field's combo-box lists as you type. Names rather than ids: nobody filters by an eos id
	// they remembered, and the trigram index makes a substring needle an index lookup (resolveNamedPlayerIds).
	searchPlayers: orpcBase.input(z.object({ needle: z.string() })).handler(async ({ input, context: ctx }) => {
		const eosIds = await HistoryQuery.resolveNamedPlayerIds(ctx, input.needle)
		if (eosIds.length === 0) return { code: 'ok' as const, players: [] }
		const rows = await ctx
			.db()
			.select({ eosId: Schema.players.eosId, username: Schema.players.username })
			.from(Schema.players)
			.where(E.inArray(Schema.players.eosId, eosIds))
			.limit(PLAYER_SEARCH_LIMIT)
		return { code: 'ok' as const, players: rows }
	}),

	// Every SLM user, for the user field to search and to label its selection from. Listed rather than
	// searched: an install has hundreds of users where it has hundreds of thousands of players, so the whole
	// table is cheaper than a round trip per keystroke plus another to name what is already selected.
	listUsers: orpcBase.handler(async ({ context: ctx }) => {
		const rows = await ctx
			.db()
			.select({ discordId: Schema.users.discordId, nickname: Schema.users.nickname, username: Schema.discordAccounts.username })
			.from(Schema.users)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.users.discordId))
		return { code: 'ok' as const, users: rows.map((r) => ({ userId: r.discordId.toString(), name: r.nickname || r.username })) }
	}),

	// names for players already chosen, which the search-by-needle path cannot supply: a query arriving by
	// url or as a saved row carries ids nobody typed a needle for
	playerLabels: orpcBase.input(z.object({ playerIds: z.array(z.string()) })).handler(async ({ input, context: ctx }) => {
		if (input.playerIds.length === 0) return { code: 'ok' as const, players: [] }
		const rows = await ctx
			.db()
			.select({ eosId: Schema.players.eosId, username: Schema.players.username })
			.from(Schema.players)
			.where(E.inArray(Schema.players.eosId, input.playerIds))
		return { code: 'ok' as const, players: rows }
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
		return { code: 'ok' as const }
	}),
}

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
	order: HistoryWorker.EventOrder = 'newest',
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

	// hits from either family; a replayed entry is kept when it stands for one of them (see iterContainedEventIds)
	const wanted = new Set<number>(hits.flatMap((h) => (h.serverEventId === undefined ? [] : [h.serverEventId])))
	const wantedAppEvents = new Set<string>(hits.flatMap((h) => (h.appEventId === undefined ? [] : [h.appEventId])))
	const events: CHAT.EventEnriched[] = []
	for (const [serverId, ids] of byServer) {
		const serverCtx = { ...ctx, serverId, matchEventsCache: MatchEventsCache.initMatchEventsCacheContext() }
		const enriched = await MatchEventsCache.getEnrichedEventsForMatches(serverCtx, Settings.GLOBAL_SETTINGS.chat, ...ids)
		// by containment, not by id: a hit whose event replay folded into another entry -- a warn collapsed under
		// the app event that issued it, one of a burst merged into a WARNS_AGGREGATED -- is shown by that entry,
		// and matching on the top-level id alone would drop it from the page
		events.push(
			...enriched.filter((e) => {
				if (includeMatchBoundaries && e.type === 'NEW_GAME') return true
				if (typeof e.id === 'string' && wantedAppEvents.has(e.id)) return true
				for (const id of CHAT.iterContainedEventIds(e)) {
					if (wanted.has(id)) return true
				}
				return false
			}),
		)
	}
	// the same direction the hits were paged in, so each further page stacks on in reading order
	events.sort((a, b) => (order === 'newest' ? b.time - a.time : a.time - b.time))
	const matches = matchRows.flatMap((row) => toMatchDetails(row) ?? [])
	const revived = await MatchEventsCache.reviveNoops(ctx, events, { keepSuppressed: true })
	if (format === 'wire') return { rowsHtml: [] as string[], events: CHAT.Wire.encode(revived), matches }
	return { rowsHtml: renderEventRows(revived, matches, render, await actorLabels(ctx, revived)), events: null, matches }
}

// display names for the actors the page's app events name. Resolved here rather than by the rows, which are inert
// templates: the same lookup the client does through its stores (see use-actor-labels.ts).
async function actorLabels(ctx: C.Db, events: CHAT.EventEnriched[]) {
	const userIds = new Set<USR.UserId>()
	for (const event of events) {
		if (event.type !== 'APP_EVENT') continue
		for (const id of AppEvents.iterAssocUserIds(event.appEvent)) userIds.add(id)
	}
	// nickname over the discord username, and no discord fetch: a row is not worth a round trip per actor, and
	// this is the fallback every lookup lands on anyway when discord is disabled (see selectBestDisplayName)
	const users =
		userIds.size > 0
			? await ctx
					.db()
					.select({ discordId: Schema.users.discordId, nickname: Schema.users.nickname, username: Schema.discordAccounts.username })
					.from(Schema.users)
					.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.users.discordId))
					.where(E.inArray(Schema.users.discordId, [...userIds]))
			: []
	const names = new Map(users.map((u) => [u.discordId, u.nickname || u.username]))
	const pluginNames = new Map(PluginsSys.listRuntimeInfo().map((p) => [p.id, p.name]))
	return {
		userLabel: (userId: USR.UserId) => names.get(userId),
		pluginName: (pluginId: string) => pluginNames.get(pluginId),
	}
}

function renderEventRows(
	events: CHAT.EventEnriched[],
	matches: MH.MatchDetails[],
	render: RenderOpts,
	labels: Pick<RC.RenderCtx, 'userLabel' | 'pluginName'>,
): string[] {
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
		...labels,
	}
	// safe to set-and-restore without a scope: the render loop below is synchronous, so nothing else can
	// read the ambient locale while it is ours. Same for the timestamp format: results span days and servers,
	// so a row's time on its own does not place it, unlike in a feed of one match.
	const prevLocale = I18n.getAmbientLocale()
	I18n.setAmbientLocale(render.locale)
	const prevFull = RC.setFullTimestamps(true)
	try {
		const out: string[] = []
		for (const event of events) {
			// per row rather than per pass: results span matches, and which one a row is from is the thing a
			// timestamp alone does not say
			RC.setRowMatchId(event.matchId ?? undefined)
			const html = renderRow(rctx, event)
			if (html !== '') out.push(html)
		}
		return out
	} finally {
		I18n.setAmbientLocale(prevLocale)
		RC.setFullTimestamps(prevFull)
		RC.setRowMatchId(undefined)
	}
}
