import { FixedSizeMap } from '@/lib/lru-map'
import * as BM from '@/models/battlemetrics.models'
import type * as CS from '@/models/context-shared'
import type * as SM from '@/models/squad.models'
import * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'

import { z } from 'zod'

const getEnv = Env.getEnvBuilder({ ...Env.groups.battlemetrics })
const module = initModule('battlemetrics')
const orpcBase = getOrpcBase(module)
let log!: ReturnType<typeof module.getLogger>

export function setup() {
	log = module.getLogger()
}

// -------- TTL cache --------

type CacheEntry<T> = {
	value: T
	expiresAt: number
	inflight?: Promise<T>
}

const CACHE_TTL = {
	steamIdResolution: 60 * 60 * 1000, // 1 hour
	orgServerIds: 15 * 60 * 1000, // 15 minutes
	playerFlags: 5 * 60 * 1000, // 5 minutes
	playerBansAndNotes: 5 * 60 * 1000, // 5 minutes
	playerProfile: 5 * 60 * 1000, // 5 minutes
} as const

const cache = {
	steamIdResolution: new FixedSizeMap<string, CacheEntry<string>>(500),
	orgServerIds: null as CacheEntry<string[]> | null,
	playerFlags: new FixedSizeMap<string, CacheEntry<BM.PlayerFlag[]>>(500),
	playerBansAndNotes: new FixedSizeMap<string, CacheEntry<{ banCount: number; noteCount: number }>>(500),
	playerProfile: new FixedSizeMap<string, CacheEntry<{ bmPlayerId: string; profileUrl: string; hoursPlayed: number }>>(500),
}

function getCached<T>(entry: CacheEntry<T> | undefined | null): T | undefined {
	if (!entry) return undefined
	if (Date.now() > entry.expiresAt) return undefined
	return entry.value
}

function setCached<T>(value: T, ttl: number): CacheEntry<T> {
	return { value, expiresAt: Date.now() + ttl }
}

/** Get cached value or fetch, deduplicating in-flight requests */
async function cachedFetch<T>(
	map: FixedSizeMap<string, CacheEntry<T>>,
	key: string,
	ttl: number,
	fetch: () => Promise<T>,
): Promise<T> {
	const existing = map.get(key)
	const cached = getCached(existing)
	if (cached !== undefined) return cached

	// deduplicate in-flight requests
	if (existing?.inflight) return existing.inflight

	const inflight = fetch().then((value) => {
		map.set(key, setCached(value, ttl))
		return value
	}).catch((err) => {
		// clear inflight on error so retries work
		if (map.get(key)?.inflight === inflight) {
			map.delete(key)
		}
		throw err
	})

	map.set(key, { value: undefined as T, expiresAt: 0, inflight })
	return inflight
}

// -------- rate-limit queue --------

