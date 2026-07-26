import type { Mutex } from 'async-mutex'
import type * as Fastify from 'fastify'
import type * as ws from 'ws'

import type * as AR from '@/app-routes.ts'
import type { AsyncResourceInvocationOpts, ImmediateRefetchError } from '@/lib/async-resource.ts'
import type * as Cleanup from '@/lib/cleanup.ts'
import type RconCore from '@/lib/rcon/core-rcon.ts'
import type * as CS from '@/models/context-shared.ts'
import type * as SS from '@/models/server-state.models'
import type * as USR from '@/models/users.models.ts'
import type * as LayerQueueSys from '@/systems/layer-queue.server'
import type * as MatchEventsCacheSys from '@/systems/match-events-cache.server'
import type * as MatchHistorySys from '@/systems/match-history.server'
import type * as SettingsSys from '@/systems/settings.server'
import type * as SquadRconSys from '@/systems/squad-rcon.server'
import type * as SquadServerSys from '@/systems/squad-server.server'
import type * as TeamswapSys from '@/systems/teamswaps.server'
import type * as UserPresenceSys from '@/systems/user-presence.server'
import type * as VoteSys from '@/systems/vote.server'

import type * as DB from './db.ts'

export type Db = CS.Ctx & {
	db(opts?: { redactParams?: boolean }): DB.Db
} & Partial<Tx>

// indicates the context is in a db transaction
export type Tx = CS.Ctx & {
	tx: {
		rollback: () => void

		// tasks which will be executed after the transaction is committed
		unlockTasks: (() => void | Promise<void>)[]
	}
}

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
export function initMutexStore<Ctx extends object>(ctx?: Ctx): Ctx {
	return {
		...(ctx ?? ({} as Ctx)),
		mutexes: { locked: new Set<Mutex>(), releaseTasks: [] },
	}
}

export type ResolvedRoute = CS.Ctx & { route: AR.ResolvedRoute }

// could also be ws upgrade
export type FastifyRequest = CS.Ctx & {
	req: Fastify.FastifyRequest
	cookies: AR.Cookies
} & Partial<ResolvedRoute>

export type FastifyRequestFull = FastifyRequest & AttachedFastify

export type FastifyReply = CS.Ctx & { res: Fastify.FastifyReply }
export type HttpRequest = FastifyRequest & FastifyReply
export type HttpRequestFull = HttpRequest & AttachedFastify

// sparse subset of User
export type AuthSession = CS.Ctx & {
	sessionId: string
	expiresAt: Date
}

export type WSSession = CS.Ctx & {
	wsClientId: string
}

export type AuthedUser = USR.Ctx & AuthSession

export type AttachedFastify = Db & Partial<ResolvedRoute> & CS.AbortSignal
export type Websocket = CS.Ctx & { ws: ws.WebSocket }
export type OrpcSessionBase = CS.Ctx & AuthedUser & WSSession & Websocket & FastifyRequest & Db

export type OrpcBase = OrpcSessionBase & CS.AbortSignal

export type AsyncResourceInvocation = CS.Ctx & {
	resOpts: AsyncResourceInvocationOpts
	refetch: (...args: ConstructorParameters<typeof ImmediateRefetchError>) => ImmediateRefetchError
}

export type Rcon = CS.Ctx & {
	rcon: RconCore
}

export type SquadRcon = CS.Ctx & { squadRcon: SquadRconSys.SquadRcon } & Rcon & SS.Ctx

export type Vote = CS.Ctx & {
	vote: VoteSys.VoteContext
} & SS.Ctx

export type LayerQueue = CS.Ctx & {
	layerQueue: LayerQueueSys.LayerQueueSlice
} & SS.Ctx

export type MatchHistory = CS.Ctx & {
	matchHistory: MatchHistorySys.MatchHistoryContext
} & SS.Ctx

export type MatchEventsCache = CS.Ctx & {
	matchEventsCache: MatchEventsCacheSys.MatchEventsCacheContext
} & SS.Ctx

export type SquadServer = CS.Ctx & { server: SquadServerSys.SquadServer } & SquadRcon

export type Teamswap = CS.Ctx & {
	teamswaps: TeamswapSys.TeamswapContext
} & SS.Ctx

export type UserPresence = CS.Ctx & UserPresenceSys.UserPresenceContext

export type ServerSettings = CS.Ctx & {
	serverSettings: SettingsSys.ServerSettingsSlice
} & SS.Ctx

export type ServerSliceCleanup = CS.Ctx & {
	cleanup: Cleanup.Tasks
}
export type ServerSlice = CS.Ctx &
	SquadServer &
	Vote &
	LayerQueue &
	MatchHistory &
	MatchEventsCache &
	Teamswap &
	ServerSettings &
	ServerSliceCleanup &
	// aborts when the slice is destroyed or the process shuts down
	CS.AbortSignal
