import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import { initModule } from '@/server/logger'

import type * as C from '@/server/context'

import { IsolatedSubject } from '@/lib/isolated-subject'
import { metrics } from '@opentelemetry/api'
export const wsSessions = new Map<string, C.OrpcSessionBase>()
// `interrupted` is true when the socket closed without a clean handshake (the client never
// communicated intent to leave), e.g. a network drop -- distinct from a normal/going-away close.
export const disconnect$ = new IsolatedSubject<{ ctx: C.OrpcSessionBase; interrupted: boolean }>()
export const connect$ = new IsolatedSubject<C.OrpcSessionBase>()

// WebSocket close codes that indicate the peer communicated intent to close: 1000 (normal) and
// 1001 (going away, e.g. tab close / navigation). Anything else -- notably 1006 (abnormal, no close
// frame) -- is treated as an interruption the client may recover from.
const CLEAN_CLOSE_CODES = new Set([1000, 1001])

const module = initModule('ws-session')
let log!: CS.Logger

const meter = metrics.getMeter('ws-session')
meter.createObservableGauge(ATTRS.WebSocket.CONNECTED_CLIENTS, {
	description: 'Number of currently connected WebSocket clients',
}).addCallback((result) => {
	result.observe(wsSessions.size)
})

export function setup() {
	log = module.getLogger()
}

export function registerClient(ctx: C.OrpcSessionBase) {
	if (wsSessions.has(ctx.wsClientId)) {
		// should be impossible
		throw new Error(`Client with id ${ctx.wsClientId} already exists`)
	}

	wsSessions.set(ctx.wsClientId, ctx)
	ctx.ws.on('close', (code) => {
		const interrupted = !CLEAN_CLOSE_CODES.has(code)
		log.info('%s has disconnected (%s) code=%d interrupted=%s', ctx.user.username, ctx.wsClientId, code, interrupted)
		disconnect$.next({ ctx, interrupted })
		wsSessions.delete(ctx.wsClientId)
	})
	log.info('%s has connected (%s)', ctx.user.username, ctx.wsClientId)
	connect$.next(ctx)
}

export async function forceDisconnect(ids: { userId?: bigint; wsSessionId?: string; authSessionId?: string }) {
	if (Object.keys(ids).length === 0) throw new Error('Must provide at least one id')

	let sessions: C.OrpcSessionBase[] | undefined
	if (ids.wsSessionId) {
		const session = wsSessions.get(ids.wsSessionId)
		if (session) {
			sessions = [session]
		}
	} else if (ids.authSessionId) {
		sessions = Array.from(wsSessions.values()).filter((ctx) => ctx.sessionId === ids.authSessionId)
	} else if (ids.userId) {
		sessions = Array.from(wsSessions.values()).filter((ctx) => ctx.user.discordId === ids.userId)
	}

	if (!sessions) {
		log.warn('forceDisconnect: no sessions found', ids)
	} else {
		for (const session of sessions) {
			log.debug('Disconnecting session', ids, session.wsClientId)
			session.ws.close()
		}
	}
}
