import * as CD from '@/lib/ctx-def'
import type { LRUMap } from '@/lib/lru-map'
import type * as CHAT from '@/models/chat.models'
import * as CS from '@/models/context-shared'

export type Ctx = CS.Ctx & { matchEventsCache: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['matchEventsCache'], { name: 'matchEventsCache', extends: [CS.ServerIdDef] })

export namespace Ctx {
	export type Payload = {
		// matchId -> its raw feed events, server events with app events interleaved
		events: LRUMap<number, Promise<CHAT.Event[]>>
	}
}
