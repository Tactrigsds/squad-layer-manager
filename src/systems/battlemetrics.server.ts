import * as Otel from '@opentelemetry/api'
import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema.ts'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { FixedSizeMap } from '@/lib/lru-map'
import * as Obj from '@/lib/object-utils'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import { z } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import * as BM from '@/models/battlemetrics.models'
import * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as SETTINGS from '@/models/settings.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as Env from '@/server/env'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as SecretBox from '@/server/secret-box.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as PersistedCache from '@/systems/persistedCache.server'
import * as Settings from '@/systems/settings.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'

const getEnv = Env.getEnvBuilder({ ...Env.groups.battlemetrics })
const module = initModule('battlemetrics')
const orpcBase = getOrpcBase(module)

let ENV!: ReturnType<typeof getEnv>
let log!: ReturnType<typeof module.getLogger>

// Every path out of this module is gated on it: with no token, a lookup is a 401 against a third party rather
// than a missing flag, and the pollers would spend one per online player forever. Read from the settings on
// every call, so a token entered or a switch flipped on the settings page takes effect without a restart. Off
// until the settings are loaded, which happens after this module is set up.
export function isEnabled() {
	return !!Settings.GLOBAL_SETTINGS && SETTINGS.integrationEnabled(Settings.GLOBAL_SETTINGS.integrations.battlemetrics)
}

// the org the token belongs to, or undefined when none is configured, in which case flags are not filtered by org
function orgId(): string | undefined {
	return Settings.GLOBAL_SETTINGS.integrations.battlemetrics.orgId || undefined
}

export async function setup(ctx: C.Db) {
	log = module.getLogger()
	ENV = getEnv()

	await resealPersonalTokens(ctx).catch((err) => log.warn({ err }, 'Failed to re-encrypt personal BM tokens'))

	try {
		const stored = await PersistedCache.load<PersistedCacheValue>(CACHE_PERSIST_KEY)
		if (stored) {
			const now = Date.now()
			let loaded = 0
			for (const [eosId, entry] of Object.entries(stored)) {
				if (!isServable(entry, now)) continue
				playerFlagsAndProfileCache.set(eosId, entry)
				loaded++
			}
			log.info('Loaded %d player BM cache entries from DB', loaded)
		}
	} catch (err) {
		log.warn({ err }, 'Failed to load BM player cache from DB')
	}

	const persistSub = Rx.interval(CACHE_PERSIST_INTERVAL_MS)
		.pipe(
			Instr.durableSub('bm-cache-persist', { module, root: true, taskScheduling: 'exhaust' }, () =>
				persistCache().catch((err) => log.warn({ err }, 'Failed to persist BM player cache')),
			),
		)
		.subscribe()

	const evictSub = Rx.interval(CACHE_EVICTION_INTERVAL_MS).subscribe(() => evictExpiredCacheEntries())

	CleanupSys.register(async () => {
		persistSub.unsubscribe()
		evictSub.unsubscribe()
		await persistCache().catch((err) => log.warn({ err }, 'Failed to final-persist BM player cache on shutdown'))
	})
}

// -------- personal tokens --------

// The token a write goes out under. Reads always use the org token, since their results are cached and shared
// between users. A personal token makes BM record the flag or note as written by its owner.
export type Auth = { kind: 'org' } | { kind: 'personal'; userId: bigint; token: string }
export const ORG_AUTH: Auth = { kind: 'org' }

// BM answered a personal token with 401 or 403: revoked, expired, or missing a scope the write needs. Not retried
// under the org token, which would record the write as somebody else's.
export class PersonalTokenRejectedError extends Error {
	constructor(readonly status: number) {
		super(`BattleMetrics rejected the personal token: ${status}`)
	}
}

export function isPersonalTokenRejected(err: unknown): err is PersonalTokenRejectedError {
	return err instanceof PersonalTokenRejectedError
}

// A token sealed with a key this install no longer has is treated as unset, and left in the table so that
// restoring the key brings it back.
function openToken(userId: bigint, sealed: string): string | undefined {
	try {
		return SecretBox.open(sealed)
	} catch (err) {
		log.warn({ err, userId }, 'Could not decrypt a personal BM token; writing as the org token instead')
		return undefined
	}
}

export async function authForUser(ctx: C.Db, userId: bigint): Promise<Auth> {
	const [row] = await ctx
		.db({ redactParams: true })
		.select({ token: Schema.battlemetricsUserTokens.token })
		.from(Schema.battlemetricsUserTokens)
		.where(E.eq(Schema.battlemetricsUserTokens.userId, userId))
	const token = row && openToken(userId, row.token)
	return token ? { kind: 'personal', userId, token } : ORG_AUTH
}

// the token of the SLM user who linked this steam account, for a command sent from in game
export async function authForSteamId(ctx: C.Db, steamId: string | undefined): Promise<Auth> {
	if (!steamId) return ORG_AUTH
	const [row] = await ctx
		.db({ redactParams: true })
		.select({ userId: Schema.battlemetricsUserTokens.userId, token: Schema.battlemetricsUserTokens.token })
		.from(Schema.linkedSteamAccounts)
		.innerJoin(Schema.battlemetricsUserTokens, E.eq(Schema.battlemetricsUserTokens.userId, Schema.linkedSteamAccounts.discordId))
		.where(E.eq(Schema.linkedSteamAccounts.steam64Id, BigInt(steamId)))
	const token = row && openToken(row.userId, row.token)
	return token ? { kind: 'personal', userId: row.userId, token } : ORG_AUTH
}

// brings each stored token up to the current key and envelope version (see secret-box.server.ts)
async function resealPersonalTokens(ctx: C.Db) {
	const rows = await ctx
		.db({ redactParams: true })
		.select({ userId: Schema.battlemetricsUserTokens.userId, token: Schema.battlemetricsUserTokens.token })
		.from(Schema.battlemetricsUserTokens)
	let resealed = 0
	for (const row of rows) {
		if (!SecretBox.needsReseal(row.token)) continue
		let token: string
		try {
			token = SecretBox.reseal(row.token)
		} catch (err) {
			log.warn({ err, userId: row.userId }, 'Could not decrypt a personal BM token; leaving it as stored')
			continue
		}
		await ctx
			.db({ redactParams: true })
			.update(Schema.battlemetricsUserTokens)
			.set({ token })
			.where(E.eq(Schema.battlemetricsUserTokens.userId, row.userId))
		resealed++
	}
	if (resealed > 0) log.info('Re-encrypted %d personal BM token(s) at rest', resealed)
}

