import { raceAbort, sleep, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { FixedSizeMap } from '@/lib/lru-map'
import * as AppEvents from '@/models/app-events.models'
import * as BM from '@/models/battlemetrics.models'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as PersistedCache from '@/systems/persistedCache.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Otel from '@opentelemetry/api'
import * as Rx from 'rxjs'
import { z } from 'zod'

const getEnv = Env.getEnvBuilder({ ...Env.groups.battlemetrics })
const module = initModule('battlemetrics')
const orpcBase = getOrpcBase(module)

let ENV!: ReturnType<typeof getEnv>
let log!: ReturnType<typeof module.getLogger>

export async function setup() {
	log = module.getLogger()
	ENV = getEnv()

	try {
		const stored = await PersistedCache.load<PersistedCacheValue>(CACHE_PERSIST_KEY)
		if (stored) {
			const now = Date.now()
			let loaded = 0
			for (const [eosId, entry] of Object.entries(stored)) {
				if (entry.expiresAt <= now) continue
				playerFlagsAndProfileCache.set(eosId, entry)
				loaded++
			}
			log.info('Loaded %d player BM cache entries from DB', loaded)
		}
	} catch (err) {
		log.warn({ err }, 'Failed to load BM player cache from DB')
	}

	const persistSub = Rx.interval(CACHE_PERSIST_INTERVAL_MS).pipe(
		C.durableSub(
			'bm-cache-persist',
			{ module, root: true, taskScheduling: 'exhaust' },
			() => persistCache().catch((err) => log.warn({ err }, 'Failed to persist BM player cache')),
		),
	).subscribe()

	const evictSub = Rx.interval(CACHE_EVICTION_INTERVAL_MS).subscribe(() => evictExpiredCacheEntries())

	CleanupSys.register(async () => {
		persistSub.unsubscribe()
		evictSub.unsubscribe()
		await persistCache().catch((err) => log.warn({ err }, 'Failed to final-persist BM player cache on shutdown'))
	})
}

// -------- cache --------

const PLAYER_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

// Keyed by EOS ID (required). Each entry also keeps the BM-internal player ID
// needed for flag mutation endpoints, which is not part of PlayerFlagsAndProfile.
const playerFlagsAndProfileCache = new FixedSizeMap<string, { value: BM.PlayerFlagsAndProfile; bmPlayerId: string; expiresAt: number }>(500)

let orgFlagsCache: BM.PlayerFlag[] | null = null
let orgFlagsFetchPromise: Promise<BM.PlayerFlag[]> | null = null

function getCachedPlayer(eosId: string): BM.PlayerFlagsAndProfile | undefined {
	const entry = playerFlagsAndProfileCache.get(eosId)
	if (!entry) return undefined
	if (Date.now() > entry.expiresAt) return undefined
	return entry.value
}

function getCachedPlayerEntry(eosId: string): { value: BM.PlayerFlagsAndProfile; bmPlayerId: string } | undefined {
	const entry = playerFlagsAndProfileCache.get(eosId)
	if (!entry) return undefined
	if (Date.now() > entry.expiresAt) return undefined
	return entry
}

function setCachedPlayer(eosId: string, bmPlayerId: string, value: BM.PlayerFlagsAndProfile) {
	playerFlagsAndProfileCache.set(eosId, { value, bmPlayerId, expiresAt: Date.now() + PLAYER_CACHE_TTL })
}

// -------- cache eviction --------

const CACHE_EVICTION_INTERVAL_MS = 10 * 60 * 1000

function evictExpiredCacheEntries() {
	const now = Date.now()
	let evicted = 0
	for (const [eosId, entry] of playerFlagsAndProfileCache.entries()) {
		if (entry.expiresAt <= now) {
			playerFlagsAndProfileCache.delete(eosId)
			evicted++
		}
	}
	if (evicted > 0) log.debug('Evicted %d expired BM cache entries', evicted)
}

// -------- cache persistence --------

const CACHE_PERSIST_KEY = 'bm:playerCache'
const CACHE_PERSIST_INTERVAL_MS = 5 * 60 * 1000

type PersistedCacheValue = Record<string, { value: BM.PlayerFlagsAndProfile; bmPlayerId: string; expiresAt: number }>

async function persistCache() {
	const now = Date.now()
	const toStore: PersistedCacheValue = {}
	for (const [eosId, entry] of playerFlagsAndProfileCache.entries()) {
		if (entry.expiresAt <= now) continue
		toStore[eosId] = entry
	}
	await PersistedCache.save(CACHE_PERSIST_KEY, toStore)
}

// -------- polling config --------

const POLL_INTERVAL_MS = 5 * 60 * 1000

const playerUpdate$ = new IsolatedSubject<BM.PlayerBmDataUpdate>()

export type { PublicPlayerBmData } from '@/models/battlemetrics.models'

// -------- rate-limit queue --------

const RATE_LIMITS = {
	perSecond: 10,
	perMinute: 60,
	backoffDefaultMs: 30_000,
} as const

const rateLimiter = {
	timestamps: [] as number[],
	queue: [] as Array<() => void>,
	drainScheduled: false,
	backoffUntil: 0,
}

function pruneTimestamps(now: number) {
	const cutoff = now - 60_000
	while (rateLimiter.timestamps.length > 0 && rateLimiter.timestamps[0] <= cutoff) {
		rateLimiter.timestamps.shift()
	}
}

function countInWindow(now: number, windowMs: number): number {
	let count = 0
	for (let i = rateLimiter.timestamps.length - 1; i >= 0; i--) {
		if (rateLimiter.timestamps[i] > now - windowMs) count++
		else break
	}
	return count
}

function canDispatch(now: number): boolean {
	if (now < rateLimiter.backoffUntil) return false
	return (
		countInWindow(now, 1_000) < RATE_LIMITS.perSecond
		&& countInWindow(now, 60_000) < RATE_LIMITS.perMinute
	)
}

function scheduleDrain() {
	if (rateLimiter.drainScheduled || rateLimiter.queue.length === 0) return
	rateLimiter.drainScheduled = true

	const now = Date.now()
	pruneTimestamps(now)

	let delayMs = 0
	if (now < rateLimiter.backoffUntil) {
		delayMs = rateLimiter.backoffUntil - now
	} else {
		if (countInWindow(now, 1_000) >= RATE_LIMITS.perSecond) {
			const oldest1s = rateLimiter.timestamps.find((t) => t > now - 1_000)!
			delayMs = Math.max(delayMs, oldest1s + 1_000 - now)
		}
		if (countInWindow(now, 60_000) >= RATE_LIMITS.perMinute) {
			const oldest60s = rateLimiter.timestamps[0]
			delayMs = Math.max(delayMs, oldest60s + 60_000 - now)
		}
	}

	setTimeout(() => {
		rateLimiter.drainScheduled = false
		drainQueue()
	}, delayMs + 1)
}

function drainQueue() {
	const now = Date.now()
	pruneTimestamps(now)
	while (rateLimiter.queue.length > 0 && canDispatch(now)) {
		rateLimiter.timestamps.push(now)
		const resolve = rateLimiter.queue.shift()!
		resolve()
	}
	scheduleDrain()
}

const meter = Otel.metrics.getMeter('battlemetrics')

meter.createObservableGauge(ATTRS.Battlemetrics.REQUESTS_PER_SECOND, {
	description: 'Number of BattleMetrics API requests in the last 1s window',
}).addCallback((result) => {
	const now = Date.now()
	pruneTimestamps(now)
	result.observe(countInWindow(now, 1_000))
})

meter.createObservableGauge(ATTRS.Battlemetrics.REQUESTS_PER_MINUTE, {
	description: 'Number of BattleMetrics API requests in the last 60s window',
}).addCallback((result) => {
	const now = Date.now()
	pruneTimestamps(now)
	result.observe(countInWindow(now, 60_000))
})

meter.createObservableGauge(ATTRS.Battlemetrics.QUEUE_SIZE, {
	description: 'Number of queued BattleMetrics API requests waiting for a rate limit slot',
}).addCallback((result) => {
	result.observe(rateLimiter.queue.length)
})

function acquireRateSlot(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason)
	const now = Date.now()
	pruneTimestamps(now)
	if (canDispatch(now)) {
		rateLimiter.timestamps.push(now)
		return Promise.resolve()
	}
	return new Promise<void>((resolve, reject) => {
		const entry = () => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}
		const onAbort = () => {
			const idx = rateLimiter.queue.indexOf(entry)
			if (idx !== -1) rateLimiter.queue.splice(idx, 1)
			reject(signal!.reason)
		}
		signal?.addEventListener('abort', onAbort, { once: true })
		rateLimiter.queue.push(entry)
		scheduleDrain()
	})
}

