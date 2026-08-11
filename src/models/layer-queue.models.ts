import type { MutexInterface } from 'async-mutex'

import * as CD from '@/lib/ctx-def'
import type * as ODSM from '@/lib/odsm'
import type * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared'
import type * as L from '@/models/layer'
import type * as SS from '@/models/server-state.models'
import type * as SLL from '@/models/shared-layer-list'

export type Ctx = CS.Ctx & { layerQueue: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['layerQueue'], { name: 'layerQueue', extends: [CS.ServerIdDef] })

// A running in-game vote on the Squad server (AdminEnableVoting). Its result overwrites the next layer, so SLM
// stands down for the rest of the match while one is live. Runtime-only: it is rebuilt from the log stream, and a
// vote never outlives the match it was called in.
export type IngameVote = {
	choices: string[]
	startedAt: number
}

// What became of SLM's last attempt to write the queue head to the game server over RCON. 'syncing' is the window
// between issuing the write and reading it back, and is the one time the queue head and the server's next layer are
// expected to disagree.
export type NextLayerSyncState =
	| { code: 'synced' }
	| { code: 'syncing' }
	| { code: 'disabled' }
	| { code: 'err:rcon' }
	// the server kept a different layer, either refusing ours or holding one somebody else set
	| { code: 'err:refused'; actualLayerId: L.LayerId }

export namespace Ctx {
	export type Payload = {
		nextLayerSyncState$: Rx.BehaviorSubject<NextLayerSyncState>
		ingameVote$: Rx.BehaviorSubject<IngameVote | null>

		// TODO we should fold this into the server events
		update$: Rx.ReplaySubject<SS.LQStateUpdate>

		session: ODSM.Server.Session<SLL.Operation, SLL.State>
		op$: Rx.Subject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>
		updateLayerMtx: MutexInterface
	}
}
