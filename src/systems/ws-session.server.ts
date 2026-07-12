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

// Cumulative, unlike the gauge above: a client that connects and drops inside one collection interval
// is invisible to the gauge but shows up here, which is what makes reconnect storms detectable.
const connectionCounter = meter.createCounter(ATTRS.WebSocket.CONNECTIONS, {
	description: 'WebSocket connections accepted',
})

const messageCounter = meter.createCounter(ATTRS.WebSocket.MESSAGES, {
	description: 'WebSocket messages, by direction',
})

const ioCounter = meter.createCounter(ATTRS.WebSocket.IO, {
	description: 'Bytes moved over WebSocket connections, by direction',
	unit: 'By',
})

function byteLength(data: unknown): number {
	if (typeof data === 'string') return Buffer.byteLength(data, 'utf8')
	if (Buffer.isBuffer(data)) return data.byteLength
	if (data instanceof ArrayBuffer) return data.byteLength
	if (ArrayBuffer.isView(data)) return data.byteLength
	if (Array.isArray(data)) return data.reduce<number>((n, part) => n + byteLength(part), 0)
	return 0
}

// Per-connection rather than aggregate, because the byte counts are only available on the socket
// itself. No client id on the attributes: it would mint a series per connection.
function instrumentSocketIo(ws: C.OrpcSessionBase['ws']) {
	const sent = { [ATTRS.IO.DIRECTION]: 'sent' satisfies ATTRS.IO.Direction }
	const received = { [ATTRS.IO.DIRECTION]: 'received' satisfies ATTRS.IO.Direction }

	ws.on('message', (data: unknown) => {
		messageCounter.add(1, received)
		ioCounter.add(byteLength(data), received)
	})

	// oRPC writes through ws.send, so wrapping the instance method is the only place both the payload
	// and its size are visible. Bound to this socket, so it goes away with the connection.
	const send = ws.send.bind(ws) as (...args: unknown[]) => void
	ws.send = ((data: unknown, ...rest: unknown[]) => {
		messageCounter.add(1, sent)
		ioCounter.add(byteLength(data), sent)
		return send(data, ...rest)
	}) as typeof ws.send
}

export function setup() {
	log = module.getLogger()
}

export function registerClient(ctx: C.OrpcSessionBase) {
	if (wsSessions.has(ctx.wsClientId)) {
		// should be impossible
		throw new Error(`Client with id ${ctx.wsClientId} already exists`)
	}

	wsSessions.set(ctx.wsClientId, ctx)
	connectionCounter.add(1)
	instrumentSocketIo(ctx.ws)
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