function triggerBackoff(res: Response) {
	const retryAfter = res.headers.get('Retry-After')
	let delayMs = RATE_LIMITS.backoffDefaultMs
	if (retryAfter) {
		const seconds = Number(retryAfter)
		if (!Number.isNaN(seconds)) {
			delayMs = seconds * 1_000
		}
	}
	rateLimiter.backoffUntil = Date.now() + delayMs
	log.warn('BattleMetrics 429 — backing off for %dms', delayMs)
	scheduleDrain()
}

// -------- BM API --------

const RETRY = {
	maxAttempts: 3,
	baseDelayMs: 1_000,
} as const

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500
}

async function bmFetch<T = null>(
	ctx: CS.Ctx & CS.AbortSignal,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	init?: Omit<RequestInit, 'body' | 'method'> & { body?: unknown; responseSchema?: z.ZodType<T>; passthroughCodes?: number[] },
): Promise<readonly [T, Response]> {
	return C.spanOp(
		'bmFetch',
		{
			module,
			kind: Otel.SpanKind.CLIENT,
			levels: { error: 'error', event: 'trace' },
			attrs: () => ({ [ATTRS.Http.METHOD]: method, [ATTRS.Http.PATH]: path }),
		},
		async (ctx: CS.Ctx & CS.AbortSignal) => {
			const url = `${ENV.BM_HOST}${path}`

			const headers: Record<string, string> = {
				'Authorization': `Bearer ${ENV.BM_PAT}`,
				'Accept': 'application/json',
				...(init?.headers as Record<string, string>),
			}

			let body: string | undefined
			if (init?.body != null && typeof init.body === 'object') {
				body = JSON.stringify(init.body)
				headers['Content-Type'] = 'application/json'
			}

			let lastError!: Error
			for (let attempt = 0; attempt < RETRY.maxAttempts; attempt++) {
				await acquireRateSlot(ctx.signal)
				const res = await fetch(url, { method, headers, body, signal: ctx.signal }).catch((error) => {
					log.error(`${method} ${path}: ${error.message}`)
					return error as Error
				})

				// network error
				if (res instanceof Error) {
					ctx.signal.throwIfAborted()
					lastError = res
					if (attempt < RETRY.maxAttempts - 1) {
						const delay = RETRY.baseDelayMs * 2 ** attempt
						log.warn(`${method} ${path}: network error, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY.maxAttempts})`)
						await sleep(delay, ctx.signal)
						continue
					}
					throw lastError
				}

				if (res.status === 429) {
					triggerBackoff(res)
					lastError = new Error(`BattleMetrics API rate limited: 429 Too Many Requests`)
					if (attempt < RETRY.maxAttempts - 1) {
						const delay = Math.max(RETRY.baseDelayMs * 2 ** attempt, rateLimiter.backoffUntil - Date.now())
						log.warn(`${method} ${path}: 429 rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY.maxAttempts})`)
						await sleep(delay, ctx.signal)
						continue
					}
					throw lastError
				}
				if (init?.passthroughCodes?.includes(res.status)) {
					return [null as any, res] as const
				}

				if (!res.ok) {
					const text = await res.text().catch(() => '')
					lastError = new Error(`BattleMetrics API error: ${res.status} ${res.statusText}\n${text}`)
					if (isRetryable(res.status) && attempt < RETRY.maxAttempts - 1) {
						const delay = RETRY.baseDelayMs * 2 ** attempt
						log.warn(`${method} ${path}: ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY.maxAttempts})`)
						await sleep(delay, ctx.signal)
						continue
					}
					log.error({ status: res.status, statusText: res.statusText, body: text }, `${method} ${path}: ${res.status} ${res.statusText}`)
					throw lastError
				}
				let level: 'info' | 'debug' = 'info'
				if (method === 'GET') level = 'debug'

				log[level]({ status: res.status, method, path }, `${method} ${path} : ${res.status}`)
				C.setSpanOpAttrs({ [ATTRS.Http.STATUS_CODE]: res.status })

				const contentType = res.headers.get('content-type') ?? ''
				if (!contentType.includes('application/json')) {
					const text = await res.text().catch(() => '')
					log.error({ contentType, body: text }, `${method} ${path}: unexpected content-type: ${contentType}`)
					throw new Error(`BattleMetrics API returned unexpected content-type: ${contentType}`)
				}

				if (init?.responseSchema) {
					const payload = await res.json()
					const result = init.responseSchema.safeParse(payload)
					if (!result.success) {
						log.error({ validationError: z.prettifyError(result.error) }, `${method} ${path}: response validation failed`)
						throw new Error(`Failed to validate response from ${method} ${path}: \n${z.prettifyError(result.error)}`)
					}
					return [result.data, res] as const
				}

				return [null as T, res] as const
			}

			throw lastError
		},
	)(ctx)
}

