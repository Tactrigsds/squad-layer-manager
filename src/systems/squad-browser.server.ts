import { z } from 'zod'

import { FixedSizeMap } from '@/lib/lru-map'
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
	return ENV?.SQB_ENABLED ?? false
}

export function setup() {
	log = module.getLogger()
	ENV = getEnv()
	if (!ENV.SQB_ENABLED) {
		log.info('Squad browser integration is off (SQB_ENABLED=false); no join links are available')
	}
}

export type JoinLinkRes =
	| { code: 'ok'; joinUrl: string }
	| { code: 'err:disabled' }
	| { code: 'err:no-such-server' }
	| { code: 'err:request-failed'; msg: string }

const JoinLinkSchema = z.object({ joinUrl: z.url() })

// A name resolves to the same link until the server is renamed, and every dashboard that opens asks again, so
// the answer is held rather than re-bought. Misses are held too, briefly: a server the browser has never
// indexed is the steady state for anyone self-hosting, and it must not cost a request per page load forever.
const OK_TTL_MS = 6 * 60 * 60 * 1000
const MISS_TTL_MS = 10 * 60 * 1000
// bounded because a server that puts its player count in its name mints a new key every time it fills
const cache = new FixedSizeMap<string, { res: JoinLinkRes; expiresAt: number }>(64)

export async function getJoinLink(ctx: CS.Ctx & CS.AbortSignal, serverName: string): Promise<JoinLinkRes> {
	if (!isEnabled()) return { code: 'err:disabled' }

	const cached = cache.get(serverName)
	if (cached && cached.expiresAt > Date.now()) return cached.res

	const res = await fetchJoinLink(ctx, serverName)
	if (res.code === 'ok' || res.code === 'err:no-such-server') {
		cache.set(serverName, { res, expiresAt: Date.now() + (res.code === 'ok' ? OK_TTL_MS : MISS_TTL_MS) })
	}
	return res
}

async function fetchJoinLink(ctx: CS.Ctx & CS.AbortSignal, serverName: string): Promise<JoinLinkRes> {
	let response: Response
	try {
		response = await fetch(`${ENV.SQB_HOST}/pub/join-link`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-api-key': ENV.SQB_API_KEY! },
			body: JSON.stringify({ serverName }),
			signal: ctx.signal,
		})
	} catch (error) {
		log.warn(error, 'Squad browser join-link request failed')
		return { code: 'err:request-failed', msg: 'Could not reach the squad browser' }
	}

	if (response.status === 404) return { code: 'err:no-such-server' }
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