const RATE_LIMITS = {
	perSecond: 15,
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

function acquireRateSlot(): Promise<void> {
	const now = Date.now()
	pruneTimestamps(now)
	if (canDispatch(now)) {
		rateLimiter.timestamps.push(now)
		return Promise.resolve()
	}
	return new Promise<void>((resolve) => {
		rateLimiter.queue.push(resolve)
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

async function bmFetch<T = null>(
	ctx: CS.Ctx,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	init?: Omit<RequestInit, 'body' | 'method'> & { body?: unknown; responseSchema?: z.ZodType<T> },
): Promise<readonly [T, Response]> {
	return C.spanOp(
		'bmFetch',
		{ module, levels: { error: 'error', event: 'trace' }, attrs: () => ({ 'http.method': method, 'http.path': path }) },
		async (ctx: CS.Ctx) => {
			const { BM_HOST, BM_PAT } = getEnv()
			const url = `${BM_HOST}${path}`

			const headers: Record<string, string> = {
				'Authorization': `Bearer ${BM_PAT}`,
				'Accept': 'application/json',
				...(init?.headers as Record<string, string>),
			}

			let body: string | undefined
			if (init?.body != null && typeof init.body === 'object') {
				body = JSON.stringify(init.body)
				headers['Content-Type'] = 'application/json'
			}

			await acquireRateSlot()
			const res = await fetch(url, { method, headers, body }).catch((error) => {
				log.error(`${method} ${path}: ${error.message}`)
				throw error
			})

			if (res.status === 429) {
				triggerBackoff(res)
				throw new Error(`BattleMetrics API rate limited: 429 Too Many Requests`)
			}

			if (!res.ok) {
				const text = await res.text().catch(() => '')
				log.error({ status: res.status, statusText: res.statusText, body: text }, `${method} ${path}: ${res.status} ${res.statusText}`)
				throw new Error(`BattleMetrics API error: ${res.status} ${res.statusText}`)
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
		},
	)(ctx)
}

const resolvePlayerBySteamId = C.spanOp(
	'resolvePlayerBySteamId',
	{ module, attrs: (_ctx, steamId) => ({ steamId }) },
	async (ctx: CS.Ctx, steamId: string): Promise<string> => {
		return cachedFetch(cache.steamIdResolution, steamId, CACHE_TTL.steamIdResolution, async () => {
			const [data] = await bmFetch(ctx, 'POST', '/players/match', {
				responseSchema: BM.PlayerMatchResponse,
				body: {
					data: [{
						type: 'identifier',
						attributes: {
							type: 'steamID',
							identifier: steamId,
						},
					}],
				},
			})
			const playerId = data.data[0]?.relationships?.player?.data?.id
			if (!playerId) {
				throw new Error(`No BattleMetrics player found for Steam ID ${steamId}`)
			}
			return playerId
		})
	},
)

const getOrgServerIds = C.spanOp(
	'getOrgServerIds',
	{ module },
	async (ctx: CS.Ctx): Promise<string[]> => {
		const cached = getCached(cache.orgServerIds)
		if (cached) return cached

		const { BM_ORG_ID } = getEnv()
		const [data] = await bmFetch(ctx, 'GET', `/servers?filter[organizations]=${BM_ORG_ID}&fields[server]=name`, {
			responseSchema: BM.ServersResponse,
		})
		const ids = data.data.map((s) => s.id)
		cache.orgServerIds = setCached(ids, CACHE_TTL.orgServerIds)
		return ids
	},
)

// -------- handler result types --------

// -------- cached fetchers (shared by handlers and priming) --------

const fetchPlayerFlags = C.spanOp(
	'fetchPlayerFlags',
	{ module, attrs: (_ctx, steamId) => ({ steamId }) },
	async (ctx: CS.Ctx, steamId: string): Promise<BM.PlayerFlag[]> => {
		return cachedFetch(cache.playerFlags, steamId, CACHE_TTL.playerFlags, async () => {
			const bmPlayerId = await resolvePlayerBySteamId(ctx, steamId)
			const [data] = await bmFetch(
				ctx,
				'GET',
				`/players/${bmPlayerId}?include=flagPlayer,playerFlag&fields[playerFlag]=name,color,description,icon`,
				{ responseSchema: BM.PlayerWithFlagsResponse },
			)

			const included = data.included ?? []
			const flagPlayers = included.filter((i): i is typeof i & { type: 'flagPlayer' } => i.type === 'flagPlayer')
			const playerFlags = included.filter((i): i is typeof i & { type: 'playerFlag' } => i.type === 'playerFlag')

			return flagPlayers.map((fp) => {
				const flagId = fp.relationships?.playerFlag?.data?.id
				const flag = playerFlags.find((pf) => pf.id === flagId)
				return {
					id: flagId ?? fp.id,
					name: flag?.attributes?.name ?? null,
					color: flag?.attributes?.color ?? null,
					description: flag?.attributes?.description ?? null,
					icon: flag?.attributes?.icon ?? null,
				}
			})
		})
	},
)

const fetchPlayerBansAndNotes = C.spanOp(
	'fetchPlayerBansAndNotes',
	{ module, attrs: (_ctx, steamId) => ({ steamId }) },
	async (ctx: CS.Ctx, steamId: string) => {
		return cachedFetch(cache.playerBansAndNotes, steamId, CACHE_TTL.playerBansAndNotes, async () => {
			const bmPlayerId = await resolvePlayerBySteamId(ctx, steamId)
			const [[bansData], [notesData]] = await Promise.all([
				bmFetch(ctx, 'GET', `/bans?filter[player]=${bmPlayerId}&page[size]=1`, {
					responseSchema: BM.BansResponse,
				}),
				bmFetch(ctx, 'GET', `/players/${bmPlayerId}/relationships/notes?page[size]=1`, {
					responseSchema: BM.NotesResponse,
				}),
			])
			return {
				banCount: bansData.meta?.total ?? bansData.data.length,
				noteCount: notesData.meta?.total ?? notesData.data.length,
			}
		})
	},
)

const fetchPlayerProfile = C.spanOp(
	'fetchPlayerProfile',
	{ module, attrs: (_ctx, steamId) => ({ steamId }) },
	async (ctx: CS.Ctx, steamId: string) => {
		return cachedFetch(cache.playerProfile, steamId, CACHE_TTL.playerProfile, async () => {
			const bmPlayerId = await resolvePlayerBySteamId(ctx, steamId)
			const serverIds = await getOrgServerIds(ctx)

			const serverInfos = await Promise.all(
				serverIds.map((serverId) =>
					bmFetch(ctx, 'GET', `/players/${bmPlayerId}/servers/${serverId}`, {
						responseSchema: BM.PlayerServerResponse,
					})
						.then(([d]) => d.data.attributes.timePlayed ?? 0)
						.catch(() => 0)
				),
			)

			const totalSeconds = serverInfos.reduce((sum, t) => sum + t, 0)

			return {
				bmPlayerId,
				profileUrl: `https://www.battlemetrics.com/rcon/players/${bmPlayerId}`,
				hoursPlayed: Math.round(totalSeconds / 3600),
			}
		})
	},
)

// -------- event-driven cache priming --------

const primePlayerCache = C.spanOp(
	'primePlayerCache',
	{ module, levels: { error: 'error', event: 'trace' }, attrs: (_ctx, steamId) => ({ steamId }) },
	async (ctx: CS.Ctx, steamId: string) => {
		await Promise.all([
			fetchPlayerFlags(ctx, steamId),
			fetchPlayerBansAndNotes(ctx, steamId),
			fetchPlayerProfile(ctx, steamId),
		])
	},
)

export function setupSquadServerInstance(ctx: C.ServerSlice) {
	ctx.server.event$.pipe(
		C.durableSub('bm-cache-prime', { module, root: true, taskScheduling: 'parallel' }, async ([ctx, events]) => {
			const steamIdsToPrime = new Set<string>()

			for (const event of events) {
				if (event.type === 'PLAYER_CONNECTED') {
					const steamId = (event as SM.Events.PlayerConnected).player.ids.steam
					if (steamId && !getCached(cache.playerFlags.get(steamId))) {
						steamIdsToPrime.add(steamId)
					}
				} else if (event.type === 'NEW_GAME' || event.type === 'RESET') {
					const state = (event as SM.Events.NewGame).state
					for (const player of state.players) {
						if (player.ids.steam && !getCached(cache.playerFlags.get(player.ids.steam))) {
							steamIdsToPrime.add(player.ids.steam)
						}
					}
				}
			}

			if (steamIdsToPrime.size === 0) return

			log.debug('priming BM cache for %d players', steamIdsToPrime.size)
			await Promise.allSettled(
				[...steamIdsToPrime].map((steamId) => primePlayerCache(ctx, steamId)),
			)
		}),
	).subscribe()
}

// -------- oRPC handlers --------

export const router = {
	getPlayerFlags: orpcBase.input(z.object({
		steamId: z.string(),
	})).handler(async ({ input, context: ctx }) => {
		return fetchPlayerFlags(ctx, input.steamId)
	}),

	getPlayerBansAndNotes: orpcBase.input(z.object({
		steamId: z.string(),
	})).handler(async ({ input, context: ctx }) => {
		return fetchPlayerBansAndNotes(ctx, input.steamId)
	}),

	getPlayerProfile: orpcBase.input(z.object({
		steamId: z.string(),
	})).handler(async ({ input, context: ctx }) => {
		return fetchPlayerProfile(ctx, input.steamId)
	}),
}

// -------- rate-limit queue --------

namespace RateLimit {
	const RATE_LIMIT = {
		perSecond: 15,
		perMinute: 60,
	} as const

	const rateLimiter = {
		/** Timestamps of requests dispatched in the last 60s */
		timestamps: [] as number[],
		/** Queue of pending requests waiting for capacity */
		queue: [] as Array<() => void>,
		drainScheduled: false,
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
		return (
			countInWindow(now, 1_000) < RATE_LIMIT.perSecond
			&& countInWindow(now, 60_000) < RATE_LIMIT.perMinute
		)
	}

	function scheduleDrain() {
		if (rateLimiter.drainScheduled || rateLimiter.queue.length === 0) return
		rateLimiter.drainScheduled = true

		const now = Date.now()
		pruneTimestamps(now)

		// figure out how long until we have capacity
		let delayMs = 0
		if (countInWindow(now, 1_000) >= RATE_LIMIT.perSecond) {
			// wait until the oldest request in the 1s window expires
			const oldest1s = rateLimiter.timestamps.find((t) => t > now - 1_000)!
			delayMs = Math.max(delayMs, oldest1s + 1_000 - now)
		}
		if (countInWindow(now, 60_000) >= RATE_LIMIT.perMinute) {
			const oldest60s = rateLimiter.timestamps[0]
			delayMs = Math.max(delayMs, oldest60s + 60_000 - now)
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

	export function acquireRateSlot(): Promise<void> {
		const now = Date.now()
		pruneTimestamps(now)
		if (canDispatch(now)) {
			rateLimiter.timestamps.push(now)
			return Promise.resolve()
		}
		return new Promise<void>((resolve) => {
			rateLimiter.queue.push(resolve)
			scheduleDrain()
		})
	}
}
