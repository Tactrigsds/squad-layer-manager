import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { FixedSizeMap } from '@/lib/lru-map'
import * as BM from '@/models/battlemetrics.models'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as PersistedCache from '@/systems/persistedCache.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import { metrics } from '@opentelemetry/api'
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

let orgServerIdsCache: { ids: { id: string; name: string | null }[] } | null = null
let orgServerIdsFetchPromise: Promise<{ id: string; name: string | null }[]> | null = null

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

/** Per-server state for bulk polling and streaming */
type ServerBmState = {
	update$: Rx.Subject<void>
	onlineEosIds: Set<string>
}

const serverBmState = new Map<string, ServerBmState>()

function getServerBmState(serverId: string): ServerBmState {
	let state = serverBmState.get(serverId)
	if (!state) {
		state = { update$: new Rx.Subject<void>(), onlineEosIds: new Set() }
		serverBmState.set(serverId, state)
	}
	return state
}

export type { PublicPlayerBmData } from '@/models/battlemetrics.models'
type PublicPlayerBmData = BM.PublicPlayerBmData

function getPlayerBmDataSnapshot(eosIds: Set<string>): PublicPlayerBmData {
	const result: PublicPlayerBmData = {}
	for (const eosId of eosIds) {
		const value = getCachedPlayer(eosId)
		if (value) result[eosId] = value
	}
	return result
}

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

const meter = metrics.getMeter('battlemetrics')

meter.createObservableGauge(ATTRS.Battlemetrics.RateLimit.PER_SECOND, {
	description: 'Number of BattleMetrics API requests in the last 1s window',
}).addCallback((result) => {
	const now = Date.now()
	pruneTimestamps(now)
	result.observe(countInWindow(now, 1_000))
})

meter.createObservableGauge(ATTRS.Battlemetrics.RateLimit.PER_MINUTE, {
	description: 'Number of BattleMetrics API requests in the last 60s window',
}).addCallback((result) => {
	const now = Date.now()
	pruneTimestamps(now)
	result.observe(countInWindow(now, 60_000))
})

meter.createObservableGauge(ATTRS.Battlemetrics.RateLimit.QUEUE_SIZE, {
	description: 'Number of queued BattleMetrics API requests waiting for a rate limit slot',
}).addCallback((result) => {
	result.observe(rateLimiter.queue.length)
})

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
		{ module, levels: { error: 'error', event: 'trace' }, attrs: () => ({ [ATTRS.Http.METHOD]: method, [ATTRS.Http.PATH]: path }) },
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

				log.debug({ status: res.status, method, path }, `${method} ${path} : ${res.status}`)
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

const getOrgServerIds = C.spanOp(
	'getOrgServerIds',
	{ module },
	async (ctx: CS.Ctx, serverName?: string | null): Promise<string[]> => {
		if (orgServerIdsCache) {
			if (serverName) {
				const filtered = orgServerIdsCache.ids.filter((s) => s.name?.includes(serverName))
				if (filtered.length > 0) return filtered.map((s) => s.id)
			}
			return orgServerIdsCache.ids.map((s) => s.id)
		}

		if (!orgServerIdsFetchPromise) {
			orgServerIdsFetchPromise = (async () => {
				const { BM_ORG_ID } = getEnv()
				const [data] = await bmFetch(ctx, 'GET', `/servers?filter[organizations]=${BM_ORG_ID}&fields[server]=name`, {
					responseSchema: BM.ServersResponse,
				})
				return data.data.map((s) => ({ id: s.id, name: s.attributes.name ?? null }))
			})().catch((err) => {
				orgServerIdsFetchPromise = null
				throw err
			})
		}
		const servers = await orgServerIdsFetchPromise
		orgServerIdsCache = { ids: servers }

		if (serverName) {
			const filtered = servers.filter((s) => s.name?.includes(serverName))
			if (filtered.length > 0) return filtered.map((s) => s.id)
		}
		return servers.map((s) => s.id)
	},
)

const OrgFlagsResponse = z.object({
	data: z.array(z.object({
		type: z.literal('playerFlag'),
		id: z.string(),
		attributes: BM.PlayerFlagAttributes,
	})),
})

const getOrgFlags = C.spanOp(
	'getOrgFlags',
	{ module },
	async (ctx: CS.Ctx): Promise<BM.PlayerFlag[]> => {
		if (orgFlagsCache) return orgFlagsCache

		if (!orgFlagsFetchPromise) {
			orgFlagsFetchPromise = (async () => {
				const [data] = await bmFetch(ctx, 'GET', `/player-flags?page[size]=100`, {
					responseSchema: OrgFlagsResponse,
				})
				return data.data.map((f) => ({ id: f.id, ...f.attributes }))
			})().catch((err) => {
				orgFlagsFetchPromise = null
				throw err
			})
		}

		const flags = await orgFlagsFetchPromise
		orgFlagsCache = flags
		return flags
	},
)

