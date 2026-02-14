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
let ENV = getEnv()
const module = initModule('battlemetrics')
const orpcBase = getOrpcBase(module)
let log!: ReturnType<typeof module.getLogger>

export function setup() {
	log = module.getLogger()
	ENV = getEnv()
}

// -------- TTL cache --------

type CacheEntry<T> = {
	value: T
	expiresAt: number
	inflight?: Promise<T>
}

type PlayerFlagsAndProfile = {
	flags: BM.PlayerFlag[]
	bmPlayerId: string
	profileUrl: string
	hoursPlayed: number
}

const CACHE_TTL = {
	steamIdResolution: Infinity,
	orgServerIds: Infinity,
	playerFlagsAndProfile: 30 * 60 * 1000, // 30 minutes
	playerBansAndNotes: 60 * 60 * 1000, // 60 minutes
} as const

const cache = {
	steamIdResolution: new FixedSizeMap<string, CacheEntry<string>>(500),
	orgServerIds: null as CacheEntry<{ ids: { id: string; name: string | null }[] }> | null,
	playerFlagsAndProfile: new FixedSizeMap<string, CacheEntry<PlayerFlagsAndProfile>>(500),
	playerBansAndNotes: new FixedSizeMap<string, CacheEntry<{ banCount: number; noteCount: number }>>(500),
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
	perSecond: 10,
	perMinute: 45,
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

const RETRY = {
	maxAttempts: 3,
	baseDelayMs: 1_000,
} as const

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500
}

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
				await acquireRateSlot()
				const res = await fetch(url, { method, headers, body }).catch((error) => {
					log.error(`${method} ${path}: ${error.message}`)
					return error as Error
				})

				// network error
				if (res instanceof Error) {
					lastError = res
					if (attempt < RETRY.maxAttempts - 1) {
						const delay = RETRY.baseDelayMs * 2 ** attempt
						log.warn(`${method} ${path}: network error, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY.maxAttempts})`)
						await new Promise((r) => setTimeout(r, delay))
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
						await new Promise((r) => setTimeout(r, delay))
						continue
					}
					throw lastError
				}

				if (!res.ok) {
					const text = await res.text().catch(() => '')
					lastError = new Error(`BattleMetrics API error: ${res.status} ${res.statusText}`)
					if (isRetryable(res.status) && attempt < RETRY.maxAttempts - 1) {
						const delay = RETRY.baseDelayMs * 2 ** attempt
						log.warn(`${method} ${path}: ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY.maxAttempts})`)
						await new Promise((r) => setTimeout(r, delay))
						continue
					}
					log.error({ status: res.status, statusText: res.statusText, body: text }, `${method} ${path}: ${res.status} ${res.statusText}`)
					throw lastError
				}

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
	async (ctx: CS.Ctx, serverName?: string | null): Promise<string[]> => {
		const cached = getCached(cache.orgServerIds)
		if (cached) {
			if (serverName) {
				const filtered = cached.ids.filter((s) => s.name?.includes(serverName))
				if (filtered.length > 0) return filtered.map((s) => s.id)
			}
			return cached.ids.map((s) => s.id)
		}

		const { BM_ORG_ID } = getEnv()
		const [data] = await bmFetch(ctx, 'GET', `/servers?filter[organizations]=${BM_ORG_ID}&fields[server]=name`, {
			responseSchema: BM.ServersResponse,
		})
		const servers = data.data.map((s) => ({ id: s.id, name: s.attributes.name ?? null }))
		cache.orgServerIds = setCached({ ids: servers }, CACHE_TTL.orgServerIds)

		if (serverName) {
			const filtered = servers.filter((s) => s.name?.includes(serverName))
			if (filtered.length > 0) return filtered.map((s) => s.id)
		}
		return servers.map((s) => s.id)
	},
)

// -------- handler result types --------

// -------- cached fetchers (shared by handlers and priming) --------