// A cheap authenticated read, which BM refuses for a token that is revoked, expired or lacks the player flag scopes.
// It can't tell whether the token may write flags and notes: only a write can, so a missing write scope shows up as
// PersonalTokenRejectedError on the first one.
async function checkPersonalToken(ctx: CS.Ctx & CS.AbortSignal, auth: Auth) {
	await bmFetch(ctx, 'GET', `/player-flags?page[size]=1`, { auth })
}

// -------- cache --------

const PLAYER_CACHE_TTL = 30 * 60 * 1000 // 30 minutes
// Entries written together (one bulk poll, a boot) would otherwise all fall due in the same later poll, and that poll
// would queue a request per player at once.
const PLAYER_CACHE_TTL_JITTER = 0.2
// how long past its expiry an entry is still shown while its refresh is on the way
const PLAYER_CACHE_STALE_GRACE = 2 * 60 * 60 * 1000

// `expiresAt` is when the entry falls due for a refresh. Until PLAYER_CACHE_STALE_GRACE past it, the entry is still
// served to whatever only displays it, and its bmPlayerId spares the refresh a quick-match.
type PlayerCacheEntry = { value: BM.PlayerFlagsAndProfile; bmPlayerId: string; expiresAt: number }

// Keyed by EOS ID (required). Each entry also keeps the BM-internal player ID
// needed for flag mutation endpoints, which is not part of PlayerFlagsAndProfile.
const playerFlagsAndProfileCache = new FixedSizeMap<string, PlayerCacheEntry>(500)

let orgFlagsCache: BM.PlayerFlag[] | null = null
let orgFlagsFetchPromise: Promise<BM.PlayerFlag[]> | null = null

function isServable(entry: PlayerCacheEntry, now: number) {
	return now <= entry.expiresAt + PLAYER_CACHE_STALE_GRACE
}

function getCachedPlayer(eosId: string): BM.PlayerFlagsAndProfile | undefined {
	const entry = playerFlagsAndProfileCache.get(eosId)
	if (!entry) return undefined
	if (Date.now() > entry.expiresAt) return undefined
	return entry.value
}

function setCachedPlayer(eosId: string, bmPlayerId: string, value: BM.PlayerFlagsAndProfile) {
	const ttl = PLAYER_CACHE_TTL * (1 + (Math.random() * 2 - 1) * PLAYER_CACHE_TTL_JITTER)
	playerFlagsAndProfileCache.set(eosId, { value, bmPlayerId, expiresAt: Date.now() + ttl })
}

// -------- cache eviction --------

const CACHE_EVICTION_INTERVAL_MS = 10 * 60 * 1000

function evictExpiredCacheEntries() {
	const now = Date.now()
	let evicted = 0
	for (const [eosId, entry] of playerFlagsAndProfileCache.entries()) {
		if (!isServable(entry, now)) {
			playerFlagsAndProfileCache.delete(eosId)
			evicted++
		}
	}
	if (evicted > 0) log.debug('Evicted %d expired BM cache entries', evicted)
}

// -------- cache persistence --------

const CACHE_PERSIST_KEY = 'bm:playerCache'
const CACHE_PERSIST_INTERVAL_MS = 5 * 60 * 1000

type PersistedCacheValue = Record<string, PlayerCacheEntry>

async function persistCache() {
	const now = Date.now()
	const toStore: PersistedCacheValue = {}
	for (const [eosId, entry] of playerFlagsAndProfileCache.entries()) {
		if (!isServable(entry, now)) continue
		toStore[eosId] = entry
	}
	await PersistedCache.save(CACHE_PERSIST_KEY, toStore)
}

// -------- polling config --------

const POLL_INTERVAL_MS = 5 * 60 * 1000

const playerUpdate$ = new IsolatedSubject<BM.PlayerBmDataUpdate>()

// A bulk fetch lands one player at a time, so the watch stream sends whatever lands within this window as one message.
const PLAYER_UPDATE_BATCH_MS = 100
const playerUpdateBatch$ = playerUpdate$.pipe(Rx.Ext.bufferBurst(PLAYER_UPDATE_BATCH_MS), Rx.share())

export type { PublicPlayerBmData } from '@/models/battlemetrics.models'

// -------- rate-limit queue --------

const RATE_LIMITS = {
	perSecond: 10,
	perMinute: 60,
	// held back from background requests, so a burst of polling never leaves an admin waiting out the minute
	interactiveReservePerMinute: 15,
	backoffDefaultMs: 30_000,
} as const

// Which requests go first when the budget runs short: an interactive one has a user waiting on it, a background one
// is a poll. Mutable, so a background fetch that a user comes to wait on can be promoted while it is queued.
export type Lane = { interactive: boolean }
const BACKGROUND: Readonly<Lane> = { interactive: false }
const INTERACTIVE: Readonly<Lane> = { interactive: true }

// BM limits each token separately, so the org token and every personal token get their own budget
type RateLimiter = {
	timestamps: number[]
	queue: Array<{ lane: Lane; resolve: () => void }>
	drainTimer: ReturnType<typeof setTimeout> | null
	backoffUntil: number
}

function createRateLimiter(): RateLimiter {
	return { timestamps: [], queue: [], drainTimer: null, backoffUntil: 0 }
}

const orgRateLimiter = createRateLimiter()
const personalRateLimiters = new Map<bigint, RateLimiter>()

function rateLimiterFor(auth: Auth): RateLimiter {
	if (auth.kind === 'org') return orgRateLimiter
	let limiter = personalRateLimiters.get(auth.userId)
	if (!limiter) {
		limiter = createRateLimiter()
		personalRateLimiters.set(auth.userId, limiter)
	}
	return limiter
}

function pruneTimestamps(limiter: RateLimiter, now: number) {
	const cutoff = now - 60_000
	while (limiter.timestamps.length > 0 && limiter.timestamps[0] <= cutoff) {
		limiter.timestamps.shift()
	}
}

function countInWindow(limiter: RateLimiter, now: number, windowMs: number): number {
	let count = 0
	for (let i = limiter.timestamps.length - 1; i >= 0; i--) {
		if (limiter.timestamps[i] > now - windowMs) count++
		else break
	}
	return count
}

function perMinuteFor(lane: Lane) {
	return lane.interactive ? RATE_LIMITS.perMinute : RATE_LIMITS.perMinute - RATE_LIMITS.interactiveReservePerMinute
}

function canDispatch(limiter: RateLimiter, now: number, lane: Lane): boolean {
	if (now < limiter.backoffUntil) return false
	return countInWindow(limiter, now, 1_000) < RATE_LIMITS.perSecond && countInWindow(limiter, now, 60_000) < perMinuteFor(lane)
}