// -------- BM data fetching --------

const OrgFlagsResponse = z.object({
	data: z.array(z.object({
		type: z.literal('playerFlag'),
		id: z.string(),
		attributes: BM.PlayerFlagAttributes,
	})),
})

export const getOrgFlags = C.spanOp(
	'getOrgFlags',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal): Promise<BM.PlayerFlag[]> => {
		if (orgFlagsCache) return orgFlagsCache

		if (!orgFlagsFetchPromise) {
			// the fetch is shared between callers, so tie it to process shutdown rather than any single caller's signal
			orgFlagsFetchPromise = (async () => {
				const [data] = await bmFetch({ ...ctx, signal: CleanupSys.shutdownSignal }, 'GET', `/player-flags?page[size]=100`, {
					responseSchema: OrgFlagsResponse,
				})
				return data.data.map((f) => ({ id: f.id, ...f.attributes }))
			})().catch((err) => {
				orgFlagsFetchPromise = null
				throw err
			})
		}

		const flags = await raceAbort(orgFlagsFetchPromise, ctx.signal)
		orgFlagsCache = flags
		return flags
	},
)

export const addPlayerFlags = C.spanOp(
	'addPlayerFlags',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal, bmPlayerId: string, flagIds: string[]) => {
		if (flagIds.length === 0) return { code: 'err:no-flags' as const }
		const [_, res] = await bmFetch(ctx, 'POST', `/players/${bmPlayerId}/relationships/flags`, {
			body: { data: flagIds.map((id) => ({ type: 'playerFlag', id })) },
			passthroughCodes: [409],
		})
		if (res.status === 409) return { code: 'player-already-has-flag' as const }
		return { code: 'ok' as const }
	},
)

