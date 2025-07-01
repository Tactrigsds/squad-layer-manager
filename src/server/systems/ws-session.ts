import * as CS from '@/models/context-shared'
import * as C from '@/server/context'
import { Subject } from 'rxjs'
const wsSessions = new Map<string, C.TrpcRequest>()
export const disconnect$ = new Subject<C.TrpcRequest>()

export function registerClient(ctx: C.TrpcRequest) {
	if (wsSessions.has(ctx.wsClientId)) {
		// should be impossible
		throw new Error(`Client with id ${ctx.wsClientId} already exists`)
	}

	wsSessions.set(ctx.wsClientId, ctx)
	ctx.ws.on('close', () => {
		disconnect$.next(ctx)
		wsSessions.delete(ctx.wsClientId)
	})
}

export async function forceDisconnect(ctx: CS.Log, ids: { userId?: bigint; wsSessionId?: string; authSessionId?: string }) {
	if (Object.keys(ids).length === 0) throw new Error('Must provide at least one id')

	let sessions: C.TrpcRequest[] | undefined
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