const addPlayerFlags = C.spanOp(
	'addPlayerFlags',
	{ module },
	async (ctx: CS.Ctx, bmPlayerId: string, flagIds: string[]): Promise<void> => {
		if (flagIds.length === 0) return
		await bmFetch(ctx, 'POST', `/players/${bmPlayerId}/relationships/flags`, {
			body: { data: flagIds.map((id) => ({ type: 'playerFlag', id })) },
		})
	},
)

const removePlayerFlags = C.spanOp(
	'removePlayerFlags',
	{ module },
	async (ctx: CS.Ctx, bmPlayerId: string, flagIds: string[]): Promise<void> => {
		if (flagIds.length === 0) return
		await Promise.all(flagIds.map((flagId) => bmFetch(ctx, 'DELETE', `/players/${bmPlayerId}/relationships/flags/${flagId}`)))
	},
)

type PlayerListData = z.infer<typeof BM.PlayerListResponse>

function parsePlayerListPage(data: PlayerListData, orgServerIdSet: Set<string>): string[] {
	const { BM_ORG_ID } = getEnv()
	const included = data.included ?? []
	const identifiers = included.filter((i): i is typeof i & { type: 'identifier' } => i.type === 'identifier')
	const flagPlayers = included.filter((i): i is typeof i & { type: 'flagPlayer' } => i.type === 'flagPlayer')
		.filter((fp) => !fp.attributes?.removedAt)
		.filter((fp) => !BM_ORG_ID || fp.relationships?.organization?.data?.id === BM_ORG_ID)
	const playerFlags = included.filter((i): i is typeof i & { type: 'playerFlag' } => i.type === 'playerFlag')

	const eosIds: string[] = []

	for (const player of data.data) {
		const bmPlayerId = player.id

		const eosIdent = identifiers.find(
			(i) => i.attributes.type === 'eosID' && i.relationships?.player?.data?.id === bmPlayerId,
		)
		if (!eosIdent) continue
		const eosId = eosIdent.attributes.identifier

		const steamIdent = identifiers.find(
			(i) => i.attributes.type === 'steamID' && i.relationships?.player?.data?.id === bmPlayerId,
		)
		const steamId = steamIdent?.attributes.identifier

		const playerIds: SM.PlayerIds.IdQuery<'eos'> = { eos: eosId, ...(steamId ? { steam: steamId } : {}) }

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

		const serverRefs = player.relationships?.servers?.data ?? []
		const totalSeconds = serverRefs
			.filter((s) => orgServerIdSet.has(s.id))
			.reduce((sum, s) => sum + (s.meta?.timePlayed ?? 0), 0)

		const canonicalId = SM.PlayerIds.getPlayerId(playerIds)
		setCachedPlayer(canonicalId, bmPlayerId, {
			flags,
			playerIds: playerIds,
			profileUrl: `https://www.battlemetrics.com/rcon/players/${bmPlayerId}`,
			hoursPlayed: Math.round(totalSeconds / 3600),
		})

		eosIds.push(canonicalId)
	}

	return eosIds
}

const bulkFetchOnlinePlayers = C.spanOp(
	'bulkFetchOnlinePlayers',
	{ module },
	async (ctx: CS.Ctx & C.ServerSlice): Promise<string[] | undefined> => {
		const teamsRes = await ctx.server.teams.get(ctx)
		if (teamsRes.code !== 'ok') return
		const onlinePlayers = teamsRes.players
		const onlineEosIds = onlinePlayers.map(p => p.ids.eos)

		const uncached = onlinePlayers.filter((p) => !getCachedPlayer(SM.PlayerIds.getPlayerId(p.ids)))
		if (uncached.length > 0) {
			await Promise.all(uncached.map((p) =>
				fetchSinglePlayerBmData(ctx, p.ids).catch((err) => {
					log.warn({ err, playerIds: p.ids }, 'failed to fetch player bm data')
				})
			))
		}

		log.debug('found %d online players (%d fetched from api)', onlineEosIds.length, uncached.length)
		return onlineEosIds
	},
)

const fetchSinglePlayerBmData = C.spanOp(
	'fetchSinglePlayerBmData',
	{ module, attrs: (_ctx, playerIds) => ({ eosId: playerIds.eos, steamId: playerIds.steam }) },
	async (ctx: CS.Ctx & C.ServerSlice, playerIds: SM.PlayerIds.IdQuery<'eos'>): Promise<BM.PlayerFlagsAndProfile | null> => {
		const eosId = playerIds.eos
		const cached = getCachedPlayer(eosId)
		if (cached) return cached

		const info = await ctx.server.serverInfo.get(ctx)
		const serverName = info.code === 'ok' ? info.data.name : null
		const serverIds = await getOrgServerIds(ctx, serverName)
		const orgServerIdSet = new Set(serverIds)

		// Search by EOS ID (required). BattleMetrics supports searching by EOS identifier type.
		// We also request steamID identifiers to be included so we can store both IDs.
		const path = `/players?filter[search]=${eosId}`
			+ `&include=identifier,flagPlayer,playerFlag`
			+ `&filter[identifiers]=eosID`
			+ `&fields[playerFlag]=name,color,description,icon`
			+ `&fields[server]=name`
			+ `&page[size]=1`

		const [data] = await bmFetch(ctx, 'GET', path, {
			responseSchema: BM.PlayerListResponse,
		})

		const parsed = parsePlayerListPage(data, orgServerIdSet)
		if (parsed.length === 0) return null

		const state = getServerBmState(ctx.serverId)
		state.onlineEosIds.add(eosId)
		state.update$.next()

		return getCachedPlayer(parsed[0]) ?? null
	},
)