export const addPlayerNote = C.spanOp(
	'addPlayerNote',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal, bmPlayerId: string, note: string) => {
		await bmFetch(ctx, 'POST', `/players/${bmPlayerId}/relationships/notes`, {
			body: {
				data: {
					type: 'playerNote',
					attributes: { note, shared: true },
					relationships: { organization: { data: { type: 'organization', id: ENV.BM_ORG_ID } } },
				},
			},
		})
	},
)

export const removePlayerFlags = C.spanOp(
	'removePlayerFlags',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal, bmPlayerId: string, flagIds: string[]): Promise<('ok' | 'already-removed')[]> => {
		if (flagIds.length === 0) return []
		return Promise.all(flagIds.map(async (flagId) => {
			const [, res] = await bmFetch(ctx, 'DELETE', `/players/${bmPlayerId}/relationships/flags/${flagId}`, { passthroughCodes: [400] })
			if (res.status === 400) {
				const bodyText = await res.text()
				const body = JSON.parse(bodyText)
				if (body.details === 'Flag is already removed') {
					return 'already-removed' as const
				}
				throw new Error(`Battlemetrics API error: ${res.status} ${res.statusText}\n${bodyText}`)
			}
			return 'ok' as const
		}))
	},
)

async function fetchPlayerDetail(
	ctx: CS.Ctx & CS.AbortSignal,
	eosId: string,
	bmPlayerId: string,
): Promise<BM.PlayerFlagsAndProfile> {
	const { BM_ORG_ID } = getEnv()
	const detailPath = `/players/${bmPlayerId}`
		+ `?include=identifier,flagPlayer,playerFlag`
		+ `&filter[identifiers]=eosID,steamID`
		+ `&fields[identifier]=type,identifier`
		+ `&fields[playerFlag]=name,color,description,icon`

	const [detailData] = await bmFetch(ctx, 'GET', detailPath, {
		responseSchema: BM.PlayerDetailResponse,
	})

	const detailIncluded = detailData.included ?? []

	const detailIdentifiers = detailIncluded.filter((i): i is typeof i & { type: 'identifier' } => i.type === 'identifier')
	const steamIdent = detailIdentifiers.find((i) => i.attributes.type === 'steamID')
	const steamId = steamIdent?.attributes.identifier
	const resolvedPlayerIds: SM.PlayerIds.IdQuery<'eos'> = { eos: eosId, ...(steamId ? { steam: steamId } : {}) }

	const flagPlayers = detailIncluded
		.filter((i): i is typeof i & { type: 'flagPlayer' } => i.type === 'flagPlayer')
		.filter((fp) => !fp.attributes?.removedAt)
		.filter((fp) => !BM_ORG_ID || fp.relationships?.organization?.data?.id === BM_ORG_ID)

	const flagIds = flagPlayers.map((fp) => fp.relationships?.playerFlag?.data?.id ?? fp.id)

	const canonicalId = SM.PlayerIds.getPlayerId(resolvedPlayerIds)
	const value: BM.PlayerFlagsAndProfile = {
		flagIds,
		bmPlayerId,
		playerIds: resolvedPlayerIds,
		profileUrl: `https://www.battlemetrics.com/rcon/players/${bmPlayerId}`,
		hoursPlayed: 0,
	}
	setCachedPlayer(canonicalId, bmPlayerId, value)

	playerUpdate$.next({ playerId: canonicalId, data: value })

	return value
}

