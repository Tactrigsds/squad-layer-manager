import type { MutexInterface } from 'async-mutex'

import * as CD from '@/lib/ctx-def'
import type { TracedSubject } from '@/lib/isolated-subject'
import type * as Rx from '@/lib/rxjs'
import type * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import type * as PendingEvents from '@/models/pending-events.models'
import type * as SE from '@/models/server-events.models'
import * as SR from '@/models/squad-rcon.models'

export type Ctx = CS.Ctx & { server: Ctx.Payload } & SR.Ctx

export namespace Ctx {
	export type Payload = {
		postRollEventsSub: Rx.Subscription | null

		serverRolling$: Rx.BehaviorSubject<number | null>

		// latest "Server Tick Rate" reported in the game logs; null until the first sample is seen
		tickRate$: Rx.BehaviorSubject<number | null>

		// events of the current match, kept in memory purely to serve the chat feed without a query. Every one of
		// them is already persisted (see the createEvent hook); this is a cache, not a write buffer.
		emittedEvents: SE.Event[]
		// Carries only what a listener cannot rebuild: the span links from whatever produced the event, and
		// the server it belongs to. Listeners resolve the managed server themselves (see eventCtx).
		// TracedSubject stamps each emission with a link to the span that produced it. Listeners
		// resolve the managed server themselves from the serverId (see SquadServer.eventCtx).
		event$: TracedSubject<SE.Event, CS.ServerId>
		eventState: PendingEvents.State

		// SLM app (audit) events for this server, and the live channel that feeds them into the activity panel
		emittedAppEvents: AppEvents.AppEvent[]
		appEvent$: TracedSubject<AppEvents.AppEvent, CS.ServerId>

		chatState: CHAT.ChatState

		destroyed: boolean
		cleanupId: number | null

		processEventsMtx: MutexInterface
	}
}

export const CtxDef = CD.defCtx<Ctx>()(['server'], { name: 'squadServer', extends: [SR.CtxDef] })
