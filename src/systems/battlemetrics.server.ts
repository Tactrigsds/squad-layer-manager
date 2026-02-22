import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { FixedSizeMap } from '@/lib/lru-map'
import * as BM from '@/models/battlemetrics.models'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as SquadServer from '@/systems/squad-server.server'
import { metrics } from '@opentelemetry/api'
import * as Rx from 'rxjs'
import { z } from 'zod'

const getEnv = Env.getEnvBuilder({ ...Env.groups.battlemetrics })
const module = initModule('battlemetrics')
const orpcBase = getOrpcBase(module)

let ENV!: ReturnType<typeof getEnv>
let log!: ReturnType<typeof module.getLogger>

export function setup() {
	log = module.getLogger()
	ENV = getEnv()
}

// -------- cache --------

const PLAYER_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

const playerFlagsAndProfileCache = new FixedSizeMap<string, { value: BM.PlayerFlagsAndProfile; expiresAt: number }>(500)

let orgServerIdsCache: { ids: { id: string; name: string | null }[] } | null = null
let orgServerIdsFetchPromise: Promise<{ id: string; name: string | null }[]> | null = null

function getCachedPlayer(steamId: string): BM.PlayerFlagsAndProfile | undefined {
	const entry = playerFlagsAndProfileCache.get(steamId)
	if (!entry) return undefined
	if (Date.now() > entry.expiresAt) return undefined
	return entry.value
}

function setCachedPlayer(steamId: string, value: BM.PlayerFlagsAndProfile) {
	playerFlagsAndProfileCache.set(steamId, { value, expiresAt: Date.now() + PLAYER_CACHE_TTL })
}

// -------- polling config --------

const POLL_INTERVAL_MS = 5 * 60 * 1000

/** Per-server state for bulk polling and streaming */
type ServerBmState = {
	update$: Rx.Subject<void>
	onlineSteamIds: Set<string>
}

const serverBmState = new Map<string, ServerBmState>()

function getServerBmState(serverId: string): ServerBmState {
	let state = serverBmState.get(serverId)
	if (!state) {
		state = { update$: new Rx.Subject<void>(), onlineSteamIds: new Set() }
		serverBmState.set(serverId, state)
	}
	return state
}

export type { PublicPlayerBmData } from '@/models/battlemetrics.models'
type PublicPlayerBmData = BM.PublicPlayerBmData