const bulkFetchOnlinePlayers = C.spanOp(
	'bulkFetchOnlinePlayers',
	{ module },
	async (ctx: CS.Ctx & C.ServerSlice): Promise<string[] | undefined> => {
		const teamsRes = await ctx.server.teams.get(ctx)
		if (teamsRes.code !== 'ok') return
		const onlinePlayers = teamsRes.players

		const onlineEosIds = onlinePlayers.map(p => SM.PlayerIds.getPlayerId(p.ids))
		const uncached = onlinePlayers.filter((p) => !getCachedPlayer(SM.PlayerIds.getPlayerId(p.ids)))

		if (uncached.length > 0) {
			// Resolve all uncached EOS IDs to BM player IDs in one request.
			const [matchData] = await bmFetch(ctx, 'POST', '/players/quick-match', {
				body: { data: uncached.map((p) => ({ type: 'identifier', attributes: { type: 'eosID', identifier: p.ids.eos } })) },
				responseSchema: BM.PlayerQuickMatchResponse,
			})

			// Build a map from EOS ID → BM player ID using the identifier value in the response.
			const eosIdToBmId = new Map<string, string>()
			for (const item of matchData.data) {
				const bmId = item.relationships?.player?.data?.id
				if (bmId) eosIdToBmId.set(item.attributes.identifier, bmId)
			}

			// Fetch full detail for each matched player in parallel.
			await Promise.all(uncached.map(async (p) => {
				const bmPlayerId = eosIdToBmId.get(p.ids.eos)
				if (!bmPlayerId) return
				await fetchPlayerDetail(ctx, p.ids.eos, bmPlayerId).catch((err) => {
					log.warn({ err, playerIds: p.ids }, 'failed to fetch player bm detail')
				})
			}))
		}

		log.info('fetched %d online players (%d fetched from BM api)', onlineEosIds.length, uncached.length)
		return onlineEosIds
	},
)