// -------- interval-based bulk polling --------

export function setupSquadServerInstance(ctx: C.ServerSlice) {
	const serverId = ctx.serverId
	const state = getServerBmState(serverId)

	ctx.cleanup.push(
		Rx.interval(POLL_INTERVAL_MS).pipe(
			Rx.startWith(0),
			C.durableSub('bm-bulk-poll', { module, root: true, taskScheduling: 'exhaust' }, async () => {
				const sliceCtx = SquadServer.resolveSliceCtx({}, serverId)

				const onlineEosIds = await bulkFetchOnlinePlayers(sliceCtx).catch((err) => {
					log.warn({ err }, 'bulk fetch online players failed')
					return [] as string[]
				})
				if (onlineEosIds) {
					state.onlineEosIds = new Set(onlineEosIds)
				}
				state.update$.next()
			}),
		).subscribe(),
		ctx.server.event$.pipe(
			Rx.concatMap(([eventCtx, events]) =>
				events
					.filter(e => e.type === 'PLAYER_CONNECTED')
					.map(e => [eventCtx, e] as const)
			),
			C.durableSub('bm-on-player-connected', { module, root: true }, async ([eventCtx, event]) => {
				if (event.type !== 'PLAYER_CONNECTED') return
				const playerIds = event.player.ids
				const sliceCtx = SquadServer.resolveSliceCtx(eventCtx, serverId)
				fetchSinglePlayerBmData(sliceCtx, playerIds).catch((err) => {
					log.warn({ err, playerIds }, 'failed to fetch bm data on player connect')
				})
			}),
		).subscribe(),
	)
}

// -------- oRPC handlers --------

export const router = {
	getPlayerBmData: orpcBase.input(z.object({ playerId: z.string() })).handler(async ({ input, context: ctx }) => {
		const serverCtx = await Rx.firstValueFrom(SquadServer.selectedServerCtx$(ctx))
		return fetchSinglePlayerBmData(serverCtx, SM.PlayerIds.queryFromPlayerId(input.playerId))
	}),

	watchPlayerBmData: orpcBase.handler(async function*({ signal, context: _ctx }) {
		const server$ = SquadServer.selectedServerCtx$(_ctx).pipe(withAbortSignal(signal!))
		const data$ = server$.pipe(
			Rx.switchMap(async function*(ctx) {
				const state = getServerBmState(ctx.serverId)
				yield getPlayerBmDataSnapshot(state.onlineEosIds)
				const update$ = state.update$.pipe(withAbortSignal(signal!))
				for await (const _ of toAsyncGenerator(update$)) {
					yield getPlayerBmDataSnapshot(state.onlineEosIds)
				}
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(data$)
	}),

	listOrgFlags: orpcBase.handler(async ({ context: ctx }) => {
		const serverCtx = await Rx.firstValueFrom(SquadServer.selectedServerCtx$(ctx))
		return getOrgFlags(serverCtx)
	}),

	updatePlayerFlags: orpcBase.input(z.object({
		playerId: z.string(),
		flagIds: z.array(z.string()),
	})).handler(async ({ input, context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('battlemetrics:write-flags'))
		if (denyRes) return denyRes

		const serverCtx = await Rx.firstValueFrom(SquadServer.selectedServerCtx$(ctx))

		const playerIds = SM.PlayerIds.queryFromPlayerId(input.playerId)
		const eosId = input.playerId
		const current = await fetchSinglePlayerBmData(serverCtx, playerIds)
		if (!current) return { code: 'err:not-found' as const }

		const currentFlagIds = new Set(current.flags.map((f) => f.id))
		const desiredFlagIds = new Set(input.flagIds)

		const toAdd = input.flagIds.filter((id) => !currentFlagIds.has(id))
		const toRemove = [...currentFlagIds].filter((id) => !desiredFlagIds.has(id))

		const cacheEntry = getCachedPlayerEntry(eosId)!
		await Promise.all([
			addPlayerFlags(serverCtx, cacheEntry.bmPlayerId, toAdd),
			removePlayerFlags(serverCtx, cacheEntry.bmPlayerId, toRemove),
		])

		// Bust cache so next fetch returns fresh data
		playerFlagsAndProfileCache.delete(eosId)
		const updated = await fetchSinglePlayerBmData(serverCtx, playerIds)

		// Persist immediately so DB doesn't serve stale flags on next startup
		persistCache().catch((err) => log.warn({ err }, 'Failed to persist BM cache after flag update'))

		// Notify watchers
		const state = getServerBmState(serverCtx.serverId)
		state.update$.next()

		return { code: 'ok' as const, data: updated }
	}),
}
