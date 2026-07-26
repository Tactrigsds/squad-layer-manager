import type { LRUMap } from '@/lib/lru-map'
import type * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import type * as SS from '@/models/server-state.models'

export type Ctx = CS.Ctx & { matchEventsCache: Ctx.Payload } & SS.Ctx

export namespace Ctx {
	export type Payload = {
		// matchId -> enriched events
		events: LRUMap<number, Promise<CHAT.EventEnriched[]>>
	}
}
