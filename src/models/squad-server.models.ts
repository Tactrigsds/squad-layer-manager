import type { MutexInterface } from 'async-mutex'

import * as CD from '@/lib/ctx-def'
import type * as Rx from '@/lib/rxjs'
import type * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import type * as PendingEvents from '@/models/pending-events.models'
import type * as SE from '@/models/server-events.models'
import * as SR from '@/models/squad-rcon.models'
import type * as SM from '@/models/squad.models'

export type Ctx = CS.Ctx & { server: Ctx.Payload } & SR.Ctx

export namespace Ctx {
	export type Payload = {
		layersStatusExt$: Rx.Observable<SM.LayersStatusResExt>

		postRollEventsSub: Rx.Subscription | null

		serverRolling$: Rx.BehaviorSubject<number | null>

		// latest "Server Tick Rate" reported in the game logs; null until the first sample is seen
		tickRate$: Rx.BehaviorSubject<number | null>

		// events of the current match, kept in memory purely to serve the chat feed without a query. Every one of
		// them is already persisted (see the createEvent hook); this is a cache, not a write buffer.
		emittedEvents: SE.Event[]
		// Carries only what a listener cannot rebuild: the span links from whatever produced the event, and
		// the server it belongs to. Listeners resolve the slice themselves (see eventSliceCtx).
		event$: Rx.Subject<[CS.Otel & CS.ServerId, SE.Event]>
		eventState: PendingEvents.State

		// SLM app (audit) events for this server, and the live channel that feeds them into the activity panel
		emittedAppEvents: AppEvents.AppEvent[]
		appEvent$: Rx.Subject<[CS.Otel & CS.ServerId, AppEvents.AppEvent]>

		chatState: CHAT.ChatState

		destroyed: boolean
		cleanupId: number | null

		processEventsMtx: MutexInterface
	}
}

export const CtxDef = CD.defCtx<Ctx>()(['server'], { name: 'squadServer', extends: [SR.CtxDef] })
