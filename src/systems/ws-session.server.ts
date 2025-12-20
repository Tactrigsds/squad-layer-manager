import type * as CS from '@/models/context-shared'
import type * as C from '@/server/context'
import * as SquadServer from '@/systems/squad-server.server'
import { Subject } from 'rxjs'
export const wsSessions = new Map<string, C.OrpcBase>()
export const disconnect$ = new Subject<C.OrpcBase>()
export const connect$ = new Subject<C.OrpcBase>()

export function registerClient(ctx: C.OrpcBase) {
	if (wsSessions.has(ctx.wsClientId)) {
		// should be impossible
		throw new Error(`Client with id ${ctx.wsClientId} already exists`)
	}

	wsSessions.set(ctx.wsClientId, ctx)
	ctx.ws.on('close', () => {
		disconnect$.next(ctx)
		wsSessions.delete(ctx.wsClientId)
		SquadServer.globalState.selectedServers.delete(ctx.wsClientId)
	})
	connect$.next(ctx)
}

export async function forceDisconnect(ctx: CS.Log, ids: { userId?: bigint; wsSessionId?: string; authSessionId?: string }) {
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
		ctx.log.warn('forceDisconnect: no sessions found', ids)
	} else {
		for (const session of sessions) {
			ctx.log.debug('Disconnecting session', ids, session.wsClientId)
			session.ws.close()
		}
	}
}