export async function invalidateAndRefetchPlayer(
	ctx: CS.Ctx & C.ServerSlice & CS.AbortSignal,
	eosId: string,
): Promise<BM.PlayerFlagsAndProfile | null> {
	playerFlagsAndProfileCache.delete(eosId)
	const updated = await fetchSinglePlayerBmData(ctx, SM.PlayerIds.queryFromPlayerId(eosId))
	persistCache().catch((err) => log.warn({ err }, 'Failed to persist BM cache after flag update'))
	return updated
}

export const fetchSinglePlayerBmData = C.spanOp(
	'fetchSinglePlayerBmData',
	{ module, attrs: (_ctx, playerIds) => ({ [ATTRS.Player.EOS_ID]: playerIds.eos, [ATTRS.Player.STEAM_ID]: playerIds.steam }) },
	async (ctx: CS.Ctx & CS.AbortSignal, playerIds: SM.PlayerIds.IdQuery<'eos'>): Promise<BM.PlayerFlagsAndProfile | null> => {
		const eosId = playerIds.eos
		const cached = getCachedPlayer(eosId)
		if (cached) return cached

		const [matchData] = await bmFetch(ctx, 'POST', '/players/quick-match', {
			body: { data: [{ type: 'identifier', attributes: { type: 'eosID', identifier: eosId } }] },
			responseSchema: BM.PlayerQuickMatchResponse,
		})

		if (matchData.data.length === 0) return null
		const bmPlayerId = matchData.data[0].relationships?.player?.data?.id
		if (!bmPlayerId) return null

		return fetchPlayerDetail(ctx, eosId, bmPlayerId)
	},
)

// -------- interval-based bulk polling --------

export function setupSquadServerInstance(ctx: C.ServerSlice) {
	const serverId = ctx.serverId

	ctx.cleanup.push(
		Rx.interval(POLL_INTERVAL_MS).pipe(
			Rx.startWith(0),
			C.durableSub('bm-bulk-poll', { module, root: true, taskScheduling: 'exhaust' }, async (_, signal) => {
				const sliceCtx = SquadServer.resolveSliceCtx({ signal }, serverId)

				const onlineEosIds = await bulkFetchOnlinePlayers(sliceCtx).catch((err) => {
					log.warn({ err }, 'bulk fetch online players failed')
					return [] as string[]
				})
				if (onlineEosIds) {
					for (const eosId of onlineEosIds) {
						const value = getCachedPlayer(eosId)
						if (value) playerUpdate$.next({ playerId: eosId, data: value })
					}
				}
			}),
		).subscribe(),
		ctx.server.event$.pipe(
			// PLAYER_RECONCILED included: a backfilled player is one we became aware of and should fetch BM data for.
			Rx.filter(([eventCtx, event]) => event.type === 'PLAYER_CONNECTED' || event.type === 'PLAYER_RECONCILED'),
			// parallel so one player's fetch doesn't queue behind another's; the task signal aborts as soon as
			// the callback resolves, so the fetch must be awaited or it gets cancelled immediately
			C.durableSub('bm-on-player-connected', { module, root: true, taskScheduling: 'parallel' }, async ([eventCtx, event], signal) => {
				if (event.type !== 'PLAYER_CONNECTED' && event.type !== 'PLAYER_RECONCILED') return
				const playerIds = event.player.ids
				const sliceCtx = SquadServer.resolveSliceCtx({ ...eventCtx, signal }, serverId)
				await fetchSinglePlayerBmData(sliceCtx, playerIds).catch((err) => {
					log.warn({ err, playerIds }, 'failed to fetch bm data on player connect')
				})
			}),
		).subscribe(),
	)
}