const fetchPlayerFlagsAndProfile = C.spanOp(
	'fetchPlayerFlagsAndProfile',
	{ module, attrs: (_ctx, steamId) => ({ steamId }) },
	async (ctx: CS.Ctx, steamId: string): Promise<PlayerFlagsAndProfile> => {
		return cachedFetch(cache.playerFlagsAndProfile, steamId, CACHE_TTL.playerFlagsAndProfile, async () => {
			const bmPlayerId = await resolvePlayerBySteamId(ctx, steamId)
			const serverIds = await getOrgServerIds(ctx)

			const serverFilter = serverIds.length > 0 ? `&filter[servers]=${serverIds.join(',')}` : ''
			const [data] = await bmFetch(
				ctx,
				'GET',
				`/players/${bmPlayerId}?include=flagPlayer,playerFlag,server&fields[playerFlag]=name,color,description,icon&fields[server]=name${serverFilter}`,
				{ responseSchema: BM.PlayerWithFlagsAndServersResponse },
			)

			const { BM_ORG_ID } = getEnv()
			const included = data.included ?? []
			const flagPlayers = included.filter((i): i is typeof i & { type: 'flagPlayer' } => i.type === 'flagPlayer')
				.filter((fp) => !BM_ORG_ID || fp.relationships?.organization?.data?.id === BM_ORG_ID)
			const playerFlags = included.filter((i): i is typeof i & { type: 'playerFlag' } => i.type === 'playerFlag')
			const servers = included.filter((i): i is typeof i & { type: 'server' } => i.type === 'server')

			const flags = flagPlayers.map((fp) => {
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

			const orgServerIdSet = new Set(serverIds)
			const totalSeconds = servers
				.filter((s) => orgServerIdSet.has(s.id))
				.reduce((sum, s) => sum + (s.meta?.timePlayed ?? 0), 0)

			return {
				flags,
				bmPlayerId,
				profileUrl: `https://www.battlemetrics.com/rcon/players/${bmPlayerId}`,
				hoursPlayed: Math.round(totalSeconds / 3600),
			}
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

// -------- bulk fetch online players --------

const bulkFetchOnlinePlayers = C.spanOp(
	'bulkFetchOnlinePlayers',
	{ module },
	async (ctx: CS.Ctx & C.ServerSlice): Promise<string[]> => {
		const info = await ctx.server.serverInfo.get(ctx)
		const serverName = info.code === 'ok' ? info.data.name : null
		const serverIds = await getOrgServerIds(ctx, serverName)
		if (serverIds.length === 0) return []

		const orgServerIdSet = new Set(serverIds)
		const primedSteamIds: string[] = []

		let path: string | null = `/players?filter[online]=true&filter[servers]=${serverIds.join(',')}`
			+ `&include=identifier,flagPlayer,playerFlag`
			+ `&filter[identifiers]=steamID`
			+ `&fields[playerFlag]=name,color,description,icon`
			+ `&fields[server]=name`
			+ `&page[size]=100`

		while (path) {
			const [data, _res] = await bmFetch(ctx, 'GET', path, {
				responseSchema: BM.PlayerListResponse,
			})

			const { BM_ORG_ID } = getEnv()
			const included = data.included ?? []
			const identifiers = included.filter((i): i is typeof i & { type: 'identifier' } => i.type === 'identifier')
			const flagPlayers = included.filter((i): i is typeof i & { type: 'flagPlayer' } => i.type === 'flagPlayer')
				.filter((fp) => !BM_ORG_ID || fp.relationships?.organization?.data?.id === BM_ORG_ID)
			const playerFlags = included.filter((i): i is typeof i & { type: 'playerFlag' } => i.type === 'playerFlag')

			for (const player of data.data) {
				const bmPlayerId = player.id

				// find steamID identifier for this player
				const ident = identifiers.find(
					(i) => i.attributes.type === 'steamID' && i.relationships?.player?.data?.id === bmPlayerId,
				)
				if (!ident) continue
				const steamId = ident.attributes.identifier

				// populate steam ID resolution cache
				cache.steamIdResolution.set(steamId, setCached(bmPlayerId, CACHE_TTL.steamIdResolution))

				// extract flags for this player
				const playerFlagPlayers = flagPlayers.filter(
					(fp) => fp.relationships?.player?.data?.id === bmPlayerId,
				)
				const flags = playerFlagPlayers.map((fp) => {
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

				// extract server time played from player relationships
				const serverRefs = player.relationships?.servers?.data ?? []
				const totalSeconds = serverRefs
					.filter((s) => orgServerIdSet.has(s.id))
					.reduce((sum, s) => sum + (s.meta?.timePlayed ?? 0), 0)

				// populate flags+profile cache
				cache.playerFlagsAndProfile.set(
					steamId,
					setCached({
						flags,
						bmPlayerId,
						profileUrl: `https://www.battlemetrics.com/rcon/players/${bmPlayerId}`,
						hoursPlayed: Math.round(totalSeconds / 3600),
					}, CACHE_TTL.playerFlagsAndProfile),
				)

				primedSteamIds.push(steamId)
			}

			// follow pagination
			const nextUrl = data.links?.next
			if (nextUrl) {
				// links.next is a full URL; extract the path+query
				const parsed = new URL(nextUrl)
				path = parsed.pathname + parsed.search
			} else {
				path = null
			}
		}

		log.debug('bulk fetched %d online players', primedSteamIds.length)
		return primedSteamIds
	},
)

// -------- event-driven cache priming --------

export function setupSquadServerInstance(ctx: C.ServerSlice) {
	ctx.server.event$.pipe(
		C.durableSub('bm-cache-prime', { module, root: true, taskScheduling: 'parallel' }, async ([ctx, events]) => {
			let shouldBulkFetch = false

			for (const event of events) {
				if (event.type === 'PLAYER_CONNECTED') {
					const steamId = (event as SM.Events.PlayerConnected).player.ids.steam
					if (steamId && !getCached(cache.playerFlagsAndProfile.get(steamId))) {
						shouldBulkFetch = true
						break
					}
				} else if (event.type === 'NEW_GAME' || event.type === 'RESET') {
					shouldBulkFetch = true
					break
				}
			}

			if (!shouldBulkFetch) return

			// bulk fetch flags+profile for all online players across org servers
			const primedSteamIds = await bulkFetchOnlinePlayers(ctx).catch((err) => {
				log.warn({ err }, 'bulk fetch online players failed')
				return [] as string[]
			})

			if (primedSteamIds.length === 0) return
		}),
	).subscribe()
}

// -------- oRPC handlers --------

export const router = {
	getPlayerFlags: orpcBase.input(z.object({
		steamId: z.string(),
	})).handler(async ({ input, context: ctx }) => {
		const result = await fetchPlayerFlagsAndProfile(ctx, input.steamId)
		return result.flags
	}),

	getPlayerBansAndNotes: orpcBase.input(z.object({
		steamId: z.string(),
	})).handler(async ({ input, context: ctx }) => {
		return fetchPlayerBansAndNotes(ctx, input.steamId)
	}),

	getPlayerProfile: orpcBase.input(z.object({
		steamId: z.string(),
	})).handler(async ({ input, context: ctx }) => {
		const { flags: _, ...profile } = await fetchPlayerFlagsAndProfile(ctx, input.steamId)
		return profile
	}),
}