function nextInQueue(limiter: RateLimiter): number {
	const idx = limiter.queue.findIndex((e) => e.lane.interactive)
	return idx === -1 ? 0 : idx
}

// (Re)arms the drain for when the request at the head of the queue may next go out. Re-armed rather than left alone
// when already armed: promoting a queued request to interactive can bring that moment forward.
function scheduleDrain(limiter: RateLimiter) {
	if (limiter.drainTimer !== null) {
		clearTimeout(limiter.drainTimer)
		limiter.drainTimer = null
	}
	if (limiter.queue.length === 0) return

	const now = Date.now()
	pruneTimestamps(limiter, now)
	const perMinute = perMinuteFor(limiter.queue[nextInQueue(limiter)].lane)

	let delayMs = 0
	if (now < limiter.backoffUntil) {
		delayMs = limiter.backoffUntil - now
	} else {
		if (countInWindow(limiter, now, 1_000) >= RATE_LIMITS.perSecond) {
			const oldest1s = limiter.timestamps.find((t) => t > now - 1_000)!
			delayMs = Math.max(delayMs, oldest1s + 1_000 - now)
		}
		const inMinute = countInWindow(limiter, now, 60_000)
		if (inMinute >= perMinute) {
			// pruned, so every timestamp is in the window: a slot frees once all but perMinute - 1 have aged out
			const freeing = limiter.timestamps[limiter.timestamps.length - perMinute]
			delayMs = Math.max(delayMs, freeing + 60_000 - now)
		}
	}

	limiter.drainTimer = setTimeout(() => {
		limiter.drainTimer = null
		drainQueue(limiter)
	}, delayMs + 1)
}

function drainQueue(limiter: RateLimiter) {
	const now = Date.now()
	pruneTimestamps(limiter, now)
	while (limiter.queue.length > 0) {
		const idx = nextInQueue(limiter)
		if (!canDispatch(limiter, now, limiter.queue[idx].lane)) break
		limiter.timestamps.push(now)
		const [entry] = limiter.queue.splice(idx, 1)
		entry.resolve()
	}
	scheduleDrain(limiter)
}

function promote(limiter: RateLimiter, lane: Lane) {
	if (lane.interactive) return
	lane.interactive = true
	if (limiter.queue.some((e) => e.lane === lane)) drainQueue(limiter)
}

const meter = Otel.metrics.getMeter('battlemetrics')

meter
	.createObservableGauge(ATTRS.Battlemetrics.REQUESTS_PER_SECOND, {
		description: 'Number of BattleMetrics API requests made with the org token in the last 1s window',
	})
	.addCallback((result) => {
		const now = Date.now()
		pruneTimestamps(orgRateLimiter, now)
		result.observe(countInWindow(orgRateLimiter, now, 1_000))
	})

meter
	.createObservableGauge(ATTRS.Battlemetrics.REQUESTS_PER_MINUTE, {
		description: 'Number of BattleMetrics API requests made with the org token in the last 60s window',
	})
	.addCallback((result) => {
		const now = Date.now()
		pruneTimestamps(orgRateLimiter, now)
		result.observe(countInWindow(orgRateLimiter, now, 60_000))
	})

meter
	.createObservableGauge(ATTRS.Battlemetrics.QUEUE_SIZE, {
		description: 'Number of queued BattleMetrics API requests waiting for a rate limit slot on the org token',
	})
	.addCallback((result) => {
		result.observe(orgRateLimiter.queue.length)
	})

function acquireRateSlot(limiter: RateLimiter, lane: Lane, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason)
	const now = Date.now()
	pruneTimestamps(limiter, now)
	if (limiter.queue.length === 0 && canDispatch(limiter, now, lane)) {
		limiter.timestamps.push(now)
		return Promise.resolve()
	}
	return new Promise<void>((resolve, reject) => {
		const entry = {
			lane,
			resolve: () => {
				signal?.removeEventListener('abort', onAbort)
				resolve()
			},
		}
		const onAbort = () => {
			const idx = limiter.queue.indexOf(entry)
			if (idx !== -1) limiter.queue.splice(idx, 1)
			scheduleDrain(limiter)
			reject(signal!.reason)
		}
		signal?.addEventListener('abort', onAbort, { once: true })
		limiter.queue.push(entry)
		if (lane.interactive) drainQueue(limiter)
		else scheduleDrain(limiter)
	})
}

function triggerBackoff(limiter: RateLimiter, res: Response) {
	const retryAfter = res.headers.get('Retry-After')
	let delayMs = RATE_LIMITS.backoffDefaultMs
	if (retryAfter) {
		const seconds = Number(retryAfter)
		if (!Number.isNaN(seconds)) {
			delayMs = seconds * 1_000
		}
	}
	limiter.backoffUntil = Date.now() + delayMs
	log.warn('BattleMetrics 429 — backing off for %dms', delayMs)
	scheduleDrain(limiter)
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
	init?: Omit<RequestInit, 'body' | 'method'> & {
		body?: unknown
		responseSchema?: z.ZodType<T>
		passthroughCodes?: number[]
		auth?: Auth
		lane?: Lane
	},
): Promise<readonly [T, Response]> {
	const auth = init?.auth ?? ORG_AUTH
	const lane = init?.lane ?? INTERACTIVE
	const limiter = rateLimiterFor(auth)
	return Instr.spanOp(
		'bmFetch',
		{
			module,
			kind: Otel.SpanKind.CLIENT,
			levels: { error: 'error', event: 'trace' },
			attrs: () => ({ [ATTRS.Http.METHOD]: method, [ATTRS.Http.PATH]: path, [ATTRS.Battlemetrics.AUTH]: auth.kind }),
		},
		async (ctx: CS.Ctx & CS.AbortSignal) => {
			// the callers below all return early instead; reaching here means one of them stopped doing so
			if (!isEnabled()) throw new Error('The battlemetrics integration is off')
			const url = `${ENV.BM_HOST}${path}`

			const headers: Record<string, string> = {
				Authorization: `Bearer ${auth.kind === 'personal' ? auth.token : Settings.GLOBAL_SETTINGS.integrations.battlemetrics.token}`,
				Accept: 'application/json',
				...(init?.headers as Record<string, string>),
			}

			let body: string | undefined
			if (init?.body != null && typeof init.body === 'object') {
				body = JSON.stringify(init.body)
				headers['Content-Type'] = 'application/json'
			}

			let lastError!: Error
			for (let attempt = 0; attempt < RETRY.maxAttempts; attempt++) {
				await acquireRateSlot(limiter, lane, ctx.signal)
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
						await Prom.sleep(delay, ctx.signal)
						continue
					}
					throw lastError
				}

				if (res.status === 429) {
					triggerBackoff(limiter, res)
					lastError = new Error(`BattleMetrics API rate limited: 429 Too Many Requests`)
					if (attempt < RETRY.maxAttempts - 1) {
						const delay = Math.max(RETRY.baseDelayMs * 2 ** attempt, limiter.backoffUntil - Date.now())
						log.warn(`${method} ${path}: 429 rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY.maxAttempts})`)
						await Prom.sleep(delay, ctx.signal)
						continue
					}
					throw lastError
				}
				if (auth.kind === 'personal' && (res.status === 401 || res.status === 403)) {
					log.warn({ status: res.status, userId: auth.userId }, `${method} ${path}: personal token rejected`)
					throw new PersonalTokenRejectedError(res.status)
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
						await Prom.sleep(delay, ctx.signal)
						continue
					}
					log.error(
						{ status: res.status, statusText: res.statusText, body: text },
						`${method} ${path}: ${res.status} ${res.statusText}`,
					)
					throw lastError
				}
				let level: 'info' | 'debug' = 'info'
				if (method === 'GET') level = 'debug'

				log[level]({ status: res.status, method, path }, `${method} ${path} : ${res.status}`)
				Instr.setSpanOpAttrs({ [ATTRS.Http.STATUS_CODE]: res.status })

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
	data: z.array(
		z.object({
			type: z.literal('playerFlag'),
			id: z.string(),
			attributes: BM.PlayerFlagAttributes,
		}),
	),
})

