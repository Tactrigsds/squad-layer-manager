import { FixedSizeMap } from '@/lib/lru-map'
import { z } from '@/lib/zod'
import type * as CS from '@/models/context-shared'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'

// Resolves a squad server's name into a join link, via the squad browser's public api.
// https://api.squadbrowser.app/docs#tag/utilities/POST/pub/join-link

const getEnv = Env.getEnvBuilder({ ...Env.groups.squadbrowser })
const module = initModule('squad-browser')

let ENV!: ReturnType<typeof getEnv>
let log!: ReturnType<typeof module.getLogger>

export function isEnabled() {
	return ENV?.SQUADBROWSER_ENABLED ?? false
}

export function setup() {
	log = module.getLogger()
	ENV = getEnv()
	if (!ENV.SQUADBROWSER_ENABLED) {
		log.info('Squad browser integration is off (SQUADBROWSER_ENABLED=false); no join links are available')
	}
}

export type JoinLinkRes =
	| { code: 'ok'; joinUrl: string }
	| { code: 'err:disabled' }
	| { code: 'err:no-such-server' }
	| { code: 'err:rate-limited' }
	| { code: 'err:request-failed'; msg: string }

// the api puts every route under /api (the spec's `servers: [{url: '/api'}]`), while SQUADBROWSER_HOST is
// just the origin. Without this the request is a route-level 404 rather than a not-indexed one.
const JOIN_LINK_PATH = '/api/pub/join-link'

// joinUrl comes back as a steam:// protocol url rather than an https one
const JoinLinkSchema = z.object({ joinUrl: z.url() })

// The api rate-limits this to 50 requests an hour per server and serves the same link for ~90s anyway, so
// holding one for that long buys nothing staler and caps us at 40 an hour however many admins click. A miss
// keeps a longer TTL: a server the browser has never indexed stays that way, and a click must not spend a
// request rediscovering it every time.
const OK_TTL_MS = 90 * 1000
const MISS_TTL_MS = 10 * 60 * 1000
// bounded because the key carries the match, and a server that puts its player count in its name mints a new
// one every time it fills
const cache = new FixedSizeMap<string, { res: JoinLinkRes; expiresAt: number }>(64)

// The link points at a steam lobby the server tears down when it rolls, so a cached one outlives its match
// however much of its TTL is left. Keying on the match retires it at the roll and leaves the TTL to cover the
// rest (a restart inside one match, say).
function cacheKey(serverName: string, matchId: number) {
	return `${matchId}\u0000${serverName}`
}

export async function getJoinLink(ctx: CS.Ctx & CS.AbortSignal, serverName: string, matchId: number): Promise<JoinLinkRes> {
	if (!isEnabled()) return { code: 'err:disabled' }

	const key = cacheKey(serverName, matchId)
	const cached = cache.get(key)
	if (cached && cached.expiresAt > Date.now()) return cached.res

	const res = await fetchJoinLink(ctx, serverName)
	if (res.code === 'ok' || res.code === 'err:no-such-server') {
		cache.set(key, { res, expiresAt: Date.now() + (res.code === 'ok' ? OK_TTL_MS : MISS_TTL_MS) })
	}
	return res
}

async function fetchJoinLink(ctx: CS.Ctx & CS.AbortSignal, serverName: string): Promise<JoinLinkRes> {
	let response: Response
	try {
		response = await fetch(`${ENV.SQUADBROWSER_HOST}${JOIN_LINK_PATH}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-api-key': ENV.SQUADBROWSER_API_KEY! },
			body: JSON.stringify({ serverName }),
			signal: ctx.signal,
		})
	} catch (error) {
		log.warn(error, 'Squad browser join-link request failed')
		return { code: 'err:request-failed', msg: 'Could not reach the squad browser' }
	}

	if (response.status === 404) return { code: 'err:no-such-server' }
	// not cached: the limit is per hour, and holding the refusal would outlast it
	if (response.status === 429) return { code: 'err:rate-limited' }
	if (!response.ok) {
		// the key and the host are deploy config, so a 401 here is a misconfiguration an operator has to see
		log.warn('Squad browser join-link request returned %d for server name %s', response.status, serverName)
		return { code: 'err:request-failed', msg: `The squad browser returned ${response.status}` }
	}

	const parsed = JoinLinkSchema.safeParse(await response.json().catch(() => null))
	if (!parsed.success) {
		log.warn(parsed.error, 'Could not parse the squad browser join-link response')
		return { code: 'err:request-failed', msg: 'The squad browser returned an unexpected response' }
	}
	return { code: 'ok', joinUrl: parsed.data.joinUrl }
}
