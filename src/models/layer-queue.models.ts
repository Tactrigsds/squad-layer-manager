import type { MutexInterface } from 'async-mutex'

import * as CD from '@/lib/ctx-def'
import type * as ODSM from '@/lib/odsm'
import type * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared'
import type * as L from '@/models/layer'
import type * as SS from '@/models/server-state.models'
import type * as SLL from '@/models/shared-layer-list'
// Db is server infrastructure with no models home, and update$ carries it. A type-only import, and
// server/context.ts is types-only, so nothing of the server reaches the client through this.
import type * as C from '@/server/context'

export type Ctx = CS.Ctx & { layerQueue: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['layerQueue'], { name: 'layerQueue', extends: [CS.ServerIdDef] })

export namespace Ctx {
	export type Payload = {
		unexpectedNextLayerSet$: Rx.BehaviorSubject<L.LayerId | null>

		// TODO we should fold this into the server events
		update$: Rx.ReplaySubject<[SS.LQStateUpdate, C.Db & CS.ServerId]>

		session: ODSM.Server.Session<SLL.Operation, SLL.State>
		op$: Rx.Subject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>
		updateLayerMtx: MutexInterface
	}
}