export const getOrgFlags = Instr.spanOp('getOrgFlags', { module }, async (ctx: CS.Ctx & CS.AbortSignal): Promise<BM.PlayerFlag[]> => {
	if (!isEnabled()) return []
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

	const flags = await Prom.raceAbort(orgFlagsFetchPromise, ctx.signal)
	orgFlagsCache = flags
	return flags
})

export const addPlayerFlags = Instr.spanOp(
	'addPlayerFlags',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal, auth: Auth, bmPlayerId: string, flagIds: string[]) => {
		if (flagIds.length === 0) return { code: 'err:no-flags' as const }
		const [_, res] = await bmFetch(ctx, 'POST', `/players/${bmPlayerId}/relationships/flags`, {
			body: { data: flagIds.map((id) => ({ type: 'playerFlag', id })) },
			passthroughCodes: [409],
			auth,
		})
		if (res.status === 409) return { code: 'player-already-has-flag' as const }
		return { code: 'ok' as const }
	},
)

export const addPlayerNote = Instr.spanOp(
	'addPlayerNote',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal, auth: Auth, bmPlayerId: string, note: string) => {
		const [, res] = await bmFetch(ctx, 'POST', `/players/${bmPlayerId}/relationships/notes`, {
			auth,
			body: {
				data: {
					type: 'playerNote',
					attributes: { note, shared: true },
					relationships: { organization: { data: { type: 'organization', id: orgId() } } },
				},
			},
		})
		// the note is posted by now, so an unreadable response drops the cached list rather than failing the post
		const created = BM.PlayerNoteCreateResponse.safeParse(await res.json().catch(() => null))
		const cached = playerNotesCache.get(bmPlayerId)
		if (!cached) return
		if (!created.success) {
			playerNotesCache.delete(bmPlayerId)
			return
		}
		playerNotesCache.set(bmPlayerId, {
			...cached,
			notes: [BM.parseNote({ id: created.data.data.id, ...created.data.data.attributes }, null), ...cached.notes],
		})
	},
)

// -------- player notes --------

// Each notes fetch spends one request from the org's BM rate limit. A player's list is cached for 5 minutes, so several
// admins can view the same player for one request.
const PLAYER_NOTES_TTL = 5 * 60 * 1000
const PLAYER_NOTES_PAGE_SIZE = 100

const playerNotesCache = new FixedSizeMap<string, BM.PlayerNotesResult & { expiresAt: number }>(200)
const playerNotesInflight = new Map<string, Promise<BM.PlayerNotesResult>>()

async function fetchPlayerNotes(ctx: CS.Ctx, bmPlayerId: string): Promise<BM.PlayerNotesResult> {
	const org = orgId()
	const [res] = await bmFetch(
		// shared by every caller waiting on this fetch, so no one caller's signal may cancel it
		{ ...ctx, signal: CleanupSys.shutdownSignal },
		'GET',
		`/players/${bmPlayerId}/relationships/notes?include=user&page[size]=${PLAYER_NOTES_PAGE_SIZE}` +
			(org ? `&filter[organizations]=${org}` : ''),
		{ responseSchema: BM.PlayerNoteListResponse },
	)
	const fetchedAt = Date.now()
	const nicknames = new Map((res.included ?? []).filter((i) => i.type === 'user').map((u) => [u.id, u.attributes?.nickname ?? null]))
	const notes = res.data
		.filter((n) => BM.isPublicNote(n.attributes, fetchedAt))
		.map((n) => BM.parseNote({ id: n.id, ...n.attributes }, nicknames.get(n.relationships?.user?.data?.id ?? '') ?? null))
		.sort((a, b) => b.createdAt - a.createdAt)
	return { notes, fetchedAt, truncated: !!res.links?.next }
}

export const getPlayerNotes = Instr.spanOp(
	'getPlayerNotes',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal, bmPlayerId: string, opts: { fresh: boolean }): Promise<BM.PlayerNotesResult> => {
		const cached = playerNotesCache.get(bmPlayerId)
		if (cached && !opts.fresh && cached.expiresAt > Date.now()) {
			const { expiresAt: _, ...result } = cached
			return result
		}
		let inflight = playerNotesInflight.get(bmPlayerId)
		if (!inflight) {
			inflight = fetchPlayerNotes(ctx, bmPlayerId)
				.then((result) => {
					playerNotesCache.set(bmPlayerId, { ...result, expiresAt: result.fetchedAt + PLAYER_NOTES_TTL })
					return result
				})
				.finally(() => playerNotesInflight.delete(bmPlayerId))
			playerNotesInflight.set(bmPlayerId, inflight)
		}
		return Prom.raceAbort(inflight, ctx.signal)
	},
)