// -------- oRPC handlers --------

export const router = {
	getPlayerBmData: orpcBase.input(z.object({ playerId: z.string() })).handler(async ({ input, context: ctx }) => {
		return fetchSinglePlayerBmData(ctx, SM.PlayerIds.queryFromPlayerId(input.playerId))
	}),

	watchPlayerBmData: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ signal, context: _ctx }) {
		const initial$ = Rx.from(
			[...playerFlagsAndProfileCache.entries()]
				.filter(([, entry]) => Date.now() <= entry.expiresAt)
				.map(([playerId, entry]): BM.PlayerBmDataUpdate => ({ playerId, data: entry.value })),
		)
		yield* toAsyncGenerator(Rx.merge(initial$, playerUpdate$).pipe(withAbortSignal(signal!)))
	}),

	listOrgFlags: orpcBase.handler(async ({ context: ctx }) => {
		return getOrgFlags(ctx)
	}),

	updatePlayerFlags: orpcBase.meta({ type: 'mutation' }).input(z.object({
		playerId: z.string(),
		flagIds: z.array(z.string()),
	})).handler(async ({ input, context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('battlemetrics:write-flags'))
		if (denyRes) return denyRes

		const playerIds = SM.PlayerIds.queryFromPlayerId(input.playerId)
		const eosId = input.playerId
		const current = await fetchSinglePlayerBmData(ctx, playerIds)
		if (!current) return { code: 'err:not-found' as const }

		const currentFlagIds = new Set(current.flagIds)
		const desiredFlagIds = new Set(input.flagIds)

		const toAdd = input.flagIds.filter((id) => !currentFlagIds.has(id))
		const toRemove = [...currentFlagIds].filter((id) => !desiredFlagIds.has(id))

		const cacheEntry = getCachedPlayerEntry(eosId)!
		await Promise.all([
			addPlayerFlags(ctx, cacheEntry.bmPlayerId, toAdd),
			removePlayerFlags(ctx, cacheEntry.bmPlayerId, toRemove),
		])

		// Bust cache so next fetch returns fresh data
		playerFlagsAndProfileCache.delete(eosId)
		const updated = await fetchSinglePlayerBmData(ctx, playerIds)

		// Persist immediately so DB doesn't serve stale flags on next startup
		persistCache().catch((err) => log.warn({ err }, 'Failed to persist BM cache after flag update'))

		const orgFlags = await getOrgFlags(ctx)
		const flagInfo = (ids: string[]) => BM.resolveFlags(ids, orgFlags).map((f) => ({ id: f.id, name: f.name }))
		await AppEventsSys.persistAppEvent(
			ctx,
			AppEvents.create<AppEvents.PlayerFlagsUpdated>({
				type: 'PLAYER_FLAGS_UPDATED',
				playerId: input.playerId,
				added: flagInfo(toAdd),
				removed: flagInfo(toRemove),
				actor: { type: 'slm-user', userId: ctx.user.discordId },
				serverId: null,
				matchId: null,
				causeId: null,
			}),
		)

		return { code: 'ok' as const, data: updated }
	}),
}
