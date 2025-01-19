import * as C from '@/server/context'
export type WSHook = (ctx: C.TrpcRequest) => void
const wsSessions = new Map<string, C.TrpcRequest>()
const hooks: WSHook[] = []

export function registerClient(ctx: C.TrpcRequest) {
	if (wsSessions.has(ctx.wsClientId)) {
		// should be impossible
		throw new Error(`Client with id ${ctx.wsClientId} already exists`)
	}

	wsSessions.set(ctx.wsClientId, ctx)
	ctx.ws.on('close', () => {
		for (const hook of hooks) {
			hook(ctx)
		}
		wsSessions.delete(ctx.wsClientId)
	})
}

export function registerDisconnectHook(handler: WSHook) {
	hooks.push(handler)
}

export async function forceDisconnect(baseCtx: C.Log, ids: { userId?: bigint; wsSessionId?: string; authSessionId?: string }) {
	if (Object.keys(ids).length === 0) throw new Error('Must provide at least one id')
	await using ctx = C.pushOperation(baseCtx, 'ws-session:force-disconnect', { startMsgBindings: ids })

	let sessionCtx: C.TrpcRequest | undefined
	if (ids.wsSessionId) {
		sessionCtx = wsSessions.get(ids.wsSessionId)
	} else if (ids.authSessionId) {
		sessionCtx = Array.from(wsSessions.values()).find((ctx) => ctx.sessionId === ids.authSessionId)
	} else if (ids.userId) {
		sessionCtx = Array.from(wsSessions.values()).find((ctx) => ctx.user.discordId === ids.userId)
	}

	if (!sessionCtx) {
		ctx.log.warn('forceDisconnect: no session found', ids)
	}

	sessionCtx?.ws.close()
}