// posts an admin's note to one player's profile and records it. `actor` signs the note on BM; `appActor` is who the
// audit log credits; `auth` is whose token BM records the note under.
export async function addNoteToPlayer(
	ctx: CS.Ctx & CS.AbortSignal & C.Db,
	playerIds: SM.PlayerIds.IdQuery<'eos'>,
	text: string,
	actor: { label: string; appActor: AppEvents.Actor; auth: Auth },
): Promise<'ok' | 'not-found'> {
	const bmData = await fetchSinglePlayerBmData(ctx, playerIds)
	if (!bmData) return 'not-found'
	await addPlayerNote(ctx, actor.auth, bmData.bmPlayerId, BM.playerNote({ actor: actor.label, text }))
	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.PlayerNoteAdded>({
			type: 'PLAYER_NOTE_ADDED',
			playerId: playerIds.eos,
			note: text.trim(),
			actor: actor.appActor,
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
	return 'ok'
}

export const removePlayerFlags = Instr.spanOp(
	'removePlayerFlags',
	{ module },
	async (ctx: CS.Ctx & CS.AbortSignal, auth: Auth, bmPlayerId: string, flagIds: string[]): Promise<('ok' | 'already-removed')[]> => {
		if (flagIds.length === 0) return []
		return Promise.all(
			flagIds.map(async (flagId) => {
				const [, res] = await bmFetch(ctx, 'DELETE', `/players/${bmPlayerId}/relationships/flags/${flagId}`, {
					passthroughCodes: [400],
					auth,
				})
				if (res.status === 400) {
					const bodyText = await res.text()
					const body = JSON.parse(bodyText)
					if (body.details === 'Flag is already removed') {
						return 'already-removed' as const
					}
					throw new Error(`Battlemetrics API error: ${res.status} ${res.statusText}\n${bodyText}`)
				}
				return 'ok' as const
			}),
		)
	},
)

async function fetchPlayerDetail(
	ctx: CS.Ctx & CS.AbortSignal,
	eosId: string,
	bmPlayerId: string,
	lane: Lane,
): Promise<BM.PlayerFlagsAndProfile> {
	const BM_ORG_ID = orgId()
	const detailPath =
		`/players/${bmPlayerId}` +
		`?include=identifier,flagPlayer,playerFlag` +
		`&filter[identifiers]=eosID,steamID` +
		`&fields[identifier]=type,identifier` +
		`&fields[playerFlag]=name,color,description,icon`

	const [detailData] = await bmFetch(ctx, 'GET', detailPath, {
		responseSchema: BM.PlayerDetailResponse,
		lane,
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

	return {
		flagIds,
		bmPlayerId,
		playerIds: resolvedPlayerIds,
		profileUrl: `https://www.battlemetrics.com/rcon/players/${bmPlayerId}`,
		hoursPlayed: 0,
	}
}

function storePlayer(value: BM.PlayerFlagsAndProfile) {
	const playerId = SM.PlayerIds.getPlayerId(value.playerIds)
	// every watcher already holds a servable entry: it was in their initial snapshot or sent since
	const prev = playerFlagsAndProfileCache.get(playerId)
	const unchanged = prev !== undefined && isServable(prev, Date.now()) && Obj.deepEqual(prev.value, value)
	setCachedPlayer(playerId, value.bmPlayerId, value)
	if (!unchanged) playerUpdate$.next({ playerId, data: value })
}

// -------- quick-match batching --------

// Players seen for the first time arrive in bursts (a roster at boot, a wave of connects while seeding), and one
// quick-match resolves many of them for a single request.
const QUICK_MATCH_BATCH_MS = 500
const QUICK_MATCH_MAX_IDENTIFIERS = 100

type QuickMatchWaiter = { lane: Lane; resolve: (bmPlayerId: string | null) => void; reject: (err: unknown) => void }
let quickMatchWaiters = new Map<string, QuickMatchWaiter[]>()
let quickMatchTimer: ReturnType<typeof setTimeout> | null = null
let quickMatchFlushesNow = false

// the BM player id behind an EOS id, or null when BM has never seen it
function quickMatch(eosId: string, lane: Lane): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const waiters = quickMatchWaiters.get(eosId)
		if (waiters) waiters.push({ lane, resolve, reject })
		else quickMatchWaiters.set(eosId, [{ lane, resolve, reject }])
		if (lane.interactive && !quickMatchFlushesNow) {
			if (quickMatchTimer !== null) clearTimeout(quickMatchTimer)
			quickMatchTimer = setTimeout(flushQuickMatches, 0)
			quickMatchFlushesNow = true
		} else {
			quickMatchTimer ??= setTimeout(flushQuickMatches, QUICK_MATCH_BATCH_MS)
		}
	})
}

function flushQuickMatches() {
	quickMatchTimer = null
	quickMatchFlushesNow = false
	const all = [...quickMatchWaiters]
	quickMatchWaiters = new Map()
	for (let i = 0; i < all.length; i += QUICK_MATCH_MAX_IDENTIFIERS) {
		void runQuickMatch(all.slice(i, i + QUICK_MATCH_MAX_IDENTIFIERS))
	}
}

async function runQuickMatch(batch: [string, QuickMatchWaiter[]][]) {
	const lane: Lane = { interactive: batch.some(([, waiters]) => waiters.some((w) => w.lane.interactive)) }
	try {
		const [matchData] = await bmFetch({ ...CS.init(), signal: CleanupSys.shutdownSignal }, 'POST', '/players/quick-match', {
			body: { data: batch.map(([eosId]) => ({ type: 'identifier', attributes: { type: 'eosID', identifier: eosId } })) },
			responseSchema: BM.PlayerQuickMatchResponse,
			lane,
		})
		const bmIdByEosId = new Map<string, string>()
		for (const item of matchData.data) {
			const bmId = item.relationships?.player?.data?.id
			if (bmId) bmIdByEosId.set(item.attributes.identifier, bmId)
		}
		for (const [eosId, waiters] of batch) {
			for (const w of waiters) w.resolve(bmIdByEosId.get(eosId) ?? null)
		}
	} catch (err) {
		for (const [, waiters] of batch) {
			for (const w of waiters) w.reject(err)
		}
	}
}

// -------- player fetches --------

// One fetch per player at a time, shared by everyone asking for that player, so none of their signals may cancel it.
// `superseded` is set when a fresh fetch replaces this one: this one may have read BM before the change the fresh one
// was started for, so its answer must not overwrite the cache.
type PlayerFetch = { lane: Lane; superseded: boolean; promise: Promise<BM.PlayerFlagsAndProfile | null> }
const playerFetches = new Map<string, PlayerFetch>()

// Reads the player from BM and caches the result. A cached entry's bmPlayerId is reused whether or not the entry has
// expired, so only a player seen for the first time costs a quick-match. `fresh` starts a fetch rather than joining
// the one running.
function fetchPlayer(ctx: CS.Ctx, eosId: string, lane: Lane, opts?: { fresh?: boolean }): Promise<BM.PlayerFlagsAndProfile | null> {
	const running = playerFetches.get(eosId)
	if (running && !opts?.fresh) {
		if (lane.interactive) promote(orgRateLimiter, running.lane)
		return running.promise
	}
	if (running) running.superseded = true
	const job: PlayerFetch = { lane: { interactive: lane.interactive }, superseded: false, promise: undefined! }
	job.promise = (async () => {
		const shared = { ...ctx, signal: CleanupSys.shutdownSignal }
		const bmPlayerId = playerFlagsAndProfileCache.get(eosId)?.bmPlayerId ?? (await quickMatch(eosId, job.lane))
		if (!bmPlayerId) return null
		const value = await fetchPlayerDetail(shared, eosId, bmPlayerId, job.lane)
		if (!job.superseded) storePlayer(value)
		return value
	})().finally(() => {
		if (playerFetches.get(eosId) === job) playerFetches.delete(eosId)
	})
	playerFetches.set(eosId, job)
	return job.promise
}

// for the callers that only need the cache to hold the player: an unexpired entry is left alone
function ensurePlayerFetched(ctx: CS.Ctx, eosId: string): Promise<unknown> {
	if (getCachedPlayer(eosId)) return Promise.resolve()
	return fetchPlayer(ctx, eosId, BACKGROUND)
}

const bulkFetchOnlinePlayers = Instr.spanOp(
	'bulkFetchOnlinePlayers',
	{ module },
	async (ctx: CS.Ctx & C.ManagedServer): Promise<string[] | undefined> => {
		const teamsRes = await ctx.squadRcon.teams.get(ctx)
		if (teamsRes.code !== 'ok') return
		const onlineEosIds = teamsRes.players.map((p) => SM.PlayerIds.getPlayerId(p.ids))
		const due = onlineEosIds.filter((eosId) => !getCachedPlayer(eosId))

		let failed = 0
		await Promise.all(
			due.map((eosId) =>
				fetchPlayer(ctx, eosId, BACKGROUND).catch((err) => {
					failed++
					log.debug({ err, eosId }, 'failed to fetch player bm detail')
				}),
			),
		)
		if (failed > 0) log.warn('failed to fetch bm data for %d of %d players', failed, due.length)

		log.info('fetched %d online players (%d fetched from BM api)', onlineEosIds.length, due.length)
		return onlineEosIds
	},
)

// reads BM again for this player, after a change the cached answer predates. The cached entry stays if the read fails.
export async function invalidateAndRefetchPlayer(ctx: CS.Ctx & CS.AbortSignal, eosId: string): Promise<BM.PlayerFlagsAndProfile | null> {
	if (!isEnabled()) return null
	const updated = await Prom.raceAbort(fetchPlayer(ctx, eosId, INTERACTIVE, { fresh: true }), ctx.signal)
	// persist immediately so the db doesn't serve stale flags on next startup
	persistCache().catch((err) => log.warn({ err }, 'Failed to persist BM cache after flag update'))
	return updated
}

export const fetchSinglePlayerBmData = Instr.spanOp(
	'fetchSinglePlayerBmData',
	{ module, attrs: (_ctx, playerIds) => ({ [ATTRS.Player.EOS_ID]: playerIds.eos, [ATTRS.Player.STEAM_ID]: playerIds.steam }) },
	async (ctx: CS.Ctx & CS.AbortSignal, playerIds: SM.PlayerIds.IdQuery<'eos'>): Promise<BM.PlayerFlagsAndProfile | null> => {
		if (!isEnabled()) return null
		const cached = getCachedPlayer(playerIds.eos)
		if (cached) return cached
		return await Prom.raceAbort(fetchPlayer(ctx, playerIds.eos, INTERACTIVE), ctx.signal)
	},
)

// -------- interval-based bulk polling --------

// the pollers run for the life of the server and ask isEnabled on every tick, so the integration can be switched
// on or off from the settings page while servers are up
export function setupSquadServerInstance(ctx: C.ManagedServer) {
	const serverId = ctx.serverId

	ctx.cleanup.push(
		Rx.interval(POLL_INTERVAL_MS)
			.pipe(
				Rx.startWith(0),
				Instr.durableSub('bm-bulk-poll', { module, root: true, taskScheduling: 'exhaust' }, async (_, signal) => {
					if (!isEnabled()) return
					const serverCtx = SquadServer.resolveCtx({ signal }, serverId)

					// what it fetched reaches watchers through storePlayer
					await bulkFetchOnlinePlayers(serverCtx).catch((err) => {
						log.warn({ err }, 'bulk fetch online players failed')
					})
				}),
			)
			.subscribe(),
		ctx.server.event$
			.pipe(
				// PLAYER_RECONCILED included: a backfilled player is one we became aware of and should fetch BM data for.
				Rx.filter(([eventCtx, event]) => event.type === 'PLAYER_CONNECTED' || event.type === 'PLAYER_RECONCILED'),
				// parallel so one player's fetch doesn't queue behind another's, and a burst of connects shares one quick-match
				Instr.durableSub('bm-on-player-connected', { module, root: true, taskScheduling: 'parallel' }, async ([eventCtx, event]) => {
					if (event.type !== 'PLAYER_CONNECTED' && event.type !== 'PLAYER_RECONCILED') return
					if (!isEnabled()) return
					const playerIds = event.player.ids
					await ensurePlayerFetched(eventCtx, playerIds.eos).catch((err) => {
						log.warn({ err, playerIds }, 'failed to fetch bm data on player connect')
					})
				}),
			)
			.subscribe(),
	)
}

// -------- oRPC handlers --------

export const router = {
	// an expired entry is answered at once and refreshed behind it: the refresh reaches the caller over the watch stream
	getPlayerBmData: orpcBase.input(z.object({ playerId: z.string() })).handler(async ({ input, context: ctx }) => {
		const entry = isEnabled() ? playerFlagsAndProfileCache.get(input.playerId) : undefined
		if (entry && isServable(entry, Date.now())) {
			if (Date.now() > entry.expiresAt) {
				fetchPlayer(ctx, input.playerId, INTERACTIVE).catch((err) =>
					log.warn({ err, playerId: input.playerId }, 'failed to refresh bm data'),
				)
			}
			return entry.value
		}
		return fetchSinglePlayerBmData(ctx, SM.PlayerIds.queryFromPlayerId(input.playerId))
	}),

	// on-demand cache bust: drops each player's cached BM data and refetches, pushing the fresh result down the watch
	// stream. A player whose refetch fails is left with whatever was cached rather than failing the batch.
	refreshPlayerBmData: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z.object({
				playerIds: z.array(z.string()).min(1),
			}),
		)
		.handler(async ({ input, context: ctx }) => {
			const failed: string[] = []
			for (const playerId of input.playerIds) {
				await invalidateAndRefetchPlayer(ctx, playerId).catch((err) => {
					log.warn({ err, playerId }, 'failed to refresh player bm data')
					failed.push(playerId)
				})
			}
			return { code: 'ok' as const, refreshedCount: input.playerIds.length - failed.length, failed }
		}),

	// the cached entries as one message, then each batch of changed entries as it lands
	watchPlayerBmData: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal, context: _ctx }) {
		const now = Date.now()
		const snapshot: BM.PlayerBmDataUpdate[] = []
		for (const [playerId, entry] of playerFlagsAndProfileCache.entries()) {
			if (isServable(entry, now)) snapshot.push({ playerId, data: entry.value })
		}
		yield* Rx.Ext.toAsyncGenerator(Rx.merge(Rx.of(snapshot), playerUpdateBatch$).pipe(Rx.Ext.withAbortSignal(signal!)))
	}),

	listOrgFlags: orpcBase.handler(async ({ context: ctx }) => {
		return getOrgFlags(ctx)
	}),

	// whether the caller has a personal token saved. The token itself never leaves the server.
	getMyToken: orpcBase.handler(async ({ context: ctx }) => {
		const [row] = await ctx
			.db({ redactParams: true })
			.select({ updatedAt: Schema.battlemetricsUserTokens.updatedAt })
			.from(Schema.battlemetricsUserTokens)
			.where(E.eq(Schema.battlemetricsUserTokens.userId, ctx.user.discordId))
		return { code: 'ok' as const, updatedAt: row?.updatedAt.getTime() ?? null }
	}),

	// checked against BM before it is saved, so a mistyped or revoked token is refused here rather than on the
	// caller's first flag change
	setMyToken: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ token: z.string().trim().min(1).max(4096) }))
		.handler(async ({ input, context: ctx }) => {
			if (!isEnabled()) return { code: 'err:disabled' as const }
			const userId = ctx.user.discordId
			try {
				await checkPersonalToken(ctx, { kind: 'personal', userId, token: input.token })
			} catch (err) {
				if (isPersonalTokenRejected(err)) return { code: 'err:token-rejected' as const }
				log.warn({ err }, 'failed to check personal BM token')
				return { code: 'err:check-failed' as const }
			}
			const sealed = SecretBox.seal(input.token)
			const updatedAt = new Date()
			await ctx
				.db({ redactParams: true })
				.insert(Schema.battlemetricsUserTokens)
				.values({ userId, token: sealed, updatedAt })
				.onConflictDoUpdate({ target: Schema.battlemetricsUserTokens.userId, set: { token: sealed, updatedAt } })
			// a backoff earned by the previous token says nothing about this one
			personalRateLimiters.delete(userId)
			await Users.recordUserAccount(ctx, userId, 'bm-token-set')
			return { code: 'ok' as const, updatedAt: updatedAt.getTime() }
		}),

	removeMyToken: orpcBase.meta({ type: 'mutation' }).handler(async ({ context: ctx }) => {
		const userId = ctx.user.discordId
		const removed = await ctx
			.db()
			.delete(Schema.battlemetricsUserTokens)
			.where(E.eq(Schema.battlemetricsUserTokens.userId, userId))
			.returning({ userId: Schema.battlemetricsUserTokens.userId })
		personalRateLimiters.delete(userId)
		if (removed.length > 0) await Users.recordUserAccount(ctx, userId, 'bm-token-removed')
		return { code: 'ok' as const }
	}),

	// `fresh` skips the cached list, for an admin who asks to reload
	listPlayerNotes: orpcBase
		.input(z.object({ playerId: z.string(), fresh: z.boolean().prefault(false) }))
		.handler(async ({ input, context: ctx }) => {
			if (!isEnabled()) return { code: 'err:disabled' as const }
			const bmData = await fetchSinglePlayerBmData(ctx, SM.PlayerIds.queryFromPlayerId(input.playerId))
			if (!bmData) return { code: 'err:not-found' as const }
			return { code: 'ok' as const, ...(await getPlayerNotes(ctx, bmData.bmPlayerId, { fresh: input.fresh })) }
		}),

	// one note, posted to each target's profile separately. A target BM can't resolve or a post that fails is skipped
	// rather than failing the rest; the count says how many landed.
	addNote: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z.object({
				playerIds: z.array(z.string()).min(1),
				note: z.string().trim().min(1).max(BM.NOTE_MAX_LENGTH),
			}),
		)
		.handler(async ({ input, context: ctx }) => {
			if (!isEnabled()) return { code: 'err:disabled' as const }
			const auth = await authForUser(ctx, ctx.user.discordId)
			const actor = { label: actorLabel(ctx), appActor: { type: 'slm-user' as const, userId: ctx.user.discordId }, auth }
			const results = await Promise.all(
				input.playerIds.map((playerId) =>
					addNoteToPlayer(ctx, SM.PlayerIds.queryFromPlayerId(playerId), input.note, actor).catch((err) => {
						if (isPersonalTokenRejected(err)) return 'token-rejected' as const
						log.warn({ err, playerId }, 'failed to add BM note')
						return 'failed' as const
					}),
				),
			)
			const notedCount = results.filter((r) => r === 'ok').length
			if (notedCount === 0 && results.includes('token-rejected')) return { code: 'err:personal-token-rejected' as const }
			if (notedCount === 0) return { code: 'err:none-added' as const, playerCount: input.playerIds.length }
			return { code: 'ok' as const, notedCount, playerCount: input.playerIds.length }
		}),

	// one dialog's worth of edits lands as one action: one permission check, one refresh, and one audit event
	// carrying the whole change, rather than an add and a remove that only happened to be submitted together.
	updateFlags: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z.object({
				playerId: z.string(),
				add: z.array(BM.FlagChangeSchema).prefault([]),
				remove: z.array(BM.FlagChangeSchema).prefault([]),
			}),
		)
		.handler(async ({ input, context: ctx }) => {
			if (!isEnabled()) return { code: 'err:disabled' as const }

			const orgFlags = await getOrgFlags(ctx)
			// the client marks those fields required, but it's the client of a permission-gated mutation: re-check here
			const missing = BM.flagsMissingRequiredNote(input.add, Settings.GLOBAL_SETTINGS.playerFlagsRequiringNote)
			if (missing.length > 0) {
				return { code: 'err:reason-required' as const, flags: BM.resolveFlags(missing, orgFlags).map((f) => f.name) }
			}

			const playerIds = SM.PlayerIds.queryFromPlayerId(input.playerId)
			const current = await fetchSinglePlayerBmData(ctx, playerIds)
			if (!current) return { code: 'err:not-found' as const }

			// the dialog was built against flags that may have moved since; drop anything already in its target state
			// rather than failing the whole submit over it
			const toAdd = input.add.filter((f) => !current.flagIds.includes(f.id))
			const toRemove = input.remove.filter((f) => current.flagIds.includes(f.id))
			if (toAdd.length === 0 && toRemove.length === 0) return { code: 'err:no-changes' as const }

			const auth = await authForUser(ctx, ctx.user.discordId)
			try {
				const addRes = await addPlayerFlags(
					ctx,
					auth,
					current.bmPlayerId,
					toAdd.map((f) => f.id),
				)
				if (addRes.code === 'player-already-has-flag') return { code: 'err:already-flagged' as const }
				await removePlayerFlags(
					ctx,
					auth,
					current.bmPlayerId,
					toRemove.map((f) => f.id),
				)
			} catch (err) {
				if (isPersonalTokenRejected(err)) return { code: 'err:personal-token-rejected' as const }
				throw err
			}

			const added = resolveFlagChanges(toAdd, orgFlags)
			const removed = resolveFlagChanges(toRemove, orgFlags)
			const noteResults = await Promise.all([
				postFlagChangeNotes(ctx, auth, current.bmPlayerId, 'added', added, actorLabel(ctx)),
				postFlagChangeNotes(ctx, auth, current.bmPlayerId, 'removed', removed, actorLabel(ctx)),
			])

			const updated = await invalidateAndRefetchPlayer(ctx, input.playerId)
			await persistFlagsUpdatedEvent(ctx, { playerId: input.playerId, added, removed })

			return { code: 'ok' as const, data: updated, noteAdded: noteResults.every(Boolean), added, removed }
		}),

	// add-only, applied across many players (bulk selection / squad): one flag set with per-flag reasons, added to
	// every target that doesn't already have it. Each player lands its own PLAYER_FLAGS_UPDATED event and BM notes,
	// so the audit trail reads the same as if each had been flagged singly. A player already carrying a flag is left
	// untouched rather than failing the batch.
	addFlags: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z.object({
				playerIds: z.array(z.string()).min(1),
				add: z.array(BM.FlagChangeSchema).min(1),
			}),
		)
		.handler(async ({ input, context: ctx }) => {
			if (!isEnabled()) return { code: 'err:disabled' as const }

			const orgFlags = await getOrgFlags(ctx)
			const missing = BM.flagsMissingRequiredNote(input.add, Settings.GLOBAL_SETTINGS.playerFlagsRequiringNote)
			if (missing.length > 0) {
				return { code: 'err:reason-required' as const, flags: BM.resolveFlags(missing, orgFlags).map((f) => f.name) }
			}

			const auth = await authForUser(ctx, ctx.user.discordId)
			let flaggedCount = 0
			let allNotesAdded = true
			for (const playerId of input.playerIds) {
				const playerIds = SM.PlayerIds.queryFromPlayerId(playerId)
				const current = await fetchSinglePlayerBmData(ctx, playerIds)
				if (!current) continue
				const toAdd = input.add.filter((f) => !current.flagIds.includes(f.id))
				if (toAdd.length === 0) continue

				// every player's write goes out under the same token, so a rejection would repeat for the rest
				const addRes = await addPlayerFlags(
					ctx,
					auth,
					current.bmPlayerId,
					toAdd.map((f) => f.id),
				).catch((err) => {
					if (isPersonalTokenRejected(err)) return { code: 'token-rejected' as const }
					throw err
				})
				if (addRes.code === 'token-rejected') return { code: 'err:personal-token-rejected' as const, flaggedCount }
				if (addRes.code === 'player-already-has-flag') continue

				const added = resolveFlagChanges(toAdd, orgFlags)
				const noteAdded = await postFlagChangeNotes(ctx, auth, current.bmPlayerId, 'added', added, actorLabel(ctx))
				if (!noteAdded) allNotesAdded = false

				await invalidateAndRefetchPlayer(ctx, playerId)
				await persistFlagsUpdatedEvent(ctx, { playerId, added, removed: [] })
				flaggedCount++
			}

			return { code: 'ok' as const, flaggedCount, playerCount: input.playerIds.length, noteAdded: allNotesAdded }
		}),
}