function getPlayerBmDataSnapshot(steamIds: Set<string>): PublicPlayerBmData {
	const result: PublicPlayerBmData = {}
	for (const steamId of steamIds) {
		const value = getCachedPlayer(steamId)
		if (value) result[steamId] = value
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

meter.createObservableGauge('battlemetrics.rate_limit.per_second', {
	description: 'Number of BattleMetrics API requests in the last 1s window',
}).addCallback((result) => {
	const now = Date.now()
	pruneTimestamps(now)
	result.observe(countInWindow(now, 1_000))
})

meter.createObservableGauge('battlemetrics.rate_limit.per_minute', {
	description: 'Number of BattleMetrics API requests in the last 60s window',
}).addCallback((result) => {
	const now = Date.now()
	pruneTimestamps(now)
	result.observe(countInWindow(now, 60_000))
})

meter.createObservableGauge('battlemetrics.rate_limit.queue_size', {
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

type PlayerListData = z.infer<typeof BM.PlayerListResponse>

function parsePlayerListPage(data: PlayerListData, orgServerIdSet: Set<string>): string[] {
	const { BM_ORG_ID } = getEnv()
	const included = data.included ?? []
	const identifiers = included.filter((i): i is typeof i & { type: 'identifier' } => i.type === 'identifier')
	const flagPlayers = included.filter((i): i is typeof i & { type: 'flagPlayer' } => i.type === 'flagPlayer')
		.filter((fp) => !fp.attributes?.removedAt)
		.filter((fp) => !BM_ORG_ID || fp.relationships?.organization?.data?.id === BM_ORG_ID)
	const playerFlags = included.filter((i): i is typeof i & { type: 'playerFlag' } => i.type === 'playerFlag')

	const steamIds: string[] = []

	for (const player of data.data) {
		const bmPlayerId = player.id

		const ident = identifiers.find(
			(i) => i.attributes.type === 'steamID' && i.relationships?.player?.data?.id === bmPlayerId,
		)
		if (!ident) continue
		const steamId = ident.attributes.identifier

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

		setCachedPlayer(steamId, {
			flags,
			bmPlayerId,
			profileUrl: `https://www.battlemetrics.com/rcon/players/${bmPlayerId}`,
			hoursPlayed: Math.round(totalSeconds / 3600),
		})

		steamIds.push(steamId)
	}

	return steamIds
}

const bulkFetchOnlinePlayers = C.spanOp(
	'bulkFetchOnlinePlayers',
	{ module },
	async (ctx: CS.Ctx & C.ServerSlice): Promise<string[]> => {
		const onlineSteamIds = ctx.server.state.chat.interpolatedState.players.map((p) => p.ids.steam)

		const uncached = onlineSteamIds.filter((id) => !getCachedPlayer(id))
		if (uncached.length > 0) {
			await Promise.all(uncached.map((steamId) =>
				fetchSinglePlayerBmData(ctx, steamId).catch((err) => {
					log.warn({ err, steamId }, 'failed to fetch player bm data')
				})
			))
		}

		log.debug('found %d online players (%d fetched from api)', onlineSteamIds.length, uncached.length)
		return onlineSteamIds
	},
)

const fetchSinglePlayerBmData = C.spanOp(
	'fetchSinglePlayerBmData',
	{ module, attrs: (_ctx, steamId) => ({ steamId }) },
	async (ctx: CS.Ctx & C.ServerSlice, steamId: string): Promise<BM.PlayerFlagsAndProfile | null> => {
		const cached = getCachedPlayer(steamId)
		if (cached) return cached

		const info = await ctx.server.serverInfo.get(ctx)
		const serverName = info.code === 'ok' ? info.data.name : null
		const serverIds = await getOrgServerIds(ctx, serverName)
		const orgServerIdSet = new Set(serverIds)

		const path = `/players?filter[search]=${steamId}`
			+ `&include=identifier,flagPlayer,playerFlag`
			+ `&filter[identifiers]=steamID`
			+ `&fields[playerFlag]=name,color,description,icon`
			+ `&fields[server]=name`
			+ `&page[size]=1`

		const [data] = await bmFetch(ctx, 'GET', path, {
			responseSchema: BM.PlayerListResponse,
		})

		const parsed = parsePlayerListPage(data, orgServerIdSet)
		if (parsed.length === 0) return null

		const state = getServerBmState(ctx.serverId)
		state.onlineSteamIds.add(steamId)
		state.update$.next()

		return getCachedPlayer(parsed[0]) ?? null
	},
)

// -------- interval-based bulk polling --------

export function setupSquadServerInstance(ctx: C.ServerSlice) {
	const serverId = ctx.serverId
	const state = getServerBmState(serverId)

	Rx.interval(POLL_INTERVAL_MS).pipe(
		Rx.startWith(0),
		C.durableSub('bm-bulk-poll', { module, root: true, taskScheduling: 'exhaust' }, async () => {
			const sliceCtx = SquadServer.resolveSliceCtx({}, serverId)

			const onlineSteamIds = await bulkFetchOnlinePlayers(sliceCtx).catch((err) => {
				log.warn({ err }, 'bulk fetch online players failed')
				return [] as string[]
			})

			state.onlineSteamIds = new Set(onlineSteamIds)
			state.update$.next()
		}),
	).subscribe()

	ctx.server.event$.pipe(
		C.durableSub('bm-on-player-connected', { module, root: true }, async ([eventCtx, events]) => {
			for (const event of events) {
				if (event.type !== 'PLAYER_CONNECTED') continue
				const steamId = event.player.ids.steam
				if (!steamId) continue
				const sliceCtx = SquadServer.resolveSliceCtx(eventCtx, serverId)
				fetchSinglePlayerBmData(sliceCtx, steamId).catch((err) => {
					log.warn({ err, steamId }, 'failed to fetch bm data on player connect')
				})
			}
		}),
	).subscribe()
}

// -------- oRPC handlers --------

export const router = {
	getPlayerBmData: orpcBase.input(z.object({
		steamId: z.string(),
	})).handler(async ({ input, context: ctx }) => {
		const serverCtx = await Rx.firstValueFrom(SquadServer.selectedServerCtx$(ctx))
		return fetchSinglePlayerBmData(serverCtx, input.steamId)
	}),

	watchPlayerBmData: orpcBase.handler(async function*({ signal, context: _ctx }) {
		const server$ = SquadServer.selectedServerCtx$(_ctx).pipe(withAbortSignal(signal!))
		const data$ = server$.pipe(
			Rx.switchMap(async function*(ctx) {
				const state = getServerBmState(ctx.serverId)
				yield getPlayerBmDataSnapshot(state.onlineSteamIds)
				const update$ = state.update$.pipe(withAbortSignal(signal!))
				for await (const _ of toAsyncGenerator(update$)) {
					yield getPlayerBmDataSnapshot(state.onlineSteamIds)
				}
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(data$)
	}),
}
