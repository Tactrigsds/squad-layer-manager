import type { MutexInterface } from 'async-mutex'

import * as CD from '@/lib/ctx-def'
import type * as ODSM from '@/lib/odsm'
import type * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared'
import type * as L from '@/models/layer'
import type * as SS from '@/models/server-state.models'
import type * as SLL from '@/models/shared-layer-list'
import type * as SM from '@/models/squad.models'

export type Ctx = CS.Ctx & { layerQueue: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['layerQueue'], { name: 'layerQueue', extends: [CS.ServerIdDef] })

// A running in-game vote on the Squad server (AdminEnableVoting). Its result overwrites the next layer, so SLM
// stands down for the rest of the match while one is live. Runtime-only: it is rebuilt from the log stream, and a
// vote never outlives the match it was called in. See docs/ingame_voting.md.
export type IngameVote = {
	kind: SM.LogEvents.IngameVoteKind
	choices: string[]
	startedAt: number
	// whether SLM turned updatesToSquadServerDisabled on itself in response, i.e. whether the alert should offer to
	// undo it as part of the same story
	disabledUpdates: boolean
}

export namespace Ctx {
	export type Payload = {
		unexpectedNextLayerSet$: Rx.BehaviorSubject<L.LayerId | null>
		ingameVote$: Rx.BehaviorSubject<IngameVote | null>

		// TODO we should fold this into the server events
		update$: Rx.ReplaySubject<SS.LQStateUpdate>

		session: ODSM.Server.Session<SLL.Operation, SLL.State>
		op$: Rx.Subject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>
		updateLayerMtx: MutexInterface
	}
}
