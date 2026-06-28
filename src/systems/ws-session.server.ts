import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import { initModule } from '@/server/logger'

import type * as C from '@/server/context'

import * as SquadServer from '@/systems/squad-server.server'
import { metrics } from '@opentelemetry/api'
import { IsolatedSubject } from '@/lib/isolated-subject'
export const wsSessions = new Map<string, C.OrpcBase>()
export const disconnect$ = new IsolatedSubject<C.OrpcBase>()
export const connect$ = new IsolatedSubject<C.OrpcBase>()

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

export function registerClient(ctx: C.OrpcBase) {
	if (wsSessions.has(ctx.wsClientId)) {
		// should be impossible
		throw new Error(`Client with id ${ctx.wsClientId} already exists`)
	}

	wsSessions.set(ctx.wsClientId, ctx)
	ctx.ws.on('close', () => {
		log.info('%s has disconnected (%s)', ctx.user.username, ctx.wsClientId)
		disconnect$.next(ctx)
		wsSessions.delete(ctx.wsClientId)
		SquadServer.globalState.selectedServers.delete(ctx.wsClientId)
	})
	log.info('%s has connected (%s)', ctx.user.username, ctx.wsClientId)
	connect$.next(ctx)
}

export async function forceDisconnect(ids: { userId?: bigint; wsSessionId?: string; authSessionId?: string }) {
	if (Object.keys(ids).length === 0) throw new Error('Must provide at least one id')

	let sessions: C.OrpcBase[] | undefined
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