type ResolvedFlagChange = { id: string; name: string; reason?: string }

function resolveFlagChanges(flags: BM.FlagChange[], orgFlags: BM.PlayerFlag[]): ResolvedFlagChange[] {
	return BM.resolveFlags(
		flags.map((f) => f.id),
		orgFlags,
	).map((flag) => ({
		id: flag.id,
		name: flag.name,
		reason: flags.find((f) => f.id === flag.id)?.reason?.trim() || undefined,
	}))
}

function actorLabel(ctx: USR.Ctx) {
	return BM.webActorLabel(ctx.user)
}

// one note per flag, each carrying that flag's own reason. a failed note must not fail the flag change itself: the
// flag is already written to BM by this point, and reporting failure would invite a retry that double-flags. callers
// surface `noteAdded` instead, which is false if any of the notes failed.
async function postFlagChangeNotes(
	ctx: CS.Ctx & CS.AbortSignal,
	auth: Auth,
	bmPlayerId: string,
	action: 'added' | 'removed',
	flags: ResolvedFlagChange[],
	actor: string,
) {
	const results = await Promise.all(
		flags.map((flag) =>
			addPlayerNote(ctx, auth, bmPlayerId, BM.flagChangeNote({ action, flagName: flag.name, actor, reason: flag.reason }))
				.then(() => true)
				.catch((err) => {
					log.warn({ err, bmPlayerId, flag: flag.name }, 'failed to post BM note after flag change')
					return false
				}),
		),
	)
	return results.every(Boolean)
}

async function persistFlagsUpdatedEvent(ctx: USR.Ctx & C.Db, e: Pick<AppEvents.PlayerFlagsUpdated, 'playerId' | 'added' | 'removed'>) {
	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.PlayerFlagsUpdated>({
			type: 'PLAYER_FLAGS_UPDATED',
			...e,
			actor: { type: 'slm-user', userId: ctx.user.discordId },
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}
