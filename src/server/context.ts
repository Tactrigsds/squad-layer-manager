import type { Mutex } from 'async-mutex'
import type * as Fastify from 'fastify'
import type * as ws from 'ws'

import type * as AR from '@/app-routes.ts'
import type * as Cleanup from '@/lib/cleanup.ts'
import * as CD from '@/lib/ctx-def'
import * as CS from '@/models/context-shared.models.ts'
import * as LQ from '@/models/layer-queue.models'
import * as MEC from '@/models/match-events-cache.models'
import * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as SETTINGS from '@/models/settings.models'
import * as SQS from '@/models/squad-server.models'
import * as SRQ from '@/models/switch-requests.models'
import * as TSW from '@/models/teamswaps.models'
import type * as USR from '@/models/users.models.ts'
import * as V from '@/models/vote.models'

import type * as DB from './db.ts'

// the connection statements run on (see DB.all, DB.get, DB.run)
export type Db = CS.Ctx & {
	db: DB.Conn
}
export const DbDef = CD.defCtx<Db>()(['db'], { name: 'db' })

// the context is inside DB.transaction(). An interface, so the plugin api report names it rather than expanding it.
export interface Tx extends CS.Ctx {
	tx: DB.TxHandle
}
export const TxDef = CD.defCtx<Tx>()(['tx'], { name: 'tx' })

type ReleaseTask = () => void | Promise<void>
// TODO we may want some way of specifying in function signature what kinds of locks the context might acquire
export type Mutexes = CS.Ctx & {
	mutexes: {
		// represents the set of mutexes currently locked by the context
		locked: Set<Mutex>

		// tasks to be executed after mutex is released
		releaseTasks: ReleaseTask[]
	}
}
export const MutexesDef = CD.defCtx<Mutexes>()(['mutexes'], { name: 'mutexes' })
export function initMutexStore<Ctx extends object>(ctx?: Ctx): Ctx {
	return {
		...(ctx ?? ({} as Ctx)),
		mutexes: { locked: new Set<Mutex>(), releaseTasks: [] },
	}
}

export type ResolvedRoute = CS.Ctx & { route: AR.ResolvedRoute }
export const ResolvedRouteDef = CD.defCtx<ResolvedRoute>()(['route'], { name: 'resolvedRoute' })

// could also be ws upgrade
export type FastifyRequest = CS.Ctx & {
	req: Fastify.FastifyRequest
	cookies: AR.Cookies
} & Partial<ResolvedRoute>
export const FastifyRequestDef = CD.defCtx<FastifyRequest>()(['req', 'cookies', 'route'], { name: 'fastifyRequest' })

export type FastifyRequestFull = FastifyRequest & AttachedFastify

export type FastifyReply = CS.Ctx & { res: Fastify.FastifyReply }
export const FastifyReplyDef = CD.defCtx<FastifyReply>()(['res'], { name: 'fastifyReply' })
export type HttpRequest = FastifyRequest & FastifyReply
export type HttpRequestFull = HttpRequest & AttachedFastify

// sparse subset of User
export type AuthSession = CS.Ctx & {
	sessionId: string
	expiresAt: Date
}
export const AuthSessionDef = CD.defCtx<AuthSession>()(['sessionId', 'expiresAt'], { name: 'authSession' })

export type WSSession = CS.Ctx & {
	wsClientId: string
}
export const WSSessionDef = CD.defCtx<WSSession>()(['wsClientId'], { name: 'wsSession' })

export type AuthedUser = USR.Ctx & AuthSession

export type AttachedFastify = Db & Partial<ResolvedRoute> & CS.AbortSignal
export type Websocket = CS.Ctx & { ws: ws.WebSocket }
export const WebsocketDef = CD.defCtx<Websocket>()(['ws'], { name: 'websocket' })
// Whether the connection's client runs the layer data this server serves. Layer ids cross the socket as dense ids,
// which only mean the same thing on both ends of one layer data, so a client on any other is refused everything but
// the config that tells it to reload (see the staleLayerData middleware in orpc-base.ts).
export type LayerDataSession = { layerDataCurrent: boolean }

export type OrpcSessionBase = CS.Ctx & AuthedUser & WSSession & Websocket & FastifyRequest & Db & LayerDataSession

export type OrpcBase = OrpcSessionBase & CS.AbortSignal

export type ManagedServerCleanup = CS.Ctx & {
	cleanup: Cleanup.Tasks
}
export const ManagedServerCleanupDef = CD.defCtx<ManagedServerCleanup>()(['cleanup'], { name: 'managedServerCleanup' })

// def here rather than beside Msgs.Ctx: messages.models is a type-only leaf
export const TranslatorDef = CD.defCtx<Msgs.Ctx>()(['tr'], { name: 'translator' })

export type ManagedServer = CS.Ctx &
	SQS.Ctx &
	V.Ctx &
	LQ.Ctx &
	MH.Ctx &
	MEC.Ctx &
	TSW.Ctx &
	SRQ.Ctx &
	SETTINGS.Ctx &
	// resolves against the server's own locale setting, read live
	Msgs.Ctx &
	ManagedServerCleanup &
	// aborts when the managed server is destroyed or the process shuts down
	CS.AbortSignal

export const ManagedServerDef = CD.mergeDefs(
	[
		SQS.CtxDef,
		V.CtxDef,
		LQ.CtxDef,
		MH.CtxDef,
		MEC.CtxDef,
		TSW.CtxDef,
		SRQ.CtxDef,
		SETTINGS.CtxDef,
		TranslatorDef,
		ManagedServerCleanupDef,
		CS.AbortSignalDef,
	],
	{ name: 'managedServer' },
)
